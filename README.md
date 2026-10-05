# TabAssist 🎸

**TabAssist** is a lightweight, privacy-focused Chrome Extension (Manifest V3) designed for musicians. It enables hands-free guitar tab scrolling on [Songsterr](https://www.songsterr.com) using computer vision head gesture recognition.

With TabAssist, you can scroll through tabs while holding your instrument by giving a brief, natural head nod.

---

## Key Features

- **Hands-Free Tab Scrolling**: Quickly advance tabs using quick downward head nods.
- **100% Local & Private Vision**: Powered by Google MediaPipe Tasks Vision running locally in your browser—no video or frame data ever leaves your device.
- **Guitar Glance Filtering**: Built-in gesture logic filters out prolonged head lowering (like glancing down at your guitar neck or fretboard) to prevent accidental triggers.
- **Configurable Jump Sensitivity**: Customize how many measures/lines forward each nod jump advances (1 to 16 measures).
- **Fully Offline Ready**: Self-contained web assembly bundles with zero reliance on external CDNs or remote dependencies.
- **Developer Debug Logging**: Verbose debug logs in the extension popup dev tools for easy troubleshooting.

---

## Directory Structure

```text
tasbassist-extension/
├── manifest.json            # Extension configuration & MV3 permissions
├── popup.html               # Settings interface & webcam preview window
├── popup.js                 # MediaPipe init, camera control, gesture logic
├── content.js               # Songsterr DOM injector & keypress simulator
├── lib/                     # Self-contained local web vision libraries
│   ├── vision_bundle.js     # MediaPipe Tasks Vision engine
│   ├── vision_wasm_internal.js
│   ├── vision_wasm_internal.wasm
│   └── face_landmarker.task # Quantized face landmark detection model
└── README.md
```

---

## Installation

1. Clone or download this repository to your local machine:
   ```bash
   git clone https://github.com/YOUR_USERNAME/tasbassist-extension.git
   ```
2. Open Google Chrome (or any Chromium browser like Brave or Edge) and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle switch in the upper right corner.
4. Click **Load unpacked** and select the `tasbassist-extension` directory.

---

## How to Use

1. Navigate to any tab track on [Songsterr](https://www.songsterr.com).
2. Click the **TabAssist** icon in your browser toolbar to open the popup.
3. Click **Start Camera** and grant camera permissions when prompted.
4. Set your preferred **Measures per Jump** slider (default: `4`).
5. Perform a quick, subtle downward nod to jump forward through the tab!

---

## 🔒 Privacy

TabAssist prioritizes user privacy:
- Webcam access is only requested while the extension popup is open and camera tracking is explicitly started.
- All face landmark detection runs locally on your machine via WebAssembly and WebGL.
- No network requests, metrics, or video data are transmitted.

---

## 📄 License

[MIT](LICENSE)
