import {curve, preferredBrightness, upsertPreference, advanceBrightness, MAX_PREFERENCES} from '../adaptive-brightness-v2@codex.local/brightnessModel.js';
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
print('PASS: brightness curve, preferences, smoothing, bounds, and invalid readings');

