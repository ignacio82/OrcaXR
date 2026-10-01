# OrcaXR audit remediation and improvement plan

## 1. Outcome and implementation order

Address all 13 audit findings and implement all six improvement areas: autosave and recovery, deployment testing, large-project performance, application modularity, startup diagnostics, and documentation/qualification.

Deliver this in independently testable changes, ordered as follows:

1. Dependency and credential fixes.
2. Printer command and submission safety.
3. Slicing process, cancellation, and download reliability.
4. Deployment, proxy trust, and artifact verification.
5. Discovery races and startup health.
6. Asset snapshot performance and application controller extraction.
7. Autosave, recovery, and navigation protection.
8. G-code preview performance.
9. Full deployment testing, documentation, and hardware qualification.

Preserve the existing canonical project model, pinned slicing engine, intentional LAN deployment, DOM/XR feature parity, and optional remembered printer credentials. Preserve the current uncommitted maintenance-script changes when editing those scripts.

“All issues” means the audit findings and improvement ideas. It does not expand this work into implementing every unfinished item in the separate upstream-parity backlog.

## 2. Implementation changes

### A. Dependencies and credentials — findings 6 and 7

**Update vulnerable dependencies.**

- Upgrade server Multer to **2.4.0 or a later compatible patched release**, updating the lockfile. Version 2.4.0 addresses the remaining upload cleanup vulnerability identified during the audit. [Multer advisory](https://github.com/expressjs/multer/security/advisories/GHSA-3pph-fpjx-jg34)
- Update the vulnerable `qs` resolution and affected web development dependencies through compatible parent-package updates.
- Preserve the load-bearing XRBlocks and UIKit version pins. Do not use a blanket forced dependency upgrade.
- Add full dependency auditing to CI, including development dependencies; require no unresolved high-severity findings and resolve the audit’s identified moderate findings.
- Exercise aborted multipart uploads, malformed fields, repeated disconnects, and temporary-file cleanup against the upgraded server.

**Remove embedded credentials and unsafe SSH defaults.**

- Replace duplicated SSH authentication code with a shared helper accepting explicit host and username.
- Use SSH keys/agent by default. Where password authentication is necessary, obtain it through an interactive hidden prompt.
- Require verified host keys; remove automatic acceptance and `StrictHostKeyChecking=no`.
- Remove committed password literals without reproducing them in logs, fixtures, documentation, or commit descriptions.
- Change generated server-token logging to report only the protected token-file location.
- Add regression checks for secret-bearing log output and hardcoded authentication literals in maintenance scripts.
- Keep the user-controlled “remember printer credentials” feature. Update its explanation to accurately describe device-local persistence; AI credentials remain memory-only.

**Operational completion:** rotate any still-active exposed credentials and invalidate obsolete copies. Treat repository-history rewriting as a separate coordinated action; removing current literals does not revoke previously exposed credentials.

### B. Printer command safety — finding 2

Introduce a `PrinterSessionController` that owns the selected printer, transport, connection generation, subscriptions, and outstanding operations.

**Bind commands to the original user intent.**

- Capture an immutable command intent when the operator clicks or begins a confirmation gesture.
- Include printer identity, connection generation, command, displayed filename, and authoritative job identity.
- Replace the boolean `preconfirmed` shortcut with a confirmation result bound to that exact intent. A hold gesture must not authorize a subsequently displayed job.
- Resolve job identity using Moonraker history and file metadata, including job ID and print start time. This detects a new run of the same filename. If reliable identity cannot be established, block ordinary job controls with an actionable explanation. [Moonraker job history](https://moonraker.readthedocs.io/en/latest/external_api/history/), [file metadata](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/)

**Revalidate immediately before dispatch.**

- Query authoritative current state after confirmation.
- Compare against the original intent; never replace the expected filename or identity with the newly queried values.
- Reject printer changes, reconnects, job replacement, incompatible state transitions, malformed responses, and failed queries.
- Parse full query responses independently from incremental WebSocket notifications. Missing fields in a fresh query must not inherit stale values from the notification accumulator.
- Serialize ordinary commands per printer and suppress duplicate submissions.

Emergency stop remains reachable without successful readiness or history queries. Firmware restart remains a separately confirmed recovery action bound to the selected printer.

**Acceptance:** confirming cancellation of job A cannot dispatch against job B, including when both use the same filename. A failed refresh cannot authorize pause, resume, or cancel.

### C. Print submission safety — findings 3 and 5

Introduce a `PrintWorkflowController` shared by DOM and XR.

**Use an explicit submission lifecycle.**

`checking → confirming → uploading → verifying → preparing → starting → completed`

Each operation owns an abort controller, captured printer session, exact artifact identity, tool mapping, and confirmed start options.

- Require complete, recognized readiness data. Missing or unknown Klipper/print state blocks submission.
- Permit automatic start only for explicitly recognized idle states: `standby`, `complete`, or `cancelled`, with Klipper ready and the virtual SD card inactive.
- Retain upload-only as the default.
- Recheck printer session, readiness, artifact freshness, tool mapping, and relevant capabilities after upload.
- Revalidate before each preparation operation and immediately before the start request.
- Replace the unstructured `beforeStart` callback with explicit preparation steps that receive the cancellation signal and validation context.
- If prerequisites change, retain the uploaded file and explain why printing did not start. Require a new confirmation for changed mappings or options.
- Never automatically retry an ambiguous preparation or start request. Report an uncertain outcome and reconcile against fresh printer state.

**Make non-overwrite behavior dependable.**

- Propagate file-listing failures instead of treating them as an empty directory.
- For non-overwrite uploads, generate a sanitized filename with a 128-bit random suffix using the existing LAN-compatible randomness approach.
- Check the generated name against the directory listing; regenerate on collision.
- For explicit overwrite, show the exact target and capture its metadata before confirmation. Revalidate that metadata immediately before upload and reject replacement of an active file.
- Verify the upload response’s root, path, and byte count before preparation or start.

Moonraker does not provide a client-side atomic “check state and start” transaction. These changes close OrcaXR’s stale-state paths; they must not be described as preventing every race with another printer client.

### D. Slicing process and artifact lifecycle — findings 1, 8, 9, and 13

**Require successful native process completion.**

- Treat nonzero exit codes, signals, timeouts, and cancellation as unsuccessful regardless of whether an output file exists.
- Publish output only after successful process completion and existing artifact validation.
- Keep output private to its job until validation succeeds.
- Preserve bounded diagnostic logs and return a stable public error code without exposing sensitive process details.
- Apply the same terminal-state rules to synchronous and asynchronous slicing.

**Terminate the complete process group.**

- Track the owned POSIX process group independently of the immediate child’s exit status.
- Send SIGTERM, wait the configured grace period, and escalate remaining group members to SIGKILL even if the parent has already exited.
- Do not release the worker slot or report confirmed cancellation while owned descendants remain alive.
- Clean temporary files only after process termination is settled.
- Qualify this guarantee on the supported Linux/container runtime; do not silently claim equivalent process-tree guarantees on unsupported hosts.

**Retain completed results for retries.**

- Make `GET /jobs/:id/gcode` repeatable until expiry or explicit release.
- Remove download-triggered deletion, including deletion after interrupted transfers.
- Keep the existing ten-minute default TTL, measured from terminal completion.
- Protect active transfers with reference counting so expiry or explicit release cannot unlink their files mid-transfer.
- Extend `DELETE /jobs/:id`: active jobs retain cancellation semantics; terminal jobs are released; repeated release is idempotent.
- Return the terminal state before releasing it so cancellation callers can distinguish “cancelled” from “already completed.”
- Have the browser release completed jobs only after downloading and validating the artifact. Failed release is harmless because TTL cleanup remains available.
- Keep storage/admission bounded. Reject new work with a retryable capacity response rather than evicting an unexpired, unacknowledged result.
- Expose the job ID on synchronous responses so a disconnected download can be recovered without reslicing.

**Bound external cancellation end to end.**

- Start the cancellation deadline before the DELETE request.
- Apply one deadline controller to DELETE, response-body parsing, polling, and delays.
- Keep cleanup cancellation separate from the already-aborted slice signal.
- Clear timers and listeners on every completion path.
- Distinguish confirmed cancellation, an already-terminal job, and an unconfirmed outcome.
- Retain the existing outer cleanup deadline as a final safeguard, with the inner deadline completing first.

### E. Deployment and artifact integrity — findings 4, 11, and 12

**Separate static traffic from API limits.**

- Serve known application assets through a dedicated static route before the API request limiter.
- Keep API authentication, CORS, upload limits, and slicing admission controls intact.
- Scope SPA fallback so an unknown API route cannot return application HTML.
- Preserve security headers and existing cache policy: immutable caching for hashed assets and revalidation for application entry points.
- Ensure a cold load and service-worker precache can request the complete build without consuming the API allowance.

**Correct Tailscale networking and proxy trust.**

- Preserve the base Compose configuration’s intentional LAN access.
- Change the optional Tailscale sidecar to share the application’s network namespace and proxy to `127.0.0.1:3000`.
- Use userspace networking and remove unnecessary host networking, TUN mounts, and network capabilities.
- Mount the Serve configuration directory so updates are detectable. [Tailscale Docker configuration](https://tailscale.com/docs/features/containers/docker/docker-params)
- Enable loopback proxy trust for this deployment.
- Centralize trusted-peer detection using the actual socket address. Honor forwarded protocol and Tailscale identity headers only from a trusted peer.
- Apply the same predicate to same-origin checks, CORS decisions, and rate-limit identity.
- Reject malformed forwarded protocol values.
- Align the embedded Tailscale entrypoint with the same trust rules.
- Document that enabling the Tailscale profile adds access; it does not disable the existing LAN publication.

**Verify every deployed artifact set.**

- Extend artifact verification to inspect the manifest adjacent to each required or present optional deployment copy.
- Check manifest schema, pinned source identity, expected files, and actual file hashes.
- Fail on partially populated deployment directories.
- Publish binaries and their manifest as one versioned artifact set, switching the active directory only after validation.
- Use the same verifier for local publication, Docker assembly, and CI.
- Correct the stale local deployment manifest only after proving its binaries match the canonical artifacts.
- Make server attestation report a specific mismatch rather than requiring an environment override to obtain a passing test suite.

### F. Discovery and startup health — finding 10 and improvement E

**Make discovery transactional.**

- Probe candidate slicers without mutating shared preferences.
- Capture a connection/preference generation before discovery and commit only if it remains current.
- Abort or ignore obsolete probes after manual connection, disconnect, preference changes, or disposal.
- Preserve an explicitly disabled external slicer across startup.
- Commit endpoint, enabled state, and attestation together.
- Treat unavailable browser storage as a recoverable persistence failure; the current session must continue operating.

**Make startup status reflect usable capabilities.**

- Introduce a feature initialization registry with `idle`, `loading`, `ready`, and `failed` states.
- Derive overall boot state as `loading`, `ready`, `degraded`, or `failed`.
- Treat canonical workspace initialization, required profiles, and settings schema as core dependencies.
- Disable dependent operations when core data fails to load and show a specific recovery action.
- Track optional capabilities separately. An intentionally disabled camera, AI integration, printer connection, or unavailable WebXR capability is not a startup failure.
- Catch lazy-import failures and dispose partially initialized features.
- Make retries idempotent. When a failed module import requires a reload, route that reload through the unsaved-work guard.
- Show equivalent status and recovery actions in DOM and XR.
- Replace the unconditional “Ready” marker with the derived boot state.

### G. Controller boundaries and asset snapshots — improvements C and D

Extract behavior incrementally after its regression tests exist.

| Component | Ownership |
|---|---|
| `PrinterSessionController` | Printer identity, connections, state queries, subscriptions, connection generation |
| `PrintWorkflowController` | Confirmation, command guards, upload, preparation, start, cancellation |
| `ProjectPersistenceController` | Manual export, autosave, recovery, dirty-navigation decisions |
| Surface lifecycle owner | DOM/XR mounting, visibility, event subscriptions, disposal |
| Composition root | Dependency construction and wiring |

Keep canonical project code UI-independent. Pass typed intents and results across boundaries rather than workspace objects or global callbacks. Every controller must have explicit disposal and reject late results after disposal.

**Remove full asset copies from command rollback snapshots.**

- Add opaque internal repository snapshots that share immutable asset records.
- Use copy-on-write map structure for insertion/removal and restore snapshots by reference.
- Retain defensive copying for public mutable reads and untrusted imports.
- Separate internal snapshot handles from serialized asset bundles so imported data still receives full validation.
- Reuse cached bundle fingerprints while contents remain unchanged.
- Audit direct `peek()` consumers to ensure none mutate shared descriptors or bytes.

**Acceptance:** transform, selection, and settings commands copy no mesh payload bytes; failed commands, undo, and redo preserve exact project and asset identity.

### H. Autosave, recovery, and navigation — improvement A

**Separate serialization from “saved” state.**

- Add a snapshot serialization operation that does not mark the project checkpoint.
- Add a guarded checkpoint operation for successful manual exports.
- Include project identity, revision, semantic hash, and asset fingerprint in export guards.
- Inject the worker serializer into the browser workspace for both manual export and autosave.
- Serialize one persistence request at a time; coalesce pending autosaves and prioritize explicit saves.
- Make worker cancellation, failure, and disposal settle every pending request.
- Do not repeatedly fall back to expensive main-thread autosaves when a worker is unavailable. Report recovery as unavailable; allow an explicit manual export fallback.

**Implement transactional IndexedDB storage.**

- Enable autosave by default after meaningful project edits.
- Trigger after five seconds of inactivity, with a maximum thirty-second scheduling delay during continuous editing.
- Retain up to three snapshots per project/session lineage.
- Default to a 512 MiB total recovery budget; allow adjustment up to the existing archive limit and available browser quota.
- Namespace records by project and editing session so simultaneous tabs cannot overwrite or prune each other’s active recovery data.
- Allocate sequence numbers and perform snapshot insertion/pruning in one transaction.
- Preserve the previous valid recovery record if a write fails.
- Compute integrity metadata before opening the transaction; validate metadata and archive contents before recovery.
- Preserve unsupported future-version records and report them instead of deleting them.
- Expose quota, unsupported storage, and serialization failures visibly without interrupting editing.

**Provide explicit recovery and navigation flows.**

- At startup, list recoverable sessions with project name and timestamp.
- Offer recover, download recovery file, and discard.
- Restore through the existing validated import pipeline and keep recovered content dirty until explicitly saved.
- Never replace an edited current project without the normal dirty-project confirmation.
- Guard New, Open/Replace, page reload, application update, and navigation.
- Register `beforeunload` only while dirty; use visibility changes for best-effort capture without depending on unload-time asynchronous work.
- Change PWA updating from automatic reload behavior to an update action coordinated with persistence.
- State clearly that ordinary browser downloads confirm handoff, not completion of a disk write.

### I. Large-project preview and import performance — improvement C

**Index before allocating rich G-code columns.**

- Build the existing lightweight layer index first.
- If the complete record count fits within the 240,000-record preview budget, parse the whole file.
- Otherwise load bounded windows from the index immediately, avoiding the current large whole-file allocation attempt.
- Enforce the same budget for an unusually large single layer. Add record-range checkpoints within that layer so its remaining moves remain accessible.
- Preserve original record IDs, tool state, parser checkpoints, source offsets, layer navigation, and explicit incomplete-input diagnostics.
- Move indexing/window parsing into a worker for the browser path; cancel obsolete requests when the source or requested window changes.
- Bound retained worker and main-thread data and dispose superseded buffers.

**Remove avoidable project-wide work.**

- Replace import-time whole-project stringification used for feature detection with targeted typed traversal.
- Reuse immutable snapshot identity and asset fingerprints during save and slice preparation.
- Preserve existing engine provenance, output hashing, and artifact freshness rules.

Use generated large fixtures for repeatable CI measurements. Keep the available large real-world project as an optional local qualification fixture rather than committing user content.

## 3. Interfaces and compatibility

| Interface | Planned change |
|---|---|
| Printer command request | Immutable intent with printer session and job identity; replace unbound `preconfirmed` |
| Printer state | Separate authoritative query parsing from incremental notifications |
| Submission request/result | Explicit preparation steps, cancellation context, blocked/uncertain outcomes, uploaded-file details |
| Project persistence | Separate snapshot serialization from guarded saved-checkpoint acknowledgment |
| Asset repository | Opaque internal rollback snapshots; validated bundles remain the import/export boundary |
| Autosave storage | Versioned IndexedDB records and atomic retention transactions |
| Slicer job API | Repeatable downloads, terminal expiry metadata, terminal-job release through DELETE, recoverable synchronous job ID |
| Boot state | Typed capability status and derived overall readiness |

Keep existing slicing routes and ordinary successful responses compatible. Add optional response fields rather than renaming existing ones. Terminal DELETE support is additive; browser release failures against older servers must fall back to TTL cleanup.

Do not change canonical 3MF semantics or the pinned slicing engine as part of these fixes.

## 4. Verification and acceptance criteria

Turn each reproduced audit failure into a regression before modifying the corresponding behavior.

| Area | Required scenarios |
|---|---|
| Native slicing | Partial output plus exit 17; signaled exit; successful output; missing/oversized output; cancelled job never published |
| Process cleanup | Parent exits first; descendant ignores SIGTERM; escalation removes descendants; queued and running cancellation; shutdown |
| Printer commands | A→B replacement during confirmation; same filename restarted; reconnect; printer switch; failed/partial refresh; duplicate gesture; emergency stop with unreadable state |
| Submission | Busy after upload; unknown state; changed tool mapping; stale artifact; failed preparation; cancellation at each phase; uncertain start response |
| Upload naming | Listing failure; generated collision; simultaneous clients; explicit overwrite target changed; active-file replacement refused |
| Downloads | Disconnect after first chunk; successful retry; concurrent readers; expiry during transfer; release during transfer; capacity pressure |
| Cancellation deadline | Hung DELETE; hung JSON body; hung poll; lost connection; already-terminal result; cleanup timers released |
| Discovery | Manual selection during probe; disabled preference; concurrent probes; storage unavailable; disposal |
| Autosave | Dirty flag preserved; crash/reload recovery; two tabs; quota rollback; corrupt newest record; future schema; stale serialization; worker failure; explicit discard |
| Performance | Zero asset-byte copies for transforms; rollback integrity; bounded preview allocation; oversized single layer; record parity with existing parser |
| Startup | Missing schema; rejected lazy import; retry; partial initialization cleanup; truthful degraded/failed states |
| Deployment | Cold browser cache; complete precache; HTTP LAN origin; HTTPS proxy; trusted/untrusted forwarded headers; retained API rate limits |
| Artifacts/security | Stale adjacent manifest; partial copy; hash mismatch; secret-free logs; interrupted multipart uploads |

Add a browser suite that serves the built application through the real Express server. Use the existing printer simulator and a deterministic fake slicer for routine fault injection.

Run:

- The complete web quality gate, including architecture, localization, accessibility, offline, slicing, and bundle-size checks.
- Server tests against the default artifact path, without the audit’s temporary override.
- Artifact verification and existing WASM slicing fixtures.
- Dependency and secret scans.
- Compose validation and a native container build before release.
- Browser deployment tests against the built container, with a local HTTPS proxy representing the Tailscale boundary.

Keep existing bundle ceilings. Offset new functionality through lazy loading and controller extraction rather than increasing limits without measured justification.

Record performance baselines on fixed fixtures and the same runtime. Require bounded allocation and unchanged output semantics; establish timing regression thresholds from those measurements rather than inventing hardware-independent latency promises.

## 5. Delivery, documentation, and release completion

Each implementation change should include its focused regression tests and any documentation corrections it causes. Add deployment tests early enough to protect subsequent startup and persistence work.

Update deployment and credential documentation with the actual supported behavior. Reduce `GEMINI.md` to its intended size by moving historical Android material into referenced historical documentation, preserving current architectural constraints and decisions.

Regenerate parity and qualification reports with the repository tooling. Keep independent review, security signoff, printer qualification, calibration, and Galaxy XR evidence marked incomplete until the corresponding evidence exists.

Complete supervised qualification on Snapmaker U1, Elegoo Centauri Carbon, and Galaxy XR:

- Confirm readiness and job-identity fields on the installed firmware.
- Exercise upload-only, normal print start, pause/resume/cancel, reconnect, and changed-job confirmations.
- Validate recovery, large-project interaction, and windowed preview in XR.
- Exercise emergency-stop and firmware-recovery behavior under a controlled hardware procedure.
- Record firmware/browser versions, test inputs, outcomes, and limitations.

Release with additive server compatibility first, followed by the browser update. Preserve recovery data across browser rollback; an older version must leave unfamiliar records intact.

Completion requires every audit regression to pass, all six improvement areas to be integrated into the live application, supported deployment modes to pass end-to-end checks, and outstanding hardware or operational work to be explicitly evidenced rather than reported as completed.
