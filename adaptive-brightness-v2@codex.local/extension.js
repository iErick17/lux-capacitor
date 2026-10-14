// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    advanceBrightness,
    preferredBrightness,
    upsertPreference,
} from './brightnessModel.js';
import {KeyboardController} from './keyboardController.js';

const SENSOR_XML = `
<node>
  <interface name="net.hadess.SensorProxy">
    <method name="ClaimLight"/>
    <method name="ReleaseLight"/>
    <property name="HasAmbientLight" type="b" access="read"/>
    <property name="LightLevel" type="d" access="read"/>
    <property name="LightLevelUnit" type="s" access="read"/>
  </interface>
</node>`;
const SensorProxy = Gio.DBusProxy.makeProxyWrapper(SENSOR_XML);

const POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';
const TICK_MS = 100;
const MANUAL_HOLD_US = 1_500_000;
const EPSILON = 0.003;
const KEY_STEP = 0.05;

export default class AdaptiveBrightnessExtension extends Extension {
    enable() {
        const afterLock = this._wasLocked === true;
        this._wasLocked = false;
        this._settings = this.getSettings();
        this._powerSettings = new Gio.Settings({schema_id: POWER_SCHEMA});
        this._manager = Main.brightnessManager;
        this._anchors = this._loadAnchors();
        this._autoEnabled = this._settings.get_boolean('enabled');
        this._lux = null;
        this._rawLevel = null;
        this._unit = null;
        this._target = null;
        this._holdUntil = 0;
        this._lastTick = 0;
        this._timerId = 0;
        this._sensorRetryId = 0;
        this._claimRetryId = 0;
        this._sensor = null;
        this._sensorCancellable = new Gio.Cancellable();
        this._sensorClaimed = false;
        this._claimPending = false;
        this._sensorGeneration = 0;
        this._applying = false;
        this._destroyed = false;
        this._originalKeySteps = new Map();
        this._originalShowOSD = null;
        this._originalShowOSDOwn = false;
        this._originalShowOsdWindow = null;
        this._originalShowOsdWindowOwn = false;
        this._speakerOsdWrapper = null;
        this._speakerQuickItem = null;
        this._menuSetupId = 0;
        this._menuAttempts = 0;
        this._screenQuickItem = null;
        this._screenMenuEnabledId = 0;
        this._screenQuickItemDestroyId = 0;
        this._screenAutoMenuItemDestroyId = 0;
        this._screenSectionWasVisible = null;
        this._screenAutoMenuItem = null;
        this._keyboardAutoMenuItem = null;
        this._keyboardQuickItem = null;
        this._keyboardSliderId = 0;
        this._keyboardDiscreteId = 0;

        this._keyboard = new KeyboardController({
            settings: this._settings,
            onChanged: () => this._onKeyboardChanged(),
            onManualChanged: level => this._showKeyboardOSD(level),
            isDimming: () => this._manager?.dimming ?? false,
        });
        this._lastKeyboardAuto = this._keyboard.autoEnabled;

        this._settingsId = this._settings.connect('changed::enabled',
            () => this._onEnabledChanged());
        this._userUpdateId = this._manager.connect('user-update',
            () => this._onUserUpdate());
        this._managerChangedId = this._manager.connect('changed',
            () => this._onManagerChanged());

        // GNOME 50 treats its brightness slider as an auto-brightness bias.
        // This extension uses the same slider for actual backlight brightness.
        this._takeOverNativeAmbient();
        this._enforceKeyStep();
        this._patchBrightnessOSD();
        this._patchSpeakerOSD();
        this._scheduleQuickSettingsMenus();
        this._keyboard.enable(afterLock);
        this._connectSensor();
    }

