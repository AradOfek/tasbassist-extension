/**
 * TabAssist Extension Panel Script
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

// Core vision runtime & video stream references
let faceLandmarker = null;
let cameraStream = null;
let lastVideoTime = -1;
let animFrameId = null;

// Head nod gesture parameters & tracking state
let neutralNoseY = null;
const NOD_THRESHOLD = 0.040;        // Normalized vertical movement threshold
const MAX_NOD_DURATION_MS = 400;   // Maximum duration for valid nod
const COOLDOWN_MS = 800;           // Cooldown delay between jumps

let isDipping = false;
let dipStartTime = 0;
let isCooldown = false;

// Sync user's saved jump setting
if (extensionAPI && extensionAPI.storage && extensionAPI.storage.sync) {
  extensionAPI.storage.sync.get({ jumpFactor: 4 }, (items) => {
    jumpSlider.value = items.jumpFactor;
    jumpVal.textContent = items.jumpFactor;
  });
}

jumpSlider.addEventListener('input', (e) => {
  const val = parseInt(e.target.value, 10);
  jumpVal.textContent = val;
  if (extensionAPI && extensionAPI.storage && extensionAPI.storage.sync) {
    extensionAPI.storage.sync.set({ jumpFactor: val });
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
    console.error("[TabAssist Debug] MediaPipe Vision exports missing. Global Vision object:", window.Vision);
    throw new Error("MediaPipe Vision library bundle failed to load.");
  }

  // Resolve absolute paths for local extension assets
  const wasmPath = extensionAPI.runtime.getURL("lib");
  const modelPath = extensionAPI.runtime.getURL("lib/face_landmarker.task");

  console.log("[TabAssist Debug] Loading WASM binaries from:", wasmPath);
  console.log("[TabAssist Debug] Loading face model from:", modelPath);

  const filesetResolver = await vision.FilesetResolver.forVisionTasks(wasmPath);

  // Try GPU delegate first, fallback to CPU delegate if WebGL context creation fails
  try {
    console.log("[TabAssist Debug] Initializing FaceLandmarker with GPU delegate...");
    faceLandmarker = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numFaces: 1
    });
  } catch (gpuError) {
    console.warn("[TabAssist Debug] GPU delegate failed, falling back to CPU delegate:", gpuError);
    faceLandmarker = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: "CPU"
      },
      runningMode: "VIDEO",
      numFaces: 1
    });
  }

  console.log("[TabAssist Debug] MediaPipe FaceLandmarker initialized successfully.");
}

/**
 * Requests camera permission, initializes video stream and starts tracking loop.
 */
async function startCamera() {
  console.log("[TabAssist Debug] Start Camera requested.");
  try {
    await initMediaPipe();

    console.log("[TabAssist Debug] Requesting getUserMedia stream...");
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, frameRate: { ideal: 30 } },
      audio: false
    });

    console.log("[TabAssist Debug] getUserMedia success. Stream active:", cameraStream.active);

    videoElement.srcObject = cameraStream;
    placeholder.style.display = "none";
    videoElement.style.display = "block";
    startBtn.style.display = "none";
    stopBtn.style.display = "flex";

    statusIndicator.textContent = "TRACKING ACTIVE";
    statusIndicator.className = "active";

    await videoElement.play();
    console.log("[TabAssist Debug] Video element playback active. Launching frame detection loop...");
    predictWebcam();
  } catch (err) {
    console.error("[TabAssist Debug] Camera / MediaPipe Error Exception:", err);
    console.error(`[TabAssist Debug] Name: ${err.name} | Message: ${err.message}`);
    
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      statusIndicator.textContent = "CAMERA PERMISSION DENIED";
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
  console.log("[TabAssist Debug] Stopping camera tracking...");
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
  startBtn.style.display = "flex";
  stopBtn.style.display = "none";

  statusIndicator.textContent = "CAMERA STOPPED";
  statusIndicator.className = "";
  neutralNoseY = null;
  isDipping = false;
  isCooldown = false;
}

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
        const noseTipY = landmarks[1].y;

        if (neutralNoseY === null) {
          neutralNoseY = noseTipY;
        } else {
          // Slow baseline drift correction
          neutralNoseY = neutralNoseY * 0.95 + noseTipY * 0.05;
        }

        const currentDelta = noseTipY - neutralNoseY;

        if (!isCooldown) {
          if (currentDelta > NOD_THRESHOLD) {
            if (!isDipping) {
              isDipping = true;
              dipStartTime = now;
            } else if (now - dipStartTime > MAX_NOD_DURATION_MS) {
              isDipping = false;
            }
          } else if (isDipping) {
            const duration = now - dipStartTime;
            isDipping = false;

            if (duration <= MAX_NOD_DURATION_MS) {
              triggerTabJump();
            }
          }
        }
      }
    } catch (error) {
      console.error("[TabAssist Debug] Frame detection error:", error);
    }
  }

  animFrameId = requestAnimationFrame(predictWebcam);
}

/**
 * Sends jump command to active tab content script.
 */
function triggerTabJump() {
  isCooldown = true;
  statusIndicator.textContent = "⚡ NOD DETECTED!";

  extensionAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0] && tabs[0].id) {
      extensionAPI.tabs.sendMessage(tabs[0].id, { action: 'TRIGGER_JUMP' }, (response) => {
        if (extensionAPI.runtime.lastError) {
          console.log("[TabAssist Debug] Message runtime notice (tab might not be Songsterr):", extensionAPI.runtime.lastError.message);
        }
      });
    }
  });

  setTimeout(() => {
    if (cameraStream) {
      statusIndicator.textContent = "TRACKING ACTIVE";
      statusIndicator.className = "active";
    }
    isCooldown = false;
  }, COOLDOWN_MS);
}

startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);