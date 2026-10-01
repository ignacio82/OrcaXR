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

The Device page can remember printer API keys and slicer tokens in this browser's
local storage. This is optional (enabled by default), is not encrypted by OrcaXR,
and is readable by scripts on the same origin or anyone with access to the browser
profile. Turning remembrance off or choosing **Forget Saved Credentials** erases
saved copies. AI keys stay in tab memory only.

Printer maintenance scripts require an explicit SSH host and account:

```bash
python3 fix-moonraker.py --host printer.local --username root
```

They use keys or your SSH agent and require an already verified `known_hosts`
entry. Verify the printer's host-key fingerprint through a trusted channel before
adding it with your normal SSH client. `--known-hosts` selects another verified
file; `--identity` selects a private key. If the printer requires a password, add
`--password` to use OpenSSH's hidden terminal prompt. The scripts never embed,
store, or log authentication credentials. The Moonraker service and webcam scripts
change configuration and restart/reload the relevant service when run.

Credentials formerly embedded in maintenance scripts and server tokens formerly
printed in startup logs must be rotated if still active. Source cleanup does not
revoke those credentials or remove copies from Git history. History rewriting is
a separate coordinated operation; rotation and hardware qualification remain
pending until recorded evidence exists.

### Self-Hosting / All-in-One Container (Docker)

OrcaXR can be self-hosted as an all-in-one container that packages the full Web UI, the native Snapmaker Orca CLI engine, the WASM engine, and optional Tailscale HTTPS support:

```bash
docker compose -f server/docker-compose.yml up -d
```

- **Web UI & Slicing**: Navigate to `http://localhost:3000`. The browser UI automatically discovers the native CLI slicer on the container with zero configuration.
- **Same-Origin Trust**: Slicing from the served UI is authorized automatically without requiring bearer tokens. Non-browser API clients use a token supplied through `ORCAXR_SERVER_TOKEN_FILE` or `ORCAXR_SERVER_TOKEN`. Loopback-only same-origin deployments can also generate a persistent token in `~/.orcaxr/server-token`.

Generated server tokens are stored with owner-only permissions. Startup logs name
the protected file only; they never print its value. Keep token files out of
shared diagnostics and use `ORCAXR_SERVER_TOKEN_FILE` for managed deployments.

To add HTTPS through the optional Tailscale sidecar, supply `TS_AUTHKEY` through
your process environment or secret manager, then enable its Compose profile:

```bash
docker compose -f server/docker-compose.yml --profile tailscale up -d --build
```

Enable HTTPS certificates in your tailnet and open the node's Serve URL from
another authenticated tailnet device. The sidecar uses userspace networking,
shares OrcaXR's network namespace, and forwards to `127.0.0.1:3000`. Its whole
`server/tailscale/` configuration directory is mounted so Serve detects updates,
as required by the [Tailscale Docker configuration](https://tailscale.com/docs/features/containers/docker/docker-params).
No host networking, TUN device, or added network capability is needed.

**The Tailscale profile adds access; it does not remove LAN access.** Base Compose
still publishes `0.0.0.0:3000`, with its explicit LAN-exposure acknowledgment.
For a tailnet-only deployment, bind the published port to `127.0.0.1:3000:3000`
and keep the container's listener reachable by its loopback proxy. LAN mode
requires a trusted local network; HTTPS is required for WebXR and service workers.

`ORCAXR_TRUSTED_PROXY=loopback` accepts forwarded protocol and Tailscale identity
only from the actual loopback socket peer, never from `X-Forwarded-For` or a
client-supplied IP. A trusted proxy must overwrite those headers and supply one
exact `http` or `https` protocol. Same-origin authentication, CORS, and rate-limit
identity use this same boundary. Embedded Tailscale startup (when explicitly
passing `TS_AUTHKEY` into the application container) uses the same userspace
networking and loopback trust; the Compose profile is the normal deployment.

Application assets and HTML navigations bypass the API request allowance.
Hashed assets cache immutably; entry points revalidate. API routes retain their
authentication, CORS, request/upload limits, and bounded slicing admission.
Unknown API routes return JSON errors, never the application shell.

### Engine artifact publication

Every required or present deployment copy must contain both engine files and
its adjacent `artifact-provenance.json`. Verification checks schema, pinned
source, build-input identity, expected filenames, and actual SHA-256 hashes.
Missing files, stale manifests, and partial optional copies fail verification.

```bash
npm --prefix wasm run verify:artifacts
npm --prefix wasm run publish:server
```

The publisher copies and verifies a complete immutable version under
`server/wasm-artifacts/sets/`, then atomically switches `current`. Existing workers
keep their resolved version. Old sets remain for active readers and rollback;
remove them only with the service stopped. Do not update active engine files in
place. Docker assembly uses the same publisher and verifier for the runtime set
and the built browser copy. Server `/engine` reports a specific `reasonCode`
when attestation fails; changing an environment path cannot make a partial set
fall back silently to another engine.

Run `npm --prefix server run test:deployment` after building the web app to test
cold HTTP LAN and local HTTPS proxy loads, complete precaching, simulated slicing,
and API limits through Express. After building the image, run
`npm --prefix server run test:deployment:container` for the same checks against
its packaged UI and server. These tests use a deterministic test runner and local
certificates, and never contact printer hardware or join a tailnet. Native builds
default to two top-level jobs; use `--build-arg ORCA_BUILD_JOBS=1` on a busy host.
Some upstream dependency subbuilds choose their own worker counts.

### Slicer job recovery and cancellation

`POST /slice?async=1` returns a job ID. `GET /jobs/:id` reports status and,
after completion, `completedAt` and `expiresAt` timestamps. Completed G-code can
be downloaded repeatedly from `GET /jobs/:id/gcode` for ten minutes by default
(`ORCAXR_JOB_TTL_MS`). Interrupted downloads do not delete the result. Synchronous
`POST /slice` responses also expose the ID through `X-OrcaXR-Job-Id` for retries.

`DELETE /jobs/:id` cancels active work or releases a terminal result, returning
its terminal status before release. Repeated release is idempotent. Downloads
already in progress retain their files until all readers finish. New work gets
a retryable 503 when retained results fill the configured capacity. Browser
clients verify the job ID, SHA-256, and artifact byte count before releasing a
completed result; unsupported or failed releases fall back to TTL cleanup.

Only successful native process completion can publish G-code. Cancellation
terminates the owned process group before releasing the worker slot, including
descendants that outlive their parent or ignore SIGTERM. This guarantee is
qualified on Linux with a reaping init process: keep Compose's `init: true`
(or use `docker run --init`). Other hosts do not have equivalent qualified
process-tree behavior. A task stuck in kernel I/O remains owned until it exits;
the browser reports an unconfirmed cancellation if its cleanup deadline expires.

## Project Status

- **Android App**: Deprecated.
- **Web App**: Active Development (Alpha).

## Contributing

Contributions are always welcome. Feel free to open issues or pull requests to improve the web experience.

## License

OrcaXR is licensed under the [GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html). See [NOTICE.md](NOTICE.md) for source and third-party attributions.

---
*Built with ❤️ for the future of spatial making.*
