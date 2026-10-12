# Canonical project and parity contracts

Maintained technical context from [GEMINI.md](../../GEMINI.md). Read this
when changing the corresponding area; update it in the same commit as behavior.
Code paths below are relative to the repository root. Historical measurements
are fixture-specific evidence, not device-independent performance guarantees.

## Parity implementation invariants

- The Rust project-domain identifier port retains immutable UTF-16 units, exact
  case and code-unit ordering. Imported IDs may include lone surrogates and NULs;
  ordinary Rust strings cannot represent the whole accepted domain. Namespace
  syntax and whitespace follow the existing JavaScript validator, without
  trimming or Unicode normalization. Typed entity families prevent mixing plate,
  object, volume and other references. Clones and physical/mixed-to-filament
  widening share the immutable text allocation. UUID generation consumes sixteen
  injected numeric words with JavaScript wrapping; the deterministic PRNG is for
  fixtures and production entropy belongs to the host. This port introduces no
  new persisted encoding, wire protocol, project authority or application route.

- The Rust asset repository owns canonical descriptor values and immutable bytes.
  Stored metadata retains unknown fields and lossless UTF-16 strings/keys. Stable
  IDs, finite canonical metadata, declared byte length and lowercase `fnv1a64:`
  digests are checked before publication. Other digest labels retain the existing
  opaque behavior; actual-byte FNV digests still determine bundle identity. Mesh
  declared layouts, source kind and project references belong to the separate
  graph validator. Neither layer attests that mesh bytes satisfy every geometry
  or slicer constraint. This library boundary does not accept malformed IDs
  or noncanonical values merely because an unchecked JavaScript call could.
  Identical puts and absent removals preserve version/record identity. Conflicting
  metadata or bytes reject; failed public restores publish nothing. Internal
  snapshots are opaque and reject another repository's owner. History retains
  shared record allocations and cached fingerprints; a read-only lease can outlive
  repository disposal. No unsafe mutable byte access is exposed. Public get/list/
  capture/find return owned copies, and public restore creates fresh records.
  Find-by-digest uses insertion order, whereas list/bundle identity use UTF-16 ID
  order. Restoring a sorted public capture can therefore change which duplicate
  digest is found first without changing the bundle hash. Fingerprints stream
  canonical metadata and cached content digests without building a whole bundle.
  Imported JSON keys such as `__proto__` remain own properties through TypeScript
  cloning; they never invoke the legacy prototype setter. The native trace corpus
  includes that regression and binds the TypeScript reference source hashes.
  The native command owner now uses these snapshots for atomic rollback;
  the native session owns guarded string requests. An optional WASM binding now
  executes them in worker tests; production worker/JNI integration remains open.

- Rust mesh views retain an immutable asset lease and validate actual finite
  float32 xyz values, index range, triangle count and bounded buffer layouts.
  The repository already proves descriptor length and declared FNV digest before
  issuing the lease; opaque digest schemes retain that existing policy. Mesh
  views borrow source bytes without creating decoded arrays or rehashing them.
  Little-endian reads support unaligned/interleaved positions, extra position
  components, uint16/uint32 strided indices and implicit non-indexed triangles.
  Safe-integer layout arithmetic precedes address narrowing, including unused
  strides larger than wasm32 address space. Clones retain the immutable proof.
  Authoring accepts packed float32/float64 coordinates with optional uint32 indices,
  writes one canonical buffer and computes FNV while writing. Explicit input
  metadata, payload/count and expansion budgets precede their allocations.
  Finite binary64 coordinates that overflow float32 are refused by both codecs.
  Canonical bounds check full captured descriptor agreement, unique known instance
  IDs and optional volume roles. They visit all vertices, including unreferenced
  ones, applying volume then instance TRS in reference arithmetic order. There
  is no box-corner approximation or intermediate transformed mesh. Both browser
  and Rust reject non-finite transformed vertices instead of silently omitting
  them from a finite-looking result. Native mesh/bounds work polls cancellation;
  graph lookup/metadata comparison still belongs on an owned preparation task.
  This is a library proof, not a live revision guard, renderer binding or native
  import/export workflow.

- Rust facet computation retains the version-2 sparse pair: whole-facet
  assignments and only subdivided source facets. It covers color, support, seam,
  fuzzy-skin and brim values, exact split fields/order/topology, filament
  references, duplicate assignments, recursive homogeneous collapse and the
  existing depth/expansion budgets. Remapping operates on both halves; a newly
  uniform split becomes a whole-facet assignment. Typed trees are immutable,
  acyclic and at most 64 split levels. Persisted triangle counts/indices retain
  finite nonnegative binary64 integer semantics rather than introducing a
  safe-integer or platform-pointer-width schema limit. Explicit dense expansion
  checks a host-provided root budget and addressable allocation size first.
  Sparse import assembly instead consumes strictly increasing, unique, in-range
  indexed roots. It validates all provided trees under the channel budget, drops
  unpainted roots and moves uniform splits into whole-facet assignments without
  allocating or iterating over missing source facets.
  Canonical-value validation does not reuse the stateless JSON parser's smaller
  byte/node/depth limits. Raw refinement validation preserves the reference issue
  order; cyclic/shared JavaScript object identities cannot occur in owned Rust
  values. Malformed assignment containers return errors rather than unchecked
  JavaScript TypeErrors. The computation view is not a complete annotation or
  project codec and does not discard unknown fields from a stored graph. Typed
  candidates retain those fields. The graph validator checks annotation/source
  topology consistency; the future command/session gateway must check revision guards.
  This library is not wired to browser or Android project execution yet.

- Rust schema-1 candidates preserve every modeled field and unknown properties
  at each record boundary, including own `__proto__` data, UTF-16 keys/text/IDs,
  finite binary64 numbers and array order. Optional absence remains distinct from
  explicit null; required fields, enum domains and tuple lengths are checked.
  This is a typed structure boundary, not semantic graph validation or an emulator
  of unchecked JavaScript objects. `ProjectData` caches an immutable candidate's
  full canonical FNV identity, including timestamps and unknown fields. Child
  records/collections, configurations, sparse assignment payloads and extension
  data share immutable ownership. Candidate edits copy the changed path; public
  `to_value` exports make owned copies. Streaming serialization does not construct
  a second graph or clone large metadata keys. Extras moved between record types
  cannot shadow any known field, even an absent optional one.
  Empty-project construction consumes injected IDs in browser order and accepts
  host timestamps. Graph lookups preserve traversal order; topology comparison
  and filament inheritance match the reference. The separate settings library
  below resolves configuration. These candidates do not enforce cross-references,
  mesh layouts, timestamps, topology guards, commands
  or session/history policy. The separate Rust validation-value helpers retain
  pinned V8 `Date.parse` syntax and layer-event `toFixed(4)` collision behavior;
  strict ISO parsing or ordinary Rust formatting cannot silently replace them.
  Timestamp parsing preserves UTF-16, NUL termination, legacy forms, overflow days
  and the V8 build's explicit tagged-integer profile. Local dates require a host
  resolver with matching DST/historical rules and TimeClip after conversion.
  Resolver failure remains distinct from invalid project data. Graph admission
  now uses this explicit policy. The optional WASM project host calls JavaScript
  Date.parse directly. Android's JNI host uses the pinned Rust parser with an
  explicit V8 integer profile and a captured Java ZoneId resolver; host JVM
  comparisons qualify the tested DST/history rules, not Android's timezone data.
  Unknown annotation/refinement fields stay intact in the candidate, while the
  separate facet computation view owns its existing semantic checks. Persisted
  values do not inherit the stateless canonicalization request's parser limits.

- Rust graph validation operates on canonical typed `ProjectData` and reports
  all reachable graph errors in browser traversal order. Structural errors
  already excluded by typed decoding are not emulated as unchecked JavaScript.
  It checks duplicate IDs, declared asset layouts/bounds, references, inherited
  settings consistency, mixed recipes/cycles, transforms, ranges, topology/paint,
  layer events, thumbnails and extension paths. Imported foreign configuration
  remains legal; option/profile eligibility and actual mesh bytes have separate
  authorities. `ValidatedProject` admits only a report without errors and retains
  the immutable state, fingerprint and proof across clones. Creating an edited
  candidate does not change that proof; admitting the edit validates again.
  Host timestamp-service failure cannot produce a partially accepted candidate
  or an invalid-data report. Store ownership is separate from admission; native
  command execution owns history; the native session owns request identity/queueing.
  User-facing paths/messages retain UTF-16, including lone surrogates and NULs;
  Debug/Display redact source content. Unknown refinement-channel diagnostics use
  canonical UTF-16 order. Sorted range validation carries original array indices
  instead of searching by object identity, so repeated shared records get the
  correct path and save/reopen preserves diagnostics. Mixed-cycle traversal uses
  iterative DFS with the reference's last-duplicate-ID lookup and issue order.
  Valid paint indices allocate no diagnostic strings; only assigned indices are
  indexed. Effective-settings equality borrows values and uses a depth-sized
  iterator stack, avoiding JSON copies and one stack entry per scalar.

