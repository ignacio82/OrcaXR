# OrcaXR

**OrcaXR** is an XR-first 3D printing slicer, now reimagined entirely for the web.

Originally built as a native Android app, OrcaXR has been rewritten to be a fully web-native application. The native Android app is now **deprecated**.

## ⚠️ DISCLAIMER: USE AT YOUR OWN RISK

**OrcaXR is experimental software in an Alpha state.** 3D printing involves high temperatures, moving parts, and potential fire hazards. Slicing errors or unexpected G-code generation may occur. Always verify generated G-code in a desktop viewer before printing, and never leave your printer unattended.

## Highlights

*   **Web Native**: Access the slicer directly from your browser. No installation necessary.
*   **Experimental XR Shell**: Use the desktop web app or enter the spatial shell on an **XR device** such as the Samsung Galaxy XR. End-to-end controller, hand, and gaze qualification is still in progress.
*   **Powered by XRBlocks**: Built using the [XRBlocks](https://xrblocks.github.io/) framework for fluid 3D interactions, UI, and spatial environment understanding.

## Getting Started

To launch OrcaXR, simply visit our hosted web application:
**[Launch OrcaXR Web App](https://orcaxr.martinez.fyi/slicer/)**

*Note: You do not need to install an APK or compile any native code to run the slicer.*

### Connecting to a Snapmaker U1
Chrome 142 and newer can grant the hosted HTTPS app Local Network Access to a printer's HTTP Moonraker endpoint:

1. In Moonraker's `[authorization]` section, add the OrcaXR page's exact origin to `cors_domains` and restart Moonraker. For the hosted app, that origin is `https://orcaxr.martinez.fyi`.
2. In OrcaXR, enter the full local URL, such as `http://192.168.1.50` or `http://printer.local:7125`.
3. Approve the browser's Local Network Access prompt.

HTTP leaves printer status, API keys, webcam frames, and uploaded G-code unencrypted, so only use it on a trusted LAN. Browsers without Local Network Access support—or users who deny permission—still need a trusted HTTPS endpoint or reverse proxy.

For the Snapmaker U1, the [extended firmware](https://github.com/paxx12-snapmaker-u1/SnapmakerU1-Extended-Firmware) can provide an HTTPS fallback through Tailscale. Join the browser or headset and printer to the same tailnet, enable Tailscale, then SSH into the printer as root and run:

   ```bash
   tailscale serve --bg http://127.0.0.1:80
   ```

Enter the resulting address in OrcaXR, for example `https://lava.taild5c213.ts.net`.

### External Slicer (Docker)
OrcaXR runs slicing locally in the browser via WebAssembly (WASM). However, WASM has a hard memory limit of 4GB, which can cause out-of-memory crashes on extremely large or complex models.

To solve this, you can run the **External Slicer** via Docker. This offloads slicing to a dedicated server and uses a native CLI built from the pinned Snapmaker Orca v2.3.4 source instead of the browser WASM runtime.

To start the external slicer:
```bash
cd server
docker compose up -d
```
Then, in the OrcaXR web app, open the **EXTERNAL SLICER** panel and connect to your Docker instance (e.g., `http://localhost:3000`).

From the hosted app, Chrome 142+ can also reach a LAN address such as `http://192.168.1.20:3000` after Local Network Access permission. The Docker server enables CORS; use HTTP only on a trusted LAN and prefer HTTPS for remote access.

## Project Status

- **Android App**: Deprecated.
- **Web App**: Active Development (Alpha).

## Contributing

Contributions are always welcome. Feel free to open issues or pull requests to improve the web experience.

## License

OrcaXR is licensed under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html). See [NOTICE.md](NOTICE.md) for source and third-party attributions.

---
*Built with ❤️ for the future of spatial making.*
