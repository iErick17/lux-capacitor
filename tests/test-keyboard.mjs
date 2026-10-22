import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import {KeyboardController, automaticKeyboardTarget} from '../lux-capacitor@ierick17.github.io/keyboardController.js';
import Extension, {Main} from './extension-fixture.mjs';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}
let count = 0;
function test(name, callback) {
    callback();
    print(`PASS: ${name}`);
    count++;
}
function fixture(auto = true, level = 0) {
    const settings = {
        value: auto,
        ints: {'keyboard-idle-timeout': 0, 'keyboard-dark-lux': 10},
        get_boolean() { return this.value; },
        set_boolean(_key, value) { this.value = value; },
        get_int(key) { return this.ints[key]; },
    };
    const writes = [];
    const popups = [];
    const c = new KeyboardController({settings, onManualChanged: value => popups.push(value)});
    Object.assign(c, {_enabled: true, _available: true, _lastActual: level,
        _currentLevel: level, _smoothLevel: level});
    c._startRamp = () => {};
    c._stopRamp = () => {};
    c._requestWrite = value => {
        writes.push(value);
        c._lastRequested = value;
        c._ownWrites.push({level: value, expires: GLib.get_monotonic_time() + 2_000_000});
    };
    return {c, settings, writes, popups};
}
function acknowledge(c, level) {
    c._onProxySignal('BrightnessChanged', new GLib.Variant('(is)', [level, 'set property']));
}

test('Fn+Space keeps the firmware 20, 75, 100, 0 cycle without overriding it', () => {
    const {c, settings, writes, popups} = fixture();
    // The Framework EC's own cycle, as observed on hardware. Each level is
    // kept and written back unchanged, so the light never shows another level.
    const expected = [20, 75, 100, 0];
    for (let i = 0; i < expected.length; i++) {
        c._onActualLevel(expected[i]);
        assert(writes.at(-1) === expected[i], `wrong preset at step ${i}`);
        assert(popups.length === i, 'popup shown before the selected value was confirmed');
        acknowledge(c, expected[i]);
        assert(c.currentLevel === expected[i] && popups.at(-1) === expected[i], 'feedback mismatch');
    }
    assert(!settings.value && writes.join() === expected.join(), 'manual sequence changed Auto incorrectly');
});

test('Quick Fn+Space presses are each kept, with no press lost', () => {
    const {c, settings, writes, popups} = fixture(false, 0);
    // Presses about half a second apart used to fall inside the settle
    // window, leaving the firmware's 0 on screen out of sequence.
    for (const level of [20, 75, 0, 20]) {
        c._onActualLevel(level);
        acknowledge(c, level);
    }
    assert(!settings.value && writes.join() === '20,75,0,20' && popups.join() === '20,75,0,20',
        'a quick press was lost or remapped');
});

test('A forwarded firmware signal does not advance the cycle twice', () => {
    const {c, writes} = fixture(false, 20);
    c._onActualLevel(75);
    c._onProxySignal('BrightnessChanged', new GLib.Variant('(is)', [75, 'internal']));
    assert(writes.join() === '75', 'one hardware event advanced multiple times');
});

test('Manual slider selection turns software Auto off and writes the selected value', () => {
    const {c, settings, writes, popups} = fixture(true, 20);
    c.setManualLevel(43);
    acknowledge(c, 43);
    assert(!settings.value && c.currentLevel === 43 && writes.join() === '43', 'manual override failed');
    assert(popups.length === 0, 'slider unexpectedly emitted a hardware-key popup');
});

test('Software Auto follows the existing sensor curve and stops responding when disabled', () => {
    const {c, settings, writes} = fixture(false, 20);
    c.setAutoEnabled(true);
    c.onSensorLevel(0);
    assert(settings.value && c._target === 55, 'dark-room Auto target changed');
    c.onSensorLevel(78);
    assert(settings.value && c._target === 0, 'bright-room Auto target changed');
    c.setAutoEnabled(false);
    c.onSensorLevel(0);
    assert(!settings.value && c._target === null && writes.length === 0, 'disabled Auto responded to sensor');
});

test('Desktop idle dimming and restoration preserve Auto without a manual remap', () => {
    const {c, settings, writes} = fixture(true, 36);
    let dimming = true;
    c._isDimming = () => dimming;
    c.onSensorLevel(6);
    c._onPowerSignal(30, 'external');
    c._onActualLevel(30);
    assert(settings.value && c.currentLevel === 30 && writes.length === 0,
        'desktop dimming was mistaken for a manual brightness key');
    c.onSensorLevel(0);
    assert(c._rampTick() === GLib.SOURCE_REMOVE && writes.length === 0,
        'Auto fought desktop dimming');
    dimming = false;
    let ramps = 0;
    c._startRamp = () => ramps++;
    c._onPowerSignal(36, 'external');
    c._onActualLevel(36);
    assert(settings.value && c.currentLevel === 36 && ramps > 0 && writes.length === 0,
        'restoration did not resume Auto cleanly');
});