- The native command bus exclusively owns its project, selection, asset repository
  and timestamp policy. It returns ordered immutable effects, including rollback
  effects on errors; host dispatch happens outside the mutation. It reserves safe
  counter capacity for command publications and every possible rollback first.
  A context enforces the declared publication bound so a command cannot consume
  its rollback reservation. Dirty token clocks never roll back, but current dirty
  tokens do. Undo/redo restore captured selection and dirty tokens. History guard
  revision can change even when the visible history snapshot is equal. Coalescing
  retains the gesture start and cannot cross a composite entry or redo branch.
  Entry/estimated-byte retention keeps one oversized newest command, matching
  the browser. Canonical UTF-16 length is streamed, including nested escaping.
  Trusted native commands report anticipated failures with Result; panic recovery,
  nested callback transactions and host callbacks are not a transport contract.
  Generated plate batches are fully decoded/prepared before entering the bus.
  An executed batch member failure emits inner and outer project restoration;
  preparation failure emits neither. Plate duplicate commands compare the complete
  source plate/G-code/thumbnail scope, share immutable metadata and asset bytes,
  and preserve the browser's sparse-order source guard. Reorder undo restores
  logical order with consecutive indices, not the former sparse numeric orders.
  Full previous states retained by plate duplicate/delete are admitted immutable proofs;
  their revert publications can reuse admission without a timestamp-service call.
  Prepared object/volume/instance renames, instance printability and single/batch
  instance transforms now execute through the same owner. Rename trims exact
  ECMAScript whitespace; undo distinguishes absent and empty instance names.
  Batch transforms sort stable UTF-16 IDs, reject duplicate targets, coalesce
  the same gesture/target set and charge exact canonical UTF-16 history lengths.
  Single transforms retain their fixed 256-byte history estimate and legacy
  delimiter coalescing key, including its collision behavior. The existing batch
  command retains only known transform fields for undo, whereas the single
  command preserves imported transform extras; the port matches both behaviors.
  Neither operation copies mesh, paint or configuration payloads. Native object
  lifecycle commands now delete objects/instances, clear plates, duplicate
  independent objects, move objects between plates and convert instances to
  independent objects. They preserve ordered selection repair and exact undo,
  retain shared assets, and stream canonical UTF-16 history charges. Clearing an
  empty plate still enters history without a project publication. Object copies
  preserve unknown metadata; conversion intentionally rebuilds the new instance
  from its ID, optional name, transform and printable flag, matching the browser's
  omission of instance extras/extensionData while retaining transform extras.
  Local native instance creation and paste retain complete captured records,
  including unknown instance/transform metadata. Native template-only paste owns its template even
  after source deletion, injects all editable IDs, appends to the destination
  resolved on apply and retains asset references without inserting asset bytes.
  Instance insertion preserves array order and the reference's finite-index
  errors. Both use the same graph admission, rollback and UTF-16 history charges.
  Budgeted chunked record decoders prove structure, not destination eligibility;
  graph semantics are checked on apply. They create no session/wire authority.
  Local batch history preserves arbitrary domain labels and batches larger than
  64; the generated protocol retains its 64-command and label limits. A host
  admitting staged transactions must enforce explicit resource budgets before
  submission. Rust and the local TypeScript endpoint now own measured staged work
  under explicit resource/command/encoded-UTF-16 limits, disabled by default.
  Capture fixes all retained arguments before charging; one-use session-local IDs
  never repeat. The guard captured before preparation must still match owner,
  project, assets and history at admission and execution. Selection changes alone
  do not invalidate it. Ready and queued inputs share the aggregate budget;
  moving work into the queue does not free its charge. Cancel/close drop queued
  payloads immediately while preserving bounded reply slots. Release addresses
  only unaccepted input and remains available at queue capacity; it never undoes
  accepted/committed work. Host cleanup releases unconsumed inputs after failed
  transport without retrying an uncertain mutation. The small generated envelope
  adds executeStaged/releaseStaged references; its existing command/batch bounds
  are unchanged. These additive version-1 operations require a matching host
  staging implementation; older decoders reject them before mutation. They are
  not capability negotiation. Parsing/preparation budgets remain separate, and
  encoded units are not a resident-memory ceiling. WASM/JNI upload adapters now
  implement the separate version-1 `project-staging` contract. Ordered UTF-8 chunks
  carry `[version, work]`; work/command arrays use generated numeric tags and exact
  positional arities. Persisted records keep unknown fields, UTF-16 escapes and
  last-key-wins objects. Embedded small intents are ASCII JSON strings and still
  use their strict decoder. Named options explicitly bound bytes, nodes, text,
  number tokens, depth, command count and finished encoded units. Four preparation
  permits per core instance cover both reading and sealed input across sessions.
  The permit survives admission until the destination charges its finished pool;
  parse/seal/transfer failures and cancel/drop release it. Bad chunk/offset calls
  preserve progress. Sealing performs synchronous typed decoding and measurement;
  hosts must schedule it on an owned preparation executor. JNI owners can use
  separate task threads. WASM handles remain in their originating module and
  linear memory: calling a separate seal method does not provide worker isolation
  or interruptible finalization, and uploads cannot move between module instances.
  Browser task isolation remains open; Kotlin actor scheduling is described below.
  Transfer performs no parser work and rechecks the original
  guard. Detached input can outlive a closed source as an immutable capture but
  cannot attach to another owner. Hosts own cancellation of those preparation
  tasks; session close only owns accepted ready/queued work. Kotlin consumes upload
  owners on failed/successful transfer, cleans late results, and exposes a closeable
  ready reference whose release never cancels a queued command. Waiting for an input
  call does not hold the session call gate. Native asset import and native editing
  UI remain open. Kotlin clipboard scheduling is described below. The transitional browser controller now
  enables four ready/queued resources, 4,096 aggregate commands and 16 Mi encoded
  input units. Each instance capture separately allows 1,048,576 nodes and depth
  128. These are explicit logical limits, not device memory/latency qualification.
  Clone/add-instance use one staged command; fill-bed uses one staged transaction,
  preserving its one-copy label and the default 64-copy planning limit. Explicit
  fill requests above 4,096 copies refuse before planning. Aggregate input charges
  bound capture across the batch; the small wire envelope never contains the records.
  Guards precede planning/ID allocation, selection alone cannot retarget an edit,
  and summaries capture original identity/name/transform before submission. UI
  success awaits acknowledgement; a lost receipt never retries or reverses a commit.
  Browser preparation and placement planning are still synchronous.
  Browser clipboard copy retains only the immutable object subtree and an opaque,
  repository-owned asset subset, bounded to 4,096 assets / 512 MiB per capture.
  Mesh and editable SVG drawing dependencies are included; missing bytes refuse
  copy without replacing the previous clipboard. Frozen descriptors are readable;
  bytes remain private and no project-wide rollback snapshot is retained.
  Clipboard paste now captures full metadata under the same 16 Mi input-unit limit
  and queues one guarded local command. It checks asset ownership and exact existing
  declarations, then restores missing descriptors and shared byte records inside
  the command rollback boundary. Conflicting assets or dangling material references
  fail atomically; paste never silently remaps materials or overwrites bytes.
  Undo removes only assets introduced by that paste and still unreferenced; redo
  restores their original record identities. History charges captured byte lengths
  as well as object/descriptor metadata. Late receipts retain the original result
  and never replace a newer clipboard. Disposal clears the controller's clipboard
  reference. Rust now implements the matching library operation: capture shares
  the selected object, typed declarations and immutable byte records, with explicit
  asset-count/byte limits and a weak repository owner identity. It retains no whole
  project/repository version. Missing declarations/bytes are restored inside the
  command rollback boundary; foreign ownership, metadata/byte conflicts and invalid
  destination graphs refuse atomically. Undo scans references once and removes only
  introduced assets that remain unused. Native staged measurement includes all
  object/descriptor metadata and injected IDs; history additionally charges bytes.
  Seventeen browser-authored traces compare 130 native steps, full contents, ordered
  effects, asset identities and exact input/history charges. Six native boundary
  tests include source consistency, concurrent capture limits, sorted query targets
  and retryable apply/undo/redo failures. WASM/JNI now expose four clipboard owners
  per core instance, separate from the four command preparation permits. Callers
  supply asset-count/byte budgets. Capture requires a current session guard and an
  object query node from the exact current graph/revision; sorted display rows
  never become stored-array indices. History-only changes require a fresh guard
  but permit reuse of the unchanged graph query. Root/plate, foreign and stale
  nodes refuse before capture. The result exposes only five counts: volumes,
  instances, layer ranges, selected assets and bytes. It retains no query snapshot.
  A paste upload attaches immutable clipboard data plus a fresh destination guard
  from the same repository owner. The additive version-1 clipboard command tag
  carries only injected IDs and nullable destination; selected objects, descriptors
  and asset bytes are never serialized into command JSON. Full UTF-16 metadata
  still counts toward finished-input charges. One upload may mix several pastes
  from its attached capture with other commands in an atomic transaction. Freeing
  the clipboard releases its owner permit; reading/sealed uploads, accepted work
  and history retain independently charged data. Cancellation/drop releases an
  upload's preparation permit and retained data. Kotlin closes late results and
  never waits on another handle while holding the session call gate. These handles
  remain module-local in WASM; production scheduling, archive import
  and native editing UI remain open.
  Optional wire names/destinations use explicit absent/value variants. Duplicate
  names trim ECMAScript whitespace; conversion names keep their original text and
  graph validation decides validity. The browser controller now submits these six
  lifecycle intents through the guarded asynchronous transport. Selected deletion
  captures the instance/object scope before queueing; changing selection cannot
  retarget the edit. Duplicate summaries capture the exact IDs, name and source
  plate before submission rather than reading newer state after acknowledgement.
  Cut retains its synchronous copy-first behavior, including when deletion fails
  or its reply is uncertain; a newer clipboard copy is never replaced on late
  completion. The controller's existing empty-plate check skips submission and
  preserves history, distinct from executing the raw empty-plate command. Other
  command families and production worker/JNI project integration remain open.

- Rust project/selection stores require one exclusive mutation owner. Each
  accepted project replacement publishes a newer revision, including equal
  content and exact shared allocations. Restore reuses immutable admission and
  hashes but never restores an old revision; its default reason is atomic
  rollback and its dirty-category list is empty. Fresh candidates validate before
  publication; failed graph admission or timestamp services leave state and
  revision untouched. Content equality compares the complete typed graph and
  unknown JSON, not only FNV hashes, and treats signed zeros canonically. Shared
  JSON is skipped by identity; separate JSON uses depth-sized equality frames.
  Revision/hash guards intentionally have the browser store's value semantics;
  the native session additionally checks generation/asset/history guards and
  uses owner-bound local guards for host operations.
  Native revision exhaustion refuses before publication at the existing protocol
  safe-integer maximum, rather than overflowing or repeating a binary64 revision.
  This is a runtime lifetime bound, not a persisted graph limit. A transaction
  owner must preflight capacity for all publications and rollback before editing.
  Changes are immutable receipts returned after publication, without retained
  event queues or arbitrary host callbacks in the stores. Host dispatch must
  preserve their order and isolate projection failures; this library does not
  implement browser subscriptions or revisioned worker/JNI projections yet.
  Selection keeps the first occurrence of each kind/ID pair in order, accepts
  dangling references until explicit pruning, and preserves physical/mixed
  filament membership even when disabled. Exact selection no-ops return no
  receipt; invalid primaries leave state intact. Restore calls the set semantics:
  a nonempty selection without a primary selects its last item. Snapshots and
  receipts retain private UTF-16 text without exposing it in Debug diagnostics.
  Commands, assets, dirty-token policy, bounded history and session lifecycle
  remain separate owners; these stores alone do not enable native editing.

