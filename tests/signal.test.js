/**
 * Tests for the signal model.
 *
 * These are the ones that matter for the failure that shipped: the eye-relative
 * signal moves far less than a nod's raw displacement, so thresholds carried
 * over from the old raw-Y implementation were ~4x too large and suppressed
 * every normal nod.
 *
 * Geometry: the face is modelled as a nose tip sitting `d` below an eye
 * midpoint, rotating by `pitch` about a horizontal axis through that midpoint.
 * Projected into the image, the nose-to-eye vertical gap becomes
 * `d * cos(pitch)`. Dividing by interocular distance gives the eye-relative
 * signal directly.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'nodDetector.js'),
  'utf8'
);
// eslint-disable-next-line no-new-func
new Function(source)();
const { NodDetector } = globalThis;

const FRAME_MS = 1000 / 30;

/**
 * Landmark points for a face at a given pitch, eye distance and roll.
 *
 * @param {number} pitchDeg Downward pitch in degrees.
 * @param {number} eyeDist Interocular distance in normalised units.
 * @param {number} rollDeg Head roll in degrees.
 */
// Reference face at eyeDist 0.12, used to derive proportions.
const REF_EYE_DIST = 0.12;
const REF_NOSE_BELOW_EYES = 0.07;

/**
 * Landmark points for a face at a given pitch, size and roll.
 *
 * `scale` moves the whole face nearer or further from the camera. Every
 * dimension scales together, because that is what actually happens when a
 * player leans in: the nose-to-eye gap and the interocular distance grow in
 * proportion, and their ratio — which is all the detector uses — stays put.
 *
 * @param {number} pitchDeg Downward pitch in degrees.
 * @param {number} scale Interocular distance multiplier (1 = reference).
 * @param {number} rollDeg Head roll in degrees.
 */
function faceAt(pitchDeg, scale = 1, rollDeg = 0) {
  const eyeMidY = 0.45;
  const eyeDist = REF_EYE_DIST * scale;
  const noseBelowEyes = REF_NOSE_BELOW_EYES * scale;
  const roll = (rollDeg * Math.PI) / 180;
  const cosRoll = Math.cos(roll);
  const sinRoll = Math.sin(roll);
  const pitch = (pitchDeg * Math.PI) / 180;

  // Pitching about a horizontal axis through the eye midpoint swings the nose
  // along an arc; its vertical component shrinks by cos(pitch).
  const projectedGap = noseBelowEyes * Math.cos(pitch);

  return {
    leftEye: { x: (-eyeDist / 2) * cosRoll, y: eyeMidY + (eyeDist / 2) * sinRoll },
    rightEye: { x: (eyeDist / 2) * cosRoll, y: eyeMidY - (eyeDist / 2) * sinRoll },
    noseTip: {
      x: projectedGap * sinRoll,
      y: eyeMidY + projectedGap * cosRoll,
    },
  };
}

function runAt(pitches, options = {}) {
  const detector = new NodDetector(options);
  const triggers = [];
  let lastDebug = null;

  pitches.forEach((pitch, frame) => {
    const result = detector.update(faceAt(pitch), frame * FRAME_MS);
    if (result.triggered) {
      triggers.push(frame);
    }
    lastDebug = result.debug;
  });

  return { triggers, detector, debug: lastDebug };
}

/**
 * Synthetic MediaPipe facial-transformation matrix for a selected nose direction.
 *
 * Only the third column matters to the detector: it is the canonical
 * nose-forward axis expressed in runtime coordinates. The helper can add roll
 * around that axis, yaw in the horizontal plane, translation, and uniform scale
 * to prove that none of those changes the extracted nose pitch.
 */
