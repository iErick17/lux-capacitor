// SPDX-License-Identifier: GPL-3.0-or-later
// Pure brightness policy shared by the GNOME extension and its tests.
// Automatic defaults start at 8%, while a manual preference may use 0%.
export const MIN_BRIGHTNESS = 0;
export const MAX_BRIGHTNESS = 1;
export const MAX_PREFERENCES = 24;
export const BATTERY_DIM_FACTOR = 0.85;
// Multipliers for the brightening and darkening time constants.
export const TRANSITION_SPEEDS = Object.freeze({subtle: 2, normal: 1, fast: 0.5});

const RISE_TIME_CONSTANT_SECONDS = 0.65;
const FALL_TIME_CONSTANT_SECONDS = 2.5;
const MERGE_LOG_DISTANCE = Math.log(1.3);
const PREFERENCE_RADIUS = 1.5;
// Preferences closer than this (about 20x lux) must agree on direction.
const CONSISTENCY_WINDOW = 3;
const SAMPLE_STEP = 0.05;
// Relative light change needed before the screen re-targets.
const LUX_DEADBANDS = Object.freeze({
    low: Math.log(1.3),
    normal: Math.log(1.15),
    high: Math.log(1.07),
});

// These values are display fractions, not raw backlight register values.
const DEFAULT_CURVE = [
    [0, 0.08],
    [2, 0.12],
    [10, 0.23],
    [40, 0.4],
    [150, 0.62],
    [500, 0.82],
    [1600, 1],
];

function validLux(lux) {
    if (typeof lux !== 'number' || !Number.isFinite(lux) || lux < 0)
        throw new RangeError('lux must be a finite, nonnegative number');
    return lux;
}

function validFinite(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new RangeError(`${name} must be a finite number`);
    return value;
}

function clampBrightness(value) {
    return Math.min(MAX_BRIGHTNESS, Math.max(MIN_BRIGHTNESS, value));
}

function logLux(lux) {
    return Math.log1p(validLux(lux));
}

function checkedAnchors(anchors) {
    if (!Array.isArray(anchors))
        throw new TypeError('anchors must be an array');

    return anchors.map(anchor => {
        if (anchor === null || typeof anchor !== 'object')
            throw new TypeError('each anchor must be an object');
        const lux = validLux(anchor.lux);
        const brightness = clampBrightness(validFinite(anchor.brightness, 'anchor brightness'));
        return {lux, brightness, x: logLux(lux)};
    });
}

/** Default, monotone mapping from ambient lux to a display brightness fraction. */
export function curve(lux) {
    const x = logLux(lux);

    for (let i = 1; i < DEFAULT_CURVE.length; i++) {
        const [rightLux, rightBrightness] = DEFAULT_CURVE[i];
        if (lux <= rightLux) {
            const [leftLux, leftBrightness] = DEFAULT_CURVE[i - 1];
            const fraction = (x - Math.log1p(leftLux)) /
                (Math.log1p(rightLux) - Math.log1p(leftLux));
            return clampBrightness(leftBrightness +
                fraction * (rightBrightness - leftBrightness));
        }
    }

    return MAX_BRIGHTNESS;
}

/**
 * The default curve kept within the user's Auto limits. Limits only shape
 * the default; an explicit manual preference is still honored exactly.
 */
export function limitedCurve(lux, {min = MIN_BRIGHTNESS, max = MAX_BRIGHTNESS} = {}) {
    const low = clampBrightness(Math.min(min, max));
    const high = clampBrightness(Math.max(min, max));
    return Math.min(high, Math.max(low, curve(lux)));
}

// Default curve plus fading anchor offsets. Not monotone by itself: a
// preference's offset can fade faster than the default curve rises.
function blendedBrightness(x, anchors, limits) {
    const base = limitedCurve(Math.expm1(x), limits);
    let offset;
    let distance;
    if (x <= anchors[0].x) {
        offset = anchors[0].offset;
        distance = anchors[0].x - x;
    } else if (x >= anchors[anchors.length - 1].x) {
        offset = anchors[anchors.length - 1].offset;
        distance = x - anchors[anchors.length - 1].x;
    } else {
        const rightIndex = anchors.findIndex(anchor => anchor.x >= x);
        const left = anchors[rightIndex - 1];
        const right = anchors[rightIndex];
        const fraction = (x - left.x) / (right.x - left.x);
        offset = left.offset + fraction * (right.offset - left.offset);
        distance = Math.min(x - left.x, right.x - x);
    }

    const influence = Math.exp(-Math.pow(distance / PREFERENCE_RADIUS, 2));
    return clampBrightness(base + offset * influence);
}

/**
 * Apply manual preferences as local offsets from the default curve in log-lux
 * space. A stored anchor is exact at its lux; its influence fades away outside
 * the measured neighborhood instead of shifting the entire curve. Brightness
 * never falls as light rises, except midway between two distant preferences
 * that ask for that explicitly.
 */
