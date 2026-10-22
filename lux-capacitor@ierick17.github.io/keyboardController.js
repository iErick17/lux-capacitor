// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {advanceBrightness} from './brightnessModel.js';

const BUS_NAME = 'org.gnome.SettingsDaemon.Power';
const OBJECT_PATH = '/org/gnome/SettingsDaemon/Power';
const INTERFACE = 'org.gnome.SettingsDaemon.Power.Keyboard';
const BACKLIGHT_PATH = '/sys/class/leds/chromeos::kbd_backlight/brightness';

const KEYBOARD_XML = `
<node>
  <interface name="org.gnome.SettingsDaemon.Power.Keyboard">
    <property name="Brightness" type="i" access="readwrite"/>
    <property name="Steps" type="i" access="read"/>
    <signal name="BrightnessChanged">
      <arg name="brightness" type="i"/>
      <arg name="source" type="s"/>
    </signal>
  </interface>
</node>`;
const KeyboardProxy = Gio.DBusProxy.makeProxyWrapper(KEYBOARD_XML);

const POLL_MS = 200;
const RAMP_MS = 100;
const WRITE_ECHO_US = 2_000_000;
const HOTKEY_SETTLE_US = 650_000;
const RESUME_GUARD_US = 12_000_000;
const WAKE_HOLD_MS = 2_000;
// The default dark threshold. The off threshold and the whole curve scale
// with the user's threshold, so the default reproduces the original policy.
export const DEFAULT_DARK_LUX = 10;
const OFF_RATIO = 2.5;
const AUTO_CURVE = [
    [0, 55],
    [2, 48],
    [10, 30],
    [18, 18],
    [25, 8],
    [30, 0],
];

export const MANUAL_LEVELS = Object.freeze([0, 20, 50, 75, 100]);

function clampLevel(level) {
    return Math.max(0, Math.min(100, Math.round(level)));
}

function validLevel(level) {
    if (!Number.isFinite(level) || level < 0 || level > 100)
        throw new RangeError('keyboard brightness must be between 0 and 100');
    return clampLevel(level);
}

function nextLevel(current) {
    return MANUAL_LEVELS.find(level => level > current) ?? MANUAL_LEVELS[0];
}

function previousLevel(current) {
    return [...MANUAL_LEVELS].reverse().find(level => level < current) ??
        MANUAL_LEVELS[0];
}

/**
 * Keyboard illumination decreases with ambient light. Use a log-lux scale so
 * small changes in a dim room matter more than similar changes in daylight.
 */
export function keyboardTarget(lux) {
    if (!Number.isFinite(lux) || lux < 0)
        throw new RangeError('lux must be a finite nonnegative number');

    for (let i = 1; i < AUTO_CURVE.length; i++) {
        const [rightLux, rightLevel] = AUTO_CURVE[i];
        if (lux <= rightLux) {
            const [leftLux, leftLevel] = AUTO_CURVE[i - 1];
            const x = Math.log1p(lux);
            const leftX = Math.log1p(leftLux);
            const rightX = Math.log1p(rightLux);
            return leftLevel + (rightLevel - leftLevel) *
                (x - leftX) / (rightX - leftX);
        }
    }
    return 0;
}

/** Keep the light off until it is quite dark, with a gap to prevent flicker. */
export function automaticKeyboardTarget(lux, wasLit = false, darkLux = DEFAULT_DARK_LUX) {
    if (!Number.isFinite(lux) || lux < 0)
        throw new RangeError('lux must be a finite nonnegative number');
    const scaled = lux * DEFAULT_DARK_LUX / darkLux;
    const lit = wasLit ? lux < darkLux * OFF_RATIO : lux <= darkLux;
    return {lit, target: lit ? keyboardTarget(scaled) : 0};
}

/** GNOME 50 keyboard-backlight control, including firmware hotkey fallback. */
export class KeyboardController {
    static MANUAL_LEVELS = MANUAL_LEVELS;

