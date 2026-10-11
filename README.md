# Lux Capacitor

Automatic screen and keyboard brightness for GNOME 50. Great lux, no flux.

Lux Capacitor adjusts brightness to ambient light, adds separate screen and keyboard Auto controls to Quick Settings, and restores sensor readings after suspend on supported Framework laptops. This is a GNOME Shell extension with an optional system resume hook, not a standalone application for every Linux desktop.

**GNOME's built-in Automatic Brightness must stay off while Lux Capacitor is enabled.** The extension turns it off automatically and keeps it off to prevent two controllers from competing. Use the extension's screen Auto switch instead. Disabling the extension restores the previous native setting; if it was already off, it stays off. Turning only the extension's screen Auto switch off does not hand control back to native automatic brightness.

## Compatibility

| System | Validation |
| --- | --- |
| Ubuntu 26.04.1, GNOME Shell 50, Framework laptop | Installed and used on the development machine; automated regression checks run locally. |
| Fedora Workstation 44 | Maintainer reports successful installation, screen and keyboard controls, and suspend/resume recovery. |
| Other GNOME versions or KDE, Xfce, Cinnamon | Not supported by this release. |
| Other laptops with GNOME 50 | Not hardware-tested. Screen control needs an ambient-light sensor supported by iio-sensor-proxy. Keyboard behavior targets Framework's `chromeos::kbd_backlight` interface. |

Fedora hardware validation is maintainer-reported, not an independent automated hardware test. See [TESTING.md](TESTING.md) for the release checklist and reproducible software checks.

## Features

- Smooth screen brightness changes and learned manual preferences at observed light levels.
- Separate screen and keyboard Auto controls.
- Manual keyboard presets: 0%, 20%, 50%, 75%, 100%.
- Numeric brightness and volume displays; volume keys use steps of 5.
- Desktop idle dimming preserves keyboard Auto.
- Resume recovery reinitializes the Framework `i2c-FRMW0005:*` sensor and restarts iio-sensor-proxy. On other hardware the hook only restarts the sensor service.

## Install

Download `Install-Auto-Brightness.run` from the GitHub release, then run it as your normal desktop user:

```sh
bash Install-Auto-Brightness.run --check
bash Install-Auto-Brightness.run
```

The installer checks GNOME Shell 50, installs dependencies using apt on Ubuntu or dnf on Fedora, and requests sudo for the system resume hook. Log out and back in afterward. Both Auto controls start enabled on a fresh installation. Existing brightness settings are preserved; the volume step is set to 5.

From a source checkout, run `bash install.sh` instead.

The extension ZIP can also be installed with `gnome-extensions install --force <file>.shell-extension.zip`, followed by logout/login and `gnome-extensions enable adaptive-brightness-v2@codex.local`. This installs the extension only: it does not install dependencies, set the volume step, or install the system resume hook.

The existing extension UUID is retained so installation updates the original Auto Brightness extension rather than loading two brightness controllers.

## Disable and remove

Disable using GNOME Extensions, or run:

```sh
gnome-extensions disable adaptive-brightness-v2@codex.local
```

The system resume hook remains installed. To remove it, if you installed it through this project:

```sh
sudo rm /usr/lib/systemd/system-sleep/90-restart-iio-sensor-proxy
```

Remove the extension through GNOME Extensions or `gnome-extensions uninstall adaptive-brightness-v2@codex.local`. Disable it first. Installation backups of the previous extension and settings are stored under `~/.local/state/adaptive-brightness/`. Disabling does not restore the volume step; its previous value is in the backup's `desktop-settings.json`.

## Development

Install GJS, Python 3, and GLib tools, then run:

```sh
bash tests/run.sh
python3 build.py
bash dist/Install-Auto-Brightness.run --check
```

Tests mock keyboard and Quick Settings objects; they do not write hardware brightness or install the extension. The build produces a standalone installer, an extension ZIP, and checksums in `dist/`.

## License

Copyright 2026 the Lux Capacitor contributors. Distributed under GPL-3.0-or-later. You may use, modify, and redistribute it under those terms. See [LICENSE](LICENSE).

