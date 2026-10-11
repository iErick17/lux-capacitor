# Release validation

## Hardware reports

The source for this release matches the Auto Brightness version 7 installed on the maintainer's Framework laptop. The packaging uses the name Lux Capacitor while retaining the extension UUID and runtime behavior.

The current development system is a Framework Laptop 13 (AMD Ryzen AI 300 Series) running Ubuntu 26.04.1 with GNOME Shell 50. Other Framework models have not been individually validated. Fedora Workstation 44 installation and the following behaviors were confirmed by the maintainer on 2026-10-11:

- Screen brightness responds to covering and uncovering the light sensor.
- Keyboard automatic and manual brightness controls work.
- Screen and keyboard behavior continue after suspend/resume.

Fedora reports refer to the existing version 7 installation, not an independently observed installation of the new release archive. A clean install of the release archive on both distributions remains a release checklist item. GNOME Shell 50 is required and checked by the installer; the exact Fedora Shell version was not independently queried.

## Automated checks

`bash tests/run.sh` compiles the schema in a temporary directory, validates JavaScript syntax, checks the brightness policy, and runs keyboard regressions against mocks. These cover preset remapping, duplicate firmware signals, manual takeover, sensor response, idle dimming, stale hardware reads, and numeric UI feedback.

The GitHub workflow runs the software checks in Ubuntu 26.04 and Fedora 44 containers. Container checks cannot verify real light sensors, physical hotkeys, or suspend/resume. A workflow definition is not evidence that the jobs have passed; consult the actual GitHub Actions results.

## Clean-install checklist

Run this on each supported distribution before calling a new release independently hardware-validated:

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

