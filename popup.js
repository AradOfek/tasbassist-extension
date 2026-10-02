/**
 * TabAssist Extension Popup Script
 * 
 * Manages face tracking initialization via MediaPipe Tasks Vision,
 * controls webcam lifecycle, detects downward head nod gestures,
 * and communicates jump actions to active tab content scripts.
 */

// Universal extension API runtime compatibility layer
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

// Head nod detection parameters & tracking state
let neutralNoseY = null;
const NOD_THRESHOLD = 0.040;        // Normalized vertical movement threshold
const MAX_NOD_DURATION_MS = 400;   // Maximum allowed duration for a nod gesture
const COOLDOWN_MS = 800;           // Refractory delay between trigger actions

let isDipping = false;
let dipStartTime = 0;
let isCooldown = false;

/**
 * Sync jump factor setting with extension storage on startup.
 */
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
 * Initializes the MediaPipe FaceLandmarker task using bundled local assets.
 */
async function initMediaPipe() {
  if (faceLandmarker) return;

  statusIndicator.textContent = "LOADING AI ENGINE...";
  statusIndicator.className = "";

  // The vision_bundle.js IIFE defines the global 'Vision' object
  const vision = window.Vision || window;
  
  if (!vision.FilesetResolver || !vision.FaceLandmarker) {
    console.error("[TabAssist Debug] MediaPipe Vision exports missing. Global Vision object:", window.Vision);
    throw new Error("MediaPipe Vision library bundle failed to load.");
  }

  // Resolve WASM assets relative to extension root URL
  const wasmPath = extensionAPI.runtime.getURL("lib");
  const modelPath = extensionAPI.runtime.getURL("lib/face_landmarker.task");

  console.log("[TabAssist Debug] Resolving WASM assets from:", wasmPath);
  console.log("[TabAssist Debug] Loading model asset from:", modelPath);

  const filesetResolver = await vision.FilesetResolver.forVisionTasks(wasmPath);

  faceLandmarker = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath: modelPath,
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numFaces: 1
  });

  console.log("[TabAssist Debug] MediaPipe FaceLandmarker successfully initialized.");
}

/**
 * Requests camera permission, initializes video stream and starts face tracking loop.
 */
async function startCamera() {
  console.log("[TabAssist Debug] Start Camera clicked. Initializing tracking pipeline...");
  try {
    await initMediaPipe();

    console.log("[TabAssist Debug] Requesting getUserMedia camera stream...");
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, frameRate: { ideal: 30 } },
      audio: false
    });

    console.log("[TabAssist Debug] Camera stream obtained:", cameraStream);

    videoElement.srcObject = cameraStream;
    placeholder.style.display = "none";
    videoElement.style.display = "block";
    startBtn.style.display = "none";
    stopBtn.style.display = "block";

    statusIndicator.textContent = "TRACKING ACTIVE";
    statusIndicator.className = "active";

    // Play video stream explicitly to ensure continuous frame processing
    await videoElement.play();
    console.log("[TabAssist Debug] Video playback started. Launching prediction loop...");
    predictWebcam();
  } catch (err) {
    console.error("[TabAssist Debug] Detailed Camera / MediaPipe Error:", err);
    console.error("[TabAssist Debug] Error Name:", err.name, "| Message:", err.message, "| Stack:", err.stack);
    
    statusIndicator.textContent = err.name === "NotAllowedError" ? "CAMERA PERMISSION DENIED" : "CAMERA ERROR";
    statusIndicator.className = "error";
  }
}

/**
 * Stops active webcam tracks and halts the frame processing loop.
 */
function stopCamera() {
  console.log("[TabAssist Debug] Stopping camera and cleaning up resources...");
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
  neutralNoseY = null;
  isDipping = false;
  isCooldown = false;
}

/**
 * Continuous animation frame processing loop for detecting face landmarks and head nods.
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
        const noseTipY = landmarks[1].y; // Index 1 represents tip of the nose

        if (neutralNoseY === null) {
          neutralNoseY = noseTipY;
        } else {
          // Update baseline smoothing slowly to adapt to gradual body shifts
          neutralNoseY = neutralNoseY * 0.95 + noseTipY * 0.05;
        }

        const currentDelta = noseTipY - neutralNoseY;

        if (!isCooldown) {
          if (currentDelta > NOD_THRESHOLD) {
            if (!isDipping) {
              isDipping = true;
              dipStartTime = now;
            } else if (now - dipStartTime > MAX_NOD_DURATION_MS) {
              // Ignore prolonged head lowerings (e.g. looking down at instrument)
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
      console.error("[TabAssist Debug] Frame landmark detection error:", error);
    }
  }

  animFrameId = requestAnimationFrame(predictWebcam);
}

/**
 * Sends jump notification to active browser tab and engages cooldown delay.
 */
function triggerTabJump() {
  isCooldown = true;
  statusIndicator.textContent = "⚡ NOD DETECTED!";

  extensionAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0] && tabs[0].id) {
      extensionAPI.tabs.sendMessage(tabs[0].id, { action: 'TRIGGER_JUMP' }, () => {
        // Handle potential runtime message errors gracefully (e.g. non-supported tabs)
        if (extensionAPI.runtime.lastError) {
          // Message ignored or recipient non-existent on current active tab
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

// Attach control event handlers
startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);