    constructor({settings, onChanged = () => {}, onManualChanged = () => {},
        isDimming = () => false, idleMonitor = null}) {
        this._settings = settings;
        this._idleMonitor = idleMonitor;
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._idle = false;
        this._onChanged = onChanged;
        this._onManualChanged = onManualChanged;
        this._isDimming = isDimming;
        this._wasDimming = false;
        this._pendingManualOSD = null;
        this._enabled = false;
        this._autoEnabled = settings.get_boolean('keyboard-auto-enabled');
        this._available = false;
        this._currentLevel = null;
        this._lastActual = null;
        this._lux = null;
        this._target = null;
        this._autoLit = false;
        this._smoothLevel = null;
        this._lastRampTick = 0;
        this._lastRequested = null;
        this._ownWrites = [];
        this._writeInFlight = null;
        this._writeSerial = 0;
        this._desiredWrite = null;
        this._settleUntil = 0;
        this._lastFirmwareEvent = null;
        this._busChangeUntil = 0;
        this._resumeGuardUntil = 0;
        this._wakeHoldId = 0;
        this._waitingForWakeLux = false;
        this._generation = 0;
        this._notificationSerial = 0;
        this._file = Gio.File.new_for_path(BACKLIGHT_PATH);
    }

    get autoEnabled() {
        return this._autoEnabled;
    }

    get available() {
        return this._available;
    }

    get currentLevel() {
        return this._currentLevel;
    }

