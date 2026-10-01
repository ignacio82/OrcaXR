# Audit remediation evidence

This tracks implementation of [`plan.md`](../plan.md). It does not replace or
reduce that plan, and it does not claim completion of the separate parity backlog.

## Current implementation

| Plan area | State | Evidence / work remaining |
| --- | --- | --- |
| A: dependencies | Implemented | Multer 2.4.0, qs 6.16.0, compatible patched web transitive dependencies; XRBlocks 0.17.0 and UIKit 1.0.74 unchanged. CI and the local quality script audit development dependencies at moderate severity. |
| A: credential source and logging | Implemented | Seven maintenance scripts share verified OpenSSH authentication. No embedded password or automatic host-key acceptance remains. Generated server tokens log only their protected file location. Remembered device-local printer credentials remain optional; UI/docs explain the storage boundary. |
| A: operational revocation | Pending | Rotation or invalidation of previously exposed credentials and logged tokens requires operator evidence. Source cleanup does not revoke them. History rewriting is a separate coordinated action. |
| B: printer session and command intent | Pending | Existing controls still need authoritative job identity, session-bound confirmation, fresh-query rejection, and duplicate suppression. |
| C: submission lifecycle | Pending | Implement the shared workflow controller, explicit cancellable preparation, upload naming/verification, and post-upload revalidation. |
| D: process and artifact lifecycle | Pending | Successful native exit, descendant termination, retryable downloads with leases/TTL/release, bounded cancellation. |
| E: deployment and artifacts | Pending | Static/API separation, Tailscale namespace/trust, adjacent-manifest verification, atomic publication, deployment coverage. The existing local server manifest was repaired only after all three binary copies matched canonical SHA-256 hashes. |
| F: discovery and startup | Pending | Transactional discovery and truthful capability initialization/recovery on DOM and XR. |
| G: controllers and snapshots | Pending | Controller ownership/disposal and opaque immutable asset rollback snapshots. |
| H: persistence | Pending | Worker serialization/checkpoints, transactional recovery storage, autosave, recovery flows, navigation/update guards. |
| I: large-project performance | Pending | Worker indexing before rich allocations, oversized-layer checkpoints, typed import traversal, measured baselines. |
| Release qualification | Pending | Full supported-deployment checks, native container build, report regeneration, documentation reduction, supervised U1/CC/Galaxy XR procedures, independent review/security signoff. |

## Reproduced regressions and verification (2026-10-01)

- `server/multipart.test.mjs`: the delayed filename callback reproduces an
  orphaned disk file with Multer 2.2.0 and passes with 2.4.0. Real Express HTTP
  tests abort eight uploads after disk storage begins and verify cleanup after
  each; malformed bracket/prototype/long fields return client errors, never
  dispatch slicing, and leave no files behind.
- `server/server.integration.test.mjs`: startup logging exposed the synthetic
  generated credential before the fix; it now reports only its protected path.
  Assertions never echo the credential, even when failing.
- `python3 -m unittest scripts/test_maintenance_security.py`: six tests pass,
  including scanning all seven maintenance scripts, verified hosts, key/agent
  defaults, terminal password opt-in, argument boundaries, and secret-free
  error handling. Before the change all seven script scans failed.
- `npm --prefix server test`: 33/33 pass against the default artifact resolver,
  with no `ORCAXR_WASM_DIR` override. The previously stale local manifest was
  corrected after independently hashing canonical, browser, and server copies.
- `npm --prefix {web,server,wasm} audit --include=dev --audit-level=moderate`:
  all three report zero vulnerabilities. Initial audits found two affected
  server packages and seven affected web dependency packages.
- `npm --prefix wasm run verify:artifacts`: passes, including the optional
  server deployment binaries. The current verifier still lacks the adjacent
  manifest and partial-directory checks required by E.
- `npm --prefix web run quality`: passes in full, including architecture,
  localization, production browser workflows, offline, accessibility (28 axe
  rules), pseudo-locales (155 critical controls), all 13 slicing test files,
  and unchanged bundle ceilings. Main chunk: 2,328,292 bytes; total JavaScript:
  10,537,352 bytes. These existing browser tests use the Vite-built preview and
  simulator; the real-Express/container deployment suite required by E remains
  to be implemented.
- Current-source Gitleaks scan: passes with repository configuration and full
  redaction, using image digest
  `sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`.
  This scans the current tracked files plus new implementation files, not Git
  history. A documentation phrase was reworded to avoid a false positive;
  secret rules and allowances were not weakened.

The dependency and source-credential change passes its automated gates.
Hardware, credential revocation, deployment release, and independent review are
not proven by these checks. Continue with B; the overall plan remains active.