test('Fn+Space still takes manual control while the desktop is dimmed', () => {
    const {c, settings, writes} = fixture(true, 36);
    c._isDimming = () => true;
    c._onPowerSignal(30, 'external');
    c._onActualLevel(75);
    assert(!settings.value && writes.join() === '75',
        'idle handling swallowed a real hardware brightness change');
});

test('Power notifications preserve manual mode and ignore own writes and hardware signals', () => {
    const {c, settings, writes} = fixture(false, 50);
    c._ownWrites.push({level: 75, expires: GLib.get_monotonic_time() + 2_000_000});
    c._onPowerSignal(75, 'external');
    c._onPowerSignal(20, 'internal');
    assert(c.currentLevel === 50, 'own or hardware event was treated as desktop dimming');
    c._onPowerSignal(30, 'external');
    c._onActualLevel(30);
    assert(!settings.value && c.currentLevel === 30 && writes.length === 0,
        'desktop notification enabled Auto or remapped brightness in manual mode');
});

test('Numeric keyboard popup is emitted once for a confirmed preset', () => {
    const {c, popups} = fixture(false, 20);
    c._onActualLevel(75);
    acknowledge(c, 75);
    c._onActualLevel(75);
    assert(popups.join() === '75', 'duplicate or incorrect popup');
});

test('A stale hardware read cannot overwrite a newer desktop brightness notification', () => {
    for (const ownWrite of [false, true]) {
        const {c, settings, writes} = fixture(true, 36);
        let completeRead;
        c._file = {
            load_contents_async(_cancel, callback) {
                completeRead = () => callback(this, {});
            },
            load_contents_finish() {
                return [true, new TextEncoder().encode('36')];
            },
        };
        c._pollActual();
        if (ownWrite)
            c._ownWrites.push({level: 30, expires: GLib.get_monotonic_time() + 2_000_000});
        c._onPowerSignal(30, 'external');
        if (ownWrite)
            acknowledge(c, 30);
        completeRead();
        assert(settings.value && c.currentLevel === 30 && writes.length === 0,
            `stale read disabled Auto (${ownWrite ? 'own fade' : 'desktop dim'})`);
        assert(!c._pollPending, 'discarded sample stopped future polling');
        c._file.load_contents_finish = () => [true, new TextEncoder().encode('75')];
        c._pollActual();
        completeRead();
        assert(!settings.value && writes.join() === '75',
            'a fresh manual change after the discarded sample was ignored');
    }
});

test('Retained Quick Settings UI displays restored-controller percentages without writing back', () => {
    const Control = GObject.registerClass({Properties: {
        value: GObject.ParamSpec.int('value', null, null, GObject.ParamFlags.READWRITE, 0, 100, 0),
    }}, class Control extends GObject.Object {
        _init() { super._init(); this._value = 0; }
        get value() { return this._value; }
        set value(v) { this._value = v; this.notify('value'); }
    });
    const slider = new Control();
    const discrete = new Control();
    let feedbackWrites = 0;
    const item = {_sliderItem: slider, _discreteItem: discrete,
        _sliderItemChangedId: slider.connect('notify::value', () => feedbackWrites++),
        _discreteItemChangedId: discrete.connect('notify::value', () => feedbackWrites++)};
    const e = new Extension();
    const {c} = fixture(false, 50);
    Object.assign(e, {_keyboard: c, _keyboardQuickItem: item, _keyboardAutoMenuItem: {}});
    e._syncKeyboardToggle();
    assert(item.subtitle === '50%' && slider.value === 50 && item.checked,
        'retained UI disagrees with the restored controller');
    assert(e._keyboardAutoMenuItem.state === false && feedbackWrites === 0,
        'display update changed brightness or Auto');
    const displayed = [];
    Main.osdWindowManager = {showAll(_icon, label, level) { displayed.push([label, level]); }};
    e._showKeyboardOSD(50);
    assert(displayed[0][0] === '50%' && displayed[0][1] === 0.5, 'numeric popup was lost');
});