export function preferredBrightness(lux, anchors = [], limits = {}) {
    const x = logLux(lux);
    const sorted = checkedAnchors(anchors)
        .sort((a, b) => a.x - b.x)
        .map(anchor => ({...anchor,
            offset: anchor.brightness - limitedCurve(anchor.lux, limits)}));
    if (sorted.length === 0)
        return limitedCurve(lux, limits);

    // Split at contradicting neighbours; each segment is consistent.
    let segmentStart = 0;
    let first = 0;
    let last = sorted.length - 1;
    for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i].brightness <= sorted[i + 1].brightness)
            continue;
        const boundary = (sorted[i].x + sorted[i + 1].x) / 2;
        if (x < boundary) {
            last = i;
            break;
        }
        segmentStart = boundary;
        first = i + 1;
    }
    const segment = sorted.slice(first, last + 1);

    // Running maximum on a fixed log-lux grid, interpolated between grid
    // points, removes dips while staying continuous and monotone.
    let level = blendedBrightness(segmentStart, segment, limits);
    let previousX = segmentStart;
    let k = Math.floor(segmentStart / SAMPLE_STEP) + 1;
    for (; k * SAMPLE_STEP <= x; k++) {
        previousX = k * SAMPLE_STEP;
        level = Math.max(level, blendedBrightness(previousX, segment, limits));
    }
    const nextX = k * SAMPLE_STEP;
    const nextLevel = Math.max(level, blendedBrightness(nextX, segment, limits));
    level += (nextLevel - level) * (x - previousX) / (nextX - previousX);

    // Clamping between neighbouring anchors keeps each one exact.
    let lower = MIN_BRIGHTNESS;
    let upper = MAX_BRIGHTNESS;
    for (const anchor of segment) {
        if (anchor.x <= x)
            lower = Math.max(lower, anchor.brightness);
        if (anchor.x >= x)
            upper = Math.min(upper, anchor.brightness);
    }
    return clampBrightness(Math.min(upper, Math.max(lower, level)));
}

/** Return a new, recency-ordered anchor list after a manual adjustment. */
export function upsertPreference(anchors, lux, desired) {
    const x = logLux(lux);
    const brightness = clampBrightness(validFinite(desired, 'desired brightness'));
    const existing = checkedAnchors(anchors);

    let nearestIndex = -1;
    let nearestDistance = Infinity;
    for (let i = 0; i < existing.length; i++) {
        const distance = Math.abs(existing[i].x - x);
        if (distance < nearestDistance) {
            nearestIndex = i;
            nearestDistance = distance;
        }
    }

    // A nearby older preference asking for brighter in dimmer light (or the
    // reverse) contradicts the new one, so the newest choice wins.
    const contradicts = anchor => Math.abs(anchor.x - x) <= CONSISTENCY_WINDOW &&
        (anchor.x < x ? anchor.brightness > brightness : anchor.brightness < brightness);

    // Replacing a nearby anchor also makes it the most recently used one.
    const updated = existing
        .filter((anchor, i) => (i !== nearestIndex || nearestDistance > MERGE_LOG_DISTANCE) &&
            !contradicts(anchor))
        .map(anchor => ({lux: anchor.lux, brightness: anchor.brightness}));
    updated.push({lux, brightness});
    return updated.slice(-MAX_PREFERENCES);
}

/** Replay stored anchors in recency order so older conflicts are resolved. */
export function normalizePreferences(anchors) {
    return checkedAnchors(anchors).reduce((result, anchor) =>
        upsertPreference(result, anchor.lux, anchor.brightness), []);
}

/** Ignore small sensor fluctuations, as a fraction of the current light. */
export function significantLuxChange(previousLux, lux, sensitivity = 'normal') {
    if (previousLux === null || previousLux === undefined)
        return true;
    const deadband = LUX_DEADBANDS[sensitivity] ?? LUX_DEADBANDS.normal;
    return Math.abs(logLux(lux) - logLux(previousLux)) >= deadband;
}

/** First-order response: quick brightening, gentler darkening. */
export function advanceBrightness(current, target, dtSeconds, speed = 'normal') {
    const from = clampBrightness(validFinite(current, 'current brightness'));
    const to = clampBrightness(validFinite(target, 'target brightness'));
    const dt = validFinite(dtSeconds, 'elapsed time');
    if (dt < 0)
        throw new RangeError('elapsed time must be nonnegative');
    if (dt === 0 || from === to)
        return from;

    const timeConstant = (to > from
        ? RISE_TIME_CONSTANT_SECONDS
        : FALL_TIME_CONSTANT_SECONDS) *
        (TRANSITION_SPEEDS[speed] ?? TRANSITION_SPEEDS.normal);
    const fraction = -Math.expm1(-dt / timeConstant);
    return clampBrightness(from + (to - from) * fraction);
}
