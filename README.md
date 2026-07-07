# OrcaXR

**OrcaXR** is an XR-native 3D printing slicer, now reimagined entirely for the web.

Originally built as a native Android app, OrcaXR has been rewritten to be a fully web-native application. The native Android app is now **deprecated**.

## ⚠️ DISCLAIMER: USE AT YOUR OWN RISK

**OrcaXR is experimental software in an Alpha state.** 3D printing involves high temperatures, moving parts, and potential fire hazards. Slicing errors or unexpected G-code generation may occur. Always verify generated G-code in a desktop viewer before printing, and never leave your printer unattended.

## Highlights

*   **Web Native**: Access the slicer directly from your browser. No installation necessary.
*   **XR Ready**: Dive into an immersive spatial computing experience. OrcaXR works seamlessly in a **desktop web browser** or an **XR device** such as the Samsung Galaxy XR.
*   **Powered by XRBlocks**: Built using the [XRBlocks](https://xrblocks.github.io/) framework for fluid 3D interactions, UI, and spatial environment understanding.

## Getting Started

To launch OrcaXR, simply visit our hosted web application:
**[Launch OrcaXR Web App](https://orcaxr.martinez.fyi/slicer/)**

*Note: You do not need to install an APK or compile any native code to run the slicer.*

### Connecting to a Snapmaker U1
If you want to connect to a Snapmaker U1 printer over the network from the web app, you must follow these steps to bypass the browser's Mixed Content security policies:

1. Install the extended firmware on your printer: [SnapmakerU1-Extended-Firmware](https://github.com/paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware).
2. Enable Tailscale on the printer.
3. SSH into your printer as root and run the following command to securely serve Moonraker over HTTPS:
   ```bash
   tailscale serve --bg http://127.0.0.1:7125
   ```
4. In OrcaXR, enter your printer's Tailscale HTTPS address (e.g., `https://lava.taild5c213.ts.net`).

### External Slicer (Docker)
OrcaXR runs slicing natively in the browser via WebAssembly (WASM). However, WASM has a hard memory limit of 4GB, which can cause out-of-memory crashes on extremely large or complex models. 

To solve this, you can run the **External Slicer** via Docker. This offloads slicing to a dedicated server and uses the **official Snapmaker Orca Slicer** native binary instead of the WASM fork.

To start the external slicer:
```bash
cd server
docker compose up -d
```
Then, in the OrcaXR web app, open the **EXTERNAL SLICER** panel and connect to your Docker instance (e.g., `http://localhost:3000`).

## Project Status

- **Android App**: Deprecated.
- **Web App**: Active Development (Alpha).

## Contributing

Contributions are always welcome. Feel free to open issues or pull requests to improve the web experience.

## License

OrcaXR is open source software. Please see the `LICENSE` file for more details.

---
*Built with ❤️ for the future of spatial making.*