- Native document staging receives UTF-8 JSON in ordered chunks of at most 64 KiB.
  The host explicitly budgets source bytes, decoded value nodes, UTF-16 text units,
  number-token bytes, nesting, asset count and individual/aggregate asset bytes.
  Overwritten keys/values still consume parse budgets. The parser retains decoded
  values, not source chunks; it preserves escaped lone surrogates, NULs, unknown
  fields, duplicate-property last-wins behavior and canonical number semantics.
  Invalid UTF-8, nonfinite numbers and malformed/truncated syntax are refused.
  Syntax/resource failures release staged data and make the input terminal;
  offset/chunk refusals leave progress intact. The implementation supports at most
  128 nesting edges so subsequent canonical value encoding/drop stays bounded.
  This is an operation resource limit, not a new persisted schema constraint or
  the stateless canonicalizer's small request budget.
  Typed decoding, explicit timestamp services, semantic graph admission and total
  declared asset budgets precede payload allocation. Only declared assets can be
  supplied; one transfer is active at a time and exact offsets/lengths are checked.
  Digest validation precedes moving the owned buffer into its immutable record.
  Cancel releases the active buffer; digest failure discards it and permits retry
  while earlier assets remain staged. A complete bundle consumes all declared assets.
  Neither a partial document nor a partial bundle can publish a live session.
  Whole-graph decoding/admission/hashing and digest work still require an owned
  import task; chunking alone does not make finalization interruptible. A prepared
  document now checks exact graph/asset membership and metadata and warms its
  bundle fingerprint before admission into an existing authority. It owns immutable
  graph/asset records and exposes no mutable access. Open captures the source
  export identity plus a distinct operation token. Newer Opens supersede older
  ones even if the newer preparation fails or is cancelled. History-only and
  selection changes preserve an Open; project/revision/assets changes invalidate
  it. The session retains only a weak token, while tickets retain their source guard.
  Dropping all ticket handles abandons that operation. Hosts must still cancel
  preparation work and classify failure against current lifecycle/cancellation.
  Prepared input moves into Open/reset under a final source/owner check. Capacity
  checks precede publication; commit runs no parser, timestamp callback, digest
  validation or payload copy. Even equal replacement advances the project revision.
  Project, selection-clear and history receipts preserve browser order, and a clean
  history root invalidates old history guards. Session nonce/request/staged-ID
  sequences and destination repository ownership survive replacement. Old snapshots
  and leases remain immutable; clipboard subsets keep their owner identity. Ready
  and queued work remain charged until release/settlement and refuse as stale
  instead of targeting the replacement graph. Failed reset preserves pending Open;
  completing or failing an Open clears only its own operation. JNI reserves effect
  capacity before committing and Kotlin consumes document owners on every outcome.
  WASM consumes the document's contents while retaining an empty closeable wrapper;
  repeated admission returns invalid_state without poisoning session borrows. Free
  that wrapper after success or failure. Production archive decoding and
  application integration, including dirty-confirmation/document UI, remain open; the Kotlin
  actor described below now owns canonical bundle preparation and guarded commit.

- The optional project WASM host accepts generated version-1 options: ten exact
  unsigned 32-bit budgets, explicit depth/token limits, and a fresh four-word
  host nonce. Staged upload is consumed when opening a session, including on
  failure; successful construction requires the complete admitted bundle. Actual
  host Date.parse validates lossless UTF-16 timestamps; service exceptions fail
  admission without leaking their text. Raw bindings are trusted adapter APIs:
  precheck inputs before wasm-bindgen copies strings/typed arrays into memory.
  Replies transfer ordered immutable effects, including failure/rollback effects,
  for dispatch before acknowledgement. Captures and asset leases survive session
  release; hosts must release every handle, including effect-owned captures.
  Project JSON export is an explicit synchronous bulk operation with an output
  budget, separate from future bounded live projections. Reads copy bounded
  chunks into host-owned buffers. Save acknowledgement still requires a current
  owner-bound export guard after successful handoff; export alone never saves.
  Independent Node-worker replay exercises this binding. Production browser
  authority and subscription dispatch remain open. Android has a separate JNI
  binding to the same domain owner, described below.

- Android JNI project handles are positive, never reused, and bounded to 4,096
  live handles including at most four upload/prepared-document/session owners. Opening transitions
  an admitted upload into a session in its existing owner slot. Kotlin consumes
  the upload on every open failure as well as success. Response/effect capacity
  is reserved before draining or mutating, so resource exhaustion cannot discard
  a committed outcome. A busy or reentrant native call refuses rather than
  waiting through a host timestamp callback. Registry locks never cover that work.
  Close invalidates lookup immediately while in-flight references retain memory
  and admission permits until released. Kotlin serializes ordinary calls, rejects
  late results and frees any late returned capture. A mutation racing close may
  have committed; loss of its acknowledgement must not trigger automatic retry.
  Captures and owned byte arrays survive the original session's close. Raw JNI
  checks input lengths before copying and returns only bounded, owned arrays.
  Timestamp callbacks use a retained GlobalRef and redact Java exceptions to
  timestamp_service; invalid syntax remains invalid_document. The explicit
  resolver and V8 integer profile are part of admission policy. Actual JVM/JNI
  replay covers these contracts. A Kotlin actor now owns command/query scheduling
  and guarded Open/reset and command preparation: one authority worker, two preparation workers and
  one ordered effect-delivery worker, with at most 32 unsettled requests including
  undelivered effects. Caller lists are captured as bounded immutable protocol JSON
  before enqueueing; monotonic request IDs are allocated in authority execution order.
  A separate host nonce and a checked handshake bind each connection. All effects,
  including failed-command rollback, are consumed before completing its request.
  The callback borrows an automatically closed effects owner; retained child captures
  require their own explicit lifetime. Callback failure cannot undo a confirmed edit.
  Cancellation prevents queued/preparing work; active mutation cancellation refuses.
  Close invalidates native owners immediately and reports active missing receipts
  as uncertain. Already confirmed results retain their outcome with closed projection
  status. Settlement waits for any already running delivery callback to return;
  callback code must not synchronously await another request from the actor.
  Document producers own current/late native handles in a cancellation scope, with
  two preparation workers outside the authority. Superseded/edited source guards
  are checked again at commit. Open/reset without a bounded summary remain completed,
  including when no native handle remains for their optional summary query.
  Reset uses export identity, ignores history-only
  changes and preserves pending Open on failure; successful reset invalidates it.
  Host guards bind a private actor token, monotonic project/history revisions and
  asset fingerprint. They retain neither full IDs, snapshots nor native handles.
  All actor project/asset changes publish a new project revision; do not introduce
  another writer or asset-only mutation path that violates that ownership contract.
  This local proof avoids the stateless wire ID ceiling. Each bulk task checks it
  before taking a native guard and immutable source snapshot, then the native guard
  is rechecked at final admission/execution. Producers borrow the source and an
  ordered chunk writer; sealing runs on a preparation worker, and no ready staged
  reference escapes. Finished-pool limits are explicit and disabled by default.
  Cancellation releases current/late handles, and all settlements release charges.
  Replies become effects in their already reserved native slot; the consumed reply
  owner must not be closed again under its former raw handle. Repeated/wrong-kind
  conversion refuses without changing the effects. Confirmed results remain
  confirmed when an optional host guard capture fails; authority is then absent,
  and callers query again after freeing resources rather than retrying the mutation.
  Copy now starts with an immutable project/asset preparation captured under the
  original guard. Query selection and object/asset scanning run on a preparation
  worker without a live-session lock. Preparation and completed captures share
  four native owner permits; conversion reuses the input slot. Only preparation
  retains the full source version; a completed clipboard retains selected data.
  Final publication rechecks the original guard and latest copy/clear request.
  A failed/cancelled replacement preserves the previous completed clipboard but
  cannot revive an older pending copy. The actor owns clipboard handles; returned
  identities contain only bounded metadata and no native handle or actor closure.
  Paste takes a fresh destination guard and attaches that clipboard's immutable
  data before its producer starts. Later clear/replacement cannot remove those
  bytes from accepted preparation/history; new pastes with old identities refuse.
  Clear is ordered on the authority and immediately supersedes pending copies.
  Close releases the clipboard and all active preparation owners.
  Export now captures the admitted project and asset version together under an
  export guard. History-only changes remain valid; later graph/assets changes
  cannot retarget reads. A borrowed source streams canonical JSON and assets in
  declaration order on a preparation worker, with explicit JSON/asset-count/byte
  budgets. JSON uses at most 64 KiB of native output staging, without building a
  whole serialized buffer; metadata traversal and destination memory are separate.
  Each JNI callback owns its bounded byte array. Callback errors stop serialization
  and become redacted export_service failures. Closing stops subsequent chunks.
  The source is thread-confined and refuses calls after the callback completes.
  The host owns archive format, output closure/flushing, durability policy and
  successful handoff. Complete JSON and every asset must be consumed before save
  acknowledgement. Export alone never clears dirty state. Save acknowledges only
  after handoff and rechecks the captured export identity on the authority;
  concurrent edits yield a confirmed export with a stale checkpoint. History-only
  changes do not invalidate that save. Output handoff and checkpoint confirmation
  are separate: resource pressure or close after a known handoff cannot erase it.
  Checkpoint effects are delivered before completion; projection failure cannot
  undo a confirmed save. Queued preparation remains cancellable. Once the output
  callback begins, cancellation refuses, because external writes may have happened.
  Callback failure, incomplete output or close before confirmed handoff reports
  uncertainty without checkpoint acknowledgement or automatic retry. Source handles
  still close immediately; a blocked destination must enforce its own I/O deadline.
  Archive assembly, storage-provider handoff, app subscriptions and Android runtime
  qualification remain separate requirements.

- A fresh native session first checks exact asset membership and full canonical
  descriptor equality, including unknown metadata and optional-field absence.
  Borrowed typed-to-JSON comparison avoids public payload/metadata copies and
  never substitutes hashes for content. The caller supplies a semantically
  admitted graph and an explicit timestamp policy; this is not archive ingestion.
  Initialization creates the same clean checkpoint/history revision as the browser.
  The existing generated request/reply contract owns wire shape and resource bounds.
  The host supplies a fresh 128-bit connection nonce independently of project IDs.
  Submission and execution are separate: at most 32 requests retain prepared work;
  close/cancel have a control path even at capacity. Failed preparation retains a
  small settlement slot until drained. Cancel/close drop other prepared payloads
  immediately, preserving bounded reply slots and canonical assets. Generation,
  protocol, disposal, monotonic request IDs and readiness follow browser precedence.
  Queued mutations check exact project ID/revision/hash, asset fingerprint and
  history revision before committing. Local guards also bind their authority owner;
  a foreign but equal-looking snapshot cannot authorize host selection or save.
  Save acknowledgement deliberately ignores history-only changes, while requiring
  the captured project/revision/content/assets and a successful host save handoff.
  Serialization and queries never clear dirty state. A wire summary that cannot
  fit after commit yields receiptUnavailable with the actual changed flag.
  Failures still return ordered rollback effects. Hosts must dispatch these before
  delivering the reply; callbacks cannot reenter a core commit. Returned immutable
  receipts/leases survive close and disposal. No full graph crosses a session reply.
  Production worker/JNI integration, bounded renderer/tree projections, archive
  opening, Android runtime qualification, recovery and remaining command families
  remain open.

