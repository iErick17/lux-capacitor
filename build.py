# SPDX-License-Identifier: GPL-3.0-or-later
"""Build the one-file installer from the maintained recovery folder."""
from pathlib import Path
import gzip
import hashlib
import io
import json
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT
OUTPUT = ROOT / 'dist/Install-Auto-Brightness.run'
UUID = 'lux-capacitor@extensions'

HEADER = '''#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
    --help|-h)
        echo 'Auto Brightness: Ubuntu / Fedora with GNOME Shell 50 or 51.'
        echo 'Run: bash ./Install-Auto-Brightness.run (normal desktop user, no sudo).'
        echo 'Verify only: bash ./Install-Auto-Brightness.run --check'
        echo 'Includes screen/keyboard Auto, manual presets, percentage displays, and the resume hook.'
        exit 0 ;;
    ''|--check) ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
esac
if [[ "${1:-}" != --check ]] && (( EUID == 0 )); then
    echo 'Run as your normal desktop user, without sudo.' >&2
    exit 1
fi
for tool in tar gzip sha256sum awk tail mktemp; do
    command -v "$tool" >/dev/null || { echo "Required tool is missing: $tool" >&2; exit 1; }
done
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
line=$(awk '$0 == "__AUTO_BRIGHTNESS_PAYLOAD__" {print NR + 1; exit}' "$0")
[[ -n "$line" ]] || { echo 'Installer payload is missing.' >&2; exit 1; }
tail -n +"$line" "$0" > "$temporary/payload.tar.gz"
if ! (cd "$temporary" && printf '%s  payload.tar.gz\\n' '@DIGEST@' | sha256sum --check --status); then
    echo 'Installer is damaged. Obtain another copy before installing.' >&2
    exit 1
fi
tar --extract --gzip --file="$temporary/payload.tar.gz" --directory="$temporary" --no-same-owner
(cd "$temporary/Auto-Brightness" && sha256sum --check --status SHA256SUMS)
if [[ "${1:-}" == --check ]]; then
    echo 'PASS: installer payload and all bundled files verified. No installation performed.'
    exit 0
fi
bash "$temporary/Auto-Brightness/install.sh"
exit 0
__AUTO_BRIGHTNESS_PAYLOAD__
'''

def build():
    OUTPUT.parent.mkdir(exist_ok=True)
    files = [SOURCE / name for name in ['install.sh', 'setup.sh', 'install-resume-hook.sh',
        '90-restart-iio-sensor-proxy', 'default-settings.json', 'README.md', 'LICENSE']]
    files += sorted(p for p in (SOURCE / UUID).rglob('*') if p.is_file())
    hashes = {str(p.relative_to(SOURCE)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    manifest = SOURCE / 'SHA256SUMS'
    manifest.write_text(''.join(f'{digest}  {name}\n' for name, digest in sorted(hashes.items())))
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for path in sorted(files + [manifest]):
            name = path.relative_to(SOURCE)
            data = path.read_bytes()
            entry = tarfile.TarInfo(f'Auto-Brightness/{name}')
            entry.size = len(data)
            entry.mode = 0o755 if path.suffix == '.sh' or path.name.startswith('90-') else 0o644
            archive.addfile(entry, io.BytesIO(data))
    payload = gzip.compress(buffer.getvalue(), mtime=0)
    header = HEADER.replace('@DIGEST@', hashlib.sha256(payload).hexdigest()).encode()
    OUTPUT.write_bytes(header + payload)
    OUTPUT.chmod(0o755)
    (ROOT / 'dist/auto-brightness-installer.json').write_text(json.dumps({
        'installer': str(OUTPUT), 'sha256': hashlib.sha256(OUTPUT.read_bytes()).hexdigest(),
        'bundled_files': hashes, 'platforms': ['Ubuntu 26.04 / GNOME 50', 'Fedora 44 / GNOME 50', 'Fedora 45 / GNOME 51'],
        'verified_on_real_ubuntu': False,
    }, indent=2) + '\n')
    extension_zip = OUTPUT.parent / f'{UUID}.shell-extension.zip'
    with zipfile.ZipFile(extension_zip, 'w', zipfile.ZIP_DEFLATED, strict_timestamps=False) as archive:
        for path in sorted((SOURCE / UUID).rglob('*')):
            if path.is_file() and path.name != 'gschemas.compiled':
                archive.write(path, path.relative_to(SOURCE / UUID))
        archive.write(SOURCE / 'LICENSE', 'LICENSE')
    artifacts = [OUTPUT, extension_zip]
    (OUTPUT.parent / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in artifacts))
    print(f'Built {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)')

if __name__ == '__main__':
    build()
