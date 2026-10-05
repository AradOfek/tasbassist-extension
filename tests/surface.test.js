/**
 * Guards the contract popup.js depends on.
 *
 * popup.js is a browser script that reads `NodDetector` off the global scope and
 * reads `nodDetector.options.cooldownMs`. If this file drifts, the extension
 * fails at runtime instead of at build time, so it is worth pinning down here.
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

test('publishes NodDetector on the global scope', () => {
  assert.strictEqual(typeof globalThis.NodDetector, 'function');
});

test('publishes the nose-pitch matrix parser', () => {
  assert.strictEqual(
    typeof globalThis.NodDetector.nosePitchFromFacialTransformationMatrix,
    'function'
  );
});

test('publishes calibration and sensitivity APIs', () => {
  assert.strictEqual(typeof globalThis.NodDetector.summarizeCalibration, 'function');
  assert.strictEqual(globalThis.NodDetector.CALIBRATION_TARGET_SAMPLES, 30);

  const detector = new globalThis.NodDetector();
  assert.strictEqual(typeof detector.setSensitivity, 'function');
  assert.strictEqual(typeof detector.calibrateTo, 'function');
  assert.strictEqual(typeof detector.adoptCalibratedBaseline, 'function');
  assert.strictEqual(detector.setSensitivity(7), 7);
});

test('popup.js asks MediaPipe for the orientation matrix and uses it', () => {
  const popupJs = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

  assert.ok(
    popupJs.includes('outputFacialTransformationMatrixes: true'),
    'popup.js does not request facial transformation matrices'
  );
  assert.ok(
    popupJs.includes('nosePitchFromFacialTransformationMatrix'),
    'popup.js does not parse the orientation matrix'
  );
  assert.ok(
    popupJs.includes('nosePitchDeg'),
    'popup.js does not pass nose pitch to the detector'
  );
});

test('popup.js wires sensitivity and calibration to the detector', () => {
  const popupJs = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

  for (const snippet of [
    'sensitivitySlider',
    'calibrateBtn',
    'clearCalibrationBtn',
    'calibrationStatus',
    'nodDetector.setSensitivity',
    'NodDetector.summarizeCalibration',
    'nodDetector.calibrateTo',
    'adoptCalibratedBaseline',
    'pendingSavedCalibration',
    'NodDetector.CALIBRATION_TARGET_SAMPLES',
    'nodCalibration',
  ]) {
    assert.ok(popupJs.includes(snippet), `popup.js is missing ${snippet}`);
  }
});

test('popup.js uses opposite outer eye corners and the nose tip', () => {
  const popupJs = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

  // Landmark 133 is the inner corner of the same eye as 33. Using those two
  // points would collapse the eye line to one eyelid and destabilize the tilt
  // guard, so the opposite-eye pairing is pinned here.
  assert.ok(popupJs.includes('landmarks[4]'), 'popup.js does not use nose tip 4');
  assert.ok(popupJs.includes('landmarks[33]'), 'popup.js does not use eye corner 33');
  assert.ok(popupJs.includes('landmarks[263]'), 'popup.js does not use eye corner 263');
  assert.ok(
    !popupJs.includes('rightEye: landmarks[133]'),
    'popup.js uses same-eye landmarks 33 and 133 as opposite eyes'
  );
});

test('publishes all four state names', () => {
  const states = globalThis.NOD_DETECTOR_STATES;

  for (const name of ['IDLE', 'DIPPING', 'COOLDOWN', 'DISARMED']) {
    assert.ok(states[name], `missing state: ${name}`);
  }
});

test('exposes the tunables popup.js reads as numbers', () => {
  const { options } = new globalThis.NodDetector();

  for (const key of [
    'enterThreshold',
    'exitThreshold',
    'minDepth',
    'sensitivity',
    'nosePitchEnterDeg',
    'nosePitchExitDeg',
    'nosePitchMinDepthDeg',
    'nosePitchSignalAlpha',
    'nosePitchBaselineAlpha',
    'nosePitchStillDegPerFrame',
    'maxDurationMs',
    'cooldownMs',
  ]) {
    assert.strictEqual(typeof options[key], 'number', `option not numeric: ${key}`);
  }
});

test('accepts the first frame before any baseline exists', () => {
  const detector = new globalThis.NodDetector();

  const result = detector.update(
    {
      noseTip: { x: 0.5, y: 0.58 },
      leftEye: { x: 0.44, y: 0.5 },
      rightEye: { x: 0.56, y: 0.5 },
    },
    0
  );

  assert.strictEqual(result.triggered, false);
  assert.strictEqual(result.state, 'IDLE');
});

test('popup.html loads nodDetector.js before popup.js', () => {
  // Order matters: popup.js constructs a NodDetector on Start, so the class must
  // already exist by then.
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  const detectorAt = html.indexOf('nodDetector.js');
  const popupAt = html.indexOf('popup.js');

  assert.ok(detectorAt > -1, 'popup.html does not load nodDetector.js');
  assert.ok(popupAt > -1, 'popup.html does not load popup.js');
  assert.ok(detectorAt < popupAt, 'nodDetector.js must load before popup.js');
});

test('popup.html contains every element popup.js looks up', () => {
  // A missing id is a silent null in the browser and a TypeError on the first
  // click, so the ids are pinned here.
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

  const ids = [...popupJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, 'found no getElementById calls to check');

  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `popup.html is missing id="${id}"`);
  }
});

test('options passed to the constructor override the defaults', () => {
  const detector = new globalThis.NodDetector({ cooldownMs: 1234 });

  assert.strictEqual(detector.options.cooldownMs, 1234);
  // Untouched keys keep their defaults. Compared against a fresh instance
  // rather than a literal, so retuning the detector does not break this test.
  const defaults = new globalThis.NodDetector();
  assert.strictEqual(detector.options.enterThreshold, defaults.options.enterThreshold);
  assert.strictEqual(detector.options.minDepth, defaults.options.minDepth);
});