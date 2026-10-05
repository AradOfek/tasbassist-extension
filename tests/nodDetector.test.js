/**
 * Named gesture scenarios, written as head-pitch profiles in degrees so they
 * stay meaningful regardless of how the detector scales its signal.
 *
 * The critical distinction throughout: a *nod* dips and comes back up quickly;
 * *looking down* dips and stays down. Both look identical at the start, and only
 * the return (plus the frozen baseline) separates them.
 */

const test = require('node:test');
const assert = require('node:assert');

const { NodDetector, face, nodProfile, rest, run, FRAME_MS } = require('./helpers');

test('a comfortable 25-degree nod fires exactly once', () => {
  const { triggers } = run(nodProfile(25));

  assert.strictEqual(triggers.length, 1, `expected 1 trigger, got ${triggers.length}`);
});

test('a gentle 20-degree nod is detected', () => {
  const { triggers } = run(nodProfile(20));

  assert.strictEqual(triggers.length, 1, `expected 1 trigger, got ${triggers.length}`);
});

test('looking down and holding does not fire (the reported bug)', () => {
  // Down to 25 degrees and held for ~1.3 s. The old baseline converged on its
  // own and fired within ~150 ms of this; here it must never fire.
  const pitches = [...rest(5), 5, 15, 25, ...new Array(40).fill(25)];

  const { triggers } = run(pitches);

  assert.strictEqual(triggers.length, 0, `expected no triggers, got ${triggers.length}`);
});

test('a deep look at the fretboard does not fire', () => {
  const pitches = [...rest(5), 10, 30, 45, ...new Array(50).fill(45)];

  const { triggers } = run(pitches);

  assert.strictEqual(triggers.length, 0, `expected no triggers, got ${triggers.length}`);
});

test('a shallow glance never enters a dip at all', () => {
  // 10 degrees is under the enter threshold, so this should not even change
  // state — let alone fire.
  const pitches = [...rest(5), 4, 10, 6, 2, ...rest(5)];

  const { detector } = run(pitches);

  assert.strictEqual(detector.state, 'IDLE');
});

test('detector recovers after a long hold so later nods still work', () => {
  // Regression test. An earlier attempt reset to idle while the head was still
  // down without parking the baseline, so the next frame looked like a fresh
  // dip and the detector locked into an endless enter/abort loop.
  const pitches = [
    ...rest(5),
    5, 15, 28,
    ...new Array(45).fill(28), // long look at the fretboard
    10, 0, // player lifts their head back up
    ...rest(15),
    ...nodProfile(25, 0), // a genuine nod afterwards
  ];

  const { triggers } = run(pitches);

  assert.strictEqual(
    triggers.length,
    1,
    `expected exactly 1 trigger after recovery, got ${triggers.length}`
  );
});

test('a nod immediately after returning from a long hold still works', () => {
  // Same as above but the player nods right away instead of pausing first.
  const pitches = [
    ...rest(5),
    5, 15, 28,
    ...new Array(40).fill(28),
    10, 0,
    ...nodProfile(25, 0),
  ];

  const { triggers } = run(pitches);

  assert.strictEqual(triggers.length, 1, `expected 1 trigger, got ${triggers.length}`);
});

test('a head tilt does not fire', () => {
  // 30 degrees of roll throughout. Roll perturbs the signal far less than a nod
  // and in the opposite direction, so this should stay idle.
  const { triggers, detector } = run(nodProfile(25), { rollDeg: 30 });

  assert.strictEqual(triggers.length, 0, `expected no triggers, got ${triggers.length}`);
  assert.strictEqual(detector.state, 'IDLE');
});

test('a small tilt does not suppress a real nod', () => {
  const { triggers } = run(nodProfile(25), { rollDeg: 10 });

  assert.strictEqual(triggers.length, 1, `expected 1 trigger, got ${triggers.length}`);
});

test('tiny head jitter does not fire', () => {
  // Deterministic +/- ~0.6 degrees of pitch noise.
  const noise = [0.6, -0.4, 0.3, -0.6, 0.5, -0.2, 0.6, -0.3];
  const pitches = [];

  for (let i = 0; i < 150; i += 1) {
    pitches.push(noise[i % noise.length]);
  }

  const { triggers } = run(pitches);

  assert.strictEqual(triggers.length, 0, `expected no triggers, got ${triggers.length}`);
});