- Project query captures retain one immutable admitted snapshot, with its revision
  and canonical hash available after session disposal. Private positional addresses
  are meaningful only within that capture; commands still bind stable IDs and
  session guards. Project/plate/object child lists preserve canonical array order,
  except plates sort by order then UTF-16 ID and layer ranges by minimum Z then ID,
  matching the Objects projection. Only these sorted lists allocate an index, after
  checking the caller's sort-entry budget. Other lists retain constant-size ownership.
  Sorting remains synchronous work for an owned projection executor.
  The versioned query schema defines nine entity kinds, eight relations, numeric
  fields and text fields. Numeric pages contain at most 64 rows and fit within
  64 KiB; generated TypeScript/Kotlin validators reject malformed, missing,
  duplicate, unordered, unknown and out-of-domain numeric fields. Mesh-field
  groups are atomic; indices/strides require their parent layout, component counts
  stay in 1–4, and mesh fields require the mesh asset kind. Collection
  indices/counts stay unsigned 32-bit; authored finite numbers preserve their
  binary64 values, including large integer order/topology values. Optional text
  absence differs from an empty string. Unsupported fields/relations refuse;
  bounded text reads preserve surrogate halves and NULs without truncating IDs.
  Reads return owned arrays and never include settings values, paint arrays,
  geometry bytes or a serialized document. Mesh declarations retain authored
  offsets/strides and are not an attestation of GPU-safe geometry. Production
  capabilities, paint summaries, resolved settings, renderer packets and
  subscription/delta dispatch remain separate work.

- Rust settings policy uses a generated projection of the same pinned scope
  extractor as the browser. Project/plate/object/part/height-range precedence and
  eligibility cannot be hand-maintained independently. Strict layer validation
  reports unknown scope names, duplicate node layers and every out-of-scope key
  in caller-layer/canonical-key order. Omitted and empty node IDs have the same
  duplicate identity. Resolution sorts stably by scope, preserving caller order
  among distinct nodes at the same scope. Explanations identify the winner and
  losing layers in reverse precedence. Import sanitization returns kept values
  and removal diagnostics; it never mutates the original map. Authoring uses the
  strict path. Values, including unknown base metadata and own `__proto__` data,
  remain lossless UTF-16 JSON. Native views borrow immutable values; explicit
  mutable exports copy.
  Project configuration selectors verify parent relationships, layer the allowed
  keys, retain imported foreign data in the graph and report ignored keys using
  canonical UTF-16 ordering within each scope. A stored local key that the engine
  ignores must not appear in `local` or remove the actual value from `inherited`,
  even when an ancestor contributes the same key. This projection correction is
  covered in both browser and native reference tests. These APIs establish scope
  policy, not option value/type/range validation, profile compatibility, commands,
  preflight or a native session endpoint. Diagnostic UI text can contain source
  IDs/keys; native Debug/Display output keeps those values redacted.

- `AsyncEditorSession` orders local queries and mutations over the existing
  TypeScript session. It captures project/revision/semantic/asset identity plus
  history revision at submission (or accepts a guard captured before preparation).
  A later request does not silently rebase onto an earlier queued edit. Cancellation,
  source drift, history/checkpoint replacement, another owner, reset and disposal
  reject before mutation; a failure does not poison the queue. A synchronous commit
  still receives an acknowledgement if an observer then cancels or disposes it.
  At most 32 operations may be pending, and transactions capture a list of at most
  64 existing command objects on the legacy local path; prepared batches carry
  up to 64 serializable intents instead of an asynchronous callback. The
  original bus retains atomic rollback, monotonic project revisions, selection,
  coalescing and checkpoints without copying asset payloads. Empty batches do not
  change history revision. Acknowledgements freeze identity/history; queued queries
  return summaries rather than project or mesh copies. This internal facade keeps
  its opaque owner token; the endpoint translates validated wire guards into it.
  Production Undo/Redo and all seven plate lifecycle operations await this facade
  through the generated string transport, workspace and registry. Plate requests capture their guard before
  preparation/ID allocation; exact activation/rename/order/printability no-ops keep
  selection, revision, history and checkpoints. UI success follows acknowledgement,
  while canonical subscriptions own selection/projection updates. Deletion does
  not clear a newer selection after delivery. Objects reveal awaits activation and
  checks its receipt plus the expected selection before selecting/framing a row;
  a superseded reveal leaves newer intent intact. Object/part renames, instance
  printability, single/batch transforms and derived placement operations now
  await the same transport. UI name/transform validation remains in the controller;
  prepared inputs and guards are captured before queueing. Multi-instance
  printability validates every ID up front, preserves a separate undo entry per
  changed instance, chains its own receipts and reports the completed count if a
  later request fails. No receipt is inferred from a later current snapshot.
  DOM/XR transform gestures retain at most one dispatched command and one latest
  immutable full-pose set. Final release awaits the last queued pose. Only an
  actual acknowledgement advances the gesture guard; intervening edits or
  checkpoints stop it without rebasing. A selection lifetime invalidates on each
  real selection change, including away-and-back changes in one task, and sends
  cancellation immediately through the transport. Tool changes and disposal also
  cancel. Already committed poses remain undoable, and lost replies never cause
  retries. The local bridge releases AbortSignal listeners on settlement and
  preserves authoritative replies when cancellation races a commit observer.
  Named editing actions, numeric transforms and DOM/XR scene transforms now
  preserve their results through ActionRegistry. The ordinary boolean invocation
  delegates to the same result-bearing availability boundary. A result carries
  the actual command acknowledgement, never a later query or a fabricated guard;
  denied requests carry the original availability reason. Tool actions with a
  transform payload commit without reactivating the tool or cancelling its own
  gesture. Each dispatched pose rechecks availability on the declared inspector
  or scene surface. DOM lay-on-face commits use the same gateway; no XR scene
  route is declared for that unfinished interaction. Missing action context
  refuses edits rather than falling back to a direct controller mutation. Other
  editing, import, save and slice paths still require migration.
- `contracts/project-intents.json` owns prepared payloads for plate add,
  duplicate, delete, activation, rename, reorder and printability, plus object/
  volume/instance rename, instance printability and single/batch transforms. It generates
  TypeScript, Rust and Kotlin types and conversion checks. Production plate,
  object/part rename, printability and transform routes capture these intents
  before queueing through `AsyncEditorSession`;
  `transactionIntents` captures a bounded list and uses one existing bus transaction.
  Preparation retains injected ID order and allocates no transport nonce from the
  project ID source. The executor validates stable-ID semantics and constructs the
  existing commands; it creates no shadow graph or replacement history model.
  Names and IDs preserve UTF-16 units, including NULs and lone surrogates. Wire
  JSON is ASCII (text uses numeric unit arrays); numeric fields have binary64
  value semantics, including decimal/exponent integer spellings and negative zero.
  The format rejects unknown/duplicate/missing keys, positional objects, invalid
  versions and values outside schema bounds. Limits are 1 MiB, 131,072 value nodes,
  depth 12, 64 batch commands, 36 reordered plates, 160-unit added names and
  120-unit renamed plate names. Object/part/instance names and gesture text use
  the aggregate request budget (at most 131,072 units per field); constructors
  enforce name and gesture semantics. Complete transforms carry exact 3/4/3
  finite binary64 arrays; scale/quaternion validity belongs to graph admission.
  These additive union variants keep version 1; older decoders reject unknown
  commands before execution. No capability is inferred from that version alone.
  Plate order retains the domain’s finite nonnegative integer values, including
  values above the safe-integer range. These are transport limits, not new persisted
  graph limits. Local capture
  rejects getters, custom prototypes, symbols, typed/sparse/extended arrays and
  freezes owned copies before queueing. Per-request text conversion budgets reject
  excessive aggregate UTF-16 allocation during preparation. Batches preserve
  empty/no-op behavior,
  atomic rollback, selection and asset sharing.
- The same schema now generates session request/reply envelopes. Protocol version,
  persisted project schema version and prepared-intent version are negotiated
  separately; the existing computation ABI handshake remains independent. A
  connection has a host-injected 128-bit generation (four unsigned words), distinct
  from project IDs and their injected ID source. A reliable ordered connection
  uses increasing safe-integer request IDs; the endpoint rejects replay/out-of-order
  requests with a high-water mark, without retaining an unbounded response cache.
  Guards carry project/revision/semantic/asset and history identity. The browser
  bridge also checks the original local owner before dropping its Symbol; equal
  project identities from another facade never become a valid owner.
  Requests are captured before waiting for negotiation. Both client and endpoint
  limit pending operations to 32. Cancellation and close use separate control
  messages; a cancellation reply means requested/not pending, while the operation
  reply determines whether it actually committed. Closing invalidates queued work
  but never turns an already committed edit into a cancellation or disposes the
  separately owned assets. Ordered queries report summaries and changed=false.
  Replies carry bounded typed errors without private command diagnostics. History
  display labels keep at most 256 UTF-16 units with explicit present/truncated
  flags; canonical history remains complete. Whole envelopes share the leaf
  byte/node/depth budgets, so framing consumes capacity too. Undo can restore an
  arbitrarily large imported ID after committing: if its reply cannot fit, the
  endpoint returns receiptUnavailable with the known changed value. The client
  retains that completed outcome, and the local adapter raises a distinct
  completed-operation diagnostic. It must never automatically retry that edit.
  A lost, malformed, mismatched or semantically inconsistent reply fails the client
  closed with an unknown outcome. The host must reconcile the authoritative
  session before opening another connection; no retry or recovery-from-optimism
  is implemented. Post-commit replies remain valid after close on their original
  connection; existing UI guard checks prevent their use in a newer workspace.
  Production currently exchanges strings in-process with the TypeScript authority.
  Selection/capability/projection subscriptions remain local. Production worker/JNI
  project integration, crash recovery, remaining command families and complete
  revisioned projection transport remain Phase 1/4 work. Rust/Kotlin codecs alone
  do not execute a native project.
- `EditorSession.open` binds its source project/revision/semantic/asset identity
  and owns a single current open operation. Newer opens supersede older reads,
  even if the newer read fails. Reset, disposal, cancellation and source drift
  reach the serializer through its cancellation token and are checked again
  before staging and commit. A late or invalid read preserves state, immutable
  asset ownership, selection, history and checkpoints. The legacy session slice
  helper also checks cancellation before copying assets and after its adapter
  returns; production slicing still uses the canonical job coordinator.
- `docs/parity.md` is the canonical phased plan/evidence policy. The generated
  `docs/parity/snapmaker-v2.3.4.json` currently maps 1,622 upstream leaves in
  13 families to a task/adaptation using 17 exact Git blobs. Generate/check it
  only with `tools/parity/`; never hand-edit it or derive truth from a dirty
  upstream worktree. A mapped leaf is scope coverage, not implemented parity.
