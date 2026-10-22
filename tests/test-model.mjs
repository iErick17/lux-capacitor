// SPDX-License-Identifier: GPL-3.0-or-later
import {curve, preferredBrightness, upsertPreference, advanceBrightness, MAX_PREFERENCES,
    normalizePreferences, significantLuxChange, limitedCurve} from '../lux-capacitor@extensions/brightnessModel.js';
function assert(ok, message) { if (!ok) throw new Error(message); }
assert(curve(0) === 0.08 && curve(1600) === 1, 'Default curve endpoints changed');
let previous = 0;
for (let lux = 0; lux <= 2000; lux++) {
    const value = curve(lux);
    assert(value >= previous && value <= 1, 'Default curve is not monotone');
    previous = value;
}
const anchors = upsertPreference([], 40, 0.7);
assert(Math.abs(preferredBrightness(40, anchors) - 0.7) < 1e-9, 'Manual preference is not exact');
assert(advanceBrightness(0.2, 0.8, 0) === 0.2, 'Zero elapsed time changed brightness');
assert(advanceBrightness(0.2, 0.8, 1) > 0.2 && advanceBrightness(0.2, 0.8, 1) < 0.8, 'Brightness ramp overshot');
let preferences = [];
for (let i = 0; i < 50; i++) preferences = upsertPreference(preferences, 2 ** i, 0.5);
assert(preferences.length <= MAX_PREFERENCES, 'Preferences grew without bound');
for (const lux of [-1, NaN, Infinity]) {
    let rejected = false;
    try { curve(lux); } catch { rejected = true; }
    assert(rejected, 'Invalid light reading was accepted');
}
function largestDip(anchors) {
    let highest = 0;
    let dip = 0;
    for (let lux = 0; lux <= 2000; lux += lux < 50 ? 0.25 : 2) {
        const value = preferredBrightness(lux, anchors);
        dip = Math.max(dip, highest - value);
        highest = Math.max(highest, value);
    }
    return dip;
}
for (const [lux, brightness] of [[40, 0.9], [40, 0.1], [500, 0.3], [5, 0.6]]) {
    const single = upsertPreference([], lux, brightness);
    assert(largestDip(single) < 1e-9, `Brightness fell in brighter light around ${lux} lux`);
    assert(Math.abs(preferredBrightness(lux, single) - brightness) < 1e-9, 'Single preference is not exact');
}
const conflicting = upsertPreference(upsertPreference([], 40, 0.9), 150, 0.3);
assert(conflicting.length === 1 && largestDip(conflicting) < 1e-9, 'Contradicting nearby preference was kept');
assert(Math.abs(preferredBrightness(150, conflicting) - 0.3) < 1e-9, 'Newest preference did not win');
const consistent = upsertPreference(upsertPreference([], 40, 0.5), 500, 0.95);
assert(consistent.length === 2 && largestDip(consistent) < 1e-9, 'Consistent preferences were dropped');
const distant = upsertPreference(upsertPreference([], 2, 0.9), 1600, 0.2);
assert(distant.length === 2, 'Distant preference was erased');
let seed = 7;
const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
for (let run = 0; run < 100; run++) {
    let sequence = [];
    for (let i = 0; i < 10; i++)
        sequence = upsertPreference(sequence, Math.expm1(random() * 8), random());
    for (const anchor of sequence)
        assert(Math.abs(preferredBrightness(anchor.lux, sequence) - anchor.brightness) < 1e-9, 'Random preference is not exact');
    const sorted = [...sequence].sort((a, b) => a.lux - b.lux);
    if (sorted.every((anchor, i) => i === 0 || sorted[i - 1].brightness <= anchor.brightness))
        assert(largestDip(sequence) < 1e-9, 'Consistent random preferences produced a dip');
}
const normalized = normalizePreferences([{lux: 40, brightness: 0.9}, {lux: 150, brightness: 0.3}]);
assert(normalized.length === 1 && normalized[0].lux === 150, 'Stored contradictions were not resolved');
assert(significantLuxChange(null, 100) && significantLuxChange(100, 130), 'Real light change was ignored');
assert(!significantLuxChange(100, 105) && !significantLuxChange(0, 0.1), 'Sensor noise changed the target');
print('PASS: brightness curve, preferences, smoothing, bounds, and invalid readings');
print('PASS: monotone preferences, newest choice wins, stored cleanup, and lux dead zone');
for (const lux of [0, 5, 40, 500, 2000])
    assert(limitedCurve(lux) === curve(lux), 'Default limits changed the curve');
const limits = {min: 0.2, max: 0.7};
assert(limitedCurve(0, limits) === 0.2 && limitedCurve(2000, limits) === 0.7, 'Auto limits were ignored');
const outside = upsertPreference([], 40, 0.05);
assert(Math.abs(preferredBrightness(40, outside, limits) - 0.05) < 1e-9, 'Limits overrode a manual preference');
assert(preferredBrightness(2000, [], limits) === 0.7, 'Auto exceeded the maximum');
const step = speed => advanceBrightness(0.2, 0.8, 0.5, speed);
assert(step('subtle') < step('normal') && step('normal') < step('fast'), 'Transition speeds are not ordered');
assert(step(undefined) === step('normal'), 'Default speed changed');
assert(significantLuxChange(100, 110, 'high') && !significantLuxChange(100, 110, 'normal'), 'High sensitivity ignored a change');
assert(!significantLuxChange(100, 125, 'low') && significantLuxChange(100, 125, 'normal'), 'Low sensitivity reacted to a small change');
print('PASS: Auto limits, transition speeds, and light sensitivity');

