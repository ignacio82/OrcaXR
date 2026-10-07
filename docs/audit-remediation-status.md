# Audit remediation evidence

This tracks implementation of [`plan.md`](../plan.md). It does not replace or
reduce that plan, and it does not claim completion of the separate parity backlog.

The separate [native Android/Rust migration](android-native-rust-plan.md) now has
Stage A build infrastructure and an initial shared G-code computation port.
[Native-core evidence](engineering/native-core.md)
records the exact verification scope: Rust and generated-binding checks, real
browser WASM vectors, Android debug/release builds, JVM/JNI tests, non-XR emulator
startup, and native artifact alignment. Rust and all three npm development audits
pass; the configured redacted source scan finds no leaks. These checks do not
close project editing, native slicing, XR, physical-device, or existing supervised
printer/security/credential gates.

G-code evidence covers the unchanged TypeScript reference against host Rust,
browser WASM, and Android JNI, bounded packed columns, UTF-16 preservation,
source/session lifecycle, and cancellation. Projection, bounded inspection and
playback also run through development session bindings. Generated browser metadata
guards, packet checks and the bounded source owner now replay actual WASM outputs.
Android now has generated metadata guards, strict bounded JSON parsing and
model/index relational checks. Views require an explicit captured model and
validate source/window, record, layer, cursor, tick and projection relations;
the renderer rejects a different capture identity. Native production integration,
search, full project command contracts, production native rendering,
and physical-device performance
remain migration work; these bindings do not change release support.
The [Android boundary evidence](engineering/native-core.md) now records 21 passing
JNI tests, including actual-packet mutation, capture/window binding and cancellation
cases, plus three shell cold starts and three renderer lifecycle tests. Builds, lint, artifact
alignment, audits and the configured redacted source scan pass. Shared G-code
source/view request types now generate from one schema across all three languages;
the Rust decoder requires objects and rejects duplicate option keys. Matching
Rust browser/JNI artifacts were rebuilt. Metadata layouts and slicing-engine
artifacts remain unchanged. Thirty independent request cases agree across host
Rust, actual browser WASM, Android JNI and the generated host guards; typed
encoders also preserve UInt32 bits/UTF-16 units and enforce bounded serialization.
The canonicalization envelope now also requires named object fields: the previous
Serde-derived decoder incorrectly accepted positional arrays. Forty-eight raw
request cases agree across host Rust debug/release, browser WASM and Android JNI,
including malformed/duplicate fields, numeric versions and sanitized errors.
Only the inner JSON input retains canonical last-key-wins duplicate semantics.

