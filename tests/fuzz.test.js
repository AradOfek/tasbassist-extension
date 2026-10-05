/**
 * Fuzz tests: randomised motion must never produce a false trigger, and real
 * nods must still be caught.
 *
 * The named scenarios in nodDetector.test.js pin down known behaviours. These
 * search for combinations nobody thought of — noise, drift, glances and tilt all
 * at once — which is where threshold tuning usually goes wrong.
 */

const test = require('node:test');
const assert = require('node:assert');

const { face, rest, run, makeRandom, FRAME_MS } = require('./helpers');
const { NodDetector } = require('./helpers');

// Frames spent easing into and out of a simulated glance. Chosen so the shortest
// possible glance comfortably exceeds the detector's 400 ms nod budget — see the
// comment at the ramp below.
const RAMP_FRAMES = 12;

test('random motion never fires without a real nod', () => {
  const TRIALS = 400;
  const FRAMES = 240;
  const random = makeRandom(20260405);

  for (let trial = 0; trial < TRIALS; trial += 1) {
    const detector = new NodDetector();

    let pitch = 0;
    let drift = 0;
    let glide = 0;
    let holdTotal = 0;
    let glideFramesLeft = 0;

    for (let frame = 0; frame < FRAMES; frame += 1) {
      // Small per-frame jitter, assigned rather than accumulated. An
      // accumulating random walk diverges without bound, and a pitch of 270
      // degrees is not something a head can do — nor something the geometric
      // face model means anything for.
      pitch = (random() - 0.5) * 1.2;

      // Slow posture drift, bounded so it wanders rather than diverging.
      drift += (random() - 0.5) * 0.8;
      drift = Math.max(-12, Math.min(12, drift));
      pitch += drift * 0.05;

      // Occasional glance: dip down and stay down well past the duration
      // budget. These must never fire.
      if (glideFramesLeft === 0 && random() < 0.01) {
        // The hold is the flat part only. The ramps are tracked separately below, so a
        // glance always lasts hold + 2 * RAMP_FRAMES.
        holdTotal = 10 + Math.floor(random() * 30);
        glideFramesLeft = holdTotal + RAMP_FRAMES * 2;
        glide = 25 + random() * 25;
      }
      // The glance eases in over several frames and eases back out when it
      // ends, the way a real head settles onto the fretboard and lifts off it.
      //
      // The ramp length matters. Each leg takes 12 frames, so the shortest
      // possible glance here is 24 frames — 800 ms at the capture rate, twice
      // the detector's 400 ms nod budget. A ramp short enough to fit inside the
      // budget is not a glance, it is a nod, and the detector is right to fire.
      let total = pitch;
      if (glideFramesLeft > 0) {
        const elapsed = holdTotal + RAMP_FRAMES * 2 - glideFramesLeft;
        const fade = Math.min(1, elapsed / RAMP_FRAMES);
        const release = Math.min(1, glideFramesLeft / RAMP_FRAMES);
        total += glide * Math.min(fade, release);
        glideFramesLeft -= 1;
      }

      const roll = (random() - 0.5) * 60;
      const result = detector.update(face(total, { rollDeg: roll }), frame * FRAME_MS);

      assert.strictEqual(
        result.triggered,
        false,
        `trial ${trial} frame ${frame}: false trigger, pitch=${total.toFixed(2)}, roll=${roll.toFixed(1)}`
      );
    }
  }
});

test('a real nod is detected amid background noise', () => {
  const TRIALS = 200;
  const random = makeRandom(987654321);
  let detected = 0;

  for (let trial = 0; trial < TRIALS; trial += 1) {
    // Jitter is re-drawn each frame rather than accumulated, so it stays
    // centred on the profile instead of wandering off as a random walk.
    const jitter = () => (random() - 0.5) * 1.2;
    const profile = [
      ...rest(20),
      ...[5, 15, 25, 25, 20, 12, 5, 0].map((p) => p + jitter()),
      ...rest(20).map(() => jitter()),
    ];

    const { triggers } = run(profile);

    if (triggers.length > 0) {
      detected += 1;
    }
  }

  // Every trial contains a textbook 25-degree nod, so detection should be
  // essentially total. A little slack for unlucky noise draws.
  assert.ok(
    detected >= TRIALS * 0.95,
    `only ${detected}/${TRIALS} nods detected`
  );
});

test('detection is stable across face sizes', () => {
  // Same nod, face rendered at half, normal and double size.
  const nod = [0, 0, 0, 0, 0, 5, 15, 25, 20, 12, 5, 0, 0, 0];
  const results = [0.5, 1, 2].map((scale) => run(nod, { scale }).triggers.length);

  assert.deepStrictEqual(
    results,
    [1, 1, 1],
    `detection varied with face size: ${JSON.stringify(results)}`
  );
});

test('detection is stable when the face is off-centre', () => {
  // A player who is not sitting square to the camera. The signal is measured
  // between landmarks, so a constant offset should not matter — only roll.
  const nod = [0, 0, 0, 0, 0, 5, 15, 25, 20, 12, 5, 0, 0, 0];
  const results = [0, 15, -15].map((rollDeg) => run(nod, { rollDeg }).triggers.length);

  assert.deepStrictEqual(
    results,
    [1, 1, 1],
    `detection varied with roll: ${JSON.stringify(results)}`
  );
});

test('the detector never reports a depth larger than the peak allows', () => {
  // Guards an internal invariant relied on by the exit test.
  const random = makeRandom(555);
  const detector = new NodDetector();

  for (let frame = 0; frame < 300; frame += 1) {
    const result = detector.update(
      face((random() - 0.5) * 30, { rollDeg: (random() - 0.5) * 40 }),
      frame * FRAME_MS
    );

    const { dipRef, peakY, depth } = result.debug;
    if (dipRef !== null && peakY !== null && depth !== null) {
      assert.ok(
        Math.abs(depth - (peakY - dipRef)) < 1e-12,
        `inconsistent depth at frame ${frame}`
      );
    }
  }
});

test('frame timestamps are honoured, not assumed to be uniform', () => {
  // A dropped frame must not make a nod look longer than it was. Feeding the
  // same pitch profile with irregular timestamps should still fire once.
  const detector = new NodDetector();
  const profile = [0, 0, 0, 0, 5, 15, 25, 20, 12, 5, 0, 0, 0];
  let triggers = 0;
  let t = 0;

  profile.forEach((pitch) => {
    // Irregular intervals between 20 and 45 ms.
    t += 20 + Math.floor((t * 7) % 26);
    if (detector.update(face(pitch), t).triggered) {
      triggers += 1;
    }
  });

  assert.strictEqual(triggers, 1, `expected 1 trigger, got ${triggers}`);
});

test('FRAME_MS matches the rate the popup requests', () => {
  // Guards the assumption behind rearmStillMs, which converts frame counts to
  // milliseconds. If the capture rate changes, that constant must follow.
  assert.strictEqual(FRAME_MS, 1000 / 30);
});