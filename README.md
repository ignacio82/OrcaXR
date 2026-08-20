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

### Self-Hosting / All-in-One Container (Docker)

OrcaXR can be self-hosted as an all-in-one container that packages the full Web UI, the native Snapmaker Orca CLI engine, the WASM engine, and optional Tailscale HTTPS support:

```bash
docker compose -f server/docker-compose.yml up -d
```

- **Web UI & Slicing**: Navigate to `http://localhost:3000`. The browser UI automatically discovers the native CLI slicer on the container with zero configuration.
- **Same-Origin Trust**: Slicing from the served UI is authorized automatically without requiring bearer tokens. Non-browser API clients use the persistent bearer token saved to `~/.orcaxr/server-token`.
- **Headset / WebXR Access via Tailscale**: For spatial slicing on standalone XR headsets (such as the Samsung Galaxy XR) which require a secure HTTPS context for WebXR, launch with your Tailscale auth key:

```bash
TS_AUTHKEY="tskey-auth-..." docker compose -f server/docker-compose.yml up -d
```

Tailscale Serve will automatically provision HTTPS certificates at `https://orcaxr.<your-tailnet>.ts.net`, giving headsets immediate access to WebXR, full-power CLI slicing, and 3D spatial interaction.

## Project Status

- **Android App**: Deprecated.
- **Web App**: Active Development (Alpha).

## Contributing

Contributions are always welcome. Feel free to open issues or pull requests to improve the web experience.

## License

OrcaXR is licensed under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html). See [NOTICE.md](NOTICE.md) for source and third-party attributions.

---
*Built with ❤️ for the future of spatial making.*