- `web/src/project/` is the UI-independent canonical graph/history boundary;
  domain code must not import DOM, XRBlocks, or Three UI objects. Enforce it
  with `npm --prefix web run architecture:check`. The explicit Three browser
  adapter stays in `project/surfaces`, is direct-imported, and is not exported
  by the headless project index. Transactional import and the per-plate revision/
  asset-guarded slice coordinator remain headless; live legacy state is only a
  migration source, never a second canonical model. Published G-code is bound
  to the exact submitted semantic snapshot; preview/download/send fail closed
  after drift; printer mutations pass the owned session and submission guards. Auto-place wipe tower
  plans Chebyshev clearance across 8 bed candidates and commits `SetPlateWipeTowerCommand`
  to the active plate without undefined properties in canonical JSON. **It reserves the
  tower's printed footprint against the printable rectangle, never its body against a
  bed size.** Two facts make that the whole job: a printable area has an *origin* as well
  as an extent (the U1's is `0.5x1 … 270.5x271`, and `bedSizeFromProfile` returns its far
  corner, which is not a size), and the engine prints well outside `prime_tower_width` —
  `prime_tower_brim_width` on every side, plus, when `wipe_tower_wall_type` is `rib`,
  the diagonals `generate_rib_polygon` unions across the body. Reserving only the body
  against a bed rooted at (0,0) put a 30 mm tower at `wipe_tower_x = 1` and extruded its
  first layer down to x = −8.8 mm, 9.3 mm off the front-left corner.
  `wipeTowerFootprintMarginMm` is an upper bound on that overhang derived from the same
  config keys the engine reads, deliberately not a second copy of `generate_rib_polygon`:
  a bound cannot drift out of step with the engine, and over-reserving only moves the
  tower a few millimetres inboard. `wipe_tower_x/y` still addresses the **body** corner,
  because that is what the engine reads. The ghost draws the tower where the engine will
  actually print it and outlines that footprint — it used to clamp itself onto the bed,
  so an overhanging tower looked seated and the defect only surfaced on the first layer.
  `wipe-tower-outside-build-volume` checks that same footprint: it used to test the
  origin *point*, which is on the bed in exactly the case that goes wrong, so the one
  gate that should have refused the print stayed silent. All three — planner, ghost,
  preflight — read `wipeTowerFootprintMarginMm`, so a placement one accepts is a
  placement the others accept. Mixed recipes use stable physical-head IDs, never virtual rows; live Match uses a bounded worker, while auto-pair generation defaults off and requires count-bound confirmation above four physical filaments. Refined facet selection uses the version-2 subdivided-facet and child-path encoding: source vertices precede float32 shared midpoints, commit applies leaf targets before recursively collapsing homogeneous children, and malformed/deep/shared/duplicate/unordered trees fail closed. Live UI and slicing share exact catalog-backed canonical preflight; ambiguous profile/build/nozzle mappings block, and Three/display defaults are never safety inputs. Preview projections consume rich typed columns and must return explicit unsupported metadata for missing exact filament colors or authoritative layer durations rather than inventing palette/time values. Split-to-objects must capture the exact revision/hash/selection/object scope before confirmation, revalidate it at commit, and leave canonical state untouched on cancel, stale input, unsupported metadata, or topology failure. Calibration requests bind exact definition version/fingerprint plus printer/nozzle/filament/process/firmware prerequisites; vendor automatic execution and any unsafe/stale/unbounded plan fail closed before canonical mutation. G-code inspection derives layer, move, tick, tool, source-window, and focus state from unrenumbered rich record IDs, retains only bounded source text, exposes incomplete prefixes, and never treats headless projection as proof of live controls. Official statistics require a same-export engine sidecar plus an opaque rich-source handle created by streaming SHA-256 over the exact UTF-8 G-code; source/source-asset identities use canonical FNV-1a64, project/config/output/artifact identities use SHA-256, and job/plate/revision/engine bindings also match. Sidecars are exact-key JSON with canonical dense capped arrays and finite bounded arithmetic; `plannerBlockCount` bounds float32 partitions and move subsets, `volumeSampleCount` bounds double material reconciliation, nonempty ordered custom segments cover planner total while a synthetic tail remains conditional, and sparse role-by-tool volumes equal model + support + wipe tower with flush excluded. Rich columns remain observations, missing assumptions propagate unavailable, detected conflicts are non-exhaustive/partial, and all-plate sums group by tool plus profile, expose partial silent coverage, retain a sole known cost unit while affected totals stay unavailable, and never reuse first-plate metadata.
- **The G-code carries a picture of what it prints, and the browser is the only
  thing that can draw it.** `GCode.cpp` writes a thumbnail only when it is handed a
  `ThumbnailsGeneratorCallback`, and that callback is the *GUI* rendering the plate
  offscreen — `libslic3r` has geometry, not a view. The WASM build has no GUI, so the
  callback was null, the branch never ran, and every file reached the machine wearing
  the firmware's stock image. `slicer/GcodeThumbnails.ts` is the engine's own writer
  ported exactly (`THUMBNAIL_BLOCK_START`, `; thumbnail begin WxH <base64 length>`,
  78-character rows, `thumbnail`/`thumbnail_JPG` tags, and the position after
  `HEADER_BLOCK_END`), because a printer parses this by pattern and a near-miss shows
  nothing at all — which is indistinguishable from the bug. `workspace/PlateThumbnailRenderer.ts`
  is the other half: it clones the display meshes into a throwaway scene rather than
  toggling `visible`/`layers` on live ones, so a throw cannot leave the workspace in a
  wrong state, and it turns `renderer.xr.enabled` off around the render because
  `WebGLRenderer.render` otherwise substitutes the XR camera for the one it was given.
  The blocks are attached at `CanonicalSlicerClientRoute`, *before* the coordinator
  hashes the artifact, so download, preview and send all carry the same bytes. Sizes
  come from the printer's own `thumbnails` value (U1 `48x48/PNG, 300x300/PNG`, Centauri
  `144x144`) — never a fixed size, and a format a canvas cannot produce is reported
  rather than emitted under another format's tag. Thumbnailing is best-effort by
  design: a lost WebGL context must not turn a finished slice into a failed one.
  Note the bed is deliberately *not* drawn, unlike upstream's `show_bed: true` — this
  app has two beds, and a thumbnail that depends on which shell you sliced from cannot
  be compared with itself.
- **The app's own deployment is not a secure context, and nothing may assume it is.**
  The all-in-one server publishes the UI over plain HTTP on a LAN address
  (`http://192.168.1.90:3000`); only `localhost` is special-cased into secure-context
  treatment, so every machine *except* the host running the container gets an insecure
  origin. Every secure-context-only web API is therefore absent there, and the two that
  were reached for unguarded both failed on the first real LAN slice:
  `crypto.subtle` (a hard "Web Crypto SHA-256 is unavailable" before the slice began)
  and `crypto.randomUUID` (called while the printer directory loads at startup).
  Both now degrade: `slicing/hash.ts` falls back to the repo's own `sha256Bytes` —
  these are **content identities, not secrets**, and it returns byte-identical digests,
  so an artifact keeps one identity across origins — and `randomPrinterId` builds a v4
  UUID from `getRandomValues`, which carries no such restriction. Before adding any
  `crypto.*`, `navigator.clipboard`, `navigator.serviceWorker`, `mediaDevices`, or
  `SharedArrayBuffer`/`crossOriginIsolated` use, assume the page is **not** secure and
  degrade explicitly; `localhost` testing will never show you the failure.
- **An HTTPS page cannot reach a plain-HTTP machine on the operator's LAN, and the app
  must say so rather than report it as silence.** The published build is served over
  HTTPS (`orcaxr.martinez.fyi`), so `http://192.168.1.228` and `http://192.168.1.90:3000`
  are refused as mixed content *before a request leaves* — and the browser reports that
  as `TypeError: Failed to fetch`, which is exactly what it reports for a printer that
  is switched off. Chrome relaxes this for a LAN address once Local Network Access is
  granted (the prompt is raised by the request; `navigator.permissions.query({name:
  'local-network'})` only *reads* the state), and `targetAddressSpace` is needed only
  for a named host whose address space the browser cannot know before resolving — an IP
  literal is already classified, which is why `localNetworkTargetForRequest` returns
  `null` for one. `net/LocalNetworkAccess.ts` owns the diagnosis and every LAN caller
  reports through it: the status line gets one sentence and a modal gets the three moves
  that actually work. **The best of those is to open the app from the operator's own
  all-in-one server** — it publishes the web UI beside the slicer, so page, slicer and
  printer are all plain HTTP with nothing cross-origin — so when a server is configured
  the diagnosis names it and links to it. Never answer this failure with "check the
  address": the address is fine, and a retry cannot succeed.
- The live G-code viewer renders the bounded rich model plus the preview
  projection: the UI-free session owns mode, bounded record/layer windows, and
  move-class filters; the browser owns its parser worker and cached projections, and `ui/preview/GcodePreviewSurface` draws exactly the
  projected records with the projection's RGBA, shown as authored: the
  projection's colours are sRGB and three's vertex colours are linear, so each
  is converted to three's working space (copied raw, every toolpath showed
  lighter). Never colour or filter a
  toolpath in the renderer, and never fabricate metadata the projection reports
  as unsupported. Standalone G-code opens read-only and must not touch canonical
  project state. A pinned XY `G2`/`G3` command remains one semantic/source record:
  direction, center, and a dense bounded Float32 interpolation slice are sidecar
  data, and render/inspection consumers expand that slice without renumbering the
  record or distributing semantic metadata. Preserve the upstream Float32
  assignment order—word parsing, P's distinct full-circle length, modal Z/height,
  width, volume, flow, and interpolation floor all have observable boundary
  behavior. Parser record/path/numeric caps publish no partial arc; the lower
  renderer cap fails back to model view with retained narrowing controls. Any
  nonzero arc E stays an extrusion as upstream classifies it, but negative-E
  width uses an explicit finite web fallback instead of propagating upstream NaN.
