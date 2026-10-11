// SPDX-License-Identifier: GPL-3.0-or-later
// Pure brightness policy shared by the GNOME extension and its tests.
// Automatic defaults start at 8%, while a manual preference may use 0%.
export const MIN_BRIGHTNESS = 0;
export const MAX_BRIGHTNESS = 1;
export const MAX_PREFERENCES = 24;

const RISE_TIME_CONSTANT_SECONDS = 0.65;
const FALL_TIME_CONSTANT_SECONDS = 2.5;
const MERGE_LOG_DISTANCE = Math.log(1.3);
const PREFERENCE_RADIUS = 1.5;

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
 * Apply manual preferences as local offsets from the default curve in log-lux
 * space. A stored anchor is exact at its lux; its influence fades away outside
 * the measured neighborhood instead of shifting the entire curve.
 */
export function preferredBrightness(lux, anchors = []) {
    const x = logLux(lux);
    const base = curve(lux);
    const sorted = checkedAnchors(anchors).sort((a, b) => a.x - b.x);
    if (sorted.length === 0)
        return base;

    let offset;
    let distance;
    if (x <= sorted[0].x) {
        const anchor = sorted[0];
        offset = anchor.brightness - curve(anchor.lux);
        distance = anchor.x - x;
    } else if (x >= sorted[sorted.length - 1].x) {
        const anchor = sorted[sorted.length - 1];
        offset = anchor.brightness - curve(anchor.lux);
        distance = x - anchor.x;
    } else {
        const rightIndex = sorted.findIndex(anchor => anchor.x >= x);
        const left = sorted[rightIndex - 1];
        const right = sorted[rightIndex];
        const fraction = (x - left.x) / (right.x - left.x);
        const leftOffset = left.brightness - curve(left.lux);
        const rightOffset = right.brightness - curve(right.lux);
        offset = leftOffset + fraction * (rightOffset - leftOffset);
        distance = Math.min(x - left.x, right.x - x);
    }

    const influence = Math.exp(-Math.pow(distance / PREFERENCE_RADIUS, 2));
    return clampBrightness(base + offset * influence);
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

    // Replacing a nearby anchor also makes it the most recently used one.
    const updated = existing
        .filter((_, i) => i !== nearestIndex || nearestDistance > MERGE_LOG_DISTANCE)
        .map(anchor => ({lux: anchor.lux, brightness: anchor.brightness}));
    updated.push({lux, brightness});
    return updated.slice(-MAX_PREFERENCES);
}

/** First-order response: quick brightening, gentler darkening. */
export function advanceBrightness(current, target, dtSeconds) {
    const from = clampBrightness(validFinite(current, 'current brightness'));
    const to = clampBrightness(validFinite(target, 'target brightness'));
    const dt = validFinite(dtSeconds, 'elapsed time');
    if (dt < 0)
        throw new RangeError('elapsed time must be nonnegative');
    if (dt === 0 || from === to)
        return from;

    const timeConstant = to > from
        ? RISE_TIME_CONSTANT_SECONDS
        : FALL_TIME_CONSTANT_SECONDS;
    const fraction = -Math.expm1(-dt / timeConstant);
    return clampBrightness(from + (to - from) * fraction);
}