test('two nods inside the cooldown window fire only once', () => {
  // Second nod starts ~0.3 s after the first ends, inside the 800 ms lockout.
  const pitches = [...rest(5), ...nodProfile(25, 0), ...rest(8), ...nodProfile(25, 0)];

  const { triggers } = run(pitches);

  assert.strictEqual(triggers.length, 1, `expected 1 trigger, got ${triggers.length}`);
});

test('two well-separated nods both fire', () => {
  // ~1.2 s apart, comfortably outside the cooldown.
  const pitches = [
    ...rest(5),
    ...nodProfile(25, 0),
    ...rest(36),
    ...nodProfile(25, 0),
  ];

  const { triggers } = run(pitches);

  assert.strictEqual(triggers.length, 2, `expected 2 triggers, got ${triggers.length}`);
});

test('slow posture drift does not fire and does not break detection', () => {
  // Resting pitch creeps from 0 to 12 degrees over ~3 s, then a real nod.
  const pitches = [];
  for (let i = 0; i < 90; i += 1) {
    pitches.push((i / 90) * 12);
  }
  pitches.push(...nodProfile(25, 0));

  const { triggers } = run(pitches);

  assert.strictEqual(triggers.length, 1, `expected 1 trigger, got ${triggers.length}`);
});

test('a lost face mid-dip abandons the gesture', () => {
  const detector = new NodDetector();
  const triggers = [];

  for (let frame = 0; frame < 5; frame += 1) {
    detector.update(face(0), frame * FRAME_MS);
  }
  // Start dipping...
  for (let frame = 5; frame < 8; frame += 1) {
    detector.update(face(28), frame * FRAME_MS);
  }
  // ...then the face disappears for longer than the grace period.
  for (let frame = 8; frame < 30; frame += 1) {
    detector.markFaceLost(frame * FRAME_MS);
  }
  for (let frame = 30; frame < 40; frame += 1) {
    if (detector.update(face(0), frame * FRAME_MS).triggered) {
      triggers.push(frame);
    }
  }

  assert.strictEqual(triggers.length, 0, `expected no triggers, got ${triggers.length}`);
});

test('a degenerate eye distance is ignored rather than dividing by zero', () => {
  const detector = new NodDetector();

  detector.update(face(0), 0);

  const result = detector.update(
    {
      noseTip: { x: 0.5, y: 0.5 },
      leftEye: { x: 0.5, y: 0.5 },
      rightEye: { x: 0.5, y: 0.5 },
    },
    FRAME_MS
  );

  assert.strictEqual(result.triggered, false);
  assert.strictEqual(result.debug.aborted, 'degenerate-eye-distance');
});

test('reset returns the detector to its initial condition', () => {
  const detector = new NodDetector();

  for (let frame = 0; frame < 5; frame += 1) {
    detector.update(face(0), frame * FRAME_MS);
  }
  detector.reset();

  assert.strictEqual(detector.state, 'IDLE');
  assert.strictEqual(detector.baseY, null);
  assert.strictEqual(detector.dipRef, null);
});

test('higher sensitivity lowers all gesture thresholds together', () => {
  const low = new NodDetector({ sensitivity: 1 });
  const normal = new NodDetector({ sensitivity: 5 });
  const high = new NodDetector({ sensitivity: 10 });

  const lowThresholds = low.update(face(0), 0, 0).debug.thresholds;
  const normalThresholds = normal.update(face(0), 0, 0).debug.thresholds;
  const highThresholds = high.update(face(0), 0, 0).debug.thresholds;

  assert.ok(lowThresholds.enter > normalThresholds.enter);
  assert.ok(normalThresholds.enter > highThresholds.enter);
  assert.strictEqual(
    highThresholds.exit / highThresholds.enter,
    normalThresholds.exit / normalThresholds.enter
  );
  assert.strictEqual(
    highThresholds.minDepth / highThresholds.enter,
    normalThresholds.minDepth / normalThresholds.enter
  );
});

