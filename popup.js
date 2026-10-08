/**
 * TabAssist Extension Popup / SidePanel Script
 *
 * Controls camera access, initializes MediaPipe face landmark tracking via local WASM assets,
 * detects downward head nod gestures, and dispatches jump events to active Songsterr tabs.
 */

// Universal browser runtime layer
const extensionAPI = typeof browser !== 'undefined' ? browser : chrome;

// DOM Elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const videoElement = document.getElementById('webcam');
const placeholder = document.getElementById('placeholder');
const statusIndicator = document.getElementById('statusIndicator');
const jumpSlider = document.getElementById('jumpSlider');
const jumpVal = document.getElementById('jumpVal');
const sensitivitySlider = document.getElementById('sensitivitySlider');
const sensitivityVal = document.getElementById('sensitivityVal');
const sensitivityName = document.getElementById('sensitivityName');
const calibrateBtn = document.getElementById('calibrateBtn');
const clearCalibrationBtn = document.getElementById('clearCalibrationBtn');
const calibrationStatus = document.getElementById('calibrationStatus');

// Debug panel elements. The panel is opt-in and does nothing but render the
// detector's own debug object, so it cannot affect detection itself.
const debugToggle = document.getElementById('debugToggle');
const debugPanel = document.getElementById('debugPanel');
const debugState = document.getElementById('debugState');
const debugCanvas = document.getElementById('debugCanvas');
const debugNote = document.getElementById('debugNote');
const debugFields = {
  source: document.getElementById('dbgSource'),
  signal: document.getElementById('dbgSignal'),
  smooth: document.getElementById('dbgSmooth'),
  base: document.getElementById('dbgBase'),
  delta: document.getElementById('dbgDelta'),
  ref: document.getElementById('dbgRef'),
  depth: document.getElementById('dbgDepth'),
  pitch: document.getElementById('dbgPitch'),
  eyeShape: document.getElementById('dbgEyeShape'),
  eye: document.getElementById('dbgEye'),
  roll: document.getElementById('dbgRoll'),
  thresh: document.getElementById('dbgThresh'),
};
const debugCtx = debugCanvas.getContext('2d');

// Core vision runtime & video stream references
let faceLandmarker = null;
let cameraStream = null;
let lastVideoTime = -1;
let animFrameId = null;

// Gesture recognition is delegated to nodDetector.js so the algorithm can be
// read, reviewed and tested on its own. This file owns camera capture, MediaPipe
// setup, the UI and messaging to the Songsterr tab.
let nodDetector = null;

// Persisted user settings. Sensitivity uses the detector's 1-10 scale; the
// calibration stores only a numeric resting baseline, never video or landmarks.
const storedSettingDefaults = {
  jumpFactor: 4,
  sensitivity: 5,
  nodCalibration: null,
};
let currentSensitivity = storedSettingDefaults.sensitivity;
let savedCalibration = null;
let pendingSavedCalibration = null;
let calibrationCapture = null;

function storageSync() {
  if (extensionAPI && extensionAPI.storage && extensionAPI.storage.sync) {
    return extensionAPI.storage.sync;
  }
  return null;
}

function getStoredSettings() {
  const sync = storageSync();
  if (!sync) {
    return Promise.resolve({ ...storedSettingDefaults });
  }

  return new Promise((resolve) => {
    try {
      sync.get(storedSettingDefaults, (items = {}) => {
        resolve({ ...storedSettingDefaults, ...items });
      });
    } catch {
      resolve({ ...storedSettingDefaults });
    }
  });
}

function normalizeSensitivity(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) {
    return storedSettingDefaults.sensitivity;
  }
  return Math.min(10, Math.max(1, numeric));
}

function sensitivityDisplayName(value) {
  if (value <= 3) {
    return 'Gentle';
  }
  if (value >= 8) {
    return 'Sensitive';
  }
  return 'Balanced';
}

