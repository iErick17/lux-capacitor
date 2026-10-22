# Release validation

## Hardware reports

The v0.1.0 release used the Auto Brightness version 7 code I installed on my Framework laptop. Version 0.1.1 adds volume OSD feedback when moving the Quick Settings slider; Version 0.1.2 removes the 100 ms OSD level animation for brightness and volume, so their bars follow rapid slider reversals immediately. Screen and keyboard brightness control behavior is unchanged.

Version 0.1.3 changes screen Auto only. Learned preferences can no longer make the screen dimmer in brighter light, a newer preference replaces a nearby contradicting one, and contradictions stored by earlier versions are cleaned up on load. Light changes under about 15% no longer re-target the screen, and a slider drag saves its preference once, 500 ms after the drag settles (or immediately when the screen locks). Keyboard behavior is unchanged. I haven't recorded hardware checks for 0.1.3 yet.

My laptop is a Framework Laptop 13 (AMD Ryzen AI 300 Series), currently running Ubuntu 26.04.1 with GNOME Shell 50. I haven't tested other Framework models. I also installed this on Fedora Workstation 44 and confirmed the following on 2026-10-11:

- Screen brightness responds to covering and uncovering the light sensor.
- Keyboard automatic and manual brightness controls work.
- Screen and keyboard behavior continue after suspend/resume.

I've installed this same version 7 code multiple times on this Framework laptop while switching between Ubuntu and Fedora. Those repeated installations and hardware checks, together with the automated installer checks below, are the basis for the stable v0.1.0 release. The installer requires and checks GNOME Shell 50; I haven't recorded the exact Shell version from that Fedora session.

## Automated checks

`bash tests/run.sh` compiles the schema in a temporary directory, validates JavaScript syntax, checks the brightness policy (including that learned preferences never dim the screen in brighter light and stay exact at their own light level), and runs keyboard and screen regressions against mocks. Screen regressions cover the sensor-noise dead zone, saving a slider drag once, resetting preferences when Auto is turned off, saving on lock, and cleaning up stored contradictions. These cover preset remapping, duplicate firmware signals, manual takeover, sensor response, idle dimming, stale hardware reads, and numeric UI feedback, and volume slider OSD feedback with backend synchronization and disable/re-enable cleanup. OSD regressions also cover rapid level reversals, multiple monitors, amplified volume, and preservation of unrelated OSD animations.

The GitHub workflow runs the software checks in Ubuntu 26.04 and Fedora 44 containers. Container checks cannot verify real light sensors, physical hotkeys, or suspend/resume. Both container jobs passed in [this GitHub Actions run](https://github.com/iErick17/lux-capacitor/actions/runs/38150099547).

`tests/test-install.py` also checks GNOME-version rejection, fresh installation defaults, and upgrade preservation of settings and backups in an isolated environment. It uses real schemas and settings storage, with package installation, system changes, and live Shell activation mocked. These installer checks passed on both container distributions. I also ran them against the downloaded v0.1.0 installer and verified its published checksums on Ubuntu.

The Quick Settings screenshots in the README show both Auto switches enabled on my Ubuntu installation. They document the interface, not a clean-install or suspend test.

## Clean-install checklist

This is the checklist I use for a clean-install hardware test on each supported distribution:

1. Record `cat /etc/os-release`, `gnome-shell --version`, and the laptop model.
2. Verify the installer with `bash Install-Auto-Brightness.run --check`.
3. Install as the desktop user, log out and back in, and confirm the extension is enabled.
4. Cover/uncover the sensor in several lighting conditions. Check smooth screen updates and numeric feedback.
5. Adjust the screen slider in dim light, then move to brighter light and confirm the screen never gets dimmer. Confirm stored preferences survive login, and that toggling screen Auto off resets them.
6. Toggle keyboard Auto. Test hotkeys and the manual 0/20/50/75/100 presets.
7. Let the desktop idle-dim, then resume activity. Confirm keyboard Auto stays enabled.
8. Suspend/resume, including one long suspend. Repeat steps 4–6.
9. Disable and enable the extension. Check that native GNOME controls work while disabled.
10. Inspect `journalctl --user -b` for extension errors and `systemctl status iio-sensor-proxy` for sensor errors.

