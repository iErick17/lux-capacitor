# Release validation

## Hardware reports

This release uses the same Auto Brightness version 7 code I installed on my Framework laptop. I renamed the project Lux Capacitor but kept the extension UUID and brightness behavior the same.

My laptop is a Framework Laptop 13 (AMD Ryzen AI 300 Series), currently running Ubuntu 26.04.1 with GNOME Shell 50. I haven't tested other Framework models. I also installed this on Fedora Workstation 44 and confirmed the following on 2026-10-11:

- Screen brightness responds to covering and uncovering the light sensor.
- Keyboard automatic and manual brightness controls work.
- Screen and keyboard behavior continue after suspend/resume.

I've installed this same version 7 code multiple times on this Framework laptop while switching between Ubuntu and Fedora. Those repeated installations and hardware checks, together with the automated installer checks below, are the basis for the stable v0.1.0 release. The installer requires and checks GNOME Shell 50; I haven't recorded the exact Shell version from that Fedora session.

## Automated checks

`bash tests/run.sh` compiles the schema in a temporary directory, validates JavaScript syntax, checks the brightness policy, and runs keyboard regressions against mocks. These cover preset remapping, duplicate firmware signals, manual takeover, sensor response, idle dimming, stale hardware reads, and numeric UI feedback.

The GitHub workflow runs the software checks in Ubuntu 26.04 and Fedora 44 containers. Container checks cannot verify real light sensors, physical hotkeys, or suspend/resume. Both container jobs passed in [this GitHub Actions run](https://github.com/iErick17/lux-capacitor/actions/runs/38150099547).

`tests/test-install.py` also checks GNOME-version rejection, fresh installation defaults, and upgrade preservation of settings and backups in an isolated environment. It uses real schemas and settings storage, with package installation, system changes, and live Shell activation mocked. These installer checks passed on both container distributions. I also ran them against the downloaded v0.1.0 installer and verified its published checksums on Ubuntu.

The Quick Settings screenshots in the README show both Auto switches enabled on my Ubuntu installation. They document the interface, not a clean-install or suspend test.

## Clean-install checklist

This is the checklist I use for a clean-install hardware test on each supported distribution:

1. Record `cat /etc/os-release`, `gnome-shell --version`, and the laptop model.
2. Verify the installer with `bash Install-Auto-Brightness.run --check`.
3. Install as the desktop user, log out and back in, and confirm the extension is enabled.
4. Cover/uncover the sensor in several lighting conditions. Check smooth screen updates and numeric feedback.
5. Toggle screen Auto, adjust the slider, and confirm stored preferences survive login.
6. Toggle keyboard Auto. Test hotkeys and the manual 0/20/50/75/100 presets.
7. Let the desktop idle-dim, then resume activity. Confirm keyboard Auto stays enabled.
8. Suspend/resume, including one long suspend. Repeat steps 4–6.
9. Disable and enable the extension. Check that native GNOME controls work while disabled.
10. Inspect `journalctl --user -b` for extension errors and `systemctl status iio-sensor-proxy` for sensor errors.