test('Native automatic brightness stays off during extension control and restores its previous state', () => {
    for (const initiallyEnabled of [false, true]) {
        const values = {'native-override-active': false, 'native-ambient-was-enabled': false};
        let native = initiallyEnabled;
        let changed;
        const e = new Extension();
        e._settings = {
            get_boolean(key) { return values[key]; },
            set_boolean(key, value) { values[key] = value; },
        };
        e._powerSettings = {
            get_boolean() { return native; },
            set_boolean(_key, value) { native = value; },
            connect(_signal, callback) { changed = callback; return 1; },
        };
        e._manager = {_inhibitUpdates: false, globalScale: {value: 0.4}, _sync() {}};
        e._getActualBrightness = () => 0.4;
        e._takeOverNativeAmbient();
        assert(!native && values['native-override-active'], 'Native Auto was not disabled');
        native = true;
        changed();
        assert(!native, 'Native Auto competed with the extension');
        e._restoreNativeAmbient();
        assert(native === initiallyEnabled && !values['native-override-active'], 'Previous native setting was not restored');
    }
});

test('Volume slider shows OSD for user changes, ignores backend sync, and restores its handler', () => {
    new Extension()._restoreSpeakerSlider();
    const Control = GObject.registerClass({
        Properties: {value: GObject.ParamSpec.double('value', 'value', 'value',
            GObject.ParamFlags.READWRITE, 0, 1.5, 0)},
    }, class VolumeSliderControl extends GObject.Object {});
    for (const ownHandler of [false, true]) {
        const slider = new Control();
        let writes = 0;
        const shown = [];
        const prototype = {
            _sliderChanged() { writes++; },
            showOSD() { shown.push(this.slider.value); },
        };
        const item = Object.assign(Object.create(prototype), {slider, stream: {}});
        if (ownHandler)
            item._sliderChanged = prototype._sliderChanged;
        const original = item._sliderChanged;
        const changedId = slider.connect('notify::value', () => item._sliderChanged());
        const e = new Extension();
        e._patchSpeakerSlider(item);
        slider.value = 0.5;
        slider.value = 1.25;
        assert(writes === 2 && shown.join(',') === '0.5,1.25', 'User changes lost volume writes or OSD');
        slider.block_signal_handler(changedId);
        slider.value = 0.2;
        slider.unblock_signal_handler(changedId);
        assert(writes === 2 && shown.length === 2, 'Backend sync triggered feedback');
        item.stream = null;
        slider.value = 0.3;
        assert(shown.length === 2, 'Missing output stream triggered OSD');
        item.stream = {};
        e._restoreSpeakerSlider();
        assert(item._sliderChanged === original && Object.hasOwn(item, '_sliderChanged') === ownHandler,
            'Disable did not restore the original handler');
        slider.value = 0.4;
        assert(writes === 4 && shown.length === 2, 'OSD patch survived disable');
        e._patchSpeakerSlider(item);
        slider.value = 0.6;
        assert(shown.length === 3, 'Re-enable duplicated or lost feedback');
        const otherWrapper = () => {};
        item._sliderChanged = otherWrapper;
        e._restoreSpeakerSlider();
        assert(item._sliderChanged === otherWrapper, 'Disable overwrote another extension');
        slider.disconnect(changedId);
    }
});

test('Brightness and volume OSD bars follow rapid reversals immediately and restore on disable', () => {
    for (const ownHandler of [false, true]) {
        const bars = [0, 1].map(() => ({
            value: 0, pending: null, removed: 0,
            remove_transition(name) {
                assert(name === 'value', 'Popup fade was changed');
                this.pending = null;
                this.removed++;
            },
        }));
        const calls = [];
        const prototype = {
            _showOsdWindow(monitor, icon, label, level, maxLevel) {
                calls.push([monitor, label, level, maxLevel]);
                if (Number.isFinite(level))
                    bars[monitor].pending = level;
                return 'original-result';
            },
        };
        const manager = Object.assign(Object.create(prototype), {
            _osdWindows: bars.map(bar => ({_level: bar})),
        });
        if (ownHandler)
            manager._showOsdWindow = prototype._showOsdWindow;
        Main.osdWindowManager = manager;
        const original = manager._showOsdWindow;
        const e = new Extension();
        e._patchSpeakerOSD();
        for (const [monitor, name] of [[0, 'display-brightness-symbolic'], [1, 'audio-volume-high-symbolic']]) {
            const icon = new Gio.ThemedIcon({name});
            for (const level of [0.9, 0.1, 1, 0, 0.6]) {
                assert(manager._showOsdWindow(monitor, icon, 'label', level, 1) === 'original-result',
                    'Original OSD result was lost');
                assert(bars[monitor].value === level && bars[monitor].pending === null,
                    'OSD still trails the current slider level');
            }
        }
        const call = calls.at(-1);
        assert(call[1] === '60' && call[3] === 1, 'Numeric volume label or range changed');
        manager._showOsdWindow(1, new Gio.ThemedIcon({name: 'audio-volume-overamplified-symbolic'}), null, 1.25, 1.5);
        assert(bars[1].value === 1.25 && calls.at(-1)[1] === '125', 'Amplified volume was clamped');
        const removed = bars[0].removed;
        manager._showOsdWindow(0, new Gio.ThemedIcon({name: 'microphone-sensitivity-high-symbolic'}), null, 0.4, 1);
        assert(bars[0].pending === 0.4 && bars[0].removed === removed, 'Unrelated OSD animation changed');
        manager._showOsdWindow(0, null, 'No level', null, 1);
        assert(bars[0].removed === removed, 'Missing level changed animation');
        e._restoreSpeakerOSD();
        assert(manager._showOsdWindow === original && Object.hasOwn(manager, '_showOsdWindow') === ownHandler,
            'Disable did not restore original OSD behavior');
    }
});

