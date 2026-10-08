# TabAssist

Hands-free guitar tab navigation on Songsterr. Keep your hands on your instrument — just nod to scroll the tab forward.

![TabAssist demo](tabassist_demo.mp4)

## Features

- **Nod to scroll** — a quick downward nod jumps forward in the tab
- **Measures per jump** — choose how far each nod advances (1–16)
- **Nod sensitivity** — a 1–10 scale, from deliberate nods to subtle ones
- **Posture calibration** — capture your playing position in one click
- **100% on-device** — camera and tracking run locally, nothing is uploaded
- **Works offline** — all AI files ship with the extension, no CDN needed
- **Detector debug view** — an optional live view for fine-tuning detection

## Try it

1. Open `chrome://extensions`, enable **Developer mode**, and load this folder with **Load unpacked**. (Chrome Web Store listing coming soon.)
2. Go to any tab on [Songsterr](https://www.songsterr.com).
3. Click the TabAssist icon, press **Start Camera**, and allow camera access.
4. Set your measures per jump, optionally calibrate your posture, and nod to scroll.

Nods need to be quick — holding your head down (for example to check the fretboard) is ignored on purpose.

## Privacy

- The camera runs only while tracking is started from the popup.
- All face tracking happens locally on your device.
- No video, images, or data ever leave your machine.

## License

[MIT](LICENSE)
