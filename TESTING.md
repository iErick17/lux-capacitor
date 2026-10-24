# Release validation

## Hardware reports

The v0.1.0 release used the Auto Brightness version 7 code I installed on my Framework laptop. Version 0.1.1 adds volume OSD feedback when moving the Quick Settings slider; Version 0.1.2 removes the 100 ms OSD level animation for brightness and volume, so their bars follow rapid slider reversals immediately. Screen and keyboard brightness control behavior is unchanged.

Version 0.1.3 changes screen Auto only. Learned preferences can no longer make the screen dimmer in brighter light, a newer preference replaces a nearby contradicting one, and contradictions stored by earlier versions are cleaned up on load. Light changes under about 15% no longer re-target the screen, and a slider drag saves its preference once, 500 ms after the drag settles (or immediately when the screen locks). Keyboard behavior is unchanged. I haven't recorded hardware checks for 0.1.3 yet.

Version 0.2.0 adds a settings window. Screen options are transition speed, light sensitivity, minimum and maximum Auto brightness, slight dimming on battery, a learned-curve graph, and a reset for learned brightness. Keyboard options are an idle timeout (it only turns off light that Auto turned on) and the dark threshold, with a reset. Every default matches 0.1.3 behavior. Manual keyboard control is unchanged.

Version 0.2.1 fixes keyboard problems I found while testing 0.2.0. Every Fn+Space press advances exactly one of the 0/20/50/75/100 steps and turns keyboard Auto off, even during an Auto fade. Keyboard Auto fades finish instead of lingering at a few percent. The keyboard level is checked every 50 ms instead of 200 ms, which shortens the brief flash of the firmware's own level between steps.

On 2026-10-21 I tested 0.2.0 and 0.2.1 on my Framework Laptop 13 with Fedora Workstation 44 and GNOME Shell 50.6, recording the keyboard level, the extension's writes, and key events while I used it:

- Fn+Space never reaches the OS as a key event. The firmware handles it and cycles 0 → 20 → 75 → 100 → 0 by itself, and the extension then sets its step.
- With 0.2.1, six full Fn+Space cycles, including presses about 0.3 s apart, each gave exactly one step in order. The 50 ms check was added after this recording.
- Keyboard Auto lit the keyboard when I covered the light sensor and faded it out when I uncovered it.

Version 0.2.3 adds GNOME Shell 51 (Fedora 45). GNOME 51 refused to load 0.2.2 only because its metadata listed GNOME 50; no code changes were needed. I checked GNOME 51's own code for every internal the extension relies on (the brightness manager, the Quick Settings brightness, keyboard and volume items, the on-screen display, the idle monitor, and the settings window base class) and the system services it uses (iio-sensor-proxy, UPower and settings-daemon keyboard brightness). All are unchanged. GNOME 51 newly remembers manual brightness per monitor across logins, which does not conflict, because the extension sets the brightness itself once it starts. The automated checks also run in a Fedora 45 container, and I ran them locally on Fedora 45 with GJS 1.90 and libadwaita 1.10.

Version 0.2.4 simplifies the code without changing behavior: repeated code now shares helpers, and the screen and keyboard curves share one calculation. The keyboard hotkey and fade logic is unchanged. Before release, the old and new code gave the same screen brightness, keyboard levels, settings window behavior, and restored GNOME functions. On 2026-10-23 I tested 0.2.4 on my Framework Laptop 13 with Fedora Workstation 45 and GNOME Shell 51.0, and everything worked as before: screen Auto following the light sensor, learning from the screen slider, 5% brightness key steps with numeric popups, the numeric volume popup, Fn+Space stepping through 0, 20, 50, 75 and 100 and turning keyboard Auto off, keyboard Auto fades, both Quick Settings Auto switches and the keyboard slider, lock and unlock, suspend and resume, and the settings window graph, options and reset buttons.

Version 0.2.5 fixes the Keyboard tile, which turned keyboard Auto off without lighting the keyboard. On 2026-10-23 I recorded the keyboard level every 20 ms together with the settings daemon, UPower and setting changes on my Framework Laptop 13 (Fedora Workstation 45, GNOME Shell 51.0, BIOS 04.02), and tested the firmware directly with the extension disabled:

- When Fn+Space turns the light off from exactly 100%, the firmware locks it off. Until the next Fn+Space press it puts the light back off within about 25–200 ms after every write, whether through the settings daemon, UPower or logind, and with the Framework Control service stopped. The kernel driver only passes the level through, so this happens in the firmware.
- The same press from 99% turns the light off without locking, and a software write of 0 never locks. Lux Capacitor now writes 100% as 99%.
- The Keyboard tile wrote 100% directly, bypassing Lux Capacitor, and the extension kept showing the light as on when the firmware put it back off. The tile now goes through Lux Capacitor like Fn+Space and the slider, turns the light back on at the last level chosen, and the display follows the real level if the firmware overrides a write.

With 0.2.5 installed, the tile turned the light on after keyboard Auto, after Fn+Space had turned it off, and off and on repeatedly. The slider at 100% and at a middle level stayed lit, Fn+Space still gave one step per press, and the recording showed no overridden writes and no write of exactly 100%.

On 2026-10-23 I also tested the keyboard idle timeout with 0.2.5 (30 seconds, sensor covered so keyboard Auto lit the keyboard at about 55%). The light faded out 30 seconds after my last input, came back when I pressed Shift, and faded out again when I uncovered the sensor.

Dimming on battery doesn't work in 0.2.5 ([issue #6](https://github.com/iErick17/lux-capacitor/issues/6)). Screen Auto used the same brightness on battery as on AC, including right after restarting the extension on battery. The screen does look dimmer on battery, but that comes from AMD panel power savings, which Fedora's battery power profile turns on.

Not yet checked on hardware for 0.2.x: anything on Ubuntu.

My laptop is a Framework Laptop 13 (AMD Ryzen AI 300 Series), currently running Fedora Workstation 45 with GNOME Shell 51.0. I've also used it with Fedora Workstation 44 (GNOME Shell 50.6) and Ubuntu 26.04.1 (GNOME Shell 50). I haven't tested other Framework models. On Fedora Workstation 44 I confirmed the following on 2026-10-11:

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
6. Toggle keyboard Auto. Test hotkeys, including quick presses, and the manual 0/20/50/75/100 presets.
7. Let the desktop idle-dim, then resume activity. Confirm keyboard Auto stays enabled.
8. Suspend/resume, including one long suspend. Repeat steps 4–6.
9. Disable and enable the extension. Check that native GNOME controls work while disabled.
10. Open the settings window. Change each option and confirm the screen and keyboard respond; reset learned brightness and the keyboard settings. With an idle timeout set, stop typing in the dark and confirm the keyboard light fades out and returns on input, and that Fn+Space still advances exactly one preset.
11. Inspect `journalctl --user -b` for extension errors and `systemctl status iio-sensor-proxy` for sensor errors.

