# TabAssist 🎸

**TabAssist** is a lightweight, privacy-focused Chrome Extension (Manifest V3) designed for musicians. It enables hands-free guitar tab scrolling on [Songsterr](https://www.songsterr.com) using computer vision head gesture recognition.

With TabAssist, you can scroll through tabs while holding your instrument by giving a brief, natural head nod.

---

## 🌟 Key Features

- **Hands-Free Tab Scrolling**: Quickly advance tabs using quick downward head nods.
- **100% Local & Private Vision**: Powered by Google MediaPipe Tasks Vision running locally in your browser—no video or frame data ever leaves your device.
- **Guitar Glance Filtering**: A rigid nose-pitch measurement from MediaPipe's facial-orientation matrix, plus a frozen baseline and hysteresis, rejects sustained head lowering (glancing at your fretboard) and head tilts, so only a real down-and-up nod triggers a jump.
- **Configurable Jump Sensitivity**: Customize how many measures/lines forward each nod jump advances (1 to 16 measures).
- **Nod Sensitivity Meter**: Choose how large a nod must be on a 1–10 scale without rebuilding the extension.
- **Playing-Posture Calibration**: Capture standing, sitting, near/far, or turned-posture idle positions as a better detector starting point.
- **Fully Offline Ready**: Self-contained web assembly bundles with zero reliance on external CDNs or remote dependencies.
- **Developer Debug Logging**: Verbose debug logs in the extension popup dev tools for easy troubleshooting.
- **Built-In Detector Inspector**: An optional panel in the popup plots the live signal against the baseline and thresholds, and shows the state machine, so thresholds can be tuned against a real camera without a rebuild.

---

## 🧠 How the Gesture Detection Works

The interesting problem is not detecting that a head moved — it is telling an
*intentional nod* apart from the several other things a guitarist's head does.
The full write-up lives in [`nodDetector.js`](nodDetector.js); the short version:

1. **The signal.** Not the raw nose-tip Y from MediaPipe, which responds to
   nodding, leaning, and head tilt alike. The primary signal is the direction
   the nose is actually pointing, taken from MediaPipe's facial-transformation
   matrix:

   ```js
   forward = normalize(matrixColumn(z))
   nosePitchDeg = asin(-forward.y)
   ```

   That matrix maps MediaPipe's canonical face model to the observed face, so
   its third column is the nose-forward axis. Translation lives in a different
   part of the matrix, uniform scale is normalized away, and rolling around the
   forward axis does not move that axis. Consequently, moving or bobbing the
   whole head does not look like a nod; only changing the nose's pitch does.
   A physical 20° nod changes this signal by about 20°, rather than changing a
   projected face-shape proxy by a few hundredths of an eye distance.

   If MediaPipe does not supply a transformation matrix, the detector falls back
   to the nose tip measured relative to the eyes, along the face's own down
   axis:

   ```js
   down   = perpendicular(rightEye - leftEye)
   signal = dot(noseTip - eyeMid, down) / |rightEye - leftEye|
   ```

   The fallback measures face *shape* rather than face *position*, but its pitch
   response is weak: foreshortening shrinks the projected gap by `cos θ`, so a
   25° nod moves it by only about **0.05 eye-distances**. The fallback therefore
   uses separate eye-distance-unit thresholds.
2. **A frozen reference.** The baseline adapts slowly toward the resting
   position, but **only while idle**. The moment a dip starts, the reference is
   frozen for its duration. This is the bug fix: the previous version kept
   adapting mid-gesture, so for a downward step of depth `D` the baseline
   converged on its own as `D · 0.95ⁿ`, sliding back under the threshold after
   `ln(0.040/D)/ln(0.95)` frames — roughly 150 ms at `D = 0.05` — with the head
   still down. That fired on looking down without ever looking back up.
3. **Hysteresis.** At the default sensitivity, entering a nose-pitch dip needs a
   7° excursion, completing one needs the head back within 2.5° of where it
   started, plus a real minimum depth of 5°. So the return has to be genuine
   rather than the baseline drifting into place. The fallback uses the
   corresponding eye-distance thresholds: enter `0.024`, exit `0.009`, minimum
   depth `0.018`. The 1–10 sensitivity control scales all three thresholds
   together while preserving their hysteresis relationship.
4. **Duration and cooldown.** A dip lasting over 400 ms is treated as the player
   checking their fretboard, not gesturing, so it is discarded; an 800 ms
   lockout after firing stops one nod counting as several jumps.

Four states — `IDLE`, `DIPPING`, `COOLDOWN`, `DISARMED` — cover the transitions,
including recovery after an abandoned dip.

The popup supplies MediaPipe landmarks `4` (nose tip) and opposite outer eye
corners `33` and `263`. Landmark `133` is intentionally avoided because it is
the inner corner of the same eye as `33`; using those two points would collapse
the eye line to one eyelid and destabilize the tilt guard.

Calibration records the current resting signal after about one second of steady
posture. It is a starting point, not a lock: the adaptive baseline keeps
running, so standing up, leaning, or gradually changing posture does not
require recalibration. Separate sitting/standing positions also do not need
separate saved postures unless the user wants a particular starting baseline;
facing left or right does not need calibration because the nose-pitch signal is
constructed to avoid yaw leakage.

Performance: frames are only processed when the video element reports a new
`currentTime`, so inference never runs twice on the same frame; capture is
constrained to 320×240 @ 30 fps; and the landmarker initialises with a GPU
delegate, falling back to CPU if the WebGL context fails.

---

## 🧪 Tests

The gesture logic is pure and DOM-free, so it is tested against synthetic
signals — no webcam required, and fully deterministic:

```bash
node --test tests/*.test.js
```

Scenarios are written as head-pitch profiles in degrees rather than raw signal
values, against a simple geometric face model (`tests/helpers.js`), so the
numbers stay meaningful as the detector's internal scaling changes.

Coverage includes a nod firing once, looking down and holding *not* firing,
recovery after a long hold, head tilt rejection, jitter, cooldown, posture
drift, detection stability across face size and roll, nose-pitch matrix parsing
(including ignored translation/scale/roll/yaw components), sensitivity scaling,
calibration acceptance/rejection, popup integration contracts, and a fuzz pass
asserting that randomised motion never
false-triggers while textbook nods are still reliably detected.

### Inspecting the detector live

Click **Show detector debug** in the popup for a live plot of the smoothed
signal against the baseline and the enter/exit thresholds, plus the current
state, active signal source, nose pitch, fallback eye shape, dip reference,
peak depth, interocular distance and roll. This is a read-only view of the
detector's own debug object, so it cannot change what gets detected — it exists
to make threshold tuning against a real camera possible without a rebuild.

---

## 📁 Directory Structure

```text
tasbassist-extension/
├── manifest.json            # Extension configuration & MV3 permissions
├── popup.html               # Settings interface, webcam preview, debug panel
├── popup.js                 # MediaPipe init, camera control, debug UI, messaging
├── nodDetector.js           # Gesture recognition algorithm (documented, tested)
├── content.js               # Songsterr DOM injector & keypress simulator
├── tests/                   # Deterministic gesture-detection test suite
│   ├── helpers.js           # Geometric face model + detector loader
│   ├── nodDetector.test.js  # Named scenarios
│   ├── signal.test.js       # Signal scale, invariance and direction
│   ├── fuzz.test.js         # Randomised motion, false-positive hunting
│   └── surface.test.js      # Global API + popup integration contracts
├── lib/                     # Self-contained local web vision libraries
│   ├── vision_bundle.js     # MediaPipe Tasks Vision engine
│   ├── vision_wasm_internal.js
│   ├── vision_wasm_internal.wasm
│   └── face_landmarker.task # Quantized face landmark detection model
├── LICENSE
└── README.md
```

---

## 📌 Important Note on Browser Popup Behavior

In Chrome Manifest V3 extensions, **toolbar popup windows automatically close** whenever you click anywhere outside the popup (e.g., clicking on the Songsterr webpage to focus or scroll). When the popup closes, its DOM context and webcam stream are destroyed by Chrome.

### 💡 Recommended Setup for Practice Sessions:
- **Pin Extension / Keep Open**: If you want to view the camera preview while practicing, **right-click the extension icon or popup title bar and select "Inspect"** (or inspect popup element). Keeping DevTools open for the popup prevents Chrome from closing it when clicking on the tab!
- Alternatively, you can use Chrome's **Side Panel API** or open the popup in its own window tab (`chrome-extension://<EXTENSION_ID>/popup.html`).

---

## 🚀 Installation

1. Clone or download this repository to your local machine:
   ```bash
   git clone https://github.com/YOUR_USERNAME/tasbassist-extension.git
   ```
2. Open Google Chrome (or any Chromium browser like Brave or Edge) and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle switch in the upper right corner.
4. Click **Load unpacked** and select the `tasbassist-extension` directory.

---

## 🎸 How to Use

1. Navigate to any tab track on [Songsterr](https://www.songsterr.com).
2. Click the **TabAssist** icon in your browser toolbar to open the popup.
3. Click **Start Camera** and grant camera permissions when prompted.
4. Set your preferred **Measures per Jump** slider (default: `4`).
5. Optionally set **Nod sensitivity**: lower values need a larger nod, higher values count a smaller nod.
6. Optionally assume your normal playing posture and click **Calibrate playing posture** while holding still for about one second.
7. Perform a quick, subtle downward nod to jump forward through the tab!

Nods need to be **quick**. A hold of more than about 400 ms reads as looking at
your fretboard and is deliberately ignored — hold your head down as long as you
like and nothing will fire.

---

## 🔒 Privacy

TabAssist prioritizes user privacy:
- Webcam access is only requested while the extension popup is open and camera tracking is explicitly started.
- All face landmark detection runs locally on your machine via WebAssembly and WebGL.
- No network requests, metrics, or video data are transmitted.

---

## 📄 License

[MIT](LICENSE)