- Colour painting is canonical end to end: `web/src/project/painting/` owns the
  stable-ID palette projection and a UI-independent `PaintStrokeService`; live
  surfaces stream pointer samples, preview with a derived overlay, and commit one
  labelled undoable command on release. A facet stores the stable physical or
  mixed filament ID, never a palette index or predicted RGB, and the legacy
  display-colour paint panel/brush state is deleted. The `1`-`9` palette keys are
  nine discrete registry actions, matching upstream. The same tool set authors
  support (enforce/block), seam (prefer/avoid), and fuzzy-skin facets - the
  active modal tool owns the channel, so `PAINT_TOOL_CHANNELS` is the only
  channel authority - and the XR rail draws every declared `xr-toolbar` action in
  `XR_RAIL_GROUPS` order, with labels and an overflow group for new actions. Refined state persists as the bounded version-2
  subdivided-facet/child-path tree and uses the pinned uppercase BBS nibble codec for
  `paint_color`, `paint_supports`, `paint_seam`, and `paint_fuzzy_skin` (plus the
  legacy `paint_fuzzy` reader alias). Color projection may use only material
  states `1..64`, even though the wire codec represents `1..255`; an unsupported
  child omits its whole refined source root from the standard projection with a
  warning while the canonical envelope remains lossless. BBS has no brim facet
  attribute, and official-Orca colour round-trip remains unproven.
  Native BBS text primitives now stream UTF-16 XML values under aggregate text and
  output budgets. Illegal XML controls, unpaired surrogates and U+FFFE/U+FFFF
  refuse the provisional stream. Any error prevents successful finalization;
  cancellation covers interrupted writes, and host flush/publication remains
  separate. Numeric projection preserves compact float32 mesh coordinates and
  full double precision for transforms, including 3MF's distinct matrix order.
  The native core-model writer now combines admitted state and captured mesh
  leases with material slots, sparse paint, plate origins and preserved XML
  attributes. It verifies supplied full asset descriptors and distinguishes
  missing/malformed geometry omissions from fatal resource/cancellation failures.
  Disabled physical materials retain slots; only enabled mixed materials receive
  slots. An unsupported refined color leaf omits its entire standard root.
  Regular attribute duplicates refuse output; repeated facet attributes retain
  the last value after validating every applicable value. Namespace prefixes and
  attributes use UTF-16 ordering. The prepared model also anchors native model
  settings, layer ranges/events, brim ears and layer-height profile writers.
  Model settings use resource IDs; ranges, brim ears and profiles use one-based
  object ordinals even for omitted meshes. Plate membership uses stable sorted
  plate order and all instances, with independent instance printability.
  Configuration streams in UTF-16 key order without cloning payloads; range
  filament slots replace its configured extruder, while object/part metadata
  retains the browser's separate declared-slot and configuration rows. Emboss
  attributes encode newlines, preserve absent optionals and reject illegal XML
  in both implementations. Six-decimal text matches ECMAScript rounding rather
  than binary multiplication followed by Rust formatting. SVG gathering follows
  original plate order; shared paths require identical bytes and cannot replace
  structural members. Missing drawings omit references with typed warnings even
  if another part supplies that path. Distinct IDs with equal bytes may share a
  drawing. Borrowed leases remain provisional until full package finalization.
  Project settings borrow that same model's physical/mixed slots and sorted
  plates. Correct-length imported filament vectors take precedence over local
  values; other known vector fields preserve undefined/null fallback semantics.
  Reset scripts follow ECMAScript multiline syntax and are appended only in the
  engine projection. FullSpectrum rows derive slots from the current physical
  order and retain unsigned 64-bit IDs exactly. Manual groups choose the engine
  pair independently of UI mode and weight each group equally when deriving the
  B percentage. Ordinary mixed weights scale only when their original arithmetic
  overflows; canonical weights remain unchanged. JSON preserves lone surrogates
  and controls through escaping, independently of XML character restrictions.
  Complete package assembly now validates exact captured asset membership and
  descriptors, selects deterministic asset paths, streams the canonical envelope,
  and reconciles generated/preserved members without buffering complete metadata.
  Only the four explicitly preservable BBS metadata members may override generated
  bytes under the preserved-original marker. Equal collisions keep the generated
  member; other collisions refuse. OPC stages use the browser's exact inventory
  at each step. Typed package warnings cover all scopes, including missing or
  disabled filament references, hooks, extensions and dropped relationships.
  Standalone model diagnostics are collapsed into package-level filament warnings.
  Warning text ordering/deduplication belongs to the host presentation adapter;
  native Debug/Display remains redacted. Native save handoff/bindings remain open.
- Measurement is a read-only port of the pinned `Measure.cpp`, and its plane
  clustering is easy to get wrong: a neighbour facet is *queued* but only
  *claimed* when it is popped and its normal still matches the seed. Claiming at
  push time swallows the whole mesh into one plane (a cube reports 1 instead of
  6). Circle fitting deliberately replaces upstream's default-seeded
  `circle_ransac` with a deterministic algebraic fit — `std::sample` ordering is
  implementation-defined, so exact replication is impossible — while keeping the
  pinned error metric and `0.05` threshold. Circle-to-circle across non-parallel
  planes needs upstream's degree-8 solver and is reported unsupported, never
  approximated. A non-uniformly scaled circle is an ellipse and has no radius to
  report.
- Model import (STL/OBJ/AMF/compressed AMF/ZIP) is signature-first and transactional:
  `web/src/project/import/formats/` decides the container from content, refuses a
  recognised extension that disagrees with the signature, and returns typed
  `requires-project-import`/`requires-native-kernel`/`requires-emboss-workflow`/
  `not-a-model-format` reasons for 3MF/STEP/SVG/G-code instead of re-parsing the
  bytes. `ModelImportParser` stages decoded objects/parts/instances through the
  same `ProjectImportCoordinator` as Open Project, so every add is previewed,
  deduplicated, undoable in one command, and leaves canonical state untouched on
  failure or cancel. Never add a second direct scene-insert import path.
- The shared Rust archive reader now indexes ZIP/ZIP64 under explicit archive,
  member-count, per-member/aggregate expansion, ratio and path limits. Hosts own
  immutable staged input; document providers need not support seek. Paths are
  package names, never filesystem extraction destinations. Member reads verify
  exact expanded length and CRC through bounded buffers; output remains private
  until success, since an integrity failure may follow partial output. Cancellation
  is cooperative around reads, decompression and writes; hosts supply I/O deadlines.
  Browser and Rust now reject inconsistent classic/ZIP64 counts, invalid ZIP64
  record extents and nonzero disk fields. Canonical-envelope staging now builds on
  that reader: explicit JSON/asset budgets, one leading UTF-8 BOM, last-key-wins
  JSON and unsafe-key rejection precede typed graph admission. Dense facet roots
  replace their sparse projections; legacy false fuzzy assignments are validated
  as enabled before removal so invalid triangles/references cannot disappear.
  Exact asset mappings, structural-path exclusion, lengths/FNV digests and declared
  blob equality are checked before returning the owning intermediate. Unsupported
  digest schemes retain source ordinals for warnings; CRC/length checks still run.
  Every other member is integrity-checked and retained in the immutable archive.
  A consuming OPC step now merges preserved relationships/content types and
  revalidates the candidate without changing live authority. It retains unknown
  members and original asset identities. Canonical completion consumes the
  intermediate, regenerates every BBS output and compares the four preservable
  metadata members exactly. A bounded ZIP pull reader verifies unread tails after
  mismatches; it never substitutes digest equality or a full metadata buffer.
  Missing printable area permits preservation only after drawing path/collision
  checks. Browser envelope admission also enforces required SVG recipe field
  shapes, matching native schema decoding even when regeneration is postponed.
  Unknown files are adopted in UTF-16 path order using the compressed archive's
  FNV seed, shared media policy, exact bytes and standard plate PNG recognition.
  Completed bundles re-admit the graph and enter existing guarded prepared-document
  Open/reset; foreign BBS parsing, host archive bindings and provider/UI flows
  remain separate. Three bounded OPC writers preserve deterministic
  XML bytes and refuse invalid XML text, duplicate relationship IDs and conflicting
  required types. Root relationships require both canonical and model members.
  Members whose suffix cannot name a valid default content type receive a
  per-part override. Import recognizes inferred declarations without adding user
  metadata; explicit declarations, canonical identity and unknown bytes survive
  repeated Open/Save.
  Internal targets use one validated resolver on read and write, preserving query
  and fragment links to present members. OPC casing is pinned to Unicode 16
  independently of browser, Android or Rust Unicode upgrades; member names are
  unchanged. The compatibility scanner matches the existing tag-extraction rules,
  including legacy comment/prefix behavior; it is not a general XML or BBS parser.
  The separate BBS facet codec accepts nonempty uppercase hex under explicit byte
  limits, at most 64 split levels and one million nodes per root. One mutable node
  budget spans explicit roots/channels; failed decoding does not refund work.
  Missing attributes consume no nodes. Wire state zero is unpainted; callbacks
  map states 1–255 to canonical values and enforce channel/slot policy, including
  the BBS color limit of 64. Brim has no BBS facet attribute. Encoding borrows
  computation or persisted JSON trees without cloning their paint values, uses
  bounded provisional writes and checks cancellation between short/interrupted
  writes. A bounded streaming model-XML scanner validates UTF-8, XML
  characters/entities, namespaces and tag structure while emitting provisional
  events; callers must discard them unless finish succeeds. Its one-part structural
  reader covers basic 3MF units, mesh geometry, materials, build items and component
  references. A bounded cross-part resolver validates Production paths, part-local
  references and component cycles, then expands build roots under depth and work
  budgets. The structural ZIP staging API streams the root and referenced parts
  under shared geometry, title, encoded-facet, refinement-node and annotation-
  materialization budgets and invokes that resolver. The part projection decodes
  BBS color, support, seam and fuzzy-skin roots into sparse canonical channels;
  color slots remain import placeholders pending model metadata. It also retains
  bounded unknown object/component/build/facet attributes and keeps component-edge
  identity through graph expansion. BBS settings, metadata-driven filament
  resolution, canonical extensionData assembly and admitted foreign import remain open.
  Graph admission/hash and digest finalization belong on an owned preparation
  task; cancellation checkpoints do not forcibly interrupt those synchronous calls.
  Native ZIP authoring streams one member at a time into an empty private seekable
  destination. It fixes time, permissions, UTF-8 paths and UTF-16 member order;
  producer chunk boundaries and flush calls cannot change output. Classic/ZIP64
  headers are patched only within staging, with aggregate/entry/output/index caps.
  The host owns provider copy, flush/durability, publication and save acknowledgement.
  Failure or cancellation invalidates all output; Drop never writes. Highly
  compressible DEFLATE output receives empty stored blocks to remain readable
  under the same compression-ratio cap, without replaying/copying source payloads.
  Container determinism does not require compressed-byte identity with fflate;
  member names, expanded bytes and metadata must agree independently. Package
  output accepts a frozen ExportCapture and cannot consult or acknowledge live
  state. A streamed envelope enforces mapping, state-node/depth/output and unsafe-key
  policies without allocating a second state graph or whole JSON output. The host
  still owns operation deadlines and private provider staging; partial output is
  never a successful save. Foreign archive import and application adoption remain separate work.
  ZIP names preserve literal leading U+FEFF in both readers. Browser expansion
  uses verified member offsets rather than a filename-keyed decoder dictionary.
  A one-byte sentinel detects fflate truncation to dishonest declared lengths;
  the output allocation stays bounded before expansion. Sorted local extents
  reject overlap before payload decoding without quadratic pairwise searches.
  Browser ZIP authoring preserves a literal `__proto__` member by temporarily
  aliasing it through fflate's dictionaries and restoring only the equal-length
  header names. Aliases cannot collide with declared members. Compression, CRCs,
  offsets and ordinary archive bytes stay unchanged; unknown members must survive
  canonical Open/Save with their exact original names and payloads.
- Smart Paint is a proposal, never a painter. An assistant returns a bounded
  version-1 proposal of normalized-AABB boxes and normal-direction cones;
  `project/painting/aiPaintProposal.ts` projects it against the volume's own
  mesh into exact source triangles (later regions overwrite earlier ones), and
  `AiPaintSession` commits the operator-corrected mask through the same
  `PaintStrokeService` as a manual stroke, as one labelled transaction. Never
  accept a free-form polygon (it would need a camera the proposal never
  declared), never trust a provider-supplied region ID, and never let a
  provider payload reach canonical state without passing the strict parser.
  Consent is checked per payload kind and per provider *before* the request:
  geometry consent sends only a facet count and bounding-box extent, never
  vertices, names, or IDs. Cancel, provider failure, malformed output, and a
  revision/topology change between preview and apply must all leave the project
  byte-identical.