    disable() {
        this._wasLocked = Main.sessionMode.isLocked;
        this._destroyed = true;
        this._stopTimer();
        if (this._menuSetupId)
            GLib.source_remove(this._menuSetupId);
        this._menuSetupId = 0;
        this._removeScreenAutoSwitch();
        this._keyboardAutoMenuItem?.destroy();
        this._keyboardAutoMenuItem = null;
        this._restoreKeyboardManualHandlers();
        this._keyboardQuickItem = null;
        this._keyboard?.disable();
        this._keyboard = null;
        this._restoreKeySteps();
        this._restoreBrightnessOSD();
        this._restoreSpeakerSlider();
        this._restoreSpeakerOSD();
        if (this._sensorRetryId)
            GLib.source_remove(this._sensorRetryId);
        this._sensorRetryId = 0;
        if (this._claimRetryId)
            GLib.source_remove(this._claimRetryId);
        this._claimRetryId = 0;
        this._releaseSensor();
        this._sensorCancellable?.cancel();

        if (this._sensor) {
            this._sensor.disconnectObject(this);
            this._sensor = null;
        }
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        if (this._userUpdateId)
            this._manager.disconnect(this._userUpdateId);
        if (this._managerChangedId)
            this._manager.disconnect(this._managerChangedId);
        if (this._powerSettingsId)
            this._powerSettings.disconnect(this._powerSettingsId);

        this._restoreNativeAmbient();

        this._manager = null;
        this._settings = null;
        this._powerSettings = null;
        this._sensorCancellable = null;
    }

    _takeOverNativeAmbient() {
        if (!this._settings.get_boolean('native-override-active')) {
            this._settings.set_boolean('native-ambient-was-enabled',
                this._powerSettings.get_boolean('ambient-enabled'));
            this._settings.set_boolean('native-override-active', true);
        }
        this._powerSettings.set_boolean('ambient-enabled', false);
        this._powerSettingsId = this._powerSettings.connect(
            'changed::ambient-enabled', () => {
                if (this._powerSettings.get_boolean('ambient-enabled'))
                    this._powerSettings.set_boolean('ambient-enabled', false);
            });

        // Preserve the currently visible brightness during the handover.
        // Setting autoBrightnessTarget normally calls _sync immediately;
        // inhibit that call until the actual slider value is in place.
        const actual = this._getActualBrightness();
        const manager = this._manager;
        const previousInhibit = manager._inhibitUpdates;
        manager._inhibitUpdates = true;
        try {
            manager.autoBrightnessTarget = -1;
            if (actual !== null && manager.globalScale) {
                manager.globalScale.value = actual;
                manager._globalScaleChanged = true;
            }
        } finally {
            manager._inhibitUpdates = previousInhibit;
        }
        if (!previousInhibit)
            manager._sync({showOSD: false});
    }

    _restoreNativeAmbient() {
        if (!this._settings.get_boolean('native-override-active'))
            return;
        const previous = this._settings.get_boolean('native-ambient-was-enabled');
        this._settings.set_boolean('native-override-active', false);
        if (previous && !this._powerSettings.get_boolean('ambient-enabled')) {
            // Restore GNOME's centered bias while preserving actual brightness.
            const actual = this._getActualBrightness();
            const manager = this._manager;
            const previousInhibit = manager._inhibitUpdates;
            manager._inhibitUpdates = true;
            try {
                if (actual !== null && manager.globalScale) {
                    manager.globalScale.value = 0.5;
                    manager._globalScaleChanged = true;
                    manager.autoBrightnessTarget = actual;
                }
            } finally {
                manager._inhibitUpdates = previousInhibit;
            }
            if (!previousInhibit)
                manager._sync({showOSD: false});
            this._powerSettings.set_boolean('ambient-enabled', previous);
        }
    }

    _getActualBrightness() {
        const values = this._manager.scales.flatMap(scale =>
            scale.monitor.get_monitors()
                .filter(monitor => monitor.get_backlight() && monitor.is_active())
                .map(monitor => {
                    const backlight = monitor.get_backlight();
                    const span = backlight.brightnessMax - backlight.brightnessMin;
                    return span > 0
                        ? (backlight.brightness - backlight.brightnessMin) / span
                        : 0;
                }));
        return values.length > 0 ? Math.max(...values) : null;
    }