function normalizeCalibration(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const baseline = Number(value.baseline);
  if (
    (value.signalSource !== 'nose-pitch' && value.signalSource !== 'eye-shape') ||
    !Number.isFinite(baseline)
  ) {
    return null;
  }
  return {
    signalSource: value.signalSource,
    baseline,
    sampleCount: Number.isFinite(Number(value.sampleCount))
      ? Number(value.sampleCount)
      : null,
    capturedAt: Number.isFinite(Number(value.capturedAt))
      ? Number(value.capturedAt)
      : null,
  };
}

function updateSensitivityUI() {
  sensitivitySlider.value = currentSensitivity;
  sensitivityVal.textContent = currentSensitivity;
  sensitivityName.textContent = sensitivityDisplayName(currentSensitivity);
}

function calibrationTargetSamples() {
  const target = Number(NodDetector.CALIBRATION_TARGET_SAMPLES);
  return Number.isFinite(target) && target > 0 ? Math.floor(target) : 30;
}

function setCalibrationStatus(message, tone = '') {
  calibrationStatus.textContent = message;
  calibrationStatus.className = tone;
}

function updateCalibrationUI(statusMessage, statusTone = '') {
  if (calibrationCapture) {
    calibrateBtn.textContent = `Cancel calibration (${calibrationCapture.samples.length}/${calibrationCapture.target})`;
    clearCalibrationBtn.style.display = 'none';
  } else if (savedCalibration) {
    calibrateBtn.textContent = 'Recalibrate playing posture';
    clearCalibrationBtn.style.display = 'block';
  } else {
    calibrateBtn.textContent = 'Calibrate playing posture';
    clearCalibrationBtn.style.display = 'none';
  }

  if (typeof statusMessage !== 'undefined') {
    setCalibrationStatus(statusMessage, statusTone);
  } else if (!calibrationCapture && !savedCalibration) {
    setCalibrationStatus('No playing posture saved.');
  }
}

function applyStoredSettings(settings) {
  const jumpFactor = parseInt(settings.jumpFactor, 10);
  jumpSlider.value = Number.isFinite(jumpFactor) ? jumpFactor : storedSettingDefaults.jumpFactor;
  jumpVal.textContent = jumpSlider.value;

  currentSensitivity = normalizeSensitivity(settings.sensitivity);
  savedCalibration = normalizeCalibration(settings.nodCalibration);
  updateSensitivityUI();
  updateCalibrationUI(
    savedCalibration
      ? `Playing posture saved (${savedCalibration.signalSource === 'nose-pitch' ? 'nose pitch' : 'eye shape'}).`
      : 'No playing posture saved.'
  );
}

getStoredSettings().then(applyStoredSettings);

jumpSlider.addEventListener('input', (e) => {
  const val = parseInt(e.target.value, 10);
  jumpVal.textContent = val;
  const sync = storageSync();
  if (sync) {
    sync.set({ jumpFactor: val });
  }
});

sensitivitySlider.addEventListener('input', (e) => {
  currentSensitivity = normalizeSensitivity(e.target.value);
  updateSensitivityUI();

  const sync = storageSync();
  if (sync) {
    sync.set({ sensitivity: currentSensitivity });
  }
  if (nodDetector) {
    nodDetector.setSensitivity(currentSensitivity);
  }
});

/**
 * Initializes the MediaPipe FaceLandmarker task using bundled local WASM assets.
 */