The debug Android flat viewport now has generated mesh/toolpath fixtures with
bounded Filament uploads, original-facet picking and display paint ranges.
The [renderer evidence](engineering/native-core.md#emulator-evidence-on-2026-10-05)
records six JVM tests, ten JNI tests, three shell cold starts and three real-pixel/
lifecycle app tests. Two two-million-facet opens retain a 983,040-byte staging
peak and request 120,008,000 GPU buffer bytes including the toolpath; those
counters do not measure driver allocation or total process memory. Release
excludes the workbench and Filament. Both APKs pass native alignment checks;
strict dependency verification, lint, audits and the redacted source scan pass.
The [separate SceneCore rc01 candidate](engineering/native-core.md#scenecore-candidate)
now builds against the same packed mesh and replaces bounded chunks for sample
paint. Four JVM tests cover the actual SDK validators and unchanged source
geometry; a non-XR emulator test checks zero session attempts and no loaded XR
native libraries across Activity recreation. Its 14 packaged native libraries
pass both-ABI alignment checks. Spatial execution remains unverified: the
Linux/SwiftShader XR-image diagnostic did not reach a verified boot. Picking,
clipping, toolpaths, nonuniform/mirrored transforms, spatial lifecycle and
performance remain open, alongside native engine/project workflows and physical
qualification. No migration phase exit is closed by these candidate checks.

The [current-engine dependency proof](engineering/slicing.md#native-android-dependency-feasibility)
now builds the pinned recipe's TBB 2021.5.0 archive with a tracked Android CMake
port for arm64 and x86_64 using NDK 29/Clang 21. Eight ELF files pass ABI/alignment and dependency
closure checks. Seven mutation tests reject invalid packages; three x86_64
emulator runs exercise real allocation and task scheduling. The full-engine port
now passes clean libslic3r/fixture-adapter builds for both ABIs, ELF alignment
and dependency checks, and seven package mutation tests per ABI. Runtime
inspection found pre-main logging
corrupting stdout protocol and an unwritable default import-staging path. The
adapter now uses an exclusive result file and an owned import directory; nine
runner guards pass. The final clean x86_64 package passes four initialization
patterns and all eleven native/reference comparisons with unchanged tolerances.
ARM64 execution, an application route, historical painting/allocator qualification and physical
device evidence remain open.
The [canonical slice reference corpus](engineering/native-slice-fixtures.md)
now passes eleven real archive slices on the published WASM engine and seven input
guard cases. Physical/mixed paint, scoped settings, manual support and actual
wave extrusion are observable in the outputs. This is browser reference
evidence for the native comparison, not Android slicing qualification.

The Rust preview projection now passes 1,567 host reference cases covering all
12 modes, filters, legends, exact Float32 outputs, malformed inputs and unsupported
metadata. Resource tests add bounded-window projection, cancellation and independent
outputs. Host inspection adds 1,181 cases over 456 models. Another 4,554 queries
over 103 immutable sources agree across host Rust, browser WASM and Android JNI,
including explicit window selection, Float32 extremes, UTF-16 context, playback
and ten rejections. Bounded packets preserve ownership after disposal, reject
malformed headers/text, and clear stale pending transfers. Cancellation now covers
metadata/column packing. The browser source owner also agrees with those 4,554
queries; packet decoding covers 456 models/windows and rejects 26 deliberately
corrupted view packets. Transfer/reopen/disposal and pre-copy request bounds pass.
The production preview worker now defaults to Rust, with a fixed startup
TypeScript rollback and versioned, digest-checked manifest/WASM packaging. Both
adapters pass bounded DOM/XR paging, canonical-state preservation, empty-filter
recovery, cancellation and disposal in Chromium. First-preview offline tests
cover the PWA and static `/slicer/` host; static updates preserve a dirty project
on Cancel and activate/reload through the existing guard on Discard. Missing and
corrupt pairs fail without switching adapters; fetch cancellation and explicit
retry pass without isolation under production CSP. The native application
remains a development shell. These are software tests, not device performance
or physical XR qualification.
The complete web gate passes with 258 unit-test files and unchanged JS ceilings
(2,264,048-byte entry; 10,574,850-byte total). The container web build, all 56 server
tests, actual HTTP/HTTPS browser checks with external-slice preview, four current
engine artifact copies, dependency audits and the redacted 1,556-file source scan
pass. An initial persistence startup timeout did not recur in the focused retry
or full repeated gate; startup-state failure diagnostics were added.
The existing web truncated-parse notice reports the inspected prefix without inferring
that slicing completed. Full web quality, optimized Rust reference tests,
Clippy, cross-target compilation, dependency audits and the configured redacted
source scan pass. The wave-settings source test uses pinned Git content plus the
tracked build patch rather than a mutable developer checkout.

The TypeScript session lifecycle was verified on 2026-10-05 before further
asynchronous command migration. Archive completion now binds the source project,
revision, semantic/asset identities and current open operation. Eleven regressions
cover cancellation, edit/undo, asset-only drift, reset/disposal, both completion
orders for overlapping opens, a failed newer request, invalid assets, cooperative
serializer rejection and cancelled legacy slice results. Rejection preserves the
immutable asset version, selection, dirty state and history. The complete
`scripts/quality.sh` gate passes, including 260 web unit-test files, production
browser/offline checks, slicing, server and HTTP/HTTPS deployment tests, artifact
verification and all three dependency audits. The redacted 1,630-file source scan
reports no leaks. This closes a session lifecycle defect, not the planned
asynchronous command facade or Rust project migration.

The asynchronous project facade routes production Undo/Redo and the seven plate
lifecycle operations through authoritative acknowledgements. Object/part rename,
instance printability, single/batch transforms and derived placement tools now
use the same generated string transport over the TypeScript authority. DOM/XR
gestures retain one dispatched edit and one latest pose, chain actual receipts,
and invalidate on selection/tool/lifetime changes. Multi-instance printability
keeps separate undo entries and reports partial completion. Numeric transforms,
DOM/XR gestures and DOM lay-on-face now use declared registry routes. The result
API preserves actual acknowledgements and original availability reasons, with no
direct-controller fallback when the action context is absent. An XR event test
exposed and fixed an ephemeral projection-record membership check that prevented
drag movement. Other command families, import/save and slice capture remain
migration work.
Fifteen focused session cases cover queued ownership, revision/asset/history
drift, cancellation, reset/disposal, rollback, coalescing, immutable replies,
capacity and zero asset payload copies. Twelve action cases verify acknowledgement
and rejection propagation through DOM, keyboard and XR registry routes; the
workspace test exercises real queued undo/redo and stale/disposed rejection.
The earlier facade revision passed `scripts/quality.sh` with 265 web unit-test files,
95 project test files, production browser/offline/recovery and accessibility
checks, real slicing, server and HTTP/HTTPS deployment checks, artifact verification
and all three development-dependency audits. Bundle limits remain unchanged.
The configured redacted scan of 1,640 UTF-8 source files reports no leaks.
Plate-specific regressions add 39 controller cases, 64 registry cases across every
declared surface, and 15 real workspace presentation cases. They cover deferred
commit, exact undo/redo/no-ops, immutable assets, stale ownership/history/revision,
rejection propagation, late disposal and newer selection preservation. The XR desk
composition also checks captured-revision registry routing. The browser plate flow
holds delivery of a real rename acknowledgement to check busy and success timing.
The object/transform and lifecycle extension now passes 57 canonical edit/gesture
cases, 60 lifecycle controller cases, 222 registry acknowledgement cases,
21 transform-routing cases and 56 workspace presentation cases. Selected deletion,
plate clearing, cut and instance conversion await their actions; independent
object duplication and plate moves use guarded async controller APIs. Tests cover
bounded gestures, selection changes, interrupted printability, captured duplicate
summaries, lost acknowledgements, exact undo/redo, clipboard ownership and disposed
surfaces. All 33 workspace/action files pass; final action/presentation regressions,
TypeScript, lint, production build, offline inventory and bundle checks pass.
The final bundle is 2,117,624 bytes for main and 10,453,184 bytes total JavaScript.
The redacted scan covers 1,790 UTF-8 sources without findings. The full quality
attempt passed static checks, encountered `spawnSync git EPERM` and localhost
`listen EPERM`, then stalled at the calibration Git-stdin check and ended at its
180-second bound (exit 124). Earlier full-gate passes do not qualify this
extension. Browser and Android runtime/device verification remain open; these
are host/controller checks.
The native prepared-command extension now covers nineteen intents,
including object/instance deletion, plate clearing, independent duplication,
plate movement and conversion to an independent object. Its TypeScript reference
contains 1,108 command steps / 51 traces and 1,380 session requests / 60 traces.
Rust debug/release, actual Node-worker WASM, and debug/release JNI replay agree
on full state, selection, ordered effects, history and asset identity. The six
lifecycle commands add 120 execution/undo pairs to the large-project allocation
probe. Local instance creation and paste add another 40 pairs: 580 revisions and
1,520 events retain zero mesh/config payload copies (1,124,220,476 bytes total
allocation; 217,600 bytes largest allocation). Full Rust workspace/release tests,
strict Clippy and both command corpora pass.
Kotlin writers pass twelve lifecycle option/text cases in addition to the numeric
corpus; 5,987 query packets and 7,576 malformed packets pass shared validator
checks. Thirty focused browser object/transport test files, TypeScript/static
checks, production build, offline inventory and bundle limits pass (2,116,556-byte
main; 10,452,116-byte total JS). The redacted scan covers 1,789 UTF-8 sources with
no findings. The full web quality attempt again ended at 180 seconds / exit 124
after Git-pipe and localhost permission errors; a separate broad project run was
stopped at the unchanged calibration Git-stdin check (exit 130). Fresh web/server/
wasm dependency audits could not reach the npm registry (`EAI_AGAIN`). None of
these partial checks closes the full web gate. Instance creation and paste now
have local full-record Rust commands and budgeted chunked input. A separate
197-step / 11-trace TypeScript corpus checks full metadata/UTF-16 preservation,
insertion order, paste after source deletion, exact retention, graph failures,
and atomic 70-instance batches. Five native staging/ownership tests cover byte
splits, malformed/incomplete input, explicit limits above the small wire ceiling,
source-buffer ownership and copy-on-write isolation. Local history accepts domain
batch sizes/labels; generated wire limits are unchanged. Rust and the local
TypeScript endpoint now admit full captured commands through session-owned,
one-use references. A 32-trace / 398-group / 331-request independent replay
compares guards, quotas, immediate cancel/close release and atomic batches above
64 commands. Eight native and sixteen TypeScript tests additionally cover large
records, ownership, lost replies and unavailable post-commit summaries. The
allocation probe retains an 8 MiB record without a payload copy; cancellation
destroys it before reply settlement. Finished-input quotas count encoded units,
not resident memory or in-flight preparation. The generated envelope now carries
execute/release references, and the ordinary session corpus includes 43 control/
refusal requests independent of upload admission. WASM/JNI now expose separate
chunked command upload owners: four preparation permits span parsing, sealing
and transfer into the session's finished pool. Actual binding replay covers 109
uploads / 331 requests and 103 shared boundary refusals. Seven Kotlin ownership
scenarios check consumed inputs, late/closed owners and ready-reference cleanup;
two native tests cover concurrency, full records beyond the small wire ceilings,
option bounds and permit release. The generated option encoders pass 148 TypeScript
shape/ownership/budget checks. Browser clone/add-instance/fill-bed now use the
local staged transport with explicit input/pool budgets. Twenty-three controller
cases cover guarded 70-copy transactions, failed-member rollback, quota release,
stale/closed owners and captured or uncertain results. Registry/presentation
regressions wait for acknowledgement and suppress late success after disposal.
Clipboard paste now uses the local staged route and restores descriptors/bytes
within its rollback boundary. Thirteen controller checks cover source deletion,
reset, stale/closed requests, held/lost replies and 3MF save/reopen. Eleven asset
ownership checks cover bounded immutable subsets, SVG drawings, atomic conflicts,
rollback/retry and twenty 8 MiB paste/undo/redo cycles without mesh payload copies.
Rust now implements selected clipboard capture and atomic asset-restoring paste:
17 independent browser traces / 130 steps compare full contents, ordered effects,
asset identities and exact input/history charges. Six native tests cover capture
limits, sorted query targets and retryable apply/undo/redo failures. The release clipboard probe runs
twenty cycles over an 8 MiB asset with no payload-sized allocations; the public
read control detects one. WASM/JNI now expose four clipboard owners per core
instance, capturing current object query nodes under explicit asset/byte budgets.
Paste uploads retain selected immutable data and a fresh destination guard; JSON
carries only injected IDs and the destination. Ten reference captures, 53 shared
refusals and six Kotlin ownership scenarios cover sorted rows, stale/foreign
nodes, quota release, source closure and late-result cleanup. Production archive
import, preparation scheduling, native UI,
remaining command families, production worker/JNI integration, current APK
assembly and Android/device execution remain open. The Phase 4 checklist remains open.

The separate release preparation probe runs twenty capture/upload/seal/stage/release
cycles with zero payload-sized allocations. Each 139-byte upload charges 8,979,001
input units; total allocation is 298,300 bytes, with largest allocation 640 bytes.
Release destroys the capture immediately. These are host ownership measurements,
not Android device RAM or latency qualification.

Prepared document adoption now implements guarded Open/reset through Rust,
WASM/JNI and Kotlin. Source identity and operation tokens prevent late/superseded
input from replacing newer state; failed/cancelled newer Opens never revive older
ones. Atomic commit transfers admitted records, advances revisions, clears selection
and establishes clean history while preserving repository and protocol ownership.
Sixteen browser-authored traces compare 59 steps and four complete states. Three
native tests check foreign/reused operations, record identity, immediate rejected
input destruction and stale staged settlement; the history capacity test also
covers adoption refusal before publication. Both actual host bindings replay the
corpus plus seven refusal cases. Seven Kotlin ownership scenarios and the
instrumentation source compilation pass. WASM's consumed-document retry returns
invalid_state while leaving the session usable; its empty wrapper must be freed.

The Android bridge now owns bounded asynchronous command/query execution, guarded
Open/reset and staged-command preparation. A single authority executor, two
preparation workers and ordered effect delivery retain at most 32 unsettled tasks.
Bulk producers borrow an immutable source and ordered chunk writer; original native
guards are checked at admission/execution, and ready references never escape.
Explicit finished-pool limits default to zero. Opaque actor guards bind revisions,
assets and ownership without retaining large IDs, native handles or source graphs.
This preserves bulk/reset access to valid projects beyond the small wire ID budget.

The original twelve actor scenarios and sixteen new preparation scenarios pass
complete debug/release JNI replays from a clean compiled class directory. The new
checks include twenty staged-edit/undo cycles without remaining
pool charges, stale/queued/cancelled work, four-upload saturation, malformed input,
rollback delivery, reset/history rules and close races. A browser-authored 70-instance
batch matches its complete acknowledgement/effect sequence and one-entry undo/redo.
Handle saturation during an active mutation reproduced a post-commit reply/effect
allocation failure. JNI now transfers effects in the already reserved reply slot,
including at capacity; wrong-kind/repeated conversion leaves effects intact. Three
additional raw-boundary refusals raise that corpus to 75. Confirmed results survive
an unavailable optional host guard, and callers query again instead of repeating
an already completed edit. A second reproduced exhaustion case after document
adoption is fixed for both Open/reset: an unavailable summary query preserves the
confirmed result, ordered effects and usable session.

Native clipboard preparation now freezes guarded project/asset ownership before
running query selection and object/asset scanning on a preparation worker.
Preparations and finished clipboards share four permits; conversion reuses its
native slot. The actor checks source/newer-copy identity before publication and
owns the current clipboard. Paste attaches selected data before its producer
starts, so clear/replacement cannot discard already prepared work. Thirteen
shared host/device scenarios pass both full host JNI profiles, exercising repeated cycles, cancellation, stale/foreign
identities, limits, source closure and late cleanup. Two TypeScript fixture replays
compare complete acknowledgements/effects and undo/redo, including sorted selection.
Subscriptions and the application's complete editing workflows remain open.

Native save/export now captures the admitted project and exact immutable asset
version together. Owned preparation workers stream canonical JSON through JNI with
64 KiB output staging and read assets in bounded chunks under explicit budgets.
Captures survive reset/source disposal without copying payloads. Ordinary export
leaves dirty state unchanged; manual save checkpoints only a confirmed, complete
handoff whose captured identity remains current. Concurrent edits preserve newer
dirty state. Confirmed handoff survives checkpoint handle exhaustion and close;
callback failures remain uncertain, and projection failure preserves an already
committed checkpoint. The host owns I/O deadlines and publication durability.
Thirteen shared host/device export scenarios pass both complete host JNI profiles,
including independent TypeScript byte comparisons, all UTF-16 units, repeated saves,
budget refusals, stale captures, cancellation and close/capacity races. Rust verifies
frozen record identity and declaration order. Archive assembly, storage-provider
handoff, application integration and Android runtime qualification remain open.

Protocol JSON now uses the actual bounded portable Kotlin parser on the host JVM,
with the existing lexical, byte/node/depth and duplicate-field rules. It passes
241 accepted round trips and 1,224 refusals, including the entire 969-case corpus,
structural/escape/budget mutations and all UTF-16 units. Existing numeric/lifecycle/
staged-reference writer checks remain green. No runtime dependency was added.
The Android instrumentation sources compile against verified dependencies, but a
fresh Gradle attempt still fails to obtain a usable wildcard IP before building.
These results qualify host behavior, not a new APK, Android runtime or device latency.

The release document probe measures twenty bundle-proof/fingerprint/commit cycles
over an 8 MiB mesh and two 8 MiB metadata strings: 85,328 total allocated bytes,
largest allocation 640 bytes, zero payload-sized allocations and three positive
public-copy controls. Graph/payload admission and fixture allocation precede this
measurement. It does not qualify end-to-end import or device performance.

Workspace tests with all features, strict Clippy, optimized document/session/
staging/clipboard tests, allocation probes and reference regeneration pass.
Rebuilt WASM and debug/release JNI retain all existing session/staging/query replay
results and exercise document adoption and clipboard operations through the actual
bindings. Both rebuilt Android ABI libraries expose 92 project JNI exports and
16 KB LOAD alignment. Refreshed browser manifests bind 222 source inputs.

The shared archive crate now indexes bounded ZIP/ZIP64 sources and streams stored
or DEFLATE members through 64 KiB buffers, checking lengths and CRC before returning
a receipt. Hosts own immutable staging, provisional output and I/O deadlines.
Seventy-five independent browser cases, fifteen path cases and four shipped ZIP64
calibration archives agree; six native debug/release scenarios cover cancellation,
short reads, dishonest sizes, private errors and hostile mutations. The reference
corpus reproduced five malformed ZIP64 directory forms accepted by the browser;
record extents, disk fields and classic/ZIP64 agreement are now checked on both
paths. Browser ZIP authoring also fixes silent renaming of an exact `__proto__`
member to `0`: bounded same-length header restoration preserves names without
changing ordinary deterministic bytes. Canonical Open/Save and alias-collision
regressions pass. Twenty read cycles at 1 MiB and 16 MiB leave no retained allocations and
allocate no member-sized buffer. Strict Clippy, all-feature workspace tests,
three target compilation checks and focused browser suites pass. Five locked
compression/checksum dependencies are attributed in NOTICE. The cached 2026-10-03
advisory database reports no vulnerabilities among 66 dependencies; fresh fetch
fails and yanked-version checks are unqualified. Canonical-envelope staging now
adds bounded BOM-aware JSON, legacy dense-facet/false-fuzzy migrations with
validation before removal, typed graph admission, exact asset mappings,
length/digest checks and declared-blob byte comparison. The owning intermediate
verifies and retains unknown members for later reconciliation; it cannot be
consumed as a completed import. Its 109-case production-browser reference has
46 admitted and 63 refused envelopes, with full-import acceptance recorded
separately. Five native integration scenarios and a byte-split decoder unit test
cover reference contents, limits, cancellation, private errors and ownership.
Twenty success and twenty corrupt-unknown-member cycles over an 8 MiB asset each
make exactly one payload allocation per load and retain no allocations afterward.
OPC reconciliation now consumes staged canonical input, streams bounded metadata,
merges preserved relationships/content types and re-admits the graph without
replacing live authority. Its three XML writers use bounded provisional output
and the validated import resolver. Browser Open/Save now retains fragment/query
relationships and writes safe per-part declarations for nonstandard suffixes;
three repeated cycles preserve canonical identity and opaque member bytes.
Ninety-two production-helper cases (71 admitted merges) and thirty resolutions
compare native state, warnings and exact XML/refusals. Six integration scenarios
and streaming-scanner mutations cover budgets, cancellation, private errors and
ownership. Shared Unicode 16 tables match every scalar, isolated surrogate and
9,986 captured casing contexts; runtime verification prevents Unicode drift.
The workspace passes 229 tests; the final core-model suite and all 81 release
archive tests pass, with strict
Clippy, formatting and checks for WASM/both Android targets. The OPC allocation
probe retains no allocations: twenty exclusive-metadata cycles allocate 8,922,400
bytes, with no payload copy and a 65,536-byte maximum allocation; retaining the
old project snapshot correctly forces one 8 MiB metadata copy per cycle.
Foreign BBS parsing/component resolution, archive bindings,
provider integration and application cross-platform round trips remain open.

The BBS facet wire codec now decodes uppercase hex under explicit byte/node/depth
limits and writes borrowed computation or persisted trees through a 4 KiB buffer.
Channel mappings retain canonical paint identities; sparse assembly consumes only
indexed roots, so declared unpainted facets do not allocate dense state. Failed
decodes spend the same shared budget as the browser. Short/interrupted writes
remain cancellable and expose only redacted I/O kinds. The independent unchanged
browser codec supplies 1,594 cases, five shared-budget sequences, eight sparse
imports and all 69,904 hex streams of lengths one through four. Eight native
integration tests also cover malformed trees, byte/node limits, cancellation and
sparse index/value validation. The allocation probe compares two million and two
billion declared facets with three explicit roots: twenty cycles allocate 27,360
bytes, largest 632 bytes, with no retained allocations. Borrowed writing of an
existing 8 MiB paint value allocates 480 bytes across twenty cycles, largest 24
bytes, for both representations. A deliberate 8 MiB copy verifies the counter.
These primitives do not implement the full BBS XML/model/metadata projection,
native Open/Save or device qualification.

The packed Rust mesh codec now validates immutable source bytes without allocating
decoded vertex/index arrays or rehashing an admitted lease. It preserves strided,
unaligned, uint16/uint32 and non-indexed layouts, with checked safe-integer addressing
and explicit limits. Authoring checks supplied metadata before allocating one packed
output and hashes bytes while writing. Public expansion requires its own byte cap.
Canonical bounds compare captured descriptors and compose volume/instance transforms
over actual vertices with role filtering, bounded work and cancellation. Independent
browser references cover 196 encoding cases, 768 decoding cases and 146 bounds
cases, comparing exact bytes/float bits and refusals. New browser regressions
reproduced and fixed finite-double overflow during float32 authoring and silently
ignored overflowed vertices during bounds calculation. Six native tests cover
reference/source identity, budgets, cancellation, proof lifetime and output isolation.
The two-million-vertex / two-million-triangle host probe uses a 48 MB asset plus
8 MiB metadata: twenty mesh validation/clone/bounds cycles allocate zero bytes;
twenty canonical bounds queries allocate 86,520 bytes, largest 1,160 bytes, with
no payload copy. Encoding and explicit expansion each make only their one required
48 MB or 72 MB output allocation per cycle. All phases release measured allocations.
Mesh bindings, renderer packets, file import and guarded editing remain open.

Native BBS numeric/XML primitives now preserve exact browser number text,
float32 mesh-coordinate rounding and double matrix operation/order. Eight browser
helpers were extracted without changing their syntax. Independent references
cover 4,419 explicit coordinates, 9,351,846 float32 samples, 2,884 doubles, 2,070
transforms, 322 XML strings and every single Unicode code point. The fixed 4 KiB
writer bounds aggregate input/output, rejects illegal XML characters, polls
cancellation during short/interrupted writes, poisons failed finalization and
leaves durable flush to the host. Eleven native debug/release tests pass, as do
37 focused browser BBS tests. Five two-million-vertex writes match the browser's
116,727,266-byte stream while allocating zero heap bytes; twenty escaped writes
of an existing 8 MiB UTF-16 value also allocate none. A deliberate clone confirms
the 8 MiB allocation counter. Rebuilt WASM/glue, host JNI and Android ABI
libraries remain byte-identical to the qualified mesh build; existing binding
replay evidence is retained on that identity. New primitives have no bindings yet.

Rust now streams the complete standard BBS core-model member from an admitted
project and immutable mesh leases, including stable numeric IDs, material slots,
plate origins, component/build transforms, sparse paint and preserved extension
attributes. Full descriptor agreement and explicit record/text/geometry/paint
budgets precede authoring. Missing or malformed geometry gives typed omission
warnings; limits and cancellation fail the operation. Borrowed paint trees and
extension values are not copied, and unpainted triangles allocate no paint state.
The production-browser corpus supplies 212 cases: 172 exact XML outputs and 40
refusals, including unsorted whole assignments and refined paint. Seven native
debug/release tests cover references, budgets, cancellation and ownership. Five
preparations of a two-million-vertex / two-million-triangle, 48 MB source with
sparse paint and an 8 MiB extension value allocate 34,950 bytes total; five writes
of its 239,309,686-byte model allocate 1,560 bytes total. Neither phase copies a
payload or retains allocations. The large native writes have equal hashes;
independent browser byte agreement is qualified by the smaller reference cases.
Dense paint indexes remain explicitly bounded. This is host evidence, not Android
residency or device latency. BBS XML import/reconciliation, native bindings and
transactional native Open/Save remain open; package output is described below.

Native BBS model settings, layer ranges/events, brim ears and layer-height
profiles now share the prepared core model's resource IDs and object ordinals.
Configuration, emboss recipes and SVG leases remain borrowed; recursive JSON
and semicolon-array settings stream through bounded escape buffers. SVG gathering
follows original plate order, while model membership follows sorted plate order.
Shared drawing paths require identical bytes and cannot replace structural members.
Missing drawings omit their own references even when another part supplies that
path; browser and native regressions reproduced this bug before correction.
Preparation bounds records, configuration nodes/depth, UTF-16 text
and drawing bytes; optional members and each output stream have explicit limits.
The 259-case browser reference includes 225 exact member sets and 34 refusals;
4,109 numeric cases independently check six-decimal and emboss rounding. Seven
native tests cover those references, resource limits, lease identity,
cancellation and short/private I/O failures. A browser regression reproduced
illegal XML in emboss text/SVG paths; both writers now refuse it while preserving
valid output. Canonical-envelope references were regenerated after the helper
change; all 109 case expectations remain unchanged. A reference-freshness sweep
also corrected preexisting session/query source hashes without changing their
reference values. Complete package generation is described below; app publication remains open.
The metadata probe holds an 8 MiB drawing plus separate 8 MiB configuration and
emboss strings. Five preparations including the SVG ownership indexes
allocate 25,040 bytes total, largest 456 bytes;
five complete writes of 41,944,424 bytes allocate no heap memory. Neither phase
retains allocations or copies a payload; a deliberate 8 MiB drawing copy is
detected. Input/admission and core-model preparation are excluded. The repeated
large native hashes complement the independent smaller browser references;
these measurements do not qualify Android residency or file providers.

Native project settings now borrow canonical configuration, reset scripts and
exact FullSpectrum recipes. The 98-key filament-vector policy is generated from
the browser writer; correct-length imported vectors retain precedence. Slot
remapping, equal-group B percentages, uint64 IDs, offsets and gradient text match
508 browser cases (507 exact members and one 65-tool refusal), with 4,108 separate
four-decimal numeric cases. Four integration tests and one long-reset-line
cancellation test pass; strict Clippy and optimized archive checks pass. The corpus
includes a group average immediately below 0.5 that rejects the incorrect
add-half-then-floor rounding formula. The browser regression also reproduced NaN
percentages and incorrect gradient endpoints from large finite weights; both
writers scale only overflowing calculations while preserving canonical weights.
Sixty focused browser tests across six files passed the settings checkpoint.
Complete package/envelope assembly and warning inventory are qualified below;
native bindings and transactional application Open/Save remain open. These
library checks do not close a migration phase.
The settings ownership probe holds three separate 8 MiB UTF-16 values and an
8 MiB exact pattern with 524,288 IDs. Five preparations allocate 20,420 bytes,
largest 728 bytes; five 38,273,506-byte writes allocate no heap memory. Both
phases retain zero allocations and make no payload-sized copies; the positive
copy control detects exactly 8 MiB. These are host measurements after input,
graph and model preparation, with independent browser identity established by
the smaller reference corpus. WASM and both Android target checks pass.

The native streaming ZIP/ZIP64 writer now borrows payloads into bounded private
seekable staging, with deterministic metadata/order, output/index limits and
cancellable compression. It pads unusually small DEFLATE output with valid empty
blocks to retain the reader's ratio limit. Six native scenarios cover failures,
chunk independence, actual ZIP64 counts and a virtual sparse 4 GiB member with a
following member beyond 32-bit offsets. Independent browser/Python decoders check
74 emitted archives. The new references reproduced BOM filename collisions and
dishonest DEFLATE expansion with prefix CRCs; both readers preserve literal names
and the browser now bounds expansion with an extra sentinel byte. Sorting local
extents preserves overlap refusal while avoiding quadratic inspection work.
Bindings and native application Save remain open; these are container-level checks.
The output probe streams 24 MiB per archive from an existing 8 MiB random payload
and a zero generator. Five file-backed writes allocate 4,504,940 bytes total,
largest 85,196 bytes, with no retained allocations or payload-sized copies.
Each 16,787,249-byte archive has the same hash; an intentional 8 MiB copy is
detected. Source construction and later verification are excluded. All 63
optimized archive tests and three target checks pass after rebuilding the
reference tests against the final browser-reader source hashes.

Complete package authoring now streams BBS members, the canonical envelope,
captured assets and preserved metadata into private ZIP staging. Exact bundle
membership/descriptors, deterministic path selection, collision policy, warning
inventory and OPC stage order match 1,032 browser cases (937 accepted, 95 refused).
The production browser independently opens 947 emitted native packages, including
ten native command-bus edits, then saves and reopens them with complete state,
asset and warning comparison. Only newly imported opaque IDs normalize the
specified compressed-archive hash seed; existing canonical IDs remain exact.
Boundary tests cover sixteen budget failures, cancellation, I/O, repeatability
and export after session replacement/disposal. Foreign import, app
bindings and file-provider publication remain open; canonical host interchange
has separate evidence below. The updated metadata probe passes with the figures above. Five complete
file-backed package writes allocate 26,379,550 bytes total, largest 85,196 bytes,
with zero payload-sized copies and zero retained allocations. Each archive is
16,859,744 bytes and expands to 71,311,249 bytes; repeated native SHA-256 agrees
and the deliberate 8 MiB copy is detected. Construction/admission and final
integrity verification are excluded. The workspace passes 229 tests and all
81 optimized archive tests pass, along with strict Clippy, formatting and wasm32/
both Android target checks. Host checks do not qualify Android memory or lifecycle.

Canonical-envelope completion now reconciles OPC/BBS metadata, compares generated
members through bounded pull reads and adopts every unowned file before final
graph admission. It preserves exact browser import IDs, opaque bytes, thumbnails
and warnings across 385 independent cases (276 accepted / 109 refused). A required
SVG recipe-field regression failed before the browser envelope validator was
corrected; valid recipes and unknown fields remain unchanged. Four native tests
cover full reference contents, original lease identity, eleven budget families,
cancellation, timestamp failure and guarded adoption through a real project
session. Five ZIP stream/comparison tests verify unread-tail integrity, partial
and interrupted reads, cancellation and compressed-input FNV identity. All 229
workspace tests and 81 optimized archive tests pass, along with strict Clippy,
formatting and three target checks. The optimized completion probe allocates
both its declared and newly adopted 8 MiB payload exactly once per load, retaining
no allocations after five success or five late-admission-failure cycles. Allocation
totals are 91,804,945 and 91,747,240 bytes. Five equal and five early-mismatch
comparisons allocate 675,005 and 1,002,685 bytes with no payload-sized allocations;
the maximum is 65,557 bytes, and both phases release all measured storage.
The deliberate copy control is detected. The actual interchange harness reuses
all 385 canonical completion inputs and 937 accepted package inputs. Its debug
and optimized runs match 109 import refusals, execute 1,213 native session edits, and report
three matching Save refusals. The remaining 1,210 native archives match every
browser-written member, open in both readers, receive a real browser command edit
and Save, then reimport into Rust with exact state/assets/warnings. IDs are never
normalized for these same-input comparisons. Debug/release reports agree exactly;
fresh workspace and optimized archive runs pass 229 and 81 tests respectively.
Foreign formats, archive bindings and provider/application flows remain open.

The earlier command-upload and browser instance/clipboard routes passed eleven
focused files. The earlier archive/OPC/facet change passed 41 tests across four focused
files. The mesh change passes 96 tests across nine focused files, TypeScript, lint, formatting, production build, offline inventory and bundle
budgets. Main JavaScript
is 2,127,027 bytes and total JavaScript is 10,477,565 bytes. Kotlin writers pass four
staged-reference boundary cases and six invalid-ID refusals. The redacted scan
covers 1,957 UTF-8 files without findings. A verified generated-policy checksum
false positive has an exact-digest/manifest-path exception; controls detect other
synthetic values at that path and the same digest outside it. Fresh npm audits
remain blocked by registry DNS (`EAI_AGAIN`); Cargo audit cannot fetch a fresh
advisory database. The browser WASM attempt exits during Chrome startup
with a denied Crashpad socket and `Target closed`,
so it supplies no browser
execution evidence. These are separate from the passing Node-worker replay.
The fresh full web gate passes static checks, encounters Git/localhost permission
errors, and reaches `src/project/calibration/resources.test.ts` before its
300-second timeout (exit 124).
Production build, offline inventory and bundle budgets pass.
The fresh Gradle attempt with a writable temporary cache still cannot
obtain a usable wildcard IP, so no new APK/JVM-Gradle/lint result is claimed.
This remains an incomplete gate.

The Rust project-domain foundation now ports stable identifiers without changing
the existing TypeScript authority. UTF-16 units preserve surrogate halves, NULs,
case and imported namespaces; typed entity families prevent cross-kind references.
Independent fixtures exercise 150 explicit IDs, 2,555,904 grammar probes, long
payloads, deterministic PRNG words and UUID streams. Debug/release tests, strict
workspace Clippy/tests, Cargo audit and compilation checks for wasm32 and both
Android targets pass. Immutable ID clones share their text allocation. This is
an identifier port, not a Rust graph/session implementation or native editor.
That identifier-only update retained byte-identical WASM/JNI executables;
both APK artifact checks and the complete repository gate passed. Its configured
redacted source scan covered 1,646 UTF-8 files with no findings.

Rust now also implements immutable asset ownership: shared records, read-only
leases, opaque owner-bound rollback snapshots, transactional public restores and
cached streaming bundle fingerprints. Thirteen synthetic payloads and 222
TypeScript reference operations agree on outputs, errors, record/version identity
and fingerprints, including insertion-versus-canonical ordering, surrogate/NUL
metadata, duplicate IDs/digests, copy isolation and failed restoration. The browser
clone regression for own `__proto__` JSON keys is fixed; imported fields retain
their data and do not change object prototypes. An 8 MiB allocation probe reports
zero mesh-sized allocations across 200 internal history cycles and initial
fingerprinting, with one measured 8 MiB allocation for a public copy. Rust asset
integration/lifetime and compile-fail checks pass with the existing ID tests,
strict Clippy/audit and three target checks. This is library/host evidence: native
project commands, full graph validation and session execution are still unimplemented.

The Rust facet computation library now preserves sparse whole-facet assignments
and version-2 subdivision trees across all five paint channels. It validates and
normalizes trees, remaps both halves without losing newly uniform paint, and
requires an explicit budget for temporary dense roots. Independent TypeScript
fixtures compare 273 refinement cases, 80 assignment cases, four depth boundaries
and 160 editing traces. Seven debug/release tests also cover invalid constructors,
atomic failures and aggregate expansion limits. The sparse allocation probe
reports 4,038,946 allocated bytes across decode and five remaps for a synthetic
1,897,256-triangle declaration with 10,000 assigned facets and one split; an
explicit dense positive control allocates 75,890,240 bytes. These are host/library
results. Full graph/schema validation, native commands/history/session execution
and device qualification remain open. Strict workspace tests/Clippy, Cargo audit,
three target checks, Android debug/release assembly, JVM tests and lint, APK
source/alignment checks, browser WASM smoke and owned-emulator checks all pass.
The complete repository gate passes after repairing its timing-based preview
replacement test to observe actual worker submission and termination. Both preview
adapters retain their cancellation assertions. The final redacted source scan
covers 1,678 UTF-8 files with zero findings; all three full npm audits are clean.

Rust schema-1 typed project candidates now preserve modeled fields, unknown
record metadata, UTF-16 identities/text and optional presence. Immutable child,
configuration and paint ownership supports edits without copying untouched
payloads; full-state canonical fingerprints stream and are cached by the candidate
owner. Empty-project factories and graph/filament selectors match independently
executed TypeScript references. Eleven complete states, four factories, five
direct edit steps, 33 record layouts and 11 literal domains are covered by ten
debug/release tests. The 300,000-assignment probe retains 20 edits with no copies
of its 9,600,000-byte paint-index array; largest internal allocation is 552 bytes,
and public export makes one measured payload copy. These are host library results,
not command/history replay or device qualification. Semantic graph validation,
option/profile validation, native commands/history/session execution and Android editing
remain unimplemented. CI checks model fixture drift and the allocation probe.
Strict workspace Clippy/tests, Cargo audit, three target checks, Android
debug/release builds, JVM tests/lint, both APK provenance/alignment checks and
the rebuilt browser WASM smoke pass. The owned emulator passes 24 core tests,
three cold starts, three renderer tests and non-XR startup. These platform checks
exercise existing bindings, not a native model endpoint. The complete repository
gate passes with 267 web unit-test files, 97 project files, browser recovery/offline
and accessibility checks, HTTP/HTTPS deployment and real slicing. All three full
npm audits are clean; the redacted source scan covers 1,685 UTF-8 files with no
findings. Physical-device and hosted-CI qualification remain open.

Rust settings scope policy and project config selectors now use the same pinned
engine extraction as the browser. Eligibility, strict layering, explanations,
import sanitization and parent-reference checks compare against 544 known/foreign
keys, 3,439 layer cases, 15 sanitizers and 100 graph queries. Five Rust tests cover
complete results and errors, UTF-16 data, stable precedence and public-copy
isolation. The port exposed a browser selector defect: an ignored local key could
hide its inherited value. Regression tests now preserve that inherited projection
and keep ignored diagnostics deterministic across canonical save/reopen, without
removing foreign stored data. Native read-only views share immutable payloads;
200 resolution cycles over 8 MiB of notes allocate no payload copies, while an
explicit export makes one. Largest measured internal allocation is 368 bytes.
Option/profile validation, command/session integration, native editing and physical
qualification remain open; this library does not close Phase 4.
Strict Clippy, workspace/release tests, Cargo audit, three target checks,
Android builds/JVM tests/lint, APK provenance/alignment, browser WASM smoke and
the owned-emulator suite pass. Those platform bindings do not execute the new
settings library; its runtime evidence is the host reference tests and allocation
probe. The complete repository gate passes, including all 267 web and 97 project
test files, production browser/recovery/accessibility journeys, HTTP/HTTPS
deployment and real slicing. All three full npm audits report zero vulnerabilities;
the redacted source scan covers 1,693 UTF-8 files with no findings. Hosted CI and
physical-device qualification remain open.

Prepared plate commands now use one versioned schema generating TypeScript,
Rust and Kotlin types, strict decoding and bounded encoding. All seven production
browser plate operations and Undo/Redo exchange generated session strings with
one existing TypeScript authority; prepared batches use its original atomic
transaction. The protocol carries negotiated versions, a separate connection
generation, increasing request IDs, identity/history guards, bounded
acknowledgements/errors, queries, cancellation and close. Lost/malformed replies
fail closed without retry; completed edits with unencodable summaries remain
explicitly completed. Canonical subscriptions still own local projections.
The 673-case corpus agrees across host TypeScript/Rust and emulator Kotlin,
including lossless UTF-16, numeric value semantics, distinct 160/120-unit
add/rename limits, large finite plate order values and malformed envelopes.
Additional checks cover every UTF-16 unit, resource limits, immutable queued
payloads, cancellation and rollback; 29 schema mutation guards and 19 transport
lifecycle regressions pass. Android's
strict JsonReader was observed accepting `1.`; a shared lexical check now protects
both intents and the existing G-code metadata decoder. All 24 core instrumentation
tests, three cold starts, three renderer lifecycle/pixel tests and non-XR startup
pass on the owned API 34 x86_64 emulator. Rust debug/release, Clippy/audit, Android
builds/lint and native artifact checks pass. Archive codecs now share the app's
module graph with a separate worker entry and complete offline dependency caching,
reducing duplicate JavaScript without increasing budgets. The complete repository
gate passes with 267 web unit-test files, 97 project test files, production browser,
offline/recovery/accessibility checks, HTTP/HTTPS deployment, real slicing and all
three npm audits. The redacted source scan covers 1,672 UTF-8 files with no findings.
Main-entry size is 2,101,384 bytes and total JavaScript is 10,436,886 bytes, within
unchanged limits. Generation checks and workflow actionlint pass; hosted CI is
still unqualified.
Other editing workflows, revisioned remote projections, worker/JNI execution,
crash recovery, Rust project execution and physical qualification remain open.
These contracts do not close Phase 1/4 or enable native editing.

## Current implementation

| Plan area | State | Evidence / work remaining |
| --- | --- | --- |
| A: dependencies | Implemented | Multer 2.4.0, qs 6.16.0, compatible patched web transitive dependencies; XRBlocks 0.17.0 and UIKit 1.0.74 unchanged. CI and the local quality script audit development dependencies at moderate severity. |
| A: credential source and logging | Implemented | Seven maintenance scripts share verified OpenSSH authentication. No embedded password or automatic host-key acceptance remains. Generated server tokens log only their protected file location. Remembered device-local printer credentials remain optional; UI/docs explain the storage boundary. |
| A: operational revocation | Pending | Rotation or invalidation of previously exposed credentials and logged tokens requires operator evidence. Source cleanup does not revoke them. History rewriting is a separate coordinated action. |
| B: printer session and command intent | Implemented; hardware evidence pending | One controller owns selection, connection epochs, subscriptions, queries, and commands. Immutable click/press intents bind exact job history and metadata; fresh queries reject replacement, reconnect, partial/failing responses, and duplicate commands. DOM/XR holds carry single-use confirmations. Emergency stop and distinct firmware restart remain reachable through authenticated HTTP without status/history success. |
| C: submission lifecycle | Implemented; hardware evidence pending | Shared DOM/XR workflow owns session/artifact/mapping/option guards, cancellation, preparation, random upload names, exact overwrite and response checks. Stored-file starts also bind confirmation to fresh metadata and readiness. Full web quality passes; supervised firmware evidence remains pending. |
| D: process and artifact lifecycle | Implemented; automated qualification passes | Native exit/group termination, repeatable downloads, leases, TTL/release, capacity refusal, artifact validation and bounded browser cancellation pass server, container and full web gates. The final native image passes non-root process reaping and a real native HTTP slice with retained output validation. |
| E: deployment and artifacts | Implemented; automated qualification passes | Static/API separation, actual-peer proxy trust, userspace Tailscale configuration, strict adjacent-manifest checks and atomic version publication pass focused tests. Final real Express and container HTTP/HTTPS browser tests pass. All 562 built web files match the tested container byte for byte. |
| F: discovery and startup | Implemented; automated qualification passes | Discovery, atomic preferences, session-only fallback and actual external UI slicing pass full web and deployment tests. Core/optional startup health, owned initialization, shared DOM/XR recovery and guarded dirty reload pass the full web gate, including five production-browser fault scenarios. |
| G: controllers and snapshots | Implemented; automated qualification passes | Printer/session/submission ownership and feature initialization lifetimes are implemented. Opaque copy-on-write asset rollback and import history pass focused regressions and the full web gate. Persistence and DOM/XR surface lifetime ownership are integrated; surface regressions and the full web gate pass. |
| H: persistence | Implemented; automated qualification passes | Live worker serialization, guarded manual checkpoints, atomic per-session IndexedDB retention, DOM/XR recovery/import decisions, Save/Discard/Cancel, beforeunload and coordinated PWA updates. Focused lifecycle/storage/browser tests and the complete web quality gate pass. Broader device qualification remains pending. |
| I: large-project performance | Implemented; automated qualification passes | Worker indexing before rich allocation, record/path checkpoints within oversized layers, DOM/XR move-window controls, cancellation, typed import traversal and cached save/slice fingerprints pass the complete web gate and supported-deployment checks. |
| Release qualification | Prior software qualification passes; Galaxy XR input regression under repair | The October 1 native build, supported HTTP/HTTPS deployment checks and report regeneration pass. An October 4 Galaxy XR run reports unresponsive File-menu interaction even with an empty plate; the deployed build identity is unverified and the candidate fix needs full qualification and a headset retest. Credential revocation, supervised U1/CC procedures, calibration and independent review/security signoff remain pending. The running deployment has not been replaced. |

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
  server deployment binaries. At this checkpoint, the verifier did not yet cover adjacent
  manifests or partial directories; E adds those checks below.
- `npm --prefix web run quality`: passes in full, including architecture,
  localization, production browser workflows, offline, accessibility (28 axe
  rules), pseudo-locales (155 critical controls), all 13 slicing test files,
  and unchanged bundle ceilings. Main chunk: 2,328,292 bytes; total JavaScript:
  10,537,352 bytes. These existing browser tests use the Vite-built preview and
  simulator; the real-Express/container deployment suite had not yet been
  implemented at this checkpoint. E records its later evidence below.
- Current-source Gitleaks scan: passes with repository configuration and full
  redaction, using image digest
  `sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`.
  This scans the current tracked files plus new implementation files, not Git
  history. A documentation phrase was reworded to avoid a false positive;
  secret rules and allowances were not weakened.

The dependency and source-credential change passes its automated gates.
Hardware, credential revocation, deployment release, and independent review are
not proven by these checks. The overall plan remains active.

## Printer command verification (2026-10-01)

- A new full-query regression failed against the prior accumulator: a response
  containing only progress retained the old `printing` state and filename. Full
  queries now discard old fields; incremental notifications alone merge.
- `printer-session-controller.test.ts`: 18 tests cover exact immutable identity,
  same-filename restarts, job/state changes, printer switches, reconnects,
  disposal, partial/failed queries, missing metadata, forged/replayed tokens,
  serialized commands across dialogs, and superseded/late query publication.
- DOM hold tests retain the original intent across telemetry updates, suppress
  duplicate releases, and abandon holds and dialogs on disposal/session abort.
  Real transport tests prove recovery uses authenticated POSTs without opening
  a WebSocket, and still honors cancellation and disposal.
- Production browser regressions pass for same-filename replacements during a
  modal, a DOM hold, and an XR-port hold; failed refresh after confirmation;
  dialog cancellation on reconnect; successful DOM and XR-port pause/resume;
  and separately confirmed emergency stop / firmware restart while queries fail.
  The XR ports now invoke the registered `xr-inspector` surface; the previous
  `xr-menu` invocation silently skipped those commands. These checks do not
  substitute for controller/pinch interaction on Galaxy XR.
- `npm --prefix web run quality`: passes (228 unit test files, integration,
  architecture, localization/parity/settings checks, production browser/offline,
  accessibility, pseudo-locales, and all 13 slice test files). Bundle limits are
  unchanged: main 2,339,383 bytes; total JavaScript 10,548,443 bytes. Final dialog
  lifecycle/controller tests and type checks were repeated after the corresponding
  changes; the final XR control layout is included in the accessibility/pseudo
  production builds. The localization sweep decreased from 178 to 177 strings.
- Current-source Gitleaks scan passes with the same pinned image and unchanged
  scanner rules. Regenerated qualification reporting still withholds the parity
  claim and lists five outstanding human gates.

Installed-firmware identity fields, supervised machine control, credential
revocation, and independent security/release review remain unqualified.

## Submission verification (2026-10-01)

- The readiness regression reproduced automatic-start authorization from missing
  state fields. Full, recognized Klipper/print/virtual-SD state is now required;
  only ready, inactive, explicitly idle states authorize start.
- `print-workflow-controller.test.ts`: 32 tests cover lifecycle order,
  upload-only defaults, changed artifact/session/mapping/readiness/capabilities,
  cancellation at each mutation boundary, changed preparation commands,
  ambiguous preparation/start reconciliation without retries, listing failure,
  wrong upload root/path/size, changed/active overwrite targets, collision
  regeneration, two clients choosing the same name, and stale stored reprints.
- DOM dialog tests cover abort cleanup, focus restoration, exact overwrite
  metadata, upload-only defaults and blockers. Seven XR renderer tests include
  an explicit overwrite toggle, upload-only availability with a start blocker,
  and stored-file confirmation. Both surfaces use one workflow and start
  options; closing an XR send sheet cancels its pending confirmation.
- Production browser tests upload the real sliced artifact, change loaded
  filaments before upload completes, and prove the file remains without any
  preparation/start request. Replacing a stored file during confirmation also
  sends no start. Normal verified upload/preparation/start and reprint pass.
- `npm --prefix web run quality`: passes in full, including 230 unit test files,
  all integration/project/settings/localization/XR checks, production browser
  and offline tests, 28 accessibility rules, 155 pseudo-localized controls,
  and 13 real slicing test files. The initial size check caught a 2,863-byte
  main-bundle overrun; loading the DOM confirmation on demand resolved it
  without changing ceilings. Final main: 2,346,538 bytes; JavaScript total:
  10,562,784 bytes. The localization sweep decreased from 177 to 176 strings.
- Current-source Gitleaks passes with the same pinned image and unchanged
  rules. Regenerated parity reporting still withholds the claim and lists five
  outstanding human gates. Upload checksum and response validation follow the
  [Moonraker file API](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/).

No printer hardware was mutated during these tests. Moonraker has no atomic
client-side check-and-start transaction; other-client races and installed
firmware compatibility still require supervised qualification.

## Slicing lifecycle verification (2026-10-01)

- Native regressions reproduced publication after exit 17 or a signal, and a
  live descendant after the immediate child exited. Nine lifecycle tests now
  cover those cases, normal/missing/oversized output, a CLI that never opens its
  progress FIFO, cancellation, and SIGKILL escalation of a TERM-ignoring child.
  The same nine pass in an isolated Linux container with `--init`, including
  disappearance of adopted descendants from `/proc`. This uses the existing
  runtime image with current code mounted; it is not a fresh native image build.
- All 48 server tests pass against the default artifact path. HTTP regressions
  cover interrupted/repeated/concurrent downloads, expiry and release while
  transferring, retained-capacity refusal, synchronous job recovery, bounded
  private diagnostics, and unsuccessful jobs never publishing partial output.
- The old browser deadline probe failed because a hung DELETE never reached its
  timer. Nineteen helper tests and fourteen canonical-route tests now cover
  hung DELETE/body/poll/delay, independent cleanup cancellation, distinct
  terminal outcomes, complete download before release, digest/length/identity
  mismatch, insecure-LAN hashing, older servers, and failed or hung releases.
- Full `npm --prefix web run quality` passes: 231 unit test files, all
  integration/project/settings/localization/XR checks, production browser and
  offline tests, 28 accessibility rules, 155 pseudo-localized controls, and
  thirteen real slicing test files. Unchanged budgets: main 2,344,997 bytes;
  total JavaScript 10,565,669 bytes.
- Qualification reporting was regenerated; the five human gates remain
  incomplete. Current-source scanning uses the same pinned Gitleaks image and
  unchanged repository rules.

Process-tree settlement is qualified on Linux with an init reaper. A kernel task
that remains alive after SIGKILL keeps its worker slot; cancellation cannot be
reported confirmed prematurely. Other host platforms remain unqualified.

## Deployment verification (2026-10-01)

- Real HTTP regressions first reproduced static assets exhausting the API
  allowance and reserved API paths returning SPA HTML. Seven deployment tests
  now cover cold assets and entry-point caching, JSON API misses, token and
  same-origin mutation authorization, malformed forwarded protocol, and actual
  socket authority for authentication, CORS and rate identity.
- Artifact tests reproduced acceptance of a stale adjacent manifest and a
  partially populated optional copy. Seven expanded cases now cover schema,
  source/input identity, expected filenames, missing/changed files, concurrent
  publication, old readers, invalid sources and interrupted staging. Initial
  publication builds its whole directory privately before activation; readers
  never see a partial root, including simultaneous first publishers. All
  required/present copies pass the shared verifier. Canonical/browser adjacent
  manifests were added only after independently checking every binary hash.
- A real WASM slice through Express passes against the default resolver,
  without an environment override, and validates the returned output digest.
  The server suite passes 56 tests. Native manifest regression additionally
  reproduced acceptance of an unsupported schema; the shared verifier now
  rejects wrong schema/source and malformed patch or executable identities.
- The new browser suite serves the actual production build through Express.
  Both insecure HTTP LAN and a local HTTPS proxy pass cold loads, automatic
  attested discovery, retained downloads, and API rate limits. HTTPS verifies
  every one of 157 precache entries and cross-origin isolation. The HTTP case
  connects to the existing Moonraker simulator; no hardware is contacted.
- Those browser checks exposed an unguarded service-worker registration on
  insecure LAN pages. The helper now skips registration there, and the actual
  page script is covered in addition to its pure reload-decision tests.
- A separate regression found the browser's WASM digest differed from the
  canonical published bytes. The pin now matches the independently verified
  binaries; the engine source and binaries are unchanged. Web security checks,
  a unit regression, Docker coherence checks and live discovery assertions keep
  that mismatch from recurring.
- Base and Tailscale-profile Compose validation pass. The optional sidecar uses
  shared application networking, userspace mode and a directory configuration
  mount; base LAN publication remains intentional. Embedded startup uses the
  same loopback trust boundary. A native image build is in progress; its browser
  and process-reaping checks are not yet recorded as passing.
- All three dependency audits report zero vulnerabilities. Current-source
  Gitleaks passes with the existing pinned image and unchanged rules.

Full web quality passes, including 231 unit test files, production browser and
complete offline checks, 28 accessibility rules, 155 pseudo-localized controls,
and all thirteen slicing test files. Main remains 2,344,997 bytes; total JavaScript
remains 10,565,669 bytes, with unchanged ceilings. The artifact gate required the
adjacent metadata to be committed before qualification; that metadata-only commit
is `5b90733`, and the generated release report now includes its exact Git blob.
Live tailnet enrollment, actual printer/XR hardware, credential rotation and
independent release signoff remain unqualified.

## Discovery verification (2026-10-01)

- The original probe reproduced an external route becoming enabled while its
  discovery request was still pending. Discovery now probes an explicit candidate
  without writing shared preferences, then commits one attested route only while
  its generation remains current.
- Twenty-one controller tests cover late success/failure after manual selection,
  disable/forget/token or candidate edits, preference changes, reset, disposal,
  bounded hung probes, repeated connections, coherent atomic storage, and blocked
  or full storage. An additional regression reproduced a rejected preference reset
  reviving old persisted state; reset now preserves the operator’s session intent.
- Twenty attestation tests include manual connections requiring provenance after
  ping, bounded invalidation of hung proofs, complete native executable digests,
  exact patch sets, and captured endpoint/engine/generation identity. Canonical
  route tests retain the generation and reject secret-bearing URLs before requests.
- Four DOM lifecycle tests exercise real controls against the shared controller,
  including late status updates, draft preservation, disabled remounts and disposal.
  The real-Express browser suite also passes delayed attestation versus a manual
  choice and disabled-discovery reloads over both insecure HTTP and proxy HTTPS.
- A real browser with a throwing storage getter reproduced a startup failure in
  legacy AI credential cleanup. The getter is now guarded, and both deployment
  origins boot and connect with an explicit session-only persistence hint.
- The actual Slice control reproduced a hardcoded browser route that ignored the
  attested external choice; all-plate slicing also omitted engine metadata. Both
  now consume one captured route and proof, reject changed consent before upload,
  and pass real UI slicing through the deterministic external fixture on HTTP and
  HTTPS. The native executable itself remains separately qualified.
- Preference imports preserve the chosen endpoint as disabled until reconnection.
  Export/reset includes the atomic record and legacy origin marker, with no change
  to optional credential remembrance. New status messages use the existing
  localization pipeline, and the settings surface loads in its own lazy chunk.

Full web quality passes, including 233 unit test files, the integration/project/
settings/localization/XR suites, production browser and offline workflows,
28 accessibility rules, 155 pseudo-localized controls and thirteen slicing test
files. Unchanged ceilings: main 2,349,793 bytes; total JavaScript 10,574,317 bytes.
Current-source Gitleaks passes with the pinned image and unchanged rules.
Startup qualification follows below; discovery evidence alone does not establish
application readiness.

## Startup verification (2026-10-01)

- A browser regression reproduced Ready while the required settings schema
  returned HTTP 503. The marker now derives from core workspace, shell, profiles
  and settings capabilities; unused optional integrations remain idle.
- Nine registry tests cover required/optional health, single-flight retry,
  partial-resource disposal, cancellation, deadlines, late import rejection and
  module failures that need reload. Policy/surface tests preserve printer
  recovery availability and show the same recovery target in DOM and XR.
- Required profile fetches now reject errors instead of swallowing them. A
  follow-up regression caught empty catalogs replacing valid data; failed,
  malformed, empty and late responses now preserve the previous usable catalog.
- Built-browser tests pass profile/schema failures, one request for repeated
  retry gestures, recovery without duplicate panels, and optional panel failure.
  Reload leaves a dirty project intact, then succeeds after explicit discard.
  Both HTTP and HTTPS deployment suites still pass with the derived Ready state.
- Startup controls and the shared settings adapters load separately; lazy panels
  are owned before mount and late imports cannot restore disposed features.
  Recovery text uses the localization pipeline. The XR desk retains its existing
  physical size with a bounded, scrollable failure row.
- Architecture checks follow the extracted settings adapter and still require
  `settings_apply_project` through the action registry, while forbidding direct
  canonical writes throughout the presentation layer. Startup recovery is an
  inspector action shared by the DOM status surface and XR desk.

Full web quality passes: 238 unit test files, integration/project/settings/
localization/XR suites, five startup fault scenarios, offline workflows,
28 accessibility rules, 155 pseudo-localized controls and thirteen slicing test
files. Unchanged ceilings: main 2,312,049 bytes; total JavaScript 10,588,763 bytes.
The final build also passes the real Express HTTP/HTTPS deployment suites and
the current-source scan with the pinned Gitleaks image and unchanged rules.
Broader navigation/update protection and Save/Discard/Cancel persistence flows
remain in H; hardware qualification is not implied by renderer or browser tests.

## Asset rollback verification (2026-10-01)

- A regression reproduced 6,291,456 copied mesh bytes during transform/settings
  edits and undo/redo with a 1 MiB fixture. Repository-owned opaque snapshots now
  restore immutable records and cached fingerprints by reference. Insert/remove
  create new maps; serialized imports still validate and public mutable reads
  still copy. Forged and foreign handles are rejected.
- Seven focused regressions cover ordinary edits, transaction/command failure,
  failed undo/redo, independent repository versions, defensive public reads,
  invalid serialized imports, import undo/redo and fingerprint copy avoidance.
  Import history releases its serialized staging copy after validation and
  includes the replaced and imported payload sizes in its history estimate.
- Audited both production `peek()` consumers: the Three projection and canonical
  bounds reader only read shared descriptors/bytes; their mesh decoder allocates
  separate position/index buffers. Descriptors are deeply frozen on insertion.
- Fixed 8 MiB generated fixture, Node 22.21.0, twenty transform/undo pairs on the
  same host: copied bytes fell from 335,544,320 to zero; median pair duration fell
  from 10.38 ms to 0.59 ms, with p95 14.51 ms to 1.55 ms. Asset fingerprint
  `fnv1a64:ac1234b6ba312faf` and semantic hash `fnv1a64:66c954a755f47ac5`
  stayed identical. `bench:assets` runs in the project gate and enforces zero
  copied bytes; timing is reported without a hardware-independent latency claim.

Full web quality passes: 239 unit test files, integration/project/settings/
localization/XR suites, production startup/browser/offline workflows,
28 accessibility rules, 155 pseudo-localized controls and thirteen slicing test
files. Unchanged ceilings: main 2,313,191 bytes; total JavaScript 10,591,579 bytes.
This does not complete the persistence controller or remaining surface ownership
work.

## Persistence verification (2026-10-01)

- Persistence qualification adds guarded snapshot/checkpoint, queue/disposal,
  real IndexedDB transaction and DOM/XR decision regressions. The production
  browser loses a tab, restores through the import worker, preserves dirty state,
  exercises all three navigation choices and validates per-session discard plus
  explicit manual export when worker creation fails. Initial profile defaults
  establish a clean baseline only before any authored revision exists.
- A production browser rerun exposed a pending camera request proceeding after
  the panel was hidden. The focused regression now proves cancellation on
  hide/disposal and prevents overlapping slow captures; the live adapter checks
  visibility and selected camera again after awaiting a connection/frame.
- The native source image completed all 604 build steps. Its non-root,
  init-managed process lifecycle suite passes 9/9, including required descendant
  reaping. After refreshing the runtime/web layers, real-container HTTP and
  proxy HTTPS browser checks both pass, including full precache, insecure-LAN
  behavior, simulator access, retained downloads and API limits.
- The refreshed container also slices a generated 20 mm cube through its actual
  pinned native CLI and production HTTP service with bundled Centauri Carbon
  0.4 mm / 0.20 mm Standard / Elegoo PLA profiles. Two downloads return identical
  183,923-byte G-code with extruding moves and SHA-256
  `72958e0f6f29f68d9678eb1ba8a3bdc1dbbd521697f2a476bcc901fe1442ab79`;
  explicit release then returns 404. The disposable container is non-root,
  read-only and init-managed. No deployed service or printer was changed.
  Subsequent implementation commits require another runtime/web image refresh;
  this does not claim hardware printing or a final-release image.

Full web quality passes: 247 unit test files, integration/project/settings/
localization/XR suites, production recovery and real IndexedDB fault scenarios,
five startup recovery scenarios, offline workflows, 28 accessibility rules,
155 pseudo-localized controls and thirteen slicing test files. Unchanged bundle
ceilings: main 2,324,209 bytes; total JavaScript 10,474,956 bytes. Import and
serialization share one emitted archive-worker module with independently owned
instances, avoiding duplicate codec bundles. Current-source Gitleaks passes with
the pinned image and unchanged rules. Server tests pass 56/56 against the default
artifact resolver. Generated parity reporting still lists five human gates.

## Technical context reduction (2026-10-01)

`GEMINI.md` now keeps the cross-cutting constraints and required reading in 310
lines. Detailed canonical/parity, XR/UI, runtime/deployment, engine and large-model
context moved into maintained topic documents. Retired Android/JNI guidance has
its own clearly marked historical archive; current WASM memory, config, indexing
and provenance constraints remain in the active guidance. Relative documentation
links were rebased and checked. The obsolete seven-action XR rail and pre-attestation
external-routing statements were corrected to match the shipped behavior.

## Surface lifetime verification (2026-10-01)

- A production-browser regression reproduced dead workspace tabs after a persisted
  pagehide/pageshow pair. A palette regression reproduced two Ctrl-K handlers
  toggling twice after remount. Both pass with explicit surface ownership.
- Unit checks cover permanent departure, callback restoration without clobbering a
  newer owner, observer cleanup, partial mount failure, child cancellation and late
  initialization rejection. Cached-document event handling is browser-tested; this
  does not claim a particular device's actual back-forward-cache eligibility.
- Shell callbacks/subscriptions, eager panels, optional feature children, generated
  file inputs/modal controls, AI configuration, observers and XR viewport listeners
  now have explicit disposal. A two-simulator browser regression also reproduced
  console replies disappearing after printer replacement. The console now replaces
  its notification subscription with the selected transport; both simulators' replies
  arrive, and its last subscription is released on disposal.

Full web quality passes: 249 unit test files, integration/project/settings/
localization/XR suites, production browser/recovery/startup and real IndexedDB
fault scenarios, offline workflows, 28 accessibility rules, 155 pseudo-localized
controls and thirteen slicing test files. Unchanged bundle ceilings: main
2,329,856 bytes; total JavaScript 10,477,051 bytes. Current-source Gitleaks passes
with the pinned image and unchanged rules. Generated parity reporting retains
the five outstanding human gates.

## Preview and import performance verification (2026-10-01)

- The fixed 300,002-record single-layer fixture reproduced a retained 300,002
  records and a 524,288-element Float32 column allocation. Index-first windowing
  limits both to 240,000; forward/backward paging reaches every source record.
  Five warmed Node pairs measured indexed-window/whole-parse ratios of
  1.45–1.65 (median 1.59); the relative CI guard allows at most a 2.5 median
  ratio on the same runtime/host. Modal/source/column parity tests cover event
  IDs, source line offsets, incomplete input and arc path-point checkpoints.
- Browser parsing, indexing and default projection/inspection now run in one
  owned worker. Tests cover coalesced superseded windows, source cancellation,
  crash, unreadable/malformed replies, post failure, deadline and disposal.
  The built browser reaches the second chunk using actual DOM controls and the
  XR registry, preserves canonical state and terminates obsolete source workers.
  This production run recorded 77 main-thread timer callbacks during an 841.30 ms
  open of the fixed fixture. Timings are informational on this host; independent
  hardware performance remains unqualified.
- Typed import traversal reproduced and fixes false emboss warnings from
  unrelated extension metadata without allocating a complete project string.
  Existing warning wording and IDs remain. Save/slice snapshot preparation uses
  one defensive asset copy, the immutable state/hash and cached asset fingerprint;
  stale revision/asset results still fail closed.

A real-container regression also caught the completed slicing slot being held
until asynchronous preview finished, refusing an immediate all-plate slice.
Preview now owns its worker independently of the completed engine lifecycle.

The browser workflow also exposed ordinary controls briefly re-enabling with a
rejected job identity while a background refresh was still pending. A delayed
refresh regression fails before the fix and passes afterward: after authoritative
command verification, the old identity is invalidated before releasing the command
lock. Only a completed refresh re-enables ordinary controls; emergency recovery
remains available. All 19 printer-session tests and the full DOM/XR-port command
workflow pass. The preview browser test now waits for an in-progress worker request
instead of cancelling it with a second toggle.

Full web quality passes: 251 unit test files, 93 project files, five integration
files, settings/localization/XR suites, production browser/startup/surface/preview/
recovery checks, real IndexedDB fault scenarios, offline workflows, 28 accessibility
rules, 155 pseudo-localized controls and thirteen slicing files. The final paired
preview benchmark ratio is 1.662 against the measured 2.5 ceiling. Bundle ceilings
remain unchanged: main 2,321,334 bytes; total JavaScript 10,550,815 bytes.

## Software qualification at 0902ca7 (2026-10-01)

- The fresh native source build completed all 604 steps; the final runtime/UI
  refresh produced image
  `sha256:bb105cc521c2dcc0b3c58f5c8f2e31ed3ea0bd212ce6881d3b89cba5b433b8d7`.
  Its non-root, init-managed process suite passes 9/9, including mandatory
  descendant reaping. Base and Tailscale Compose configurations validate.
- Real Express and disposable-container browser suites pass over HTTP and proxy
  HTTPS, including cold assets, complete precache, insecure-LAN operation, printer
  simulator access, retained downloads and API limits. The immediate all-plate
  slice passes after the engine slot was separated from asynchronous preview.
  SHA-256 comparison of all 562 built web files matches the image's public tree.
- `npm --prefix server run test:native:container` is now a portable qualification
  command, included in the optional native CI/local build flow. The actual pinned
  CLI slices the generated 20 mm cube with bundled Centauri Carbon 0.4 mm,
  0.20 mm Standard and Elegoo PLA profiles. Repeated downloads return identical
  183,923-byte extruding G-code with verified length and SHA-256
  `7b020486d8a03d8dee30ec03a099c198bc10bc239f0e2bfb6185161ee4ed90c6`;
  explicit release then returns 404. Hash equality is asserted within one job;
  native timestamps can change hashes across separate runs.
- Server tests pass 56/56 against the default artifact resolver. Seven artifact
  tests and verification of all four required/present artifact sets pass. The
  cube, profile, project, painted, painted-prime-tower and full-spectrum WASM
  fixtures pass. Maintenance security tests pass 6/6. All three full dependency
  audits, including development packages, report zero vulnerabilities. The final
  current-source Gitleaks scan passes with the pinned image and unchanged rules.
- Regenerated parity reporting still withholds the full-parity claim and retains
  five human gates. Repository source cleanup is not evidence of credential
  revocation. Installed firmware, supervised U1/CC control and calibration, Galaxy
  XR interaction, independent review and security signoff remain unqualified.

These checks used generated fixtures and simulators. No real printer commands,
deployment replacement or remote push occurred. The software implementation of
the audit plan is verified; the operational and human release gates above remain
explicitly pending.

## Completion audit: preview navigation (2026-10-01)

The requirement audit reproduced an uncovered session-ownership gap: an empty
preview window switched the UI to Prepare while retaining its worker and controls,
and a standalone preview without a model or published slice could not close through
the registry. Loading a preview also left Prepare unable to cancel the request.
The built-browser regression failed before the fix; the registry regression
independently reproduced the disabled close action.

UI mode now follows the loading or retained inspection session independently of
drawable geometry. DOM and XR can close that session, including a pending worker,
without weakening export or send prerequisites. Reselecting Preview preserves the
pending request. The actual move-filter control recovers an empty window; canonical
edits invalidate retained, non-drawable slice previews so they cannot be redrawn
after their artifact becomes stale. Browser tests exercise these transitions, and
headless tests cover close/disposal plus every export/send surface's artifact guard.

The complete web quality gate passes again: 251 unit files, the supporting suites,
production navigation/recovery/startup/offline checks, 28 accessibility rules,
155 pseudo-localized controls and thirteen slicing files. Main JavaScript is
2,321,516 bytes and total JavaScript is 10,550,997 bytes under unchanged ceilings.
The bounded-preview benchmark ratio is 1.552; the production 300,002-record fixture
records 77 main-thread timer callbacks during an 872.20 ms open on this host.

Refreshed image
`sha256:135825b749656c5c9cd843ee4e2897af58cda255283d725ea1cdada2f14dfbe3`
passes container HTTP/HTTPS deployment, native retained-download/release and 9/9
process-reaping checks. Host Express HTTP/HTTPS checks also pass. All 562 built
web files match the image byte for byte. The native fixture again returns 183,923
bytes, with within-job SHA-256
`77eecb21d3e461fe9cde44ea9d7150e6766cd74b1f085c2f9250fd6ae05e7ad1`.
The final current-source Gitleaks scan passes with unchanged rules, and regenerated
parity reporting retains the same five human gates.

The README now specifies backend-first release and browser rollback without
clearing recovery data. This prepares the release sequence; it does not claim it
has been performed. Credential revocation, supervised U1/CC/Galaxy XR qualification,
calibration and independent review/security signoff still require operator evidence.
No deployment, remote push or real-printer mutation occurred during this audit.

## Galaxy XR File-menu regression (2026-10-04)

The operator tested `https://orcaxr.martinez.fyi/slicer` in Chrome on Galaxy XR,
with controllers, hands and gaze available. They report unresponsive interaction
immediately after entering XR, including on an empty plate: attempting to open
File with hands freezes/moves the UI without a visible menu, and controller
activation has no visible result. Hover highlighting is present. The exact
browser/firmware versions and deployed source revision are not yet recorded;
this is a failed initial hardware check, not qualification of a known build.

A regression using the installed XRBlocks/UIBlocks components and select-event
dispatch reproduces a detached File-title anchor. Opening a menu rebuilt the
whole cockpit before reading that title's world pose, causing an origin-relative
dropdown placement (behind the operator at the default pose). The local empty
shell reproduction took approximately 190 ms for that rebuild; this is a host
measurement, not a headset frame-time result. A second regression shows that
closed cards still traversed their children during XR raycasts.

The candidate retains the menu bar, resolves dropdown anchors from the live
title, and limits overlay gestures to overlay updates. Inspector and scrubber
changes have their own invalidation paths. Hidden cards prune ray traversal and
also use UIKit display state to hide their shader children. The regression
covers both controller releases, a held second pointer, repeated toggles, live
anchors after canonical refresh, and session hide/show. Hardware performance and
interaction remain unqualified until the candidate is deployed and retested.

Candidate validation: the production-component regression, all 13 XR test files,
formatting, lint, TypeScript and architecture/direction checks pass. The production
build and offline/size contracts pass: main JavaScript is 2,321,656 bytes and total
JavaScript is 10,551,798 bytes, within unchanged limits. Repeating the initial
headless empty-shell probe keeps the File anchor at its original world pose and
places the menu in front; opening takes about 60 ms and closing about 1.3 ms on
this host. These timings are diagnostic observations, not a device budget claim.

The full `npm --prefix web run quality` attempt could not complete in the current
sandbox: local server creation fails with `listen EPERM`, and checks that invoke
Git from Node fail with `spawnSync git EPERM`. The run was stopped after those
failures. A separate parity report check encounters the same Git restriction;
the existing generated report is unchanged. Browser/end-to-end verification and
headset retesting are still required. The local investigation did not deploy or
issue real-printer commands.