test('sensitivity changes which nods count without resetting the detector', () => {
  const smallNod = [0, 0, 0, 0, 0, 3, 5, 8, 6, 3, 1, 0, 0, 0];
  const runSmallNod = (sensitivity) => {
    const detector = new NodDetector({ sensitivity });
    let triggers = 0;
    smallNod.forEach((pitch, frame) => {
      if (detector.update(face(0), frame * FRAME_MS, pitch).triggered) {
        triggers += 1;
      }
    });
    return triggers;
  };

  assert.strictEqual(runSmallNod(10), 1);
  assert.strictEqual(runSmallNod(1), 0);

  const detector = new NodDetector();
  for (let frame = 0; frame < 5; frame += 1) {
    detector.update(face(0), frame * FRAME_MS, 0);
  }
  const baseline = detector.baseY;

  assert.strictEqual(detector.setSensitivity(9), 9);
  assert.strictEqual(detector.state, 'IDLE');
  assert.strictEqual(detector.baseY, baseline);
  assert.strictEqual(detector.setSensitivity('invalid'), 5);
});

test('calibration replaces the baseline and discards an in-flight gesture', () => {
  const detector = new NodDetector();

  detector.update(face(0), 0, 12);
  detector.update(face(0), FRAME_MS, 18);
  detector.update(face(0), FRAME_MS * 2, 25);
  assert.strictEqual(detector.state, 'DIPPING');

  assert.strictEqual(
    detector.calibrateTo({ signalSource: 'nose-pitch', baseline: 3 }),
    true
  );
  assert.strictEqual(detector.state, 'IDLE');
  assert.strictEqual(detector.signalSource, 'nose-pitch');
  assert.strictEqual(detector.baseY, 3);
  assert.strictEqual(detector.smoothY, 3);
  assert.strictEqual(detector.dipRef, null);
});

test('a nearby saved calibration is adopted, a distant one is discarded', () => {
  const nearby = new NodDetector();
  nearby.update(face(0), 0, 10);
  assert.strictEqual(
    nearby.adoptCalibratedBaseline({ signalSource: 'nose-pitch', baseline: 11 }),
    true
  );
  assert.strictEqual(nearby.baseY, 11);

  const distant = new NodDetector();
  distant.update(face(0), 0, 10);
  const baseline = distant.baseY;
  assert.strictEqual(
    distant.adoptCalibratedBaseline({ signalSource: 'nose-pitch', baseline: 30 }),
    false
  );
  assert.strictEqual(distant.baseY, baseline);
});

test('invalid calibration values are rejected without changing state', () => {
  const detector = new NodDetector();

  detector.update(face(0), 0, 12);
  detector.update(face(0), FRAME_MS, 12);
  const baseline = detector.baseY;

  for (const calibration of [
    null,
    {},
    { signalSource: 'nose-pitch', baseline: Number.NaN },
    { signalSource: 'unknown-source', baseline: 3 },
  ]) {
    assert.strictEqual(detector.calibrateTo(calibration), false);
  }

  assert.strictEqual(detector.state, 'IDLE');
  assert.strictEqual(detector.signalSource, 'nose-pitch');
  assert.strictEqual(detector.baseY, baseline);
});

test('steady calibration samples produce a baseline', () => {
  const samples = [];
  for (let frame = 0; frame < NodDetector.CALIBRATION_TARGET_SAMPLES; frame += 1) {
    samples.push(10 + (frame % 2 === 0 ? 0.2 : -0.2));
  }

  const summary = NodDetector.summarizeCalibration(samples, 'nose-pitch');

  assert.strictEqual(summary.ok, true);
  assert.strictEqual(summary.signalSource, 'nose-pitch');
  assert.strictEqual(summary.sampleCount, samples.length);
  assert.ok(Math.abs(summary.baseline - 10) < 1e-9);
});

test('unsteady or incomplete calibration samples are rejected', () => {
  const moving = [];
  for (let frame = 0; frame < NodDetector.CALIBRATION_TARGET_SAMPLES; frame += 1) {
    moving.push(frame);
  }

  assert.strictEqual(
    NodDetector.summarizeCalibration(moving, 'nose-pitch').reason,
    'hold-still'
  );
  assert.strictEqual(
    NodDetector.summarizeCalibration([1, 2, 3], 'nose-pitch').reason,
    'not-enough-samples'
  );
  assert.strictEqual(
    NodDetector.summarizeCalibration(
      new Array(NodDetector.CALIBRATION_TARGET_SAMPLES).fill(1),
      'unknown-source'
    ).reason,
    'unknown-signal-source'
  );
});