    _setBrightnessSilently(value) {
        const manager = this._manager;
        if (!manager?.globalScale)
            return;
        if (Math.abs(manager.globalScale.value - value) < EPSILON &&
            manager.autoBrightnessTarget < 0)
            return;

        this._applying = true;
        const previousInhibit = manager._inhibitUpdates;
        manager._inhibitUpdates = true;
        try {
            manager.autoBrightnessTarget = -1;
            manager.globalScale.value = value;
            manager._globalScaleChanged = true;
        } finally {
            manager._inhibitUpdates = previousInhibit;
        }
        try {
            if (!previousInhibit)
                manager._sync({showOSD: false});
        } finally {
            this._applying = false;
        }
    }

    _onUserUpdate() {
        if (this._applying || !this._autoEnabled || this._lux === null)
            return;
        const value = this._manager.globalScale?.value;
        if (!Number.isFinite(value))
            return;

        this._anchors = upsertPreference(this._anchors, this._lux, value);
        this._settings.set_string('anchors', JSON.stringify(this._anchors));
        this._settings.set_string('anchor-unit', this._unit ?? '');
        this._target = value;
        this._holdUntil = GLib.get_monotonic_time() + MANUAL_HOLD_US;
        this._stopTimer();
    }

    _onManagerChanged() {
        this._enforceKeyStep();
        this._scheduleQuickSettingsMenus();
        this._keepScreenMenuAvailable();
        if (this._autoEnabled && this._lux !== null)
            this._setTarget(preferredBrightness(this._lux, this._anchors));
        this._syncToggle();
    }

    _onEnabledChanged() {
        const enabled = this._settings.get_boolean('enabled');
        if (enabled === this._autoEnabled)
            return;
        this._autoEnabled = enabled;

        // Manual preferences belong to one continuous auto-brightness session.
        this._anchors = [];
        this._settings.set_string('anchors', '[]');
        this._settings.set_string('anchor-unit', '');
        this._target = null;
        this._holdUntil = 0;
        this._stopTimer();

        if (enabled) {
            if (this._sensorClaimed)
                this._readLux();
            else
                this._claimSensor();
        } else {
            this._updateSensorClaim();
        }
        this._syncToggle();
    }

    _onKeyboardChanged() {
        if (this._destroyed)
            return;
        const autoEnabled = this._keyboard?.autoEnabled ?? false;
        const resumedAuto = autoEnabled && !this._lastKeyboardAuto;
        this._lastKeyboardAuto = autoEnabled;
        this._syncKeyboardToggle();
        this._updateSensorClaim();
        if (resumedAuto && this._sensorClaimed)
            this._readLux();
    }

    _sensorDesired() {
        return this._autoEnabled || !!this._keyboard?.autoEnabled;
    }

    _updateSensorClaim() {
        if (this._sensorDesired()) {
            this._claimSensor();
        } else {
            this._releaseSensor();
            if (this._claimRetryId)
                GLib.source_remove(this._claimRetryId);
            this._claimRetryId = 0;
        }
    }

    _loadAnchors() {
        try {
            const anchors = JSON.parse(this._settings.get_string('anchors'));
            if (!Array.isArray(anchors))
                return [];
            return anchors.filter(a => Number.isFinite(a?.lux) && a.lux >= 0 &&
                Number.isFinite(a?.brightness)).slice(-24);
        } catch {
            return [];
        }
    }

    _syncToggle() {
        if (this._screenAutoMenuItem)
            this._screenAutoMenuItem.state = this._autoEnabled;
    }