- `ActionRegistry` is constructed once at the composition root and is the only
  invocation/availability gateway for DOM, menus, shortcuts, command palette,
  XR, and contextual Objects selection/rename/reveal. `implemented` requires a real
  handler/evidence mapping; all other states remain visibly and machine-readably honest. A
  handler that completes through a DOM-only dialog must declare an exact XR exclusion reason and
  stay out of the XR surface until an in-headset flow exists; never advertise a spatial control that
  leaves the headset flow stranded. Generate shortcut matching and Help rows from registry
  declarations through the strict conflict-rejecting catalog; do not add a second hand-maintained
  shortcut list.
- **The flat shell is dressed as the official Snapmaker Orca application**, and
  its layout is that application's: a menu strip (File · Edit · View · Add ·
  Tools · Calibration · Help, one dropdown each, plus save/undo/redo), a tab
  strip (⌂ · Prepare · Preview · Device · Project, with `Slice plate` and
  `Print` at the inline end), a **parameter sidebar docked to the inline
  START** (Preview — hidden outside the Preview view and therefore first —
  then Printer / Filament / Color Mixing / Process / Objects / object tools, as
  fold-away cards), and the 3D viewport with the model tools floating over its
  top edge. On a phone the sidebar is a bottom sheet that starts folded and is
  unfolded by `#sidebar-handle`; the shell's grid column is capped at
  `minmax(0, 1fr)` because the tab strip's intrinsic width would otherwise size
  the whole shell past a narrow window. The viewport is a transparent hole so pointer
  input reaches the renderer, and the page — not the renderer — paints the wash
  the plate is seen against (`--oxr-grad-viewport`).
  `ui/tokens.ts` is the only source of colour, radius, shadow, type and motion;
  it emits both the published design-system spelling (`--oxr-surface`,
  `--radius-lg`, `--font-sans`, `--shadow-menu`) and the legacy
  `--oxr-<group>-<key>` form from one table. It now carries **two DOM themes**
  (`domThemes.light` is the default and what the app boots in; `dark` is an
  explicit choice, remembered, never negotiated from the OS) while `tokens.color`
  stays the XR palette — the headset floats over passthrough and keeps the dark,
  amber identity. `injectTokenCss()` emits light on `:root` and only the delta
  under `:root[data-theme='dark']`, so a theme switch is one attribute. Never
  hard-code a hex in the stylesheet or in a panel's inline style, and never add a
  remote font or stylesheet — the CSP and the offline gate both forbid it, so
  type stacks name the design family first and fall back to platform faces.
  Icons are the **same vendored Material SVGs in both shells**: the DOM masks
  them (`applyIcon`, `hydrateIcons`, `[data-icon]` in markup) so a glyph takes
  `currentColor`. `domIcon`'s unicode glyphs are a string-only fallback; an
  element that renders an icon uses the mask.
  `DomShell` renders the menu bar, the quick actions, the floating model
  toolbar, the two print buttons, the sidebar footer's primary bar, and the
  Project page's calibration grid; every one invokes a registry action on a
  declared surface, so `Slice plate` is presentation and never a second slice
  path. `WorkspaceViews` owns the four workspace tabs: Prepare and Preview share
  the sidebar and differ in mode (entering Preview runs the same
  `toggle_preview` action), while Device and Project are **full pages over the
  viewport** that leave the mode alone. A folded card and a hidden page both
  have no layout, so any test or automation that clicks inside one must select
  its view and unfold its card first (`showInspectorTab` in `e2e-smoke.mjs` does
  exactly that). The Project page carries `ProjectSummaryPanel` — plate/model
  counts, the canonical dirty flag, and the recent-projects store — and routes
  Open and Save through the registry, which is why `file_open_project` and
  `file_save_project` are in `INSPECTOR_MIRRORED`. `UiState.mode` follows `workspace.onPreviewStateChanged`,
  because the workspace opens the toolpath preview by itself after a slice;
  without that the tab strip would read "Prepare" over a visible toolpath.
  `PreviewScrubber` is a second view of the *same* `GcodePreviewPanelAdapter`
  the sidebar uses and renders nothing the projection did not supply.
  `main.ts` keeps the camera's `setViewOffset` in step with the viewport rect so
  the plate is centred in the visible area, and clears it whenever an XR session
  is presenting. Three more things are surface-dependent and are all switched in
  one place (`syncViewportChrome`): the camera's field of view (45° in a window,
  the runtime's own in a session — 90° through a monitor leaves the plate the
  size of a stamp), the reticle (an XR aiming cue, hidden behind a mouse), and
  `OrcaWorkspace.setPlateAppearance` — the plate is a grabbable object with
  rings and a bar in the headset, and a plain light bed with a quiet grid in the
  window.
- **The immersive shell is the flat shell, in the same words.** `ui/xr/` draws
  the same menu bar (the seven `MENU_SECTIONS` plus `XR_PANELS_SECTION_ID`,
  which finally has a home), the same four workspace tabs with their live
  sub-lines, the same tool rail, and the same panels — nothing is renamed for
  the headset and nothing is left behind. `XrLayout` is the arrangement, as
  angles from the head; `XrImmersiveShell` owns *what is on* every surface and
  talks to the workspace through one `XrShellHost`, so the whole shell is built,
  pressed and asserted in `__tests__/` with no headset, no canvas and no WebXR
  session. `OrcaWorkspace` keeps only cards, poses and the scene. Four rules
  are load-bearing:
  **`XR_PIXEL_SIZE` is exactly one millimetre**, so a card's metres and its
  layout pixels are the same number — the 58 px hit target *is* the 58 mm
  hand-tracking floor, and the 880 px menu bar *is* 0.88 m of headset.
  **A surface declares `layer` (behaviour) and `presence`/`modes`
  (coexistence) separately**: the geometry tests read the second to decide which
  pairs may not crowd, so a sheet the operator opened may cover the inspector it
  came from while the always-up cockpit may not. **A withheld action states its
  reason in the row**, never behind a hover a headset cannot perform.
  **A recentre moves everything except what the operator pinned** (`XR_PINNABLE`);
  that is the whole contract that makes a grabbable panel safe, and it is why a
  grabbable card is placed as it *arrives* rather than on every redraw — the
  scrubber used to snap out of the operator's hands mid-scrub.
  The shell is reached through exactly one dynamic `import('../ui/xr/immersive')`,
  taken when a session starts (or `?xrui=1`): a phone that never enters XR should
  not fetch and parse a spatial UI, and that one seam is what keeps ~66 KB out of
  the main chunk. Add a runtime XR dependency to `immersive.ts`, never to
  `OrcaWorkspace`'s static imports, or the chunk collapses back into the entry.
- Generated settings schema v2 treats the exact pinned `Tab.cpp` inventory as
  layout authority: 21 tabs, 93 groups, and 424 literal placements are fixed
  counts, and every placement retains its full definition-owner binding set.
  Dynamic placements, custom widgets, and general scope eligibility remain
  explicit fail-closed gaps; imperative dependency predicates and per-control
  reset rules are explicitly unresolved and unenforced, never described as
  blocked. The live generated panel owns only the canonical project/Process override seam (plus the narrow
  source-pinned FullSpectrum project overlay); it must revalidate that scope at
  both draft and commit and never enable Filament, Printer, Object, or Plate-only
  controls merely because their keys exist in `PrintConfig`. Both production
  workers cache the content-hashed schema NetworkFirst after one successful load;
  a schema contract bump requires a static shell-cache bump and an offline smoke.
- CI and clean clones have no `third_party/SnapmakerOrca`, so every gate that
  derives from the pinned engine must degrade honestly instead of crashing:
  `profiles:verify` falls back to byte-exact SHA-256 verification of
  `web/scripts/profile-overlays.lock.json` (mirrors and adaptations both carry
  hashes), and `calibration:verify` falls back to integrity-checking the
  committed inventory's schema, pinned commit, and per-source blob hashes. Both
  print that upstream re-derivation was skipped; `--write`/sync still requires
  the checkout. Never make a gate silently pass when the checkout is missing.
  **The same rule binds tests, not just the generator gates.** Three calibration
  traces once hard-threw on the missing tree and so failed every CI run; the fix
  is not to skip them but to give them a committed artifact to check against.
  The calibration inventory therefore records each workflow's documentation
  target with its blob at the pinned commit (`documentation[]`), and `docs.ts`
  reads that instead of keeping a second hand-maintained table — a Git blob id
  can only have come from resolving the path in that tree, so the link check
  stays real without the clone. Shipped resources are held to upstream the same
  way: the bytes are hashed to a Git blob id and compared to the recorded one.
  Where the clone *is* present, read blobs at the pinned commit
  (`git rev-parse <commit>:<path>`, `git show <commit>:<path>`), never off the
  worktree — a checkout left on another branch must not be able to make a
  provenance check pass. Traces that could not reach upstream say so on the
  result line rather than printing a bare tick.
- **Wave overhangs are a port of dennisklappe/OrcaSlicer-WaveOverhangs v0.4.0 (`f6a901d5`),
  in the WASM engine only.** One generator (Andersons wavefront propagation; upstream deleted
  Kaiser LaSO and `wave_overhang_algorithm` in v0.4.0), 38 `PrintRegionConfig` keys, floor
  layers that *replace* bottom shells over the wave shadow. The port deliberately differs from
  upstream in five ways, each pinned by `wasm/test_slice_wave_overhang.mjs` (`npm --prefix wasm
  run test:wave`, in CI) and listed in `wasm/patches/README-snapmaker.md`: fill carve / wall clip
  / support masks claim only the overhang components the waves *filled* (upstream claimed the
  whole zone and erased bridges it left alone); fan and nozzle-temperature overrides are scoped
  to a run of wave paths and restore the *active* tool's temperature (upstream toggled them
  around every line and restored filament 1); `apply_extra_perimeters` is told which `loops`
  entry is the island's (upstream's `.back()` trapped wasm32 on wall-less islands); tree
  supports subtract wave coverage instead of clearing every overhang; the BUILD line names
  `v0.4.0`. With waves off the G-code must stay byte-identical to the pre-wave engine apart from
  the 38 CONFIG_BLOCK keys. The keys are absent from the generated settings schema (it is built
  from pinned upstream), so `web/src/settings/waveOverhangs.ts` is their only description:
  engine defaults and bounds (the WASM test and a settings test check them against the engine),
  upstream page order and gating, labels, guidance, and which keys are inert (`min_angle`,
  `seam_mode`, `spacing_mode` — nothing reads them). The flat card (`ui/dom/WaveOverhangsPanel`)
  and the headset panel (`ui/xr/XrWaveOverhangsPanel`) both draw from it and commit through one
  `WaveOverhangsPort` (`settings_apply_project`); never show a number the engine will not use.
  `SAFE_KEYS` must list exactly the table's keys. The native CLI server has no wave port, so
  `PINNED_ENGINE_PROVENANCE.features` says so, attested routes carry the proven engine kind,
  and `resolveCanonicalSliceRoute` refuses a CLI route for a project whose resolved
  project → plate → object → part/range chain turns waves on. That check lives in the
  text-free `settings/waveOverhangsProject.ts`: main-bundle code importing `waveOverhangs.ts`
  drags every label and tooltip into the main chunk and fails `size:check`.