async function initMediaPipe() {
  if (faceLandmarker) return;

  statusIndicator.textContent = "LOADING AI ENGINE...";
  statusIndicator.className = "";

  // vision_bundle.js exports global object window.Vision or directly on window
  const vision = window.Vision || window;

  if (!vision.FilesetResolver || !vision.FaceLandmarker) {
    throw new Error("MediaPipe Vision library bundle failed to load.");
  }

  // Resolve absolute paths for local extension assets
  const wasmPath = extensionAPI.runtime.getURL("lib");
  const modelPath = extensionAPI.runtime.getURL("lib/face_landmarker.task");

  const filesetResolver = await vision.FilesetResolver.forVisionTasks(wasmPath);

  // Try GPU delegate first, fallback to CPU delegate if WebGL context creation fails
  try {
    faceLandmarker = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numFaces: 1,
      // The detector's primary signal is the rigid nose direction from this
      // matrix, rather than a projected eye-to-nose distance.
      outputFacialTransformationMatrixes: true
    });
  } catch {
    faceLandmarker = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: "CPU"
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFacialTransformationMatrixes: true
    });
  }
}

/**
 * Requests camera permission, initializes video stream and starts tracking loop.
 */
async function startCamera() {
  try {
    await initMediaPipe();

    if (typeof NodDetector === 'undefined') {
      throw new Error('nodDetector.js failed to load.');
    }

    const settings = await getStoredSettings();
    currentSensitivity = normalizeSensitivity(settings.sensitivity);
    savedCalibration = normalizeCalibration(settings.nodCalibration);
    nodDetector = new NodDetector({ sensitivity: currentSensitivity });
    // A stale saved posture must not become a false dip. It is adopted only if
    // live tracking starts near it; otherwise live tracking supplies the baseline.
    pendingSavedCalibration = savedCalibration;
    calibrationCapture = null;
    updateSensitivityUI();
    updateCalibrationUI(
      savedCalibration
        ? `Playing posture saved (${savedCalibration.signalSource === 'nose-pitch' ? 'nose pitch' : 'eye shape'}).`
        : 'No playing posture saved.'
    );

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, frameRate: { ideal: 30 } },
      audio: false
    });

    videoElement.srcObject = cameraStream;
    placeholder.style.display = "none";
    videoElement.style.display = "block";
    startBtn.style.display = "none";
    stopBtn.style.display = "block";

    statusIndicator.textContent = "TRACKING ACTIVE";
    statusIndicator.className = "active";

    await videoElement.play();
    predictWebcam();
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError" || (err.message && err.message.includes("dismissed"))) {
      statusIndicator.textContent = "OPENING PERMISSION TAB...";

      // Sidepanel workaround: Open a full browser tab to trigger the Chrome permission popup
      if (extensionAPI && extensionAPI.tabs) {
        extensionAPI.tabs.create({ url: extensionAPI.runtime.getURL("permission.html") });
      }
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      statusIndicator.textContent = "NO WEBCAM FOUND";
    } else {
      statusIndicator.textContent = `ERROR: ${err.message || "CAMERA SETUP FAILED"}`;
    }
    statusIndicator.className = "error";
  }
}

/**
 * Stops active webcam stream and cancels animation frame loop.
 */
function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }

  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  videoElement.pause();
  videoElement.srcObject = null;
  videoElement.style.display = "none";
  placeholder.style.display = "block";
  startBtn.style.display = "block";
  stopBtn.style.display = "none";

  statusIndicator.textContent = "CAMERA STOPPED";
  statusIndicator.className = "";

  debugTrace.length = 0;
  debugState.textContent = "IDLE";
  debugState.className = "";

  calibrationCapture = null;
  pendingSavedCalibration = null;
  updateCalibrationUI();
  nodDetector = new NodDetector({ sensitivity: currentSensitivity });
}

/**
 * Begin capturing the player's current posture as the detector baseline.
 *
 * Calibration is intentionally short and requires the player to hold still.
 * The resulting baseline is only a better starting point: the detector's
 * normal adaptive baseline continues afterwards, so later posture changes do
 * not require recalibration.
 */