    _syncKeyboardToggle() {
        if (!this._keyboardAutoMenuItem)
            return;
        this._keyboardAutoMenuItem.state = !!this._keyboard?.autoEnabled;
        this._keyboardAutoMenuItem.reactive = !!this._keyboard?.available;

        // Firmware hotkeys can bypass GNOME's cached D-Bus brightness. Update
        // only the displayed slider value, with its write callbacks blocked.
        const item = this._keyboardQuickItem;
        const level = this._keyboard?.currentLevel;
        if (!item || !Number.isInteger(level) || level < 0 || level > 100)
            return;
        item.checked = level > 0;
        item.subtitle = `${level}%`;
        // Pointer input owns the thumb during a drag. After release, keep
        // showing the selected target until the physical fade completes.
        if (this._keyboardDragging)
            return;
        const sliderLevel = this._keyboard.manualTarget ?? level;
        item._sliderItem.block_signal_handler(item._sliderItemChangedId);
        item._discreteItem.block_signal_handler(item._discreteItemChangedId);
        try {
            item._sliderItem.value = sliderLevel;
        } finally {
            item._discreteItem.unblock_signal_handler(item._discreteItemChangedId);
            item._sliderItem.unblock_signal_handler(item._sliderItemChangedId);
        }
    }

    _showKeyboardOSD(level) {
        if (this._destroyed)
            return;
        const icon = Gio.ThemedIcon.new_from_names([
            level > 0 ? 'keyboard-brightness-high-symbolic' : 'keyboard-brightness-off-symbolic',
            'display-brightness-symbolic',
        ]);
        Main.osdWindowManager.showAll(icon, `${level}%`, level / 100, 1);
    }

