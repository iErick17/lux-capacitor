# SPDX-License-Identifier: GPL-3.0-or-later
"""Exercise the release installer in a private settings session, with root actions mocked."""
import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile

UUID = 'lux-capacitor@ierick17.github.io'
assert os.geteuid() != 0, 'Run as a normal user (or runuser -u nobody in a container)'
artifact = pathlib.Path(sys.argv[1]).resolve()
payload = artifact.read_bytes().split(b'__AUTO_BRIGHTNESS_PAYLOAD__\n', 1)[1]

with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
        archive.extractall(root, filter='data')
    source = root / 'Auto-Brightness'
    for line in (source / 'SHA256SUMS').read_text().splitlines():
        digest, name = line.split('  ', 1)
        assert hashlib.sha256((source / name).read_bytes()).hexdigest() == digest
    commands = root / 'bin'
    commands.mkdir()
    log = root / 'commands.log'
    stubs = {
        'gnome-shell': '#!/bin/sh\nprintf "GNOME Shell %s\\n" "${TEST_SHELL_VERSION:-50.0}"\n',
        'gnome-extensions': '#!/bin/sh\nprintf "extensions %s\\n" "$*" >> "$TEST_COMMAND_LOG"\n',
        'sudo': '''#!/bin/sh
printf 'sudo %s\n' "$*" >> "$TEST_COMMAND_LOG"
case "$1" in
    apt-get|dnf) exit 0 ;;
    bash) case "$2" in */install-resume-hook.sh) exit 0 ;; esac ;;
esac
echo 'Unexpected privileged command' >&2
exit 1
''',
    }
    for name, script in stubs.items():
        p = commands / name
        p.write_text(script)
        p.chmod(0o755)
    env = dict(os.environ, PATH=str(commands) + ':' + os.environ['PATH'],
               XDG_DATA_HOME=str(root / 'data'), XDG_STATE_HOME=str(root / 'state'),
               XDG_CONFIG_HOME=str(root / 'config'), GSETTINGS_BACKEND='keyfile',
               TEST_COMMAND_LOG=str(log))
    for name in ('DBUS_SESSION_BUS_ADDRESS', 'DCONF_PROFILE', 'GSETTINGS_SCHEMA_DIR'):
        env.pop(name, None)

    def install(version='50.0'):
        return subprocess.run(['dbus-run-session', '--', 'bash', str(source / 'install.sh')],
                              input='y\n', text=True, capture_output=True,
                              env=dict(env, TEST_SHELL_VERSION=version), timeout=90)

    def settings(code):
        prelude = f'''from gi.repository import Gio
import json
schema_source = Gio.SettingsSchemaSource.new_from_directory({str(source / UUID / 'schemas')!r}, Gio.SettingsSchemaSource.get_default(), False)
brightness = Gio.Settings.new_full(schema_source.lookup('org.gnome.shell.extensions.adaptive-brightness', False), None, None)
shell = Gio.Settings.new('org.gnome.shell')
media = Gio.Settings.new('org.gnome.settings-daemon.plugins.media-keys')
'''
        p = subprocess.run(['dbus-run-session', '--', 'python3', '-c', prelude + code],
                           env=env, text=True, capture_output=True, check=True, timeout=20)
        return p.stdout.strip()

    rejected = install('49.0')
    assert rejected.returncode != 0 and not log.exists(), 'Unsupported GNOME modified the system'
    assert not (root / 'data').exists(), 'Rejected install created an extension'
    print('PASS: GNOME 49 is rejected before installation')
    fresh = install()
    assert fresh.returncode == 0, fresh.stdout + fresh.stderr
    target = root / 'data/gnome-shell/extensions' / UUID
    assert (target / 'schemas/gschemas.compiled').exists()
    for name in ('extension.js', 'keyboardController.js', 'brightnessModel.js', 'prefs.js', 'metadata.json'):
        assert (target / name).read_bytes() == (source / UUID / name).read_bytes()
    state = json.loads(settings("print(json.dumps([brightness.get_boolean('enabled'), brightness.get_boolean('keyboard-auto-enabled'), media.get_int('volume-step'), shell.get_strv('enabled-extensions')]))"))
    assert state[:3] == [True, True, 5] and UUID in state[3], state
    distro = pathlib.Path('/etc/os-release').read_text()
    expected = 'dnf install' if '\nID=fedora\n' in '\n' + distro else 'apt-get install'
    assert expected in log.read_text(), 'Wrong distribution package-manager path'
    print('PASS: fresh release install copies files, compiles schema, enables both Auto settings, and selects the distribution package manager')

    settings("brightness.set_boolean('enabled', False)\nbrightness.set_boolean('keyboard-auto-enabled', False)\nbrightness.set_string('anchors', '[{\"lux\":40,\"brightness\":0.7}]')\nGio.Settings.sync()\n")
    (target / 'extension.js').write_text('// previous extension\n')
    upgraded = install()
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr
    state = json.loads(settings("print(json.dumps([brightness.get_boolean('enabled'), brightness.get_boolean('keyboard-auto-enabled'), brightness.get_string('anchors')]))"))
    assert state == [False, False, '[{"lux":40,"brightness":0.7}]'], state
    backups = list((root / 'state/adaptive-brightness').glob('*/extension/extension.js'))
    assert any(p.read_text() == '// previous extension\n' for p in backups), 'Previous extension was not backed up'
    assert (target / 'extension.js').read_bytes() == (source / UUID / 'extension.js').read_bytes()
    print('PASS: upgrade preserves manual settings and calibration and backs up the previous extension')

    # Releases up to 0.1.2 used another extension ID; upgrading must replace it.
    legacy_uuid = 'adaptive-brightness-v2@codex.local'
    legacy = root / 'data/gnome-shell/extensions' / legacy_uuid
    legacy.mkdir(parents=True)
    (legacy / 'extension.js').write_text('// legacy extension\n')
    settings(f"shell.set_strv('enabled-extensions', ['{legacy_uuid}', 'other@example.com'])\nGio.Settings.sync()\n")
    migrated = install()
    assert migrated.returncode == 0, migrated.stdout + migrated.stderr
    assert not legacy.exists(), 'Previous extension ID was left installed'
    enabled = json.loads(settings("print(json.dumps(shell.get_strv('enabled-extensions')))"))
    assert legacy_uuid not in enabled and UUID in enabled and 'other@example.com' in enabled, enabled
    state = json.loads(settings("print(json.dumps(brightness.get_string('anchors')))"))
    assert state == '[{"lux":40,"brightness":0.7}]', 'Settings were lost when the extension ID changed'
    backups = list((root / 'state/adaptive-brightness').glob('*/legacy-extension/extension.js'))
    assert any(p.read_text() == '// legacy extension\n' for p in backups), 'Previous extension ID was not backed up'
    print('PASS: upgrade from the previous extension ID removes it, keeps settings, and backs it up')
    print('NOTE: package installation, privileged resume-hook installation, and live GNOME Shell activation were mocked; no physical hardware was tested.')