function screenFixture(anchors = '[]') {
    const values = {anchors, 'anchor-unit': anchors === '[]' ? '' : 'lux',
        'native-override-active': false};
    let writes = 0;
    const settings = {
        get_string(key) { return values[key]; },
        set_string(key, value) { values[key] = value; writes++; },
        get_boolean(key) { return values[key]; },
    };
    const e = new Extension();
    e._settings = settings;
    Object.assign(e, {_anchors: e._loadAnchors(), _anchorUnit: values['anchor-unit'],
        _saveAnchorsId: 0, _autoEnabled: true, _lux: null, _targetLux: null, _unit: null,
        _sensorClaimed: true, _manager: {globalScale: {value: 0.5}}, _originalKeySteps: new Map()});
    e._sensorDesired = () => true;
    e._stopTimer = () => {};
    e._syncToggle = () => {};
    const targets = [];
    e._setTarget = target => targets.push(target);
    const sense = lux => {
        e._sensor = {LightLevel: lux, LightLevelUnit: 'lux',
            ReleaseLightRemote() {}, disconnectObject() {}};
        e._readLux();
    };
    const drag = value => {
        e._manager.globalScale.value = value;
        e._onUserUpdate();
    };
    return {e, values, targets, sense, drag, writes: () => writes};
}

function waitForAnchorSave(e) {
    while (e._saveAnchorsId)
        GLib.MainContext.default().iteration(true);
}

test('Screen ignores small light fluctuations but follows real changes', () => {
    const {targets, sense} = screenFixture();
    for (const lux of [40, 42, 44, 46])
        sense(lux);
    assert(targets.length === 1, 'sensor noise re-targeted the screen');
    sense(60);
    assert(targets.length === 2, 'a real light change was ignored');
});

test('A screen slider drag saves one settled preference after the drag', () => {
    const {e, values, sense, drag, writes} = screenFixture();
    sense(60);
    for (const value of [0.6, 0.62, 0.64])
        drag(value);
    assert(writes() === 0 && e._saveAnchorsId, 'drag wrote settings on every step');
    waitForAnchorSave(e);
    const saved = JSON.parse(values.anchors);
    assert(saved.length === 1 && saved[0].lux === 60 && saved[0].brightness === 0.64 &&
        values['anchor-unit'] === 'lux', 'settled preference was not saved');
});

test('Turning screen Auto off resets preferences and cancels a pending save', () => {
    const {e, values, sense, drag} = screenFixture();
    sense(60);
    drag(0.7);
    values.enabled = false;
    e._updateSensorClaim = () => {};
    e._onEnabledChanged();
    assert(!e._saveAnchorsId && values.anchors === '[]' && e._anchors.length === 0,
        'pending save survived the reset');
});

test('Disabling on lock writes a pending screen preference', () => {
    const {e, values, sense, drag} = screenFixture();
    Main.sessionMode = {isLocked: true};
    Main.osdWindowManager = {};
    sense(60);
    drag(0.7);
    e.disable();
    assert(JSON.parse(values.anchors)[0]?.brightness === 0.7, 'pending preference was lost on lock');
});

test('Contradicting preferences stored by earlier versions are cleaned up on load', () => {
    const {e} = screenFixture('[{"lux":40,"brightness":0.9},{"lux":150,"brightness":0.3}]');
    assert(e._anchors.length === 1 && e._anchors[0].lux === 150, 'stored contradiction was kept');
});