function startCalibrationCapture() {
  if (!cameraStream || !nodDetector) {
    setCalibrationStatus('Start the camera before calibrating.', 'error');
    return;
  }
  if (calibrationCapture) {
    calibrationCapture = null;
    updateCalibrationUI('Calibration cancelled.');
    return;
  }

  calibrationCapture = {
    samples: [],
    signalSource: nodDetector.signalSource,
    target: calibrationTargetSamples(),
  };
  updateCalibrationUI(
    `Hold your playing posture still: 0/${calibrationCapture.target}.`
  );
}

function abortCalibrationCapture(message) {
  if (!calibrationCapture) {
    return;
  }
  calibrationCapture = null;
  updateCalibrationUI(message, 'error');
}

function calibrationFailureMessage(summary) {
  if (summary.reason === 'hold-still') {
    return 'Head movement detected. Hold your playing posture still and try again.';
  }
  if (summary.reason === 'not-enough-samples') {
    return 'Not enough steady frames were captured. Try again.';
  }
  return 'Calibration did not produce a usable baseline. Try again.';
}

function maybeAdoptSavedCalibration(result) {
  if (
    !pendingSavedCalibration ||
    calibrationCapture ||
    !nodDetector ||
    !result ||
    !result.debug ||
    result.debug.signalSource !== pendingSavedCalibration.signalSource
  ) {
    return;
  }

  if (nodDetector.adoptCalibratedBaseline(pendingSavedCalibration)) {
    savedCalibration = pendingSavedCalibration;
    updateCalibrationUI(
      `Playing posture restored (${savedCalibration.signalSource === 'nose-pitch' ? 'nose pitch' : 'eye shape'}).`,
      'success'
    );
  }
  pendingSavedCalibration = null;
}

function collectCalibrationSample(result) {
  if (!calibrationCapture || !result || !result.debug) {
    return;
  }

  const debug = result.debug;
  if (
    debug.signalSource !== calibrationCapture.signalSource ||
    typeof debug.smoothY !== 'number' ||
    !Number.isFinite(debug.smoothY)
  ) {
    abortCalibrationCapture('The tracking signal changed. Try again.');
    return;
  }

  calibrationCapture.samples.push(debug.smoothY);
  if (calibrationCapture.samples.length < calibrationCapture.target) {
    updateCalibrationUI(
      `Hold your playing posture still: ${calibrationCapture.samples.length}/${calibrationCapture.target}.`
    );
    return;
  }

  const summary = NodDetector.summarizeCalibration(
    calibrationCapture.samples,
    calibrationCapture.signalSource
  );
  if (!summary.ok) {
    abortCalibrationCapture(calibrationFailureMessage(summary));
    return;
  }

  const calibration = {
    signalSource: summary.signalSource,
    baseline: summary.baseline,
  };
  if (!nodDetector.calibrateTo(calibration)) {
    abortCalibrationCapture('Calibration did not produce a usable baseline. Try again.');
    return;
  }

  savedCalibration = {
    ...calibration,
    sampleCount: summary.sampleCount,
    capturedAt: Date.now(),
  };
  const sync = storageSync();
  if (sync) {
    sync.set({ nodCalibration: savedCalibration });
  }
  calibrationCapture = null;
  pendingSavedCalibration = null;
  updateCalibrationUI(
    `Playing posture calibrated (${calibration.signalSource === 'nose-pitch' ? 'nose pitch' : 'eye shape'}).`,
    'success'
  );
}

function clearSavedCalibration() {
  savedCalibration = null;
  pendingSavedCalibration = null;
  calibrationCapture = null;
  const sync = storageSync();
  if (sync) {
    sync.set({ nodCalibration: null });
  }
  updateCalibrationUI('No playing posture saved.');
}

calibrateBtn.addEventListener('click', startCalibrationCapture);
clearCalibrationBtn.addEventListener('click', clearSavedCalibration);

/**
 * Continuous frame detection loop.
 */