    enable(afterLock = false) {
        if (this._enabled)
            return;
        this._enabled = true;
        this._generation++;
        this._autoEnabled = this._settings.get_boolean('keyboard-auto-enabled');
        this._lux = null;
        this._target = null;
        this._autoLit = false;
        this._currentLevel = null;
        this._lastActual = null;
        this._lastRequested = null;
        this._lastFirmwareEvent = null;
        this._busChangeUntil = 0;
        this._guardResume();
        this._pollPending = false;
        this._cancellable = new Gio.Cancellable();
        this._sleepSignalId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1', 'org.freedesktop.login1.Manager',
            'PrepareForSleep', '/org/freedesktop/login1', null,
            Gio.DBusSignalFlags.NONE, (_connection, _sender, _path,
                _interface, _signal, parameters) => {
                this._guardResume();
                if (parameters.deep_unpack()[0])
                    this._stopWakeHold();
                else
                    this._beginWakeHold();
            });
        this._settingsId = this._settings.connect('changed::keyboard-auto-enabled',
            () => this._onAutoSettingChanged());
        this._optionsIds = ['keyboard-idle-timeout', 'keyboard-dark-lux'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._onOptionsChanged()));
        this._watchIdle();
        if (afterLock)
            this._beginWakeHold();
        this._powerSignalId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.UPower', 'org.freedesktop.UPower.KbdBacklight',
            'BrightnessChangedWithSource', '/org/freedesktop/UPower/KbdBacklight',
            null, Gio.DBusSignalFlags.NONE, (_connection, _sender, _path,
                _interface, _signal, parameters) =>
                this._onPowerSignal(...parameters.deep_unpack()));
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._pollActual();
            return GLib.SOURCE_CONTINUE;
        });
        this._pollActual();
        this._connectProxy();
        this._changed();
    }

    disable() {
        if (!this._enabled)
            return;
        this._enabled = false;
        this._pendingManualOSD = null;
        this._generation++;
        this._stopRamp();
        this._stopWakeHold();
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._pollId = 0;
        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = 0;
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
        for (const id of this._optionsIds ?? [])
            this._settings.disconnect(id);
        this._optionsIds = [];
        this._unwatchIdle();
        if (this._sleepSignalId)
            Gio.DBus.system.signal_unsubscribe(this._sleepSignalId);
        this._sleepSignalId = 0;
        if (this._powerSignalId)
            Gio.DBus.system.signal_unsubscribe(this._powerSignalId);
        this._powerSignalId = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._disconnectProxy();
        this._available = false;
        this._pollPending = false;
        this._writeInFlight = null;
        this._writeSerial++;
        this._desiredWrite = null;
        this._ownWrites = [];
        this._lastFirmwareEvent = null;
        this._busChangeUntil = 0;
        this._resumeGuardUntil = 0;
    }

    _guardResume() {
        this._resumeGuardUntil = GLib.get_monotonic_time() + RESUME_GUARD_US;
        this._lastFirmwareEvent = null;
    }

    _beginWakeHold() {
        if (!this._enabled || !this._autoEnabled)
            return;
        this._stopWakeHold();
        this._stopRamp();
        this._lux = null;
        this._target = null;
        this._smoothLevel = 0;
        this._waitingForWakeLux = true;
        this._requestWrite(0);
        this._wakeHoldId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            WAKE_HOLD_MS, () => this._finishWakeHold());
    }

    _finishWakeHold() {
        this._wakeHoldId = 0;
        this._smoothLevel = 0;
        this._waitingForWakeLux = this._lux === null;
        if (this._autoEnabled && !this._waitingForWakeLux)
            this._retargetFromSensor();
        return GLib.SOURCE_REMOVE;
    }

    _stopWakeHold() {
        if (this._wakeHoldId)
            GLib.source_remove(this._wakeHoldId);
        this._wakeHoldId = 0;
        this._waitingForWakeLux = false;
    }

    _observeRestoredLevel(level) {
        this._currentLevel = level;
        this._lastActual = level;
        this._smoothLevel = level;
        this._changed();
        if ((this._wakeHoldId || this._waitingForWakeLux) && level !== 0) {
            this._smoothLevel = 0;
            this._requestWrite(0);
        } else if (this._autoEnabled) {
            this._startRamp();
        }
    }

    onSensorLevel(lux) {
        if (!Number.isFinite(lux) || lux < 0)
            return;
        this._lux = lux;
        if (!this._wakeHoldId)
            this._waitingForWakeLux = false;
        if (this._autoEnabled)
            this._retargetFromSensor();
    }

    _retargetFromSensor() {
        if (this._lux === null || this._wakeHoldId || this._waitingForWakeLux)
            return;
        const {lit, target} = automaticKeyboardTarget(this._lux, this._autoLit,
            this._settings.get_int('keyboard-dark-lux'));
        this._autoLit = lit;
        // While idle, Auto keeps its on/off state but fades the light out.
        this._target = this._idle ? 0 : target;
        this._startRamp();
    }

    _onOptionsChanged() {
        this._watchIdle();
        if (this._autoEnabled)
            this._retargetFromSensor();
    }

    // Only Auto's own light is turned off when idle; manual levels are
    // never touched, and the fade goes through the normal ramp so its
    // writes are recognized as our own rather than as Fn+Space.
    _watchIdle() {
        this._unwatchIdle();
        const seconds = this._settings.get_int('keyboard-idle-timeout');
        if (!this._enabled || !this._idleMonitor || seconds <= 0)
            return;
        this._idleWatchId = this._idleMonitor.add_idle_watch(seconds * 1000,
            () => this._onIdle());
    }

    _unwatchIdle() {
        if (this._idleWatchId)
            this._idleMonitor.remove_watch(this._idleWatchId);
        if (this._activeWatchId)
            this._idleMonitor.remove_watch(this._activeWatchId);
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        if (this._idle) {
            this._idle = false;
            if (this._enabled && this._autoEnabled)
                this._retargetFromSensor();
        }
    }

    _onIdle() {
        if (!this._enabled || this._idle)
            return;
        this._idle = true;
        if (!this._activeWatchId) {
            this._activeWatchId = this._idleMonitor.add_user_active_watch(
                () => this._onActive());
        }
        if (this._autoEnabled)
            this._retargetFromSensor();
    }

    _onActive() {
        // User-active watches fire once and are removed by Mutter.
        this._activeWatchId = 0;
        if (!this._idle)
            return;
        this._idle = false;
        if (this._enabled && this._autoEnabled)
            this._retargetFromSensor();
    }

    setAutoEnabled(enabled, reason = 'Auto switch') {
        const next = !!enabled;
        if (!next && this._autoEnabled) {
            console.info(`Lux Capacitor: keyboard Auto off (${reason}); ` +
                `observed=${this._lastActual}, requested=${this._lastRequested}`);
        }
        if (this._settings.get_boolean('keyboard-auto-enabled') !== next)
            this._settings.set_boolean('keyboard-auto-enabled', next);
        this._onAutoSettingChanged();
    }

    setManualLevel(level, showOSD = false, reason = 'manual slider') {
        const next = validLevel(level);
        this.setAutoEnabled(false, reason);
        this._pendingManualOSD = showOSD ? next : null;
        this._smoothLevel = next;
        this._settleUntil = GLib.get_monotonic_time() + HOTKEY_SETTLE_US;
        this._requestWrite(next);
    }

    _onAutoSettingChanged() {
        const enabled = this._settings.get_boolean('keyboard-auto-enabled');
        if (enabled === this._autoEnabled)
            return;
        this._autoEnabled = enabled;
        if (enabled) {
            this._pendingManualOSD = null;
            this._smoothLevel = this._lastActual ?? this._currentLevel;
            this._autoLit = false;
            this._retargetFromSensor();
        } else {
            this._stopWakeHold();
            this._stopRamp();
            this._desiredWrite = null;
            this._target = null;
            this._autoLit = false;
            this._lux = null;
        }
        this._changed();
    }

    _connectProxy() {
        if (!this._enabled)
            return;
        const generation = this._generation;
        new KeyboardProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
            (proxy, error) => {
                if (!this._enabled || generation !== this._generation)
                    return;
                if (error) {
                    console.error(`Lux Capacitor: keyboard service unavailable: ${error}`);
                    this._scheduleRetry();
                    return;
                }
                this._proxy = proxy;
                this._signalId = proxy.connect('g-signal',
                    (_proxy, _sender, signal, parameters) =>
                        this._onProxySignal(signal, parameters));
                this._propertiesId = proxy.connect('g-properties-changed',
                    () => {
                        this._notificationSerial++;
                        if (!this._hasOwnWrite(proxy.Brightness))
                            this._busChangeUntil = GLib.get_monotonic_time() +
                                300_000;
                    });
                this._ownerId = proxy.connect('notify::g-name-owner',
                    () => this._onProxyOwnerChanged());
                this._onProxyOwnerChanged();
            }, this._cancellable);
    }

    _disconnectProxy() {
        if (this._proxy) {
            if (this._signalId)
                this._proxy.disconnect(this._signalId);
            if (this._ownerId)
                this._proxy.disconnect(this._ownerId);
            if (this._propertiesId)
                this._proxy.disconnect(this._propertiesId);
        }
        this._signalId = 0;
        this._ownerId = 0;
        this._propertiesId = 0;
        this._proxy = null;
    }

    _onProxyOwnerChanged() {
        if (!this._enabled || !this._proxy)
            return;
        this._notificationSerial++;
        const level = this._proxy.Brightness;
        const available = !!this._proxy.get_name_owner() &&
            Number.isInteger(level) && level >= 0 && level <= 100;
        this._available = available;
        if (available) {
            const actual = this._lastActual;
            this._currentLevel = actual ?? level;
            if (this._smoothLevel === null)
                this._smoothLevel = actual ?? level;
            if (this._wakeHoldId || this._waitingForWakeLux)
                this._desiredWrite = 0;
            if (actual !== null && actual !== level && !this._autoEnabled &&
                this._desiredWrite === null)
                this._requestWrite(actual);
            if (this._autoEnabled)
                this._startRamp();
            this._flushWrite();
        } else {
            this._stopRamp();
            this._writeInFlight = null;
            this._writeSerial++;
            if (this._autoEnabled)
                this._desiredWrite = this._wakeHoldId ||
                    this._waitingForWakeLux ? 0 : null;
            this._ownWrites = [];
            this._lastRequested = null;
        }
        this._changed();
    }

    _scheduleRetry() {
        if (!this._enabled || this._retryId)
            return;
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10,
            () => {
                this._retryId = 0;
                this._connectProxy();
                return GLib.SOURCE_REMOVE;
            });
    }

    _onProxySignal(signal, parameters) {
        if (!this._enabled || signal !== 'BrightnessChanged')
            return;
        const [rawLevel, source] = parameters.deep_unpack();
        if (!Number.isInteger(rawLevel) || rawLevel < 0 || rawLevel > 100)
            return;
        this._notificationSerial++;

        if (source === 'set property' && this._consumeOwnWrite(rawLevel)) {
            this._currentLevel = rawLevel;
            this._lastActual = rawLevel;
            this._changed();
            this._showConfirmedManualLevel(rawLevel);
            return;
        }
        // The EC and power daemon can restore a level after wake without a key press.
        if (GLib.get_monotonic_time() < this._resumeGuardUntil) {
            this._observeRestoredLevel(rawLevel);
            return;
        }

        const before = this._lastActual ?? this._currentLevel ?? rawLevel;
        if (source === 'set property') {
            // The native Keyboard slider and on/off button both use the
            // Brightness property. Let either one take manual control.
            this._acceptManual(rawLevel);
            if (this._writeInFlight !== null)
                this._desiredWrite = rawLevel;
            return;
        }

        if (source === 'Toggle' || source === 'StepUp' ||
            source === 'StepDown' || source === 'internal') {
            // A firmware transition can be visible in sysfs before GNOME
            // forwards the corresponding event. Count it only once.
            const firmware = this._lastFirmwareEvent;
            const age = firmware
                ? GLib.get_monotonic_time() - firmware.at : Infinity;
            if ((source === 'internal' && firmware?.level === rawLevel &&
                age < HOTKEY_SETTLE_US) ||
                (source === 'Toggle' && age < 300_000)) {
                this._lastFirmwareEvent = null;
                return;
            }
            let next;
            if (source === 'StepDown')
                next = previousLevel(before);
            else if (source === 'StepUp')
                next = before >= 100 ? 100 : nextLevel(before);
            else
                next = nextLevel(before);
            this.setManualLevel(next, source === 'internal', `keyboard signal ${source}: ${rawLevel}`);
            return;
        }

        // Startup, resume, and other daemon updates are state notifications.
        this._currentLevel = rawLevel;
        this._lastActual = rawLevel;
        this._changed();
    }

    _acceptManual(level) {
        this._pendingManualOSD = null;
        this.setAutoEnabled(false, `GNOME brightness property: ${level}`);
        this._settleUntil = GLib.get_monotonic_time() + HOTKEY_SETTLE_US;
        this._smoothLevel = level;
        this._lastRequested = level;
        this._currentLevel = level;
        this._lastActual = level;
        this._changed();
    }

    _onPowerSignal(level, source) {
        if (!this._enabled || source !== 'external' ||
            !Number.isInteger(level) || level < 0 || level > 100)
            return;
        this._notificationSerial++;
        if (this._hasOwnWrite(level))
            return;
        // GNOME dims/restores through UPower without a keyboard-proxy signal.
        // Record these software writes before polling mistakes them for Fn+Space.
        this._currentLevel = level;
        this._lastActual = level;
        this._smoothLevel = level;
        this._lastRequested = level;
        this._wasDimming = this._isDimming();
        if (this._wasDimming && this._autoEnabled) {
            this._stopRamp();
            this._desiredWrite = null;
        } else if (this._autoEnabled) {
            this._startRamp();
        }
        this._changed();
    }

    _pollActual() {
        if (!this._enabled || this._pollPending)
            return;
        this._pollPending = true;
        const generation = this._generation;
        const notificationSerial = this._notificationSerial;
        this._file.load_contents_async(this._cancellable, (file, result) => {
            if (!this._enabled || generation !== this._generation)
                return;
            this._pollPending = false;
            let level;
            try {
                const [ok, bytes] = file.load_contents_finish(result);
                if (!ok)
                    return;
                const raw = new TextDecoder().decode(bytes).trim();
                if (!/^(?:100|[1-9]?\d)$/.test(raw))
                    return;
                level = Number(raw);
            } catch (error) {
                if (!this._cancellable?.is_cancelled())
                    console.error(`Lux Capacitor: keyboard read failed: ${error}`);
                return;
            }
            // A read started before a notification may contain the old level.
            // Let the next poll sample fresh state instead of inventing a hotkey.
            if (notificationSerial === this._notificationSerial)
                this._onActualLevel(level);
        });
    }

    _onActualLevel(level) {
        const dimming = this._isDimming();
        if (dimming && this._autoEnabled) {
            this._stopRamp();
            this._desiredWrite = null;
        } else if (this._wasDimming && this._autoEnabled) {
            this._startRamp();
        }
        this._wasDimming = dimming;
        this._showConfirmedManualLevel(level);
        const previous = this._lastActual;
        this._lastActual = level;
        if (previous === null) {
            const manualWritePending = this._writeInFlight !== null ||
                this._desiredWrite !== null;
            if (!manualWritePending)
                this._smoothLevel = level;
            if (this._available && this._currentLevel !== level) {
                this._currentLevel = level;
                if (!this._autoEnabled && !manualWritePending)
                    this._requestWrite(level);
                this._changed();
            }
            if (this._autoEnabled)
                this._startRamp();
            if ((this._wakeHoldId || this._waitingForWakeLux) && level !== 0) {
                this._smoothLevel = 0;
                this._requestWrite(0);
            }
            return;
        }
        if (level === previous)
            return;
        if (GLib.get_monotonic_time() < this._resumeGuardUntil) {
            this._observeRestoredLevel(level);
            return;
        }

        if (level === this._currentLevel || this._hasOwnWrite(level) ||
            GLib.get_monotonic_time() < this._settleUntil ||
            GLib.get_monotonic_time() < this._busChangeUntil) {
            if (level === this._currentLevel)
                this._changed();
            return;
        }

        // The Framework EC can change the keyboard LED without emitting a
        // D-Bus signal. Polling its LED class value catches Fn+Space changes.
        if (this._available) {
            this._lastFirmwareEvent = {
                at: GLib.get_monotonic_time(),
                level,
            };
            const next = nextLevel(this._currentLevel ?? previous);
            this.setManualLevel(next, true, `hardware change: ${previous} -> ${level}`);
        } else {
            this._currentLevel = level;
            this._changed();
        }
    }

    // Preserve numeric feedback while restoring the earlier control logic.
    // Show the preset only after its brightness has actually been reported.
    _showConfirmedManualLevel(level) {
        if (this._pendingManualOSD !== level)
            return;
        this._pendingManualOSD = null;
        try {
            this._onManualChanged(level);
        } catch (error) {
            console.error(`Lux Capacitor: keyboard OSD failed: ${error}`);
        }
    }

    _hasOwnWrite(level) {
        const now = GLib.get_monotonic_time();
        this._ownWrites = this._ownWrites.filter(write => write.expires > now);
        return this._ownWrites.some(write => write.level === level);
    }

    _consumeOwnWrite(level) {
        this._hasOwnWrite(level);
        const index = this._ownWrites.findIndex(write => write.level === level);
        if (index < 0)
            return false;
        this._ownWrites.splice(index, 1);
        return true;
    }

    _requestWrite(level) {
        if (!this._enabled)
            return;
        this._desiredWrite = clampLevel(level);
        this._flushWrite();
    }

    _flushWrite() {
        if (!this._enabled || !this._available ||
            this._writeInFlight !== null || this._desiredWrite === null)
            return;
        const level = this._desiredWrite;
        this._desiredWrite = null;
        this._writeInFlight = level;
        const serial = ++this._writeSerial;
        this._lastRequested = level;
        this._ownWrites.push({
            level,
            expires: GLib.get_monotonic_time() + WRITE_ECHO_US,
        });
        if (this._ownWrites.length > 40)
            this._ownWrites.shift();

        const generation = this._generation;
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH,
            'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [INTERFACE, 'Brightness',
                new GLib.Variant('i', level)]),
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (connection, result) => {
                if (!this._enabled || generation !== this._generation ||
                    serial !== this._writeSerial)
                    return;
                try {
                    connection.call_finish(result);
                } catch (error) {
                    if (!this._cancellable?.is_cancelled())
                        console.error(`Lux Capacitor: keyboard write failed: ${error}`);
                    this._ownWrites = this._ownWrites.filter(write =>
                        write.level !== level);
                }
                this._writeInFlight = null;
                this._flushWrite();
            });
    }

    _startRamp() {
        if (!this._enabled || !this._autoEnabled || !this._available ||
            this._isDimming() ||
            this._target === null || this._lastActual === null ||
            this._wakeHoldId || this._waitingForWakeLux || this._rampId)
            return;
        this._smoothLevel ??= this._lastActual ?? this._currentLevel ?? 0;
        this._lastRampTick = GLib.get_monotonic_time();
        this._rampId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RAMP_MS,
            () => this._rampTick());
    }

    _rampTick() {
        if (!this._enabled || !this._autoEnabled || !this._available ||
            this._isDimming() ||
            this._target === null) {
            this._rampId = 0;
            return GLib.SOURCE_REMOVE;
        }

        const now = GLib.get_monotonic_time();
        const dt = Math.min((now - this._lastRampTick) / 1_000_000, 1);
        this._lastRampTick = now;
        const current = this._smoothLevel ?? this._lastActual ??
            this._currentLevel ?? 0;
        const next = advanceBrightness(current / 100,
            this._target / 100, dt) * 100;
        this._smoothLevel = Math.abs(next - this._target) < 0.3
            ? this._target : next;

        const rounded = clampLevel(this._smoothLevel);
        if (rounded !== this._lastRequested)
            this._requestWrite(rounded);
        if (this._smoothLevel === this._target &&
            this._writeInFlight === null && this._desiredWrite === null) {
            this._rampId = 0;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    _stopRamp() {
        if (this._rampId)
            GLib.source_remove(this._rampId);
        this._rampId = 0;
    }

    _changed() {
        if (!this._enabled)
            return;
        try {
            this._onChanged();
        } catch (error) {
            console.error(`Lux Capacitor: keyboard UI update failed: ${error}`);
        }
    }
}
