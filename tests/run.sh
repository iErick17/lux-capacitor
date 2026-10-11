#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"; rm -f tests/extension-fixture.mjs' EXIT
for script in install.sh setup.sh install-resume-hook.sh; do bash -n "$script"; done
sh -n 90-restart-iio-sensor-proxy
cp adaptive-brightness-v2@codex.local/schemas/*.xml "$temporary/"
glib-compile-schemas --strict "$temporary"
python3 - <<'PY'
from pathlib import Path
import json
root = Path('adaptive-brightness-v2@codex.local')
metadata = json.loads((root / 'metadata.json').read_text())
assert metadata['uuid'] == root.name
assert metadata['shell-version'] == ['50']
source = (root / 'extension.js').read_text()
for original, replacement in {
    "import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';": 'class Extension {}',
    "import * as Main from 'resource:///org/gnome/shell/ui/main.js';": 'export const Main = {};',
    "import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';": 'const PopupMenu = {};',
    "'./brightnessModel.js'": "'../adaptive-brightness-v2@codex.local/brightnessModel.js'",
    "'./keyboardController.js'": "'../adaptive-brightness-v2@codex.local/keyboardController.js'",
}.items():
    assert original in source, original
    source = source.replace(original, replacement)
Path('tests/extension-fixture.mjs').write_text(source)
PY
gjs -m tests/test-model.mjs
gjs -m tests/test-keyboard.mjs