function predictWebcam() {
  if (!cameraStream) return;

  const now = performance.now();

  if (videoElement.currentTime !== lastVideoTime) {
    lastVideoTime = videoElement.currentTime;

    try {
      const results = faceLandmarker.detectForVideo(videoElement, now);

      if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        const landmarks = results.faceLandmarks[0];

        // MediaPipe FaceLandmarker indices: 4 = nose tip, 33 = one outer eye
        // corner, 263 = the other outer eye corner. Landmark 133 is the inner
        // corner of the same eye as 33, so it must not be used as the opposite
        // eye: that would reduce the eye line to one eyelid and make the tilt
        // guard unstable.
        //
        // The rigid nose direction is the primary gesture signal because
        // whole-head translation does not change it. The three points remain
        // for the tilt guard and as a fallback if MediaPipe omits the matrix.
        const nosePitchDeg = NodDetector.nosePitchFromFacialTransformationMatrix(
          results.facialTransformationMatrixes
            ? results.facialTransformationMatrixes[0]
            : null
        );
        const result = nodDetector.update(
          {
            noseTip: landmarks[4],
            leftEye: landmarks[33],
            rightEye: landmarks[263],
          },
          now,
          nosePitchDeg
        );

        maybeAdoptSavedCalibration(result);
        renderDebug(result);
        collectCalibrationSample(result);

        if (result.triggered) {
          triggerTabJump();
        }
      } else {
        nodDetector.markFaceLost(now);
        abortCalibrationCapture('The face was lost during calibration. Try again.');
        if (debugPanel.classList.contains('open')) {
          debugState.textContent = 'NO FACE';
          debugState.className = '';
          debugNote.textContent = 'Waiting for a face.';
        }
      }
    } catch {
      // Per-frame inference errors are ignored; the loop retries next frame.
    }
  }

  animFrameId = requestAnimationFrame(predictWebcam);
}

debugToggle.addEventListener('click', () => {
  const open = debugPanel.classList.toggle('open');
  debugToggle.textContent = open ? 'Hide detector debug' : 'Show detector debug';

  if (open) {
    debugNote.textContent =
      'A nod is a rise above the baseline followed by a return within 400 ms; ' +
      'a dip that stays down is ignored.';
  } else {
    debugTrace.length = 0;
  }
});

/** Recent smoothed-signal samples, oldest first, drawn as the graph. */
const debugTrace = [];
const DEBUG_TRACE_LENGTH = 120;

/** Formats a number to detector precision, or a dash when there is no value. */
function debugNum(value, digits = 4) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-';
}

/**
 * Renders one frame of detector state into the debug panel.
 *
 * This is a pure readout. It reads the debug object the detector already
 * produces and never writes to the detector, so switching the panel on or off
 * cannot change what gets detected.
 */
function renderDebug(result) {
  if (!result || !debugPanel.classList.contains('open')) {
    return;
  }

  const d = result.debug;

  debugState.textContent = result.state;
  debugState.className = result.state;

  const useDegrees = d.signalUnit === 'nose-pitch-deg';
  const digits = useDegrees ? 1 : 4;
  const suffix = useDegrees ? '°' : '';
  const formatSignal = (value) => {
    const text = debugNum(value, digits);
    return text === '-' ? text : `${text}${suffix}`;
  };
  const delta = d.smoothY !== null && d.baseY !== null ? d.smoothY - d.baseY : null;

  debugFields.source.textContent = useDegrees ? 'nose pitch' : 'eye shape';
  debugFields.signal.textContent = formatSignal(d.rawSignal);
  debugFields.smooth.textContent = formatSignal(d.smoothY);
  debugFields.base.textContent = formatSignal(d.baseY);
  debugFields.delta.textContent = formatSignal(delta);
  debugFields.ref.textContent = formatSignal(d.dipRef);
  debugFields.depth.textContent = formatSignal(d.depth);
  debugFields.pitch.textContent = d.nosePitchDeg === null
    ? '-'
    : `${debugNum(d.nosePitchDeg, 1)}°`;
  debugFields.eyeShape.textContent = debugNum(d.eyeShape);
  debugFields.eye.textContent = debugNum(d.eyeDist, 3);
  debugFields.roll.textContent = `${debugNum(d.rollDeg, 1)}°`;
  debugFields.thresh.textContent = d.thresholds
    ? `${d.thresholds.enter}${suffix} / ${d.thresholds.exit}${suffix}`
    : '-';

  if (d.aborted) {
    debugNote.textContent = `Last dip abandoned: ${d.aborted}.`;
  } else if (result.triggered) {
    debugNote.textContent = 'Nod fired: rose past enter, then returned.';
  }

  if (d.smoothY !== null) {
    debugTrace.push(d.smoothY);
    if (debugTrace.length > DEBUG_TRACE_LENGTH) {
      debugTrace.shift();
    }
  }
  drawDebugTrace(delta, d.thresholds, d.signalUnit);
}

