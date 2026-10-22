// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {limitedCurve, normalizePreferences, preferredBrightness} from './brightnessModel.js';

const SPEEDS = [['subtle', 'Subtle'], ['normal', 'Normal'], ['fast', 'Fast']];
const SENSITIVITIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']];
const IDLE_TIMEOUTS = [[0, 'Off'], [5, '5 seconds'], [10, '10 seconds'],
    [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes']];
const GRAPH_MAX_LUX = 2000;
const KEYBOARD_KEYS = ['keyboard-idle-timeout', 'keyboard-dark-lux'];

// Signal connections made by the window, released when it closes.
const connections = [];
function track(object, signal, callback) {
    connections.push([object, object.connect(signal, callback)]);
}

// Bind a ComboRow to a settings key through a fixed list of [value, label].
function comboRow(settings, key, title, subtitle, choices, read, write) {
    const row = new Adw.ComboRow({
        title, subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const sync = () => {
        const index = choices.findIndex(([value]) => value === read(key));
        row.selected = Math.max(0, index);
    };
    sync();
    row.connect('notify::selected', () => {
        const [value] = choices[row.selected] ?? choices[0];
        if (value !== read(key))
            write(key, value);
    });
    track(settings, `changed::${key}`, sync);
    return row;
}

function percentRow(settings, key, title, subtitle, onChanged = () => {}) {
    const row = Adw.SpinRow.new_with_range(0, 100, 1);
    Object.assign(row, {title, subtitle});
    const sync = () => {
        row.value = settings.get_int(key);
    };
    sync();
    row.connect('notify::value', () => {
        const value = Math.round(row.value);
        if (value !== settings.get_int(key)) {
            settings.set_int(key, value);
            onChanged(value);
        }
    });
    track(settings, `changed::${key}`, sync);
    return row;
}

function readAnchors(settings) {
    try {
        const anchors = JSON.parse(settings.get_string('anchors'));
        return Array.isArray(anchors)
            ? normalizePreferences(anchors.filter(a => Number.isFinite(a?.lux) &&
                a.lux >= 0 && Number.isFinite(a?.brightness)))
            : [];
    } catch {
        return [];
    }
}

function curveGraph(settings) {
    const area = new Gtk.DrawingArea({content_height: 180, hexpand: true,
        margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12});
    const toX = (lux, width) => Math.log1p(lux) / Math.log1p(GRAPH_MAX_LUX) * width;
    area.set_draw_func((_area, cr, fullWidth, fullHeight) => {
        // Leave room for the percentage labels and the anchor dots.
        const left = 34;
        const pad = 6;
        const width = fullWidth - left - pad;
        const height = fullHeight - 2 * pad;
        cr.translate(left, pad);
        const fg = area.get_color();
        const accent = Adw.StyleManager.get_default().get_accent_color_rgba();
        const limits = {
            min: settings.get_int('screen-min-brightness') / 100,
            max: settings.get_int('screen-max-brightness') / 100,
        };
        const anchors = readAnchors(settings);
        const plot = brightness => {
            for (let px = 0; px <= width; px += 2) {
                const lux = Math.expm1(px / width * Math.log1p(GRAPH_MAX_LUX));
                const y = height - brightness(lux) * height;
                if (px === 0)
                    cr.moveTo(px, y);
                else
                    cr.lineTo(px, y);
            }
            cr.stroke();
        };

        cr.setLineWidth(1);
        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.15);
        for (const lux of [1, 10, 100, 1000]) {
            cr.moveTo(toX(lux, width), 0);
            cr.lineTo(toX(lux, width), height);
        }
        cr.stroke();

        cr.moveTo(0, 0);
        cr.lineTo(width, 0);
        cr.moveTo(0, height);
        cr.lineTo(width, height);
        cr.stroke();

        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.6);
        cr.setFontSize(11);
        for (const lux of [1, 10, 100, 1000]) {
            cr.moveTo(toX(lux, width) + 4, height - 4);
            cr.showText(`${lux} lux`);
        }
        for (const [label, y] of [['100%', 10], ['0%', height]]) {
            cr.moveTo(-left, y);
            cr.showText(label);
        }

        cr.setDash([4, 4], 0);
        cr.setLineWidth(1.5);
        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.45);
        plot(lux => limitedCurve(lux, limits));
        cr.setDash([], 0);

        cr.setLineWidth(2.5);
        cr.setSourceRGBA(accent.red, accent.green, accent.blue, 1);
        plot(lux => preferredBrightness(lux, anchors, limits));
        for (const anchor of anchors) {
            cr.arc(toX(Math.min(anchor.lux, GRAPH_MAX_LUX), width),
                height - anchor.brightness * height, 4.5, 0, 2 * Math.PI);
            cr.fill();
        }
        cr.$dispose();
    });
    const redraw = () => area.queue_draw();
    for (const key of ['anchors', 'screen-min-brightness', 'screen-max-brightness'])
        track(settings, `changed::${key}`, redraw);
    track(Adw.StyleManager.get_default(), 'notify::accent-color', redraw);
    // A row keeps the graph inside the group's card, above the reset button.
    return new Adw.PreferencesRow({child: area, activatable: false});
}

export default class LuxCapacitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        const getString = key => settings.get_string(key);
        const setString = (key, value) => settings.set_string(key, value);
        const getInt = key => settings.get_int(key);
        const setInt = (key, value) => settings.set_int(key, value);
        const page = new Adw.PreferencesPage();

        const screen = new Adw.PreferencesGroup({title: 'Screen'});
        screen.add(comboRow(settings, 'transition-speed', 'Transition speed',
            'Subtle changes brightness gradually, like a Mac', SPEEDS, getString, setString));
        screen.add(comboRow(settings, 'light-sensitivity', 'Light sensitivity',
            'How much the light must change before brightness moves',
            SENSITIVITIES, getString, setString));
        screen.add(percentRow(settings, 'screen-min-brightness', 'Minimum brightness',
            'Lowest level Auto chooses by itself, in percent', value => {
                if (value > settings.get_int('screen-max-brightness'))
                    settings.set_int('screen-max-brightness', value);
            }));
        screen.add(percentRow(settings, 'screen-max-brightness', 'Maximum brightness',
            'Highest level Auto chooses by itself, in percent', value => {
                if (value < settings.get_int('screen-min-brightness'))
                    settings.set_int('screen-min-brightness', value);
            }));
        const battery = new Adw.SwitchRow({title: 'Slightly dim on battery',
            subtitle: 'Saves power while unplugged'});
        settings.bind('dim-on-battery', battery, 'active', Gio.SettingsBindFlags.DEFAULT);
        screen.add(battery);
        page.add(screen);

        const learned = new Adw.PreferencesGroup({title: 'Learned brightness',
            description: 'Dashed: default curve. Solid: what Auto uses, including your ' +
                'adjustments (dots). Turning screen Auto off also resets it.'});
        learned.add(curveGraph(settings));
        const resetScreen = new Adw.ButtonRow({title: 'Reset Learned Screen Brightness'});
        resetScreen.add_css_class('destructive-action');
        resetScreen.connect('activated', () => {
            settings.set_string('anchors', '[]');
            settings.set_string('anchor-unit', '');
            window.add_toast(new Adw.Toast({title: 'Learned screen brightness reset'}));
        });
        learned.add(resetScreen);
        page.add(learned);

        const keyboard = new Adw.PreferencesGroup({title: 'Keyboard',
            description: 'Fn+Space and the keyboard slider always switch to a manual level ' +
                'and turn keyboard Auto off.'});
        keyboard.add(comboRow(settings, 'keyboard-idle-timeout', 'Turn off when idle',
            'Only when Auto turned the light on', IDLE_TIMEOUTS, getInt, setInt));
        const dark = Adw.SpinRow.new_with_range(1, 200, 1);
        Object.assign(dark, {title: 'Dark threshold',
            subtitle: 'Auto turns the light on below this many lux'});
        dark.value = settings.get_int('keyboard-dark-lux');
        dark.connect('notify::value', () => {
            const value = Math.round(dark.value);
            if (value !== settings.get_int('keyboard-dark-lux'))
                settings.set_int('keyboard-dark-lux', value);
        });
        track(settings, 'changed::keyboard-dark-lux', () => {
            dark.value = settings.get_int('keyboard-dark-lux');
        });
        keyboard.add(dark);
        const resetKeyboard = new Adw.ButtonRow({title: 'Reset Keyboard Settings'});
        resetKeyboard.connect('activated', () => {
            for (const key of KEYBOARD_KEYS)
                settings.reset(key);
            window.add_toast(new Adw.Toast({title: 'Keyboard settings reset'}));
        });
        keyboard.add(resetKeyboard);
        page.add(keyboard);

        window.add(page);
        window.connect('close-request', () => {
            for (const [object, id] of connections.splice(0))
                object.disconnect(id);
            return false;
        });
    }
}