- **Localization has one seam, and canonical code may not touch it (P10.4).** User-facing text
  resolves through `src/l10n/`, and it is attached to the *action registry*
  (`ActionRegistry.useTextSource`), not to a shell: every surface already reads
  labels through `all()`/`get()`, so DOM, XR, the command palette, and context
  menus switch language at the same instant. A shell that localized on its own
  would translate half the app, which reads as a broken translation rather than
  an absent one. With no text source the registry returns its declared objects
  unchanged, so headless tests pay nothing.
  Message ids for actions are **derived** (`action.<id>.{label,hint,reason,xrUnsupported}`) and
  extracted by reading the registry itself — never hand-listed, so an action's
  label cannot escape the catalogue. Everything else uses `t('dotted.id', 'English source')`
  with **both arguments string literals**; `scripts/generate-messages.mjs` walks the
  TypeScript AST and fails on anything computed. Run `l10n:sync` after touching an
  action's text and commit the regenerated `src/l10n/generated/` and `public/l10n/`;
  `l10n:verify` runs in `quality` and degrades honestly without the pinned checkout.
  **Never compile a reference catalogue into the bundle.** The English is already at every
  call site as `t`'s `source` argument, so `public/l10n/en.json` is a *second* copy — it
  ships as a fetched file and only the pseudo-locales pull it. Doing this the other way
  cost 83 KB of main chunk and broke `size:check`; done right the whole feature costs 17 KB.
- **Two gates keep a translated layout honest (P10.4.4), and both are in `quality`.**
  `direction:check` refuses physical direction in CSS — `margin-left`, `text-align: left`,
  `border-right`, a physical `left:`/`right:` inset — in the `index.html` stylesheet and in
  every inline style set from TypeScript. Write the logical property
  (`margin-inline-start`, `text-align: start`, `border-inline-end`, `inset-inline-start`).
  `left: 50%` is allowed and must **stay** physical: fifty percent is the same distance from
  either edge, and converting the `translateX(-50%)` centring idiom to `inset-inline-start`
  actively breaks RTL. A genuinely physical position declares itself with a
  `direction:physical` comment and its reason — a context menu opens at the pointer's
  viewport coordinate in any writing direction.
  `test:pseudo` renders the built app in `en-XA` (40% longer) and `ar-XB` (mirrored) and
  measures 152 critical controls for geometric overflow; it refuses to run against fewer
  than forty, because a green "none clipped" over an empty selector list is worse than no
  gate. **Size chrome to its content, never to the English word in it** — the tool rail was
  a fixed 158 px and truncated eight labels the first time this ran.
  Note that `DomShell.mount` is re-entrant *because* a language change remounts it; it
  appends to the primary bar (the hidden file input lives there) and tracks what it added,
  so anything else that appends to a host it does not own must do the same or a language
  switch will duplicate it.
  Translations are **seeded from upstream's twenty pinned `.po` catalogues** by exact
  English match (plus accelerator/ellipsis normalisation) — never machine-translated, and
  a translation that drops a placeholder is refused rather than shipped, because a
  sentence that lost `{count}` renders "objects will be deleted" with no number in it.
  Plural category comes from `Intl.PluralRules`; never write a `count === 1` rule, which
  is wrong in Russian and Polish in a way an English reviewer cannot see.
  **`src/project/` may not import `src/l10n/`**, and `architecture:check` enforces it as an
  import rule so it cannot be satisfied by re-exporting. Everything in `l10n` is
  locale-dependent by construction and everything under `project/` decides the bytes of a
  saved file; canonical ordering already used `localeCompare` in eleven files once, which
  made a project's bytes depend on the machine that produced them.
- The browser engine must link with `-sDYNAMIC_EXECUTION=0`: embind otherwise
  builds its invokers with `new Function`, which the app's CSP (`script-src
  'self' 'wasm-unsafe-eval'`) refuses, so every in-browser slice fails while
  Node keeps working. Relinking also picks up whatever is in the fork worktree,
  so revert unrelated engine edits before rebuilding.
- An imported project slices as authored: its embedded printer/filament
  configuration is the preflight authority (`source: 'authored-project'`), so
  catalog preset identity is not required — but every safety fact must still be
  declared exactly by that configuration. Import must therefore keep per-tool
  `filament_type` and temperature ranges instead of collapsing them to
  "Unknown".
- Canonical slice preflight refuses every silent engine repair, and it never
  duplicates a canonical validation error — `runCanonicalSlicePreflight` short-
  circuits on those and reports them as `invalid-project-state`, so a new check
  belongs there only when `validateProjectState` cannot already see it. The
  FullSpectrum capability authority is the resolved target's own
  `physicalToolCount`, never the fact that the authoring UI allowed a virtual
  row: `SlicePreflightConstraints.printer` is optional, and an absent
  declaration leaves capability unevaluated instead of assumed. The repairs
  that must stay blocked are the extruder clamp in
  `region_config_from_model_volume`, the `[0.01, 0.99]` gradient clamp and the
  duplicate/out-of-range drops in `decode_gradient_component_ids`,
  `MAXIMUM_FILAMENT_NUMBER` (64), the pinned material compatibility matrix, and
  the `Print::validate()` prime-tower preconditions (relative E required, ooze
  prevention incompatible with single-extruder multi-material, mismatched
  nozzle/filament diameters a warning and not a stop).
- **A consumed 3MF metadata entry must not also be preserved as an opaque blob.**
  On import, `Metadata/model_settings.config` and `Metadata/project_settings.config`
  are parsed into canonical state, so the canonical writer owns them from then
  on. Preserving the originals too puts them back over the generated files on
  save: every canonical edit is silently discarded, and `model_settings.config`
  reinstates object ids the regenerated core no longer has, so the engine
  rejects the whole archive with "can not find object for assemble item". The
  rule is exact — exclude a consumed path from preservation **only when the
  writer regenerates it for that state**; a consumed path the writer does not
  emit is still the only carrier of that data and must stay preserved.
- The pinned `Print::validate()` refuses relative extruder addressing on a
  Marlin flavour unless `before_layer_change_gcode` or `layer_change_gcode`
  resets the extruder, and `use_relative_e_distances` defaults to **true**. A
  project imported without any machine G-code (a Bambu 3MF, whose machine
  settings live in a preset we never receive) therefore fails to slice with a
  raw engine message, so the writer supplies the `G92 E0` the engine itself
  names and warns that it did.
- Canonical work may leave the browser only for an **attested** engine. The
  server's `GET /engine` hashes the artifacts it will actually load and reports
  the pinned commit; the client compares both against
  `slicer/pinnedEngineProvenance.ts`, a hand-kept literal that `security:check`
  and Docker assembly hold to `wasm/artifact-provenance.json`. The proof also
  names the engine kind, which decides the features a route has
  (`PINNED_ENGINE_PROVENANCE.features`). Both engines can prove themselves, and they
  prove different things: a WASM server must match the exact artifact digests
  the client verified for itself, while the native CLI has no WASM artifacts to
  compare and instead proves its upstream commit plus the exact
  `server/patches/` set by name and digest (`PINNED_ENGINE_PROVENANCE.cliPatches`
  ↔ the image's `engine-provenance.json`). Requiring WASM digests of a native
  binary is what once made the CLI route refuse itself. `server/wasm-dist` is a
  gitignored local publish listed under `optionalPublishedCopies`; the committed
  copies are `wasm/dist` and `web/public/slicer`, and letting any of them drift
  is what makes an external route silently unverifiable.
- **`slice_worker.mjs`'s `resolveWasmDir()` is the sole WASM directory
  authority**, and `GET /engine` must hash what that resolver returns. They were
  once separate — the attestation looked only in `<server>/wasm-dist` while the
  worker loaded `<server>/wasm/dist` or `<repo>/wasm/dist` — so the container
  (whose Dockerfile populated `/app/wasm/dist`) executed a real engine while
  reporting `attested: false`, and the client refused a route that was in fact
  sound. Attesting a directory you do not load is the same defect in the other
  direction, and is worse. An explicit `ORCAXR_WASM_DIR` is authoritative and
  never falls back. Otherwise the resolver prefers `<server>/wasm-artifacts/current`,
  then `<server>/wasm-dist`, `<server>/wasm/dist`, and `<repo>/wasm/dist`.
  A present partial deployment fails instead of selecting another build. Every
  set requires an adjacent manifest; parent manifests are not substitutes.
  Shared `wasm/artifact-set.mjs` checks schema, exact source pin, input identity,
  filenames and hashes. The local/Docker publisher verifies a complete immutable
  version before an atomic `current` symlink rename. Workers resolve that pointer
  once and old versions stay available until readers have stopped. `/engine`
  reports specific mismatch codes from the same verifier. Native attestation
  likewise checks schema, exact source pin, patch identities and executable hash.
  The browser's artifact hash literals must match the canonical manifest; both
  `security:check` and Docker assembly enforce this. A formerly stale browser
  WASM pin made a correct default server reject itself during discovery.
- The Docker build context is the repository root, so `/.dockerignore` is
  load-bearing: without it the daemon receives ~16 GB (`third_party/` is 14 GB)
  before the first instruction. Anything a stage `COPY`s must not be excluded
  there — today `server/` including `server/patches/`, `wasm/dist`, and
  `wasm/artifact-provenance.json`.
- Never emit an OPC relationship whose target is not in the same package: the
  pinned engine rejects the entire archive ("Archive does not contain a valid
  model"). Projections that drop preserved members must drop their
  relationships too.
- `wasm/slic3r_wasm.cpp`, `wasm/patches/`, `wasm/shim-include/`, and the build
  script hash into `wasm/artifact-provenance.json`. Editing any of them without
  rebuilding and republishing the artifacts breaks `verify:artifacts`, and the
  edit would ship as source that the checked-in engine does not contain. Engine
  changes must land as committed `wasm/patches/*.patch` (a dirty
  `third_party/SnapmakerOrca` worktree is never the authority), then rebuild,
  publish, and update the provenance manifest in the same change.
- `./scripts/quality.sh` is the clean-clone repository gate. Web-only changes
  must at minimum pass `npm --prefix web run quality`; do not weaken a failing
  check or claim broad parity before P12.6 is independently verified.