/**
 * Plots the smoothed signal over time, with the baseline and the enter/exit
 * thresholds as reference lines so the current margin is visible at a glance.
 */
function drawDebugTrace(delta, thresholds, signalUnit) {
  const w = debugCanvas.width;
  const h = debugCanvas.height;

  debugCtx.clearRect(0, 0, w, h);
  if (debugTrace.length === 0) {
    return;
  }

  // Scale to the data plus the thresholds, so the lines are always on screen.
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of debugTrace) {
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
  }
  if (typeof delta === 'number' && Number.isFinite(delta)) {
    hi = Math.max(hi, delta);
  }
  const minPad = signalUnit === 'nose-pitch-deg' ? 0.5 : 0.02;
  const pad = Math.max(minPad, (hi - lo) * 0.2);
  lo -= pad;
  hi += pad;

  const toY = (value) => h - ((value - lo) / (hi - lo)) * h;
  const toX = (index) => (index / (DEBUG_TRACE_LENGTH - 1)) * w;

  const line = (value, color, dashed) => {
    const y = toY(value);
    debugCtx.save();
    debugCtx.strokeStyle = color;
    debugCtx.lineWidth = 1;
    if (dashed) {
      debugCtx.setLineDash([3, 3]);
    }
    debugCtx.beginPath();
    debugCtx.moveTo(0, y);
    debugCtx.lineTo(w, y);
    debugCtx.stroke();
    debugCtx.restore();
  };

  // Baseline as it was at each sample is not retained, so draw the current one;
  // it only moves slowly, which is exactly what makes it readable here.
  const ref = nodDetector ? nodDetector.baseY : null;
  if (ref !== null) {
    line(ref, '#475569');
  }
  if (ref !== null && thresholds) {
    line(ref + thresholds.enter, '#f59e0b', true);
    line(ref + thresholds.exit, '#22c55e', true);
  }

  debugCtx.strokeStyle = '#38bdf8';
  debugCtx.lineWidth = 1.5;
  debugCtx.beginPath();
  debugTrace.forEach((value, index) => {
    const x = toX(index + DEBUG_TRACE_LENGTH - debugTrace.length);
    const y = toY(value);
    if (index === 0) {
      debugCtx.moveTo(x, y);
    } else {
      debugCtx.lineTo(x, y);
    }
  });
  debugCtx.stroke();
}

/**
 * Sends jump command to active tab content script.
 */
function triggerTabJump() {
  statusIndicator.textContent = "⚡ NOD DETECTED!";

  extensionAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0] && tabs[0].id) {
      extensionAPI.tabs.sendMessage(tabs[0].id, { action: 'TRIGGER_JUMP' }, () => {
        // The active tab may not be a Songsterr page; that is expected.
      });
    }
  });

  // Only restores the status text; the detector owns the cooldown lockout.
  setTimeout(() => {
    if (cameraStream) {
      statusIndicator.textContent = "TRACKING ACTIVE";
      statusIndicator.className = "active";
    }
  }, nodDetector.options.cooldownMs);
}

startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);
