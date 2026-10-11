#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
trap 'result=$?; if (( result != 0 )); then printf "\nInstallation stopped. Read the message above for the reason.\n"; fi; if [[ -t 0 ]]; then read -r -p "Press Enter to close... " || true; fi' EXIT
if (( EUID == 0 )); then
    echo 'Open this installer as your normal desktop user, without sudo.' >&2
    exit 1
fi
source /etc/os-release
echo 'AUTO BRIGHTNESS — guided installation'
echo 'Screen and keyboard Auto, manual presets, percentage displays, and wake-up recovery.'
version=$(gnome-shell --version 2>/dev/null || true)
if [[ ! "$version" =~ GNOME\ Shell\ 50([.]|$) ]]; then
    echo "This bundle needs GNOME Shell 50. Found: ${version:-no GNOME Shell}. No changes made."
    exit 1
fi
case "${ID:-}" in
    fedora) ;;
    ubuntu) ;;
    *) echo 'This installer supports Ubuntu and Fedora with GNOME 50.'; exit 1 ;;
esac
command -v sudo >/dev/null || { echo 'Install sudo before running this installer.' >&2; exit 1; }
echo 'It will install required packages, the extension, and a system wake-up hook.'
echo 'Your password may be requested; nothing appears while you type it.'
read -r -p 'Continue? [y/N] ' answer
[[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || exit 0
case "$ID" in
    fedora) sudo dnf install -y iio-sensor-proxy python3 python3-gobject dconf glib2 gnome-settings-daemon upower ;;
    ubuntu) sudo apt-get update; sudo apt-get install -y iio-sensor-proxy python3 python3-gi dconf-cli libglib2.0-bin gnome-settings-daemon upower ;;
esac
bash "$base/setup.sh"
echo 'Finished! Log out and back in. Then test in bright and dim light, and after sleep.'
echo 'Both Auto controls start on for a new installation. Existing brightness preferences are preserved.'