    _connectSensor() {
        new SensorProxy(Gio.DBus.system, 'net.hadess.SensorProxy',
            '/net/hadess/SensorProxy', (proxy, error) => {
                if (this._destroyed)
                    return;
                if (error) {
                    console.error(`Adaptive Brightness: light sensor unavailable: ${error}`);
                    this._syncToggle();
                    this._sensorRetryId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT, 15, () => {
                            this._sensorRetryId = 0;
                            this._connectSensor();
                            return GLib.SOURCE_REMOVE;
                        });
                    return;
                }

                this._sensor = proxy;
                proxy.connectObject('g-properties-changed',
                    () => this._onSensorPropertiesChanged(),
                    'notify::g-name-owner',
                    () => this._onSensorOwnerChanged(), this);
                this._syncToggle();
                if (this._sensorDesired())
                    this._claimSensor();
            }, this._sensorCancellable);
    }

    _onSensorOwnerChanged() {
        this._sensorGeneration++;
        this._claimPending = false;
        this._sensorClaimed = false;
        this._lux = null;
        this._rawLevel = null;
        this._stopTimer();
        if (this._sensor?.get_name_owner() && this._sensorDesired())
            this._claimSensor();
        this._syncToggle();
    }

    _onSensorPropertiesChanged() {
        if (this._sensorDesired() && !this._sensorClaimed && !this._claimPending)
            this._claimSensor();
        if (this._sensorClaimed)
            this._readLux();
        this._syncToggle();
    }

    _claimSensor() {
        if (!this._sensorDesired() || !this._sensor?.HasAmbientLight ||
            !this._sensor.get_name_owner() || this._sensorClaimed ||
            this._claimPending || this._claimRetryId)
            return;
        this._claimPending = true;
        const proxy = this._sensor;
        const generation = this._sensorGeneration;
        proxy.ClaimLightRemote((_result, error) => {
            if (generation !== this._sensorGeneration)
                return;
            this._claimPending = false;
            if (error) {
                if (!this._destroyed)
                    console.error(`Adaptive Brightness: could not claim light sensor: ${error}`);
                if (!this._destroyed && this._sensorDesired() && !this._claimRetryId) {
                    this._claimRetryId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT, 15, () => {
                            this._claimRetryId = 0;
                            this._claimSensor();
                            return GLib.SOURCE_REMOVE;
                        });
                }
                this._syncToggle();
                return;
            }
            if (this._destroyed || !this._sensorDesired()) {
                // A ClaimLight response can arrive after the toggle or the
                // extension has been turned off. Release that exact claim.
                proxy.ReleaseLightRemote(() => {});
                return;
            }
            this._sensorClaimed = true;
            this._readLux();
            this._syncToggle();
        });
    }

    _releaseSensor() {
        if (!this._sensorClaimed || !this._sensor)
            return;
        this._sensorClaimed = false;
        this._sensor.ReleaseLightRemote((_result, error) => {
            if (error && !this._destroyed)
                console.error(`Adaptive Brightness: could not release light sensor: ${error}`);
        });
        this._syncToggle();
    }

    _readLux() {
        if (!this._sensorClaimed || !this._sensorDesired())
            return;
        const rawLevel = this._sensor.LightLevel;
        const unit = this._sensor.LightLevelUnit;
        if (!Number.isFinite(rawLevel) || rawLevel < 0 ||
            !['lux', 'vendor'].includes(unit))
            return;

        const anchorUnit = this._settings.get_string('anchor-unit');
        if (anchorUnit && anchorUnit !== unit) {
            this._anchors = [];
            this._settings.set_string('anchors', '[]');
            this._settings.set_string('anchor-unit', '');
        }
        this._unit = unit;
        this._rawLevel = rawLevel;
        // SensorProxy's vendor unit is a relative 0-100 reading. Map it to
        // the curve's 0-1600 range while retaining the reported value in UI.
        const lux = unit === 'vendor' ? rawLevel * 16 : rawLevel;
        this._lux = lux;
        if (this._autoEnabled)
            this._setTarget(preferredBrightness(lux, this._anchors));
        this._keyboard?.onSensorLevel(lux);
        this._syncToggle();
    }

    _setTarget(target) {
        if (!this._autoEnabled || !Number.isFinite(target))
            return;
        this._target = target;
        if (!this._timerId) {
            this._lastTick = GLib.get_monotonic_time();
            this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS,
                () => this._tick());
        }
    }

    _tick() {
        if (!this._autoEnabled || !this._manager?.globalScale || this._target === null) {
            this._timerId = 0;
            return GLib.SOURCE_REMOVE;
        }
        const now = GLib.get_monotonic_time();
        const dt = Math.min((now - this._lastTick) / 1_000_000, 1);
        this._lastTick = now;
        if (now < this._holdUntil)
            return GLib.SOURCE_CONTINUE;

        const current = this._manager.globalScale.value;
        if (Math.abs(current - this._target) <= EPSILON) {
            this._timerId = 0;
            return GLib.SOURCE_REMOVE;
        }
        let next = advanceBrightness(current, this._target, dt);
        if (Math.abs(next - this._target) <= EPSILON)
            next = this._target;
        this._setBrightnessSilently(next);
        return GLib.SOURCE_CONTINUE;
    }

    _stopTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    _enforceKeyStep() {
        for (const scale of [this._manager.globalScale, ...this._manager.scales]) {
            if (!scale || this._originalKeySteps.has(scale))
                continue;
            this._originalKeySteps.set(scale, {
                up: scale.stepUp,
                down: scale.stepDown,
                ownUp: Object.hasOwn(scale, 'stepUp'),
                ownDown: Object.hasOwn(scale, 'stepDown'),
            });
            // Shell's keybindings call these methods. Setting value normally
            // keeps the user-update signal and lux preference learning intact.
            scale.stepUp = () => {
                scale.value = Math.min(1, scale.value + KEY_STEP);
            };
            scale.stepDown = () => {
                scale.value = Math.max(0, scale.value - KEY_STEP);
            };
        }
    }

    _restoreKeySteps() {
        for (const [scale, original] of this._originalKeySteps) {
            if (original.ownUp)
                scale.stepUp = original.up;
            else
                delete scale.stepUp;
            if (original.ownDown)
                scale.stepDown = original.down;
            else
                delete scale.stepDown;
        }
        this._originalKeySteps.clear();
    }

    _patchBrightnessOSD() {
        const manager = this._manager;
        this._originalShowOSD = manager._showOSD;
        this._originalShowOSDOwn = Object.hasOwn(manager, '_showOSD');
        manager._showOSD = scales => {
            // The input can be an iterator, so retain it for the numeric labels.
            const shownScales = [...scales];
            this._originalShowOSD.call(manager, shownScales);
            for (const scale of shownScales) {
                const monitor = scale.monitor.get_number();
                Main.osdWindowManager._osdWindows[monitor]?.setLabel(
                    String(Math.round(scale.value * 100)));
            }
        };
    }

    _restoreBrightnessOSD() {
        if (!this._originalShowOSD || !this._manager)
            return;
        if (this._originalShowOSDOwn)
            this._manager._showOSD = this._originalShowOSD;
        else
            delete this._manager._showOSD;
        this._originalShowOSD = null;
    }

    _patchSpeakerOSD() {
        const manager = Main.osdWindowManager;
        this._originalShowOsdWindow = manager._showOsdWindow;
        this._originalShowOsdWindowOwn = Object.hasOwn(manager, '_showOsdWindow');
        this._speakerOsdWrapper = (monitorIndex, icon, label, level, maxLevel) => {
            const isSpeaker = icon?.get_names?.()?.some(name =>
                /^audio-volume-(muted|low|medium|high|overamplified)(-symbolic)?$/.test(name)) ?? false;
            const shownLabel = isSpeaker && Number.isFinite(level)
                ? String(Math.round(level * 100)) : label;
            return this._originalShowOsdWindow.call(manager,
                monitorIndex, icon, shownLabel, level, maxLevel);
        };
        manager._showOsdWindow = this._speakerOsdWrapper;
    }

    _restoreSpeakerOSD() {
        const manager = Main.osdWindowManager;
        if (!this._originalShowOsdWindow ||
            manager._showOsdWindow !== this._speakerOsdWrapper)
            return;
        if (this._originalShowOsdWindowOwn)
            manager._showOsdWindow = this._originalShowOsdWindow;
        else
            delete manager._showOsdWindow;
        this._speakerOsdWrapper = null;
        this._originalShowOsdWindow = null;
    }

    _patchSpeakerSlider(item) {
        this._speakerQuickItem = item;
        this._originalSpeakerSliderChanged = item._sliderChanged;
        this._originalSpeakerSliderChangedOwn = Object.hasOwn(item, '_sliderChanged');
        this._speakerSliderWrapper = (...args) => {
            this._originalSpeakerSliderChanged.apply(item, args);
            // GNOME blocks this handler when synchronizing backend volume updates.
            if (item.stream)
                item.showOSD();
        };
        item._sliderChanged = this._speakerSliderWrapper;
    }

    _restoreSpeakerSlider() {
        const item = this._speakerQuickItem;
        if (item?._sliderChanged === this._speakerSliderWrapper) {
            if (this._originalSpeakerSliderChangedOwn)
                item._sliderChanged = this._originalSpeakerSliderChanged;
            else
                delete item._sliderChanged;
        }
        this._speakerQuickItem = null;
        this._speakerSliderWrapper = null;
        this._originalSpeakerSliderChanged = null;
    }

    _scheduleQuickSettingsMenus() {
        if (this._menuSetupId)
            return;
        const currentScreen = Main.panel.statusArea.quickSettings?._brightness
            ?.quickSettingsItems?.[0];
        if (this._screenQuickItem && this._screenQuickItem !== currentScreen)
            this._removeScreenAutoSwitch();
        if (this._screenAutoMenuItem && this._keyboardAutoMenuItem && this._speakerQuickItem)
            return;
        this._menuAttempts = 0;
        this._menuSetupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100,
            () => {
                const quickSettings = Main.panel.statusArea.quickSettings;
                const screen = quickSettings?._brightness?.quickSettingsItems?.[0];
                const keyboard = quickSettings?._backlight?.quickSettingsItems?.[0];
                const speaker = quickSettings?._volumeOutput?.quickSettingsItems?.[0];
                if (speaker && !this._speakerQuickItem)
                    this._patchSpeakerSlider(speaker);

                if (this._screenQuickItem && this._screenQuickItem !== screen)
                    this._removeScreenAutoSwitch();
                if (screen && !this._screenAutoMenuItem)
                    this._addScreenAutoSwitch(screen);
                if (keyboard && !this._keyboardAutoMenuItem)
                    this._addKeyboardAutoSwitch(keyboard);

                this._menuAttempts++;
                if ((this._screenAutoMenuItem && this._keyboardAutoMenuItem && this._speakerQuickItem) ||
                    this._menuAttempts >= 100) {
                    this._menuSetupId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
    }

    _addScreenAutoSwitch(item) {
        if (!item.menu || !item._monitorBrightnessSection)
            return;
        const switchItem = new PopupMenu.PopupSwitchMenuItem(
            'Auto Brightness', this._autoEnabled);
        switchItem.connect('toggled', (_item, state) => {
            if (state !== this._settings.get_boolean('enabled'))
                this._settings.set_boolean('enabled', state);
        });
        item.menu.addMenuItem(switchItem, 0);
        this._screenQuickItem = item;
        this._screenSectionWasVisible = item._monitorBrightnessSection.actor.visible;
        this._screenAutoMenuItem = switchItem;
        this._screenMenuEnabledId = item.connect('notify::menu-enabled', () => {
            if (!this._destroyed && this._screenQuickItem === item &&
                !item.menuEnabled)
                this._keepScreenMenuAvailable();
        });
        this._screenQuickItemDestroyId = item.connect('destroy', () => {
            if (this._screenQuickItem !== item)
                return;
            this._screenQuickItem = null;
            this._screenMenuEnabledId = 0;
            this._screenQuickItemDestroyId = 0;
            this._screenSectionWasVisible = null;
            this._screenAutoMenuItem = null;
            this._screenAutoMenuItemDestroyId = 0;
            if (!this._destroyed)
                this._scheduleQuickSettingsMenus();
        });
        this._screenAutoMenuItemDestroyId = switchItem.connect('destroy', () => {
            if (this._screenAutoMenuItem !== switchItem)
                return;
            this._screenAutoMenuItem = null;
            this._screenAutoMenuItemDestroyId = 0;
            if (!this._destroyed)
                this._scheduleQuickSettingsMenus();
        });
        this._keepScreenMenuAvailable();
    }

    _removeScreenAutoSwitch() {
        const item = this._screenQuickItem;
        if (item && this._screenMenuEnabledId)
            item.disconnect(this._screenMenuEnabledId);
        if (item && this._screenQuickItemDestroyId)
            item.disconnect(this._screenQuickItemDestroyId);
        this._screenMenuEnabledId = 0;
        this._screenQuickItemDestroyId = 0;

        const switchItem = this._screenAutoMenuItem;
        if (switchItem && this._screenAutoMenuItemDestroyId)
            switchItem.disconnect(this._screenAutoMenuItemDestroyId);
        this._screenAutoMenuItemDestroyId = 0;
        this._screenAutoMenuItem = null;
        switchItem?.destroy();

        if (item) {
            item.menuEnabled = this._manager.scales.length > 1;
            const section = item._monitorBrightnessSection?.actor;
            if (section && this._screenSectionWasVisible !== null)
                section.visible = this._screenSectionWasVisible;
        }
        this._screenQuickItem = null;
        this._screenSectionWasVisible = null;
    }

    _keepScreenMenuAvailable() {
        if (!this._screenQuickItem)
            return;
        if (!this._screenQuickItem.menuEnabled)
            this._screenQuickItem.menuEnabled = true;
        const section = this._screenQuickItem._monitorBrightnessSection?.actor;
        if (section)
            section.visible = this._manager.scales.length > 1;
    }

    _addKeyboardAutoSwitch(item) {
        if (!item.menu || !this._keyboard)
            return;
        const switchItem = new PopupMenu.PopupSwitchMenuItem(
            'Auto Brightness', this._keyboard.autoEnabled);
        switchItem.connect('toggled', (_item, state) => {
            if (state !== this._keyboard.autoEnabled)
                this._keyboard.setAutoEnabled(state);
        });
        item.menu.addMenuItem(switchItem, 0);
        this._keyboardAutoMenuItem = switchItem;
        this._keyboardQuickItem = item;
        this._installKeyboardManualHandlers(item);
        this._syncKeyboardToggle();
    }

    _installKeyboardManualHandlers(item) {
        // Replace only the native manual-write callbacks. GNOME's _sync()
        // blocks these IDs while displaying automatic/property updates, so
        // those updates cannot be mistaken for a user dragging the slider.
        this._keyboardOriginalSubtitle = item.subtitle;
        this._keyboardDragging = false;
        const slider = item._sliderItem._slider;
        this._keyboardDragBeginId = slider.connect('drag-begin', () => {
            this._keyboardDragging = true;
        });
        this._keyboardDragEndId = slider.connect('drag-end', () => {
            this._keyboardDragging = false;
            this._syncKeyboardToggle();
        });
        // GNOME's own property-change callback also moves the thumb. Its
        // intermediate fade acknowledgements must not override user input.
        this._keyboardOriginalSync = item._sync;
        this._keyboardOriginalSyncOwn = Object.hasOwn(item, '_sync');
        this._keyboardSyncWrapper = () => {
            if (!this._keyboardDragging && this._keyboard?.manualTarget == null)
                this._keyboardOriginalSync.call(item);
            this._syncKeyboardToggle();
        };
        item._sync = this._keyboardSyncWrapper;
        this._keyboardOriginalSliderId = item._sliderItemChangedId;
        this._keyboardOriginalDiscreteId = item._discreteItemChangedId;
        item._sliderItem.block_signal_handler(this._keyboardOriginalSliderId);
        item._discreteItem.block_signal_handler(this._keyboardOriginalDiscreteId);
        this._keyboardSliderId = item._sliderItem.connect('notify::value', () => {
            if (item._sliderItem.visible)
                this._keyboard?.setManualLevel(item._sliderItem.value);
        });
        this._keyboardDiscreteId = item._discreteItem.connect('notify::value', () => {
            if (item._discreteItem.visible)
                this._keyboard?.setManualLevel(item._discreteItem.value);
        });
        item._sliderItemChangedId = this._keyboardSliderId;
        item._discreteItemChangedId = this._keyboardDiscreteId;
    }

    _restoreKeyboardManualHandlers() {
        const item = this._keyboardQuickItem;
        if (!item)
            return;
        const slider = item._sliderItem._slider;
        if (this._keyboardDragBeginId)
            slider.disconnect(this._keyboardDragBeginId);
        if (this._keyboardDragEndId)
            slider.disconnect(this._keyboardDragEndId);
        this._keyboardDragBeginId = 0;
        this._keyboardDragEndId = 0;
        this._keyboardDragging = false;
        if (item._sync === this._keyboardSyncWrapper) {
            if (this._keyboardOriginalSyncOwn)
                item._sync = this._keyboardOriginalSync;
            else
                delete item._sync;
        }
        this._keyboardOriginalSync = null;
        this._keyboardSyncWrapper = null;
        item.subtitle = this._keyboardOriginalSubtitle;
        if (this._keyboardSliderId) {
            item._sliderItem.disconnect(this._keyboardSliderId);
            item._sliderItemChangedId = this._keyboardOriginalSliderId;
            item._sliderItem.unblock_signal_handler(this._keyboardOriginalSliderId);
        }
        if (this._keyboardDiscreteId) {
            item._discreteItem.disconnect(this._keyboardDiscreteId);
            item._discreteItemChangedId = this._keyboardOriginalDiscreteId;
            item._discreteItem.unblock_signal_handler(this._keyboardOriginalDiscreteId);
        }
        this._keyboardSliderId = 0;
        this._keyboardDiscreteId = 0;
    }
}
