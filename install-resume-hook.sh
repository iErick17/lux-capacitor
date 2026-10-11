#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
if (( EUID != 0 )); then exec sudo -- "$0" "$@"; fi
systemctl cat iio-sensor-proxy.service >/dev/null
hook=/usr/lib/systemd/system-sleep/90-restart-iio-sensor-proxy
if [[ -e "$hook" ]]; then
    backup=$(mktemp "$hook.backup-$(date +%Y%m%d-%H%M%S)-XXXXXX")
    cp -p "$hook" "$backup"
    chmod -x "$backup"
fi
install -d -m 755 /usr/lib/systemd/system-sleep
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -m 755 "$base/90-restart-iio-sensor-proxy" "$hook"
if command -v restorecon >/dev/null; then restorecon "$hook"; fi
sh -n "$hook"
systemctl restart iio-sensor-proxy.service
systemctl is-active iio-sensor-proxy.service
echo 'Installed sensor recovery after resume and restarted the sensor now.'
