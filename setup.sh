#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
if (( EUID == 0 )); then
    echo 'Run ./install.sh as your normal desktop user; it requests sudo for the system hook.' >&2
    exit 1
fi
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
uuid=lux-capacitor@extensions
# Earlier releases used these extension IDs (up to 0.1.2, then 0.1.3 to
# 0.2.1). Upgrades remove them so two brightness controllers never run at
# once; settings carry over because the settings schema is unchanged.
legacy_uuids=(adaptive-brightness-v2@codex.local lux-capacitor@ierick17.github.io)
shell_version=$(gnome-shell --version)
if [[ ! "$shell_version" =~ GNOME\ Shell\ 5[01]([.]|$) ]]; then
    echo "This extension requires GNOME Shell 50 or 51; found: $shell_version" >&2
    exit 1
fi
glib-compile-schemas --strict "$base/$uuid/schemas"
# Fail before replacing files if there is no usable desktop settings session.
python3 - <<'PY'
from gi.repository import Gio
Gio.bus_get_sync(Gio.BusType.SESSION, None)
for name in ['org.gnome.shell', 'org.gnome.settings-daemon.plugins.media-keys']:
    Gio.Settings.new(name)
PY
# Install the privileged component first; do not leave a partial extension install
# when the administrator authentication is cancelled.
sudo bash "$base/install-resume-hook.sh"
target="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
save_root="${XDG_STATE_HOME:-$HOME/.local/state}/adaptive-brightness"
mkdir -p "$save_root" "$(dirname "$target")"
save=$(mktemp -d "$save_root/$(date +%Y%m%d-%H%M%S)-XXXXXX")
dconf dump /org/gnome/shell/extensions/adaptive-brightness/ > "$save/settings.ini"
python3 - "$save/desktop-settings.json" <<'PY'
from gi.repository import Gio
import json, sys
keys = {'org.gnome.shell': ['enabled-extensions', 'disabled-extensions', 'disable-user-extensions'],
        'org.gnome.settings-daemon.plugins.media-keys': ['volume-step'],
        'org.gnome.settings-daemon.plugins.power': ['ambient-enabled']}
snapshot = {schema: {key: Gio.Settings.new(schema).get_value(key).unpack()
                    for key in names} for schema, names in keys.items()}
with open(sys.argv[1], 'w') as f:
    json.dump(snapshot, f, indent=2)
PY
if [[ -d "$target" ]]; then
    cp -a "$target" "$save/extension"
    gnome-extensions disable "$uuid" || true
fi
for legacy_uuid in "${legacy_uuids[@]}"; do
    legacy="$(dirname "$target")/$legacy_uuid"
    if [[ -d "$legacy" ]]; then
        cp -a "$legacy" "$save/legacy-extension-$legacy_uuid"
        gnome-extensions disable "$legacy_uuid" || true
        rm -rf -- "$legacy"
    fi
done
mkdir -p "$target"
cp -a "$base/$uuid/." "$target/"
glib-compile-schemas "$target/schemas"
python3 - "$base/default-settings.json" "$target/schemas" "${legacy_uuids[@]}" <<'PY'
from gi.repository import Gio
import json, sys
with open(sys.argv[1]) as f:
    saved = json.load(f)
source = Gio.SettingsSchemaSource.new_from_directory(sys.argv[2], Gio.SettingsSchemaSource.get_default(), False)
brightness = Gio.Settings.new_full(source.lookup('org.gnome.shell.extensions.adaptive-brightness', False), None, None)
for key, value in saved['brightness'].items():
    if brightness.get_user_value(key) is None:
        if isinstance(value, bool):
            brightness.set_boolean(key, value)
        elif isinstance(value, int):
            brightness.set_int(key, value)
        else:
            brightness.set_string(key, value)
Gio.Settings.new('org.gnome.settings-daemon.plugins.media-keys').set_int('volume-step', saved['volume-step'])
settings = Gio.Settings.new('org.gnome.shell')
settings.set_boolean('disable-user-extensions', False)
uuid = 'lux-capacitor@extensions'
legacy = sys.argv[3:]
enabled = [x for x in settings.get_strv('enabled-extensions') if x not in legacy]
if uuid not in enabled:
    enabled.append(uuid)
settings.set_strv('enabled-extensions', enabled)
settings.set_strv('disabled-extensions', [x for x in settings.get_strv('disabled-extensions')
                                          if x != uuid and x not in legacy])
Gio.Settings.sync()
PY
gnome-extensions enable "$uuid" || true
printf '\nInstalled extension and automatic sensor recovery after resume.\nExisting brightness preferences were preserved.\nLog out and back in to load the extension files.\nBackup: %s\n' "$save"
