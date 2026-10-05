/**
 * Shared test helpers: a simple geometric face model plus the detector loader.
 *
 * The face is modelled as a nose tip sitting a fixed distance below an eye
 * midpoint, rotating about a horizontal axis through that midpoint. That is
 * enough structure to exercise the detector's geometry without a webcam, and it
 * keeps the tests honest about what the signal actually does under pitch.
 *
 * Scenarios are written as pitch angles in degrees rather than raw signal
 * values, because pitch is what a player does and it keeps the numbers
 * meaningful as the detector's internal scaling changes.
 */

const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'nodDetector.js'),
  'utf8'
);
// eslint-disable-next-line no-new-func
new Function(source)();

const FRAME_MS = 1000 / 30;

// Reference face proportions at scale 1.
const REF_EYE_DIST = 0.12;
const REF_NOSE_BELOW_EYES = 0.07;

/**
 * Landmark points for a face.
 *
 * @param {number} pitchDeg Downward pitch in degrees.
 * @param {object} [opts]
 * @param {number} [opts.scale] Face size multiplier (1 = reference).
 * @param {number} [opts.rollDeg] Head roll in degrees.
 * @param {number} [opts.noseBelowEyes] Override the resting nose-to-eye gap.
 */
function face(pitchDeg, opts = {}) {
  const { scale = 1, rollDeg = 0, noseBelowEyes = REF_NOSE_BELOW_EYES } = opts;

  const eyeMidY = 0.45;
  const eyeDist = REF_EYE_DIST * scale;
  const gap = noseBelowEyes * scale;
  const roll = (rollDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;

  const cosRoll = Math.cos(roll);
  const sinRoll = Math.sin(roll);

  // Pitching foreshortens the face, so the projected gap shrinks by cos(pitch).
  const projectedGap = gap * Math.cos(pitch);

  return {
    leftEye: { x: (-eyeDist / 2) * cosRoll, y: eyeMidY + (eyeDist / 2) * sinRoll },
    rightEye: { x: (eyeDist / 2) * cosRoll, y: eyeMidY - (eyeDist / 2) * sinRoll },
    noseTip: { x: projectedGap * sinRoll, y: eyeMidY + projectedGap * cosRoll },
  };
}

/** A full nod: rest, down to `deg`, and back up. */
function nodProfile(deg = 25, restFrames = 5) {
  return [
    ...new Array(restFrames).fill(0),
    5, 15, deg, deg * 0.8, deg * 0.5, deg * 0.2, 0,
    ...new Array(restFrames).fill(0),
  ];
}

/** Rest frames at pitch 0. */
function rest(n) {
  return new Array(n).fill(0);
}

/**
 * Feed a pitch profile through the detector.
 *
 * @param {Array<number>} pitches Pitch per frame, in degrees.
 * @param {object} [opts]
 * @param {object} [opts.detectorOptions] Passed to the NodDetector constructor.
 * @param {number|function} [opts.rollDeg] Constant roll, or a per-frame function.
 * @param {number} [opts.scale] Face size multiplier.
 * @returns {{triggers: number[], detector: object, debug: object|null}}
 */
function run(pitches, opts = {}) {
  const { detectorOptions = {}, rollDeg = 0, scale = 1 } = opts;
  const detector = new globalThis.NodDetector(detectorOptions);
  const triggers = [];
  let debug = null;

  pitches.forEach((pitchDeg, frame) => {
    const roll = typeof rollDeg === 'function' ? rollDeg(frame) : rollDeg;
    const result = detector.update(
      face(pitchDeg, { scale, rollDeg: roll }),
      frame * FRAME_MS
    );
    if (result.triggered) {
      triggers.push(frame);
    }
    debug = result.debug;
  });

  return { triggers, detector, debug };
}

/** Deterministic PRNG so a failing fuzz case can always be reproduced. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

module.exports = {
  NodDetector: globalThis.NodDetector,
  NOD_DETECTOR_STATES: globalThis.NOD_DETECTOR_STATES,
  FRAME_MS,
  REF_EYE_DIST,
  REF_NOSE_BELOW_EYES,
  face,
  nodProfile,
  rest,
  run,
  makeRandom,
};