function idleMonitor() {
    return {
        idle: null, active: null, removed: [],
        add_idle_watch(_ms, callback) { this.idle = callback; return 1; },
        add_user_active_watch(callback) { this.active = callback; return 2; },
        remove_watch(id) { this.removed.push(id); },
    };
}

test('The default dark threshold keeps the original keyboard policy', () => {
    for (const lux of [0, 2, 10, 18, 24, 25, 30, 100]) {
        for (const wasLit of [false, true]) {
            const expected = wasLit ? lux < 25 : lux <= 10;
            const {lit} = automaticKeyboardTarget(lux, wasLit);
            assert(lit === expected, `default threshold changed at ${lux} lux`);
        }
    }
    assert(automaticKeyboardTarget(15, false, 20).lit && !automaticKeyboardTarget(15).lit,
        'a higher dark threshold did not light the keyboard');
});

test('Idle timeout fades only Auto light and restores it on activity', () => {
    const {c, settings, writes} = fixture(true, 55);
    const monitor = idleMonitor();
    c._idleMonitor = monitor;
    settings.ints['keyboard-idle-timeout'] = 30;
    c._watchIdle();
    c.onSensorLevel(0);
    assert(c._target === 55, 'Auto did not light the keyboard');
    monitor.idle();
    assert(settings.value && c._target === 0, 'idle did not fade Auto light while keeping Auto on');
    monitor.active();
    assert(settings.value && c._target === 55 && writes.length === 0, 'activity did not restore Auto light');
});

test('Idle timeout never changes a manual keyboard level', () => {
    const {c, settings, writes} = fixture(false, 50);
    const monitor = idleMonitor();
    c._idleMonitor = monitor;
    settings.ints['keyboard-idle-timeout'] = 5;
    c._watchIdle();
    monitor.idle();
    monitor.active();
    assert(!settings.value && c._target === null && writes.length === 0, 'idle changed a manual level');
});

test('Idle fade writes are not mistaken for Fn+Space', () => {
    const {c, settings, writes, popups} = fixture(true, 55);
    const monitor = idleMonitor();
    c._idleMonitor = monitor;
    settings.ints['keyboard-idle-timeout'] = 30;
    c._watchIdle();
    c.onSensorLevel(0);
    monitor.idle();
    for (const level of [40, 20, 0]) {
        c._requestWrite(level);
        c._onActualLevel(level);
    }
    assert(settings.value && writes.join() === '40,20,0' && popups.length === 0,
        'idle fade advanced a preset or turned Auto off');
});

test('Fn+Space from an Auto level keeps the firmware level in either detection order', () => {
    for (const pollFirst of [true, false]) {
        const {c, settings, writes} = fixture(true, 37);
        if (pollFirst) {
            c._onActualLevel(75);
            c._onProxySignal('BrightnessChanged', new GLib.Variant('(is)', [75, 'internal']));
        } else {
            c._onProxySignal('BrightnessChanged', new GLib.Variant('(is)', [75, 'internal']));
            c._onActualLevel(75);
        }
        assert(!settings.value && writes.join() === '75',
            `one press did not give one level (${pollFirst ? 'poll' : 'signal'} first)`);
    }
});

test('Battery dimming keeps learned preferences undimmed and exact', () => {
    const {e, targets, sense, drag} = screenFixture();
    Object.assign(e, {_dimOnBattery: true, _onBattery: true});
    sense(60);
    drag(0.51);
    assert(Math.abs(e._anchors[0].brightness - 0.6) < 1e-9, 'battery dimming was learned as a preference');
    e._onBattery = false;
    e._retargetNow();
    assert(Math.abs(targets.at(-1) - 0.6) < 1e-9, 'preference was not restored on AC power');
});

test('Resetting learned brightness from the settings window reaches the extension', () => {
    const {e, values, targets, sense, drag} = screenFixture();
    sense(60);
    drag(0.9);
    values.anchors = '[]';
    values['anchor-unit'] = '';
    e._onAnchorsChanged();
    assert(e._anchors.length === 0 && !e._saveAnchorsId && targets.length === 2,
        'external reset was ignored or overwritten');
    e._saveAnchors();
    assert(e._anchors.length === 0 && values.anchors === '[]', 'own save reloaded preferences');
});

for (const name of ['extension.js', 'keyboardController.js', 'brightnessModel.js', 'prefs.js']) {
    const [ok, bytes] = Gio.File.new_for_path(`lux-capacitor@ierick17.github.io/${name}`).load_contents(null);
    assert(ok, `unable to read ${name}`);
    Reflect.parse(new TextDecoder().decode(bytes), {target: 'module'});
}
print(`${count} regression checks passed; all extension modules parse.`);