function matrixForNosePitch(pitchDeg, opts = {}) {
  const {
    rollDeg = 0,
    yawDeg = 0,
    translation = [0, 0, 0],
    scale = 1,
  } = opts;
  const pitch = (pitchDeg * Math.PI) / 180;
  const yaw = (yawDeg * Math.PI) / 180;
  const roll = (rollDeg * Math.PI) / 180;

  // Nose-forward direction in metric coordinates: y is up, z points away from
  // the camera, and downward pitch is positive.
  const forward = [
    Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  ];

  // Build an orthonormal basis around that forward axis, then rotate the other
  // two axes by the requested roll.
  const reference = Math.abs(forward[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const normalize = (v) => {
    const length = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const first = normalize(cross(forward, reference));
  const second = cross(forward, first);
  const rolledFirst = [
    first[0] * Math.cos(roll) + second[0] * Math.sin(roll),
    first[1] * Math.cos(roll) + second[1] * Math.sin(roll),
    first[2] * Math.cos(roll) + second[2] * Math.sin(roll),
  ];
  const rolledSecond = [
    second[0] * Math.cos(roll) - first[0] * Math.sin(roll),
    second[1] * Math.cos(roll) - first[1] * Math.sin(roll),
    second[2] * Math.cos(roll) - first[2] * Math.sin(roll),
  ];

  const data = [
    rolledFirst[0] * scale, rolledFirst[1] * scale, rolledFirst[2] * scale, 0,
    rolledSecond[0] * scale, rolledSecond[1] * scale, rolledSecond[2] * scale, 0,
    forward[0] * scale, forward[1] * scale, forward[2] * scale, 0,
    translation[0], translation[1], translation[2], 1,
  ];

  return { rows: 4, columns: 4, data };
}

function runNosePitch(pitches, options = {}) {
  const detector = new NodDetector(options);
  const triggers = [];
  let lastDebug = null;

  pitches.forEach((pitch, frame) => {
    const result = detector.update(faceAt(0), frame * FRAME_MS, pitch);
    if (result.triggered) {
      triggers.push(frame);
    }
    lastDebug = result.debug;
  });

  return { triggers, detector, debug: lastDebug };
}

test('the eye-relative signal moves far less than a raw nod', () => {
  // Documents the scale mismatch that broke real-world detection.
  const detector = new NodDetector();

  detector.update(faceAt(0), 0);
  const atRest = detector.lastSignal;

  detector.update(faceAt(30), FRAME_MS);
  const at30 = detector.lastSignal;

  // Nodding down foreshortens the face, so the signal RISES (it is negated in
  // the detector). Travel is the nose-to-eye shrink, in eye-distance units.
  const travel = at30 - atRest;
  const expected =
    (REF_NOSE_BELOW_EYES * (1 - Math.cos((30 * Math.PI) / 180))) / REF_EYE_DIST;

  assert.ok(
    Math.abs(travel - expected) < 1e-9,
    `expected travel ${expected}, got ${travel}`
  );

  // The point of the test: ~0.05 eye-distances, where the old raw-Y threshold
  // of 0.040 would have needed a raw displacement an order of magnitude larger.
  assert.ok(travel > 0.03 && travel < 0.1, `travel out of range: ${travel}`);
});

test('a normal 25-degree nod is detected', () => {
  // Rest, dip to 25 degrees, come back up.
  const pitches = [0, 0, 0, 0, 0, 5, 15, 25, 20, 12, 5, 0, 0, 0];

  const { triggers } = runAt(pitches);

  assert.strictEqual(triggers.length, 1, `expected 1 trigger, got ${triggers.length}`);
});

test('a gentle 20-degree nod is detected', () => {
  const pitches = [0, 0, 0, 0, 0, 4, 12, 20, 15, 8, 3, 0, 0, 0];

  const { triggers } = runAt(pitches);

  assert.strictEqual(triggers.length, 1, `expected 1 trigger, got ${triggers.length}`);
});

test('a very large 50-degree dip is not a nod, it is looking down', () => {
  // Slow and deep: past the duration budget.
  const pitches = [0, 0, 0, 0, 0, 20, 40, 50, 50, 50, 50, 50, 50];

  const { triggers } = runAt(pitches);

  assert.strictEqual(triggers.length, 0, `expected no triggers, got ${triggers.length}`);
});

test('detection does not change with camera distance', () => {
  // Same nod at three sizes. Raw-normalised thresholds would make the far case
  // invisible; dividing by interocular distance should make all three identical.
  const pitches = [0, 0, 0, 0, 0, 5, 15, 25, 20, 12, 5, 0, 0, 0];
  const results = [0.5, 1, 2].map((scale) => {
    const detector = new NodDetector();
    let fired = false;

    pitches.forEach((pitch, frame) => {
      const result = detector.update(faceAt(pitch, scale), frame * FRAME_MS);
      if (result.triggered) {
        fired = true;
      }
    });

    return fired;
  });

  assert.deepStrictEqual(
    results,
    [true, true, true],
    `nod detection changed with camera distance: ${JSON.stringify(results)}`
  );
});

test('pitching down raises the signal, so a nod is a positive excursion', () => {
  const detector = new NodDetector();

  detector.update(faceAt(0), 0);
  const rest = detector.lastSignal;
  detector.update(faceAt(25), FRAME_MS);
  const nodded = detector.lastSignal;

  assert.ok(
    nodded > rest,
    `expected signal to rise on a nod: ${rest} -> ${nodded}`
  );
});

test('nose pitch follows the matrix forward vector in degrees', () => {
  for (const pitch of [-25, -10, 0, 10, 25]) {
    const measured = NodDetector.nosePitchFromFacialTransformationMatrix(
      matrixForNosePitch(pitch)
    );

    assert.ok(
      Math.abs(measured - pitch) < 1e-9,
      `expected ${pitch} degrees, got ${measured}`
    );
  }
});

test('translation, scale, roll, and yaw do not change nose pitch', () => {
  const baseline = NodDetector.nosePitchFromFacialTransformationMatrix(
    matrixForNosePitch(18)
  );
  const moved = NodDetector.nosePitchFromFacialTransformationMatrix(
    matrixForNosePitch(18, {
      rollDeg: 30,
      yawDeg: 20,
      translation: [12.5, -7.25, 43.75],
      scale: 6.2,
    })
  );

  assert.ok(
    Math.abs(moved - baseline) < 1e-9,
    `whole-head motion changed nose pitch: ${baseline} -> ${moved}`
  );
  assert.ok(Math.abs(moved - 18) < 1e-9, `expected 18 degrees, got ${moved}`);
});

test('a malformed transformation matrix falls back instead of producing a signal', () => {
  for (const matrix of [
    null,
    undefined,
    {},
    { rows: 4, columns: 4, data: [1, 0] },
    { rows: 4, columns: 4, data: new Array(16).fill(0) },
    {
      rows: 4,
      columns: 4,
      data: [1, 0, 0, 0, 0, 1, 0, 0, 0, Number.NaN, 0, 0, 0, 0, 0, 1],
    },
  ]) {
    assert.strictEqual(
      NodDetector.nosePitchFromFacialTransformationMatrix(matrix),
      null
    );
  }
});

test('a missing nose-pitch frame does not substitute the fallback signal', () => {
  const detector = new NodDetector();

  detector.update(faceAt(0), 0, 10);
  const result = detector.update(faceAt(0), FRAME_MS, null);

  assert.strictEqual(result.triggered, false);
  assert.strictEqual(result.debug.aborted, 'nose-pitch-unavailable');
  assert.strictEqual(detector.signalSource, 'nose-pitch');
});

test('a normal nose-pitch nod is detected in degrees', () => {
  const pitches = [0, 0, 0, 0, 0, 3, 8, 15, 20, 16, 10, 4, 0, 0, 0];

  const { triggers, debug } = runNosePitch(pitches);

  assert.strictEqual(triggers.length, 1, `expected 1 trigger, got ${triggers.length}`);
  assert.strictEqual(debug.signalSource, 'nose-pitch');
  assert.strictEqual(debug.signalUnit, 'nose-pitch-deg');
});

test('a gentle nose-pitch nod is detected', () => {
  const pitches = [0, 0, 0, 0, 0, 2, 6, 12, 9, 5, 2, 0, 0, 0];

  const { triggers } = runNosePitch(pitches);

  assert.strictEqual(triggers.length, 1, `expected 1 trigger, got ${triggers.length}`);
});

test('a sustained nose-pitch hold does not fire', () => {
  const pitches = [...new Array(5).fill(0), 5, 12, 20, ...new Array(35).fill(20)];

  const { triggers } = runNosePitch(pitches);

  assert.strictEqual(triggers.length, 0, `expected no triggers, got ${triggers.length}`);
});

test('small nose-pitch jitter does not fire', () => {
  const pitches = [];
  for (let frame = 0; frame < 120; frame += 1) {
    pitches.push(frame % 2 === 0 ? 0.4 : -0.4);
  }

  const { triggers } = runNosePitch(pitches);

  assert.strictEqual(triggers.length, 0, `expected no triggers, got ${triggers.length}`);
});