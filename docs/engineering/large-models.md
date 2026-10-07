# Large-model performance contracts

Maintained technical context from [GEMINI.md](../../GEMINI.md). Read this
when changing the corresponding area; update it in the same commit as behavior.
Code paths below are relative to the repository root. Historical measurements
are fixture-specific evidence, not device-independent performance guarantees.

## Large-model performance (load-bearing)

- Command rollback uses repository-owned opaque snapshot handles. Versions share
  immutable asset records and copy only the map on insert/remove; restoring a
  version also restores its cached bundle fingerprint. Serialized bundles remain
  a separate validated boundary, and public mutable reads still copy. Imported
  history validates once, retains version handles for undo/redo, and accounts for
  both replaced and imported payloads in the history budget. The only production
  `peek()` consumers are the Three projection and canonical bounds reader; both
  decode into new position/index arrays and must never mutate shared bytes.
  `npm --prefix web run bench:assets` enforces zero payload copies for twenty
  transform/undo pairs over an 8 MiB generated asset; timing is informational.
  The Rust repository library follows the same ownership rule with immutable
  records, read-only leases and opaque repository-owned versions. Its synthetic
  8 MiB probe records zero mesh-sized allocations over 200 capture/remove/restore
  cycles plus initial fingerprint computation; an owned public read makes one
  measured 8 MiB allocation. Native command/history ownership has its own probe
  below; device memory ceilings remain unqualified. See the native-core document
  for the trace corpus.
  Browser clipboard captures now retain only selected immutable records through
  opaque repository-owned subsets. Copy, paste and undo/redo share mesh bytes;
  public reads still copy. Each capture is limited to 4,096 assets / 512 MiB,
  including editable SVG drawings, with no whole-repository version retained.
  Staged metadata uses the controller's separate 16 Mi encoded-unit pool, and
  command history charges all captured bytes. Four queued clipboard operations
  can retain four different captures; these logical limits are not a device RAM
  qualification. Eleven ownership tests cover failures/rollback and twenty
  paste/undo/redo cycles over an 8 MiB asset with zero payload copies; the public
  read control copies exactly 8 MiB. The Rust library now has the matching bounded
  selected-record capture and atomic paste. Its release allocation probe includes
  100,000 paint assignments and an 8 MiB asset/configuration: one asset capture and
  twenty command preparation/paste/undo/redo cycles allocate 81,669,734 bytes in total, with a largest allocation
  of 768 bytes and zero payload-sized allocations. The explicit public-read control
  detects one 8 MiB allocation. IDs and metadata charge 590,719 encoded input units;
  captured bytes separately count toward history. These synthetic results qualify
  library ownership, not device residency or latency. WASM/JNI now expose four
  clipboard owners per core instance with caller-supplied asset/byte limits.
  Capture resolves a current object query, then retains only its immutable subtree
  and selected records. Uploads attach that data without copying payloads or
  serializing the source graph; they share the existing four preparation permits.
  Closing the clipboard frees its permit while already prepared work/history
  retain their own charged data. The release host-preparation probe runs twenty
  capture/upload/seal/stage/release cycles over an 8 MiB mesh and shared metadata:
  each 139-byte upload charges 8,979,001 input units, total internal allocation is
  298,300 bytes, largest allocation is 640 bytes and no allocation reaches payload
  size. Ready release destroys the capture immediately. The public-copy controls
  detect all three payload copies. Android now captures immutable project/asset
  versions before offloading query selection and object/asset scanning to its
  preparation workers. Preparations and finished clipboards share four permits;
  conversion reuses the same JNI slot, including at registry capacity. The full
  source versions live only during preparation; completed copies retain selected
  records. The actor owns one current clipboard and closes replaced/cleared data.
  Accepted paste uploads retain their own data/charges across clear/replacement.
  Cancellation invalidates native inputs even if a selector ignores interruption;
  an already running JNI call may finish privately before releasing its captures.
  Browser task isolation and native editing integration remain open; these quotas
  do not establish a device RAM budget.

- Prepared native document adoption now transfers an admitted graph and immutable
  asset version into the existing authority without rehashing/copying payloads at
  commit. Exact metadata checks and cached bundle fingerprinting precede commit;
  source/operation guards still decide whether publication is allowed. A release
  probe measures twenty bundle preparation/adoption cycles over an 8 MiB mesh and
  two 8 MiB metadata strings: 85,328 total allocated bytes, largest allocation 640
  bytes and zero payload-sized allocations. Three public-copy controls are detected.
  Synthetic input allocation and graph/payload admission precede measurement. Parsing, archive/file
  I/O, production task scheduling and device memory/latency remain separate gates.

- Rust typed project candidates also share immutable graph children, configuration,
  extension data and sparse paint payloads. A transform edit copies the changed
  graph path; creating its cached FNV fingerprint streams all canonical fields
  without constructing JSON text or copying the paint-index array. The synthetic
  300,000-assignment probe retains 20 edited candidates and recomputes each hash:
  no allocation reaches the 9,600,000-byte index payload, and the largest internal
  allocation is 552 bytes on the measured host. An explicit public export makes
  exactly one payload-sized copy, proving the counter sees that cost. The initial
  resource fingerprint agrees with the TypeScript authority. This measures graph
  metadata ownership, not mesh import, history policy, Android memory or device
  latency. Full hashing still visits every field; this is not incremental hashing.

- Rust settings resolution, explanations, sanitization and project config
  projections borrow immutable JSON values. Resolved maps also borrow their keys;
  diagnostic messages own their text. Creating or cloning a view
  copies map entries, not configuration payloads. A synthetic 8 MiB UTF-16 notes
  string survives 200 combined resolution cycles with zero payload-sized
  allocations; largest measured internal allocation is 368 bytes. The explicit
  public-export positive control makes one 8 MiB copy. Pointer checks verify that
  effective and inherited values refer to the original payload. This is host
  allocation evidence, not a device budget or a native settings-panel benchmark.

- Rust timestamp syntax validation scans borrowed UTF-16 with constant memory.
  A 6,291,484-byte synthetic input, including a million nested comment pairs,
  takes zero heap allocations over twenty parses; a full-copy positive control
  makes one allocation. The parser does not apply transport string/depth limits
  to persisted metadata and does not recurse through comments. This qualifies
  parser ownership only. Android JNI now uses an explicit Java ZoneId resolver;
  its JVM correctness checks do not establish device allocation or latency costs.
  The optional WASM project binding uses its JavaScript host's Date.parse directly.

- Rust graph admission indexes assigned paint indices, not the entire declared
  mesh. It borrows config values for inherited-settings consistency and uses
  depth-sized equality iterators; valid paint indices allocate no issue paths.
  A synthetic graph with 1,897,256 declared triangles, 100,000 assigned facets,
  two separately owned equal 8,388,608-byte settings strings and wide metadata
  arrays allocates 1,971,034 bytes during validation, with a largest allocation
  of 640 bytes and no payload copy. Two hundred clones/reads of its immutable
  `ValidatedProject` reuse the proof with zero allocations or revalidation.
  A public config export makes one measured 8 MiB copy. This is graph metadata
  ownership evidence, not actual mesh loading, history, Android memory or latency.

- Native project publication and rollback retain immutable graph/proof ownership.
  A synthetic graph with 1,897,256 declared triangles, 100,000 paint assignments
  and an 8,388,608-byte settings string completes 200 publication/rollback cycles
  while retaining 400 receipts. Snapshot reads, stale-guard checks, selection
  clear/restore and full content comparisons against a separately owned equal
  graph allocate 2,448,000 bytes in total, with a largest allocation of 640 bytes
  and no payload-sized copy. An explicit public config export makes one measured
  8 MiB copy. This measures the store library; it does not exercise command
  execution, history retention policy, host dispatch or physical-device budgets.

- The native command/history probe executes 20 cycles of actual prepared plate
  duplication/deletion, undo/redo and failed batches, plus twenty single-transform
  and twenty batch-transform/undo pairs plus 120 object lifecycle/undo pairs and
  40 captured instance-creation/paste/undo pairs, retaining 1,520 ordered events
  through 580 project revisions. The lifecycle
  coverage includes object/instance deletion, plate clearing, duplication,
  plate moves and conversion to independent objects. Its synthetic graph has 1,897,256 declared
  source triangles, 100,000 assigned paint facets, an 8 MiB asset and two equal
  8 MiB configuration strings. Total internal allocation is 1,124,220,476 bytes;
  the largest individual allocation is 217,600 bytes. No mesh/config payload copy
  occurs; duplicate paint and configuration allocations retain identity. Canonical
  history size accounting streams full UTF-16 lengths and nested escaping instead
  of retaining large serialized source scopes. A public asset read copies exactly
  one 8 MiB payload as a positive control. Repeated validation still allocates
  temporary metadata; this measures ownership, not device residency, latency or
  thermal behavior. The caller deliberately retains events for this probe; the
  bus itself owns no retained event queue.
  Full-record command input uses a separate budgeted chunk parser; the measured
  command path starts with an immutable captured record. Parsing/typed decoding,
  session staging and asset import are not included in that command measurement.

- Native session bundle admission compares exact descriptor membership and
  canonical content through borrowed typed/JSON values. With an 8 MiB mesh and
  two 8 MiB metadata strings (known filename plus unknown metadata), admission
  and local guard checks allocate 3,778 bytes total, largest 640 bytes. Thirty-two
  prepared requests containing 120,000-unit IDs retain 7,705,984 bytes. Cancelling
  all of them releases their payloads immediately, leaving 8,064 bytes for reply
  settlement before draining; closing similarly releases all prepared payloads.
  Asset record identity survives these operations and session disposal. The
  public-read positive control makes three 8 MiB copies. These are Rust ownership
  measurements, not platform residency/latency limits. Hosts own returned reply
  and effect lifetimes; the core keeps no unbounded result/event queue.
  The finished-command staging pool retains an 8 MiB full instance record while
  ready or queued, without copying its metadata. Capture/admission and both
  release paths allocate 19,306 bytes total, largest 2,216 bytes; the maximum
  retained delta is 8,391,984 bytes and release leaves at most 2,376 bytes before
  queued settlement. Weak ownership checks prove the full record is destroyed.
  Explicit resource/command/encoded-unit caps cover both ready and queued work;
  default zero disables admission. Encoded UTF-16 units are a charge for finished
  input, not resident memory. Record parsing/construction and in-flight preparation
  precede this measurement and require separately bounded host tasks.
  The command upload adapters now provide those explicit parse budgets plus four
  preparation permits per core instance, shared across sessions. Both parsing and
  sealed input retain their permit until transfer to the finished pool or release.
  This bounds owner count and logical input, not peak resident memory. Typed decoding
  and measurement remain synchronous and require an owned preparation executor.
  WASM upload handles are module-local; a separate seal call does not provide
  worker isolation or interruptibility. The Kotlin actor now captures an immutable
  source and original native guard before assigning a command upload to either of
  two preparation workers. Up to four native preparation permits cover active and
  queued uploads; the actor also bounds all unsettled work and delivery to 32 tasks.
  Ordered writers reject byte/chunk overruns and retained writes after sealing.
  Admission/execution consumes the upload once and releases its ready reference
  after settlement. Scope cancellation immediately closes native inputs/captures;
  a provider ignoring cancellation may continue privately until it returns. Browser
  isolation and application integration remain open. Clipboard uploads now use the
  same actor preparation/commit path with independently owned selected data. An upload
  can retain its immutable source guard after session close, so application lifetime
  changes must explicitly cancel the preparation task. Native boundary checks cover
  metadata exceeding 1 MiB and 131,072 nodes; no device latency/residency claim follows.
  The transitional browser controller now stages clone/add-instance/fill-bed with
  four ready/queued resources, 4,096 aggregate commands and 16 Mi encoded units.
  Per-record capture separately bounds nodes/depth; fill subtracts each captured
  record from the remaining batch unit budget. Capture and placement planning
  still run synchronously. These controls do not qualify large-input responsiveness
  or replace the required browser preparation executor and Android app integration.

- Native document staging parses bounded UTF-8 chunks without retaining the
  complete input text. Resource budgets count all decoded values/text, including
  overwritten JSON properties. A 1,640,745-byte synthetic document with a million
  UTF-16 units and 100,001 foreign scalar values allocates 13,586,976 bytes during
  parsing/admission/comparison, largest 4,194,304 bytes. An 8 MiB asset transfer
  allocates its payload once; validated ownership moves into the immutable record
  without a second mesh copy. Cancelling that active transfer immediately releases
  8,388,608 bytes, and a public asset read adds one measured payload copy. These
  counts exclude the caller's preexisting source/asset buffers and are not device
  performance budgets. Whole-graph admission/hash and asset digest finalization
  use separate owned preparation workers in the Kotlin actor; only parsing/transfer
  calls are chunked. The actor permits two active preparation workers and at most
  32 total unsettled operations, including queued preparation and undelivered effects.
  Native owner/input budgets still apply independently. Cancelling a preparation
  invalidates its native handles immediately, including late produced handles;
  synchronous JNI may continue privately until its current call returns. This
  supplies task ownership for canonical document bundles, not archive decoding,
  process isolation, forced JNI termination or measured Android residency/latency.

- The optional project WASM binding retains immutable project, selection, history
  and asset captures without serializing them in acknowledgements. Host reads copy
  at most 64 KiB of bytes or 16,384 UTF-16 units per call; returned arrays own their
  memory and survive handle release/worker termination. wasm-bindgen copies input
  before Rust validation, so production hosts must check frame/chunk limits first.
  Explicit project/metadata export serializes once into a complete owned UTF-8
  buffer under a caller-supplied output limit; chunked reads do not remove that
  allocation or make serialization interruptible. This bulk export is for deliberate
  export/replay, not per-edit tree/renderer projections. Production adoption still
  requires isolated or cooperative serialization, complete UI projections and
  revisioned dispatch. The bounded query captures below provide the read primitives.
  Node-worker correctness/lifetime replay is not browser/device memory qualification.

- The Rust ZIP reader indexes an immutable staged seekable source without loading
  the complete archive or expanding every member together. Metadata is bounded by
  the admitted entry/path limits. Each member uses at most 64 KiB input and output
  chunks plus decoder history; the end-directory scan retains at most 65,557 bytes.
  Expansion is checked against declared lengths before output, then CRC is checked
  before returning a receipt. A failed read can already have written provisional
  bytes; callers must discard staging instead of publishing a partial project.
  Twenty verified read cycles for synthetic 1 MiB and 16 MiB members allocate
  3,614,580 and 4,807,140 bytes in total, with largest allocations 65,536 and
  65,557 bytes, zero allocations of 1 MiB or larger and zero retained bytes after
  release. Fixture construction and preexisting archive storage are excluded.
  These host allocation results do not qualify provider staging, parsed project
  residency, Android latency or forced interruption of blocking I/O.
  The same decoder now provides bounded pull reads and generated-output comparison.
  A dropped or partially read stream proves no integrity; successful finish must
  consume the tail and verify CRC, expanded length and the DEFLATE terminal boundary.
  Cancellation/I/O failures poison the attempt, while the immutable archive may be
  reopened explicitly. Exact compressed-input FNV hashing also uses bounded chunks.
  Canonical-envelope staging feeds decompressed chunks directly into the bounded
  JSON parser, including a BOM split across chunks; it retains no full decoded
  text or uncompressed envelope buffer. Graph/asset budgets precede payload
  allocation. Payload ownership moves into immutable records after CRC/length
  and digest validation, and blob equality uses bounded comparison writes.
  Unknown members are verified to a sink while the original archive remains
  owned for later reconciliation. Twenty success and twenty late-CRC-failure
  cycles over an 8 MiB asset, its blob alias and another unknown 8 MiB member
  each allocate 186,853,760 bytes total, with exactly twenty payload allocations
  and zero retained bytes. The largest allocation is 8,388,608 bytes. Synthetic
  source construction is excluded; JSON/graph storage, provider staging and
  Android residency still need separate measurements.
  OPC reconciliation then streams only its bounded parts/tags, preserving other
  archive members. Consuming uniquely owned extension metadata moves its large
  descendants without copying; an externally retained project snapshot correctly
  forces one metadata copy. The probe's twenty merge/revalidation/write cycles
  over existing 8 MiB UTF-16 metadata and a shared 8 MiB asset allocate 8,922,400
  bytes total, with a 65,536-byte largest allocation and no payload copies. The
  retained-snapshot control allocates 176,707,400 bytes, including twenty required
  8,388,608-byte metadata copies. Both retain zero measured bytes after release.
  Input construction is excluded. OPC output uses an explicit 64 KiB buffer that
  does not flush on drop after cancellation/failure; callers discard provisional
  output. Tag parsing, metadata updates and graph hashing remain synchronous and
  belong on an owned preparation task. Full BBS parsing remains open.
  Canonical completion now compares regenerated metadata directly against pull
  reads, then admits unknown members into the exact asset bundle. Asset count,
  per-asset and aggregate byte caps precede new payload allocation. Original
  declared leases retain their records; new buffers move into immutable storage.
  Final graph admission and bundle hashing stay off authority. The completion
  optimized probe covers five successful completions and five late admission
  failures, each owning one declared and one newly adopted 8 MiB payload. Each
  payload allocates exactly once per load; both phases retain zero allocations.
  They allocate 91,804,945 and 91,747,240 bytes total, respectively. Five equal
  and five early-mismatch comparisons of an 8 MiB member allocate 675,005 and
  1,002,685 bytes, respectively; the largest allocation is 65,557 bytes, with
  zero payload-sized copies or retained bytes. The deliberate 8 MiB copy control
  is detected. Source construction is excluded. These checks do not qualify
  Android/provider residency or interruption of synchronous graph/hash work.
  ZIP authoring now streams to an empty private seekable output, borrowing source
  paths and payloads. Its charged index and fixed 64 KiB compressor buffers do
  not retain a complete archive/member. Classic headers are patched in place;
  wide limits reserve ZIP64 fields before payload output. Producer flush does not
  flush/finalize host storage, and Drop writes nothing. Hosts discard staging on
  error and separately own provider transfer, deadlines and publication. Empty
  DEFLATE stored blocks enforce the selected ratio cap without payload replay.
  Metadata sorting belongs on the host task; cancellation cannot interrupt a
  blocked provider call or the underlying synchronous sort.
  Five file-backed writes of 24 MiB expanded data allocate 4,504,940 bytes total,
  largest 85,196 bytes, with zero retained allocations and no payload-sized copy.
  Each output is 16,787,249 bytes with the same hash. Source construction and
  post-write verification are excluded; an intentional 8 MiB copy is detected.
  This is host allocator evidence, not peak RSS or provider/device qualification.

- Android project JNI exposes the same immutable captures through owned Kotlin
  handles. It checks byte/text lengths before copying into Rust and bounds output
  chunks to 64 KiB / 16,384 UTF-16 units. Four document owners and 4,096 total
  handles bound retained owner count, not total device memory. Reply capacity is
  reserved before commit; closing an in-flight owner retains its memory/admission
  until work releases it. No borrowed native pointer escapes. Java arrays are
  copies; retained captures share immutable native state. Explicit JSON/metadata
  serialization still allocates a complete output buffer under its supplied
  bound and needs a separate owned export task. Host JNI replay checks capture
  lifetime and close cleanup; it does not qualify Android memory or UI latency.

- Project query nodes share an admitted snapshot and use constant-depth private
  addresses. Unsorted child lists allocate no index; plate/range lists check an
  explicit entry budget before allocating/sorting index positions. Numeric pages
  contain at most 64 rows; text reads copy at most 16,384 UTF-16 units. No query
  walks or copies settings values, paint arrays or mesh bytes. The synthetic
  query probe retains 1,897,256 declared triangles, 100,000 painted facets, an
  8 MiB name and an 8 MiB config string. Two hundred capture/page/text cycles
  allocate 6,817,600 bytes total, largest 32,768 bytes, with no payload-sized
  allocation. An explicit config export allocates one 8 MiB payload as a positive
  control. This is library ownership evidence; sorting latency, device residency,
  host-array copies and production projection scheduling still need qualification.

Measured on `~/Downloads/narwhal.3mf` — 1,897,256 facets, 629k of them painted,
stored as 161 MB of mesh XML inside a 28 MB archive. Every number below is from
that project on a desktop; a Galaxy XR is several times slower, so these are
floors, not ceilings.

- **Canonical state must never hold one entry per triangle.** The single worst
  offender was `FacetRefinementEncoding` version 1, which stored one root per
  source facet: 137 of the project's 137.3 M canonical chars, two thirds of them
  the literal default `{kind:'leaf',state:{kind:'unpainted'}}`. Because
  `ProjectStore.replaceState` clones, validates, fingerprints, and deep-freezes
  the whole state, **nudging an object one millimetre cost 24.3 s**. Version 2
  stores only subdivided facets and derives the rest from the sparse
  `TriangleAssignments` beside it; the same commit is now **1.3 s**. When adding
  canonical state, ask what it costs *per commit*, not per save.
- **A dense-per-facet shape is still the right working form mid-gesture.**
  `FacetRefinedRootSet` (dense) is what selection and painting operate on;
  `collapseFacetRefinementRoots` splits it into the sparse pair at the commit
  boundary, and `expandFacetRefinementRoots` rebuilds it. Do not persist the
  dense form, and do not make the selector work sparsely.
- **A split that collapses to a uniform leaf must move its value into the sparse
  assignments.** Remapping filaments, or resolving imported paint slots, can make
  a subdivided facet uniform; dropping the collapsed split without carrying its
  value across silently unpaints the facet. `remapFacetChannelValues` is the only
  correct way to remap one channel — it handles both halves together.
- The Rust facet library preserves the same sparse pair. Validation indexes only
  the subdivided facets when checking assignment conflicts; grouping serializes
  one canonical key per distinct paint value, rather than per assigned triangle.
  Temporary dense expansion requires a caller budget and checked allocation.
  Its synthetic host probe declares 1,897,256 source triangles, 10,000 whole-facet
  assignments and one split. Decode plus five remaps allocate 4,038,946 bytes in
  total, with a largest allocation of 131,072 bytes. The positive control's
  explicitly requested dense roots allocate 75,890,240 bytes in one array.
  Native BBS assembly now consumes only indexed decoded roots. Missing/unpainted
  facets never require a dense root array. The hex decoder charges explicit roots
  against a shared aggregate budget and a per-root node/depth cap. Its writer
  borrows either computation trees or canonical JSON refinement values, with a
  depth-bounded traversal stack and 4 KiB output buffer. Cancellation checks cover
  parsing, traversal and short/interrupted writes; the host discards partial output.
  Sparse validation/collapse remains synchronous and belongs off live authority.
  Twenty decode/normalize/write cycles allocate 27,360 bytes total, with a largest
  allocation of 632 bytes, for both two million and two billion declared facets
  with three explicit roots. Twenty borrowed writes with an existing 8 MiB paint
  value allocate 480 bytes total, largest 24 bytes, for each tree representation.
  All runs retain zero allocations; a deliberate persisted-value clone allocates
  the expected 8 MiB and verifies the counter. Input construction is excluded.
  These are host allocation observations, not actual mesh import or Android
  latency/memory qualification. Full BBS import, paint commands and application
  gesture integration remain open.

- **`fnv1a64` runs over hundreds of megabytes on import and save.** It is written
  with 16-bit limbs and `Math.imul` so a round costs no floating-point division;
  the naive `Math.floor(x / 2**32)` form ran at roughly 27 MB/s and dominated
  every profile. `projectFingerprint` likewise streams canonical JSON straight
  into the digest instead of materializing it — the string alone was 1.4 GB — and
  emits safe integers digit by digit rather than allocating one string per
  triangle index. All three are bit-identical to the old form, pinned by test.
- **Per-element path strings are the hidden cost in validators.** Building
  `` `${channel}[${i}].triangles[${j}]` `` for every triangle allocated hundreds of
  thousands of strings per commit for the overwhelmingly common case where
  nothing is wrong. Build the path only when an issue is actually reported.
- **`ProjectStore.replaceState` validates once, on the candidate.** Validating the
  caller's object as well doubled commit cost for no extra guarantee: a faithful
  JSON clone cannot turn a valid state invalid.
- **The mesh codec is packed; the tuple views are lazy.** `decodeIndexedMeshAsset`
  returns `positions`/`indices` typed arrays and materializes
  `vertices`/`triangles` only on demand. The eager tuple form cost 911 ms and
  ~400 MB per call on a path shared by render, paint, bounds, and export.
- Native mesh views instead retain the original immutable byte lease plus a small
  validated layout. Validation, vertex/triangle reads, cloning and transformed
  bounds allocate no decoded vertex/index arrays. Canonical instance bounds cache
  these views per asset, compare complete captured metadata and visit the original
  vertices through volume then instance transforms. No transformed mesh or box
  approximation is allocated. Byte/count, selected-instance, unique-asset and total
  transformed-vertex budgets are explicit; they are logical limits, not device RAM
  qualification. Authoring separately checks supplied metadata's canonical byte
  budget before allocating its output and hashes bytes while writing. Explicit
  expansion is a budgeted public copy. Polling covers validation, coordinate/index
  writing and bounds loops; full graph lookups/metadata comparison run off authority.
  A synthetic two-million-vertex / two-million-triangle asset occupies **48,000,000
  bytes**. Twenty validation/clone/bounds cycles allocate zero bytes. Twenty
  canonical instance-bound queries with an existing 8 MiB metadata value allocate
  **86,520 bytes total**, largest **1,160 bytes**, with no payload copy. Encoding
  allocates exactly one 48 MB output per cycle; explicit expansion allocates one
  72 MB output per cycle. All phases retain zero measured allocations afterward.
  Construction is excluded, and these host results do not qualify Android memory,
  renderer uploads, native mesh-file import or production editing latency.
- **`ThreeProjectSurface.resolveGeometry` is cache-first.** It used to clone the
  asset bytes and re-hash 33 MB on *every* projection — that is every canonical
  change — before consulting its own geometry cache. It now `peek`s the
  repository (no copy) and compares payload identity; the immutable repository
  makes reference equality proof enough that the content is unchanged.
- **Slice/save archive authoring runs on a worker.** `buildBbsCore` plus zip is
  ~3 s and over a gigabyte of garbage for this project, so
  `CanonicalWorkspaceSlicer` injects `WorkerProjectSerializer` rather than the
  codec directly. The canonical BBS codec is still the only writer, on both the
  worker and the no-worker fallback; `inspectWorkerSerializer` pins that.
- **Remaining headroom, deliberately not taken.** A commit still re-validates and
  re-fingerprints the whole state (~1.1 s of the 1.3 s). Scoping that to changed
  subtrees needs structural sharing — commands would have to declare what they
  touched — because `cloneProjectState` destroys object identity and any
  identity-keyed digest cache would go stale silently the first time a command
  mutated a shared subtree in place. Given that published G-code is bound to the
  exact project hash, a cache that can go stale is not an acceptable trade.
- **A live edit re-derived what canonical state already guaranteed.** Changing a
  printer profile or a filament ran a canonical capture, and
  `StoreProjectSliceSource.capture()` validated, re-cloned, re-froze, and
  re-hashed the state and every asset byte it had just read from the store —
  2.8 s on the narwhal, on a path that runs on every profile, filament, and
  placement change. The store already validated, hashed, and froze that state at
  commit, and the repository is immutable by contract, so capture now trusts it;
  the check that matters is unchanged, because `SliceJobCoordinator` never
  trusted the source port anyway and still runs `validatedSnapshot` on every
  capture it slices. Related: `deepFreeze` records the states it froze all the
  way down, and validation and `projectFingerprint` are memoized against those,
  so `replaceState` freezes *before* it validates and hashes; a repository
  caches its own bundle fingerprint; and `ReplaceProjectCommand` stops cloning
  the frozen state it is merely remembering, which is what made undo cost as
  much as the edit. One profile change went from ~6 s to well under a second of
  derived work, and undo/redo from seconds to ~120 ms.
- **`validateProjectState` stringified the whole project to throw away the
  string.** Its serializability check called `canonicalStringify` purely for the
  exception — half the cost of validating. `assertCanonicalSerializable` walks
  the same structure and throws the same errors without building anything.
- **A slice attempt limit must measure silence, not duration.** `attemptTimeoutMs`
  capped one attempt at 120 s, so a large model was cancelled mid-slice, retried,
  and then failed — and the failure surfaced as "Canonical slice route cleanup
  confirmed", which named the teardown rather than the cause. It is now
  `attemptIdleTimeoutMs`: the deadline restarts on every progress report, and
  both routes report continuously (the external one polls its job about once a
  second, the browser engine reports each stage). The route also names why it
  stopped instead of reporting that cleanup went fine. `serializationTimeoutMs`
  had the same shape of bug — a 30 s cap on work that takes ~19 s for a
  two-million-facet plate — and archive authoring reports no progress, so it is
  simply bounded generously now that it runs on a worker.
- **A regenerated archive was three times its source, for two independent
  reasons — both fixed.** The narwhal reopened as 85.7 MB against a 27.9 MB
  source; it is now 46.6 MB, and its core model XML is *smaller* and compresses
  *better* than the file it came from (158.2 MB → 27.7 MB at 5.7x, against the
  original's 161.6 MB → 29.6 MB at 5.5x).
  - **Mesh coordinates are float32, so `String(value)` is the wrong formatter.**
    It emits the shortest *double* that round-trips, which for a float32 is its
    full binary expansion: a coordinate authored as `-25.7756138` came back out
    as `-25.77561378479004`. Those digits name the same float32, so they carry
    no information — they just cost ~60% more bytes each and, being effectively
    noise, destroy compression. `formatMeshCoordinate` emits the shortest
    decimal that still round-trips through `Math.fround`. Use it for mesh
    positions only: `formatNumber` stays for canonical doubles such as layer
    `top_z` and height-range bounds, where shortening would lose precision.
    Native BBS numeric/XML primitives preserve that exact distinction. They use
    fixed stack buffers and write borrowed mesh vertices through a 4 KiB output
    buffer. Rust's generic shortest float32 text differs from the browser's first
    round-tripping `toPrecision` candidate at some power-of-two boundaries; use
    the shared BBS formatter, including JavaScript's decimal tie direction.
    Canonical double values retain their full ECMAScript number representation.
    The native core-model writer now uses these primitives over borrowed mesh
    views, sparse paint and extension text. Preparation retains only bounded
    entity/attribute/paint indexes; it never expands unpainted source facets or
    decodes another vertex array. Output reuses one attribute scratch buffer and
    writes through fixed buffers. Native model settings and optional layer/brim
    sidecars now borrow configuration, emboss recipes and captured SVG drawings.
    Recursive semicolon arrays and canonical JSON-valued settings stream through
    stack buffers; no complete configuration or escaped XML string is retained.
    Preparation budgets records, configuration nodes/depth, UTF-16 text and drawing
    bytes; each member has its own output cap. Project settings likewise borrow
    configuration, scripts and exact FullSpectrum groups, retaining only bounded
    field/vector indexes and derived percentages. Reset scanning is cancellable
    during line discovery and grammar matching; JSON string escaping uses a fixed
    buffer, including nested JSON-valued settings. Complete package assembly now
    combines these writers with a 64 KiB streamed envelope and ZIP sink. Asset
    leases, configuration and paint remain borrowed; inventory paths and mappings
    have separate record/text budgets. Generated/preserved collisions compare a
    stream directly against immutable bytes, including the entire generated member
    after the first mismatch. No complete metadata member is retained for comparison.
    Envelope node/depth limits cover state separately from asset/path limits; input
    admission and bounded index construction remain owned background work. File
    provider publication, application bindings and native import remain open.
  - **A referenced Production Extension part must not be preserved once the
    generated core absorbs it.** BBS keeps its meshes in `3D/Objects/*.model`,
    so this is every Orca/Bambu archive, not an exotic case: the writer resolved
    those parts into the flattened `3D/3dmodel.model` *and* kept the originals
    as opaque blobs, storing the geometry twice and leaving the copy frozen at
    import while the core moved on. `ImportedCoreProject.absorbedIntoCorePaths`
    names them, and they are excluded from preservation only when the core was
    actually regenerated — if `buildBbsCore` could not run, the originals are
    still the only carrier and must stay. The existing machinery already drops
    the now-dangling OPC relationship, which is required: a relationship to a
    missing part makes the pinned engine reject the whole archive.
  - What remains is principled duplication, not waste: the XML core is for
    foreign readers and the engine, and `Metadata/orcaxr/assets/*.bin` (17.2 MB
    compressed here) is the byte-exact canonical mesh the envelope reopens from.

- **The preview's parse budget silently truncated a real print, and it looked
  like a failed slice.** A 78 mm three-colour narwhal slices to 95 MB of G-code:
  99.7M UTF-16 code units, 3.17M records, 490 layers. The old caps
  (`inputCharacters` 64 MiB, `records` 1.5M) stopped the parser at Z 21.4 mm of
  78.8 mm — a quarter of the print — and the preview drew that stump as though
  it were the whole model. Both engines were fine: WASM and the external CLI
  each produced 1472 layer markers over Z 0.200–78.440 from both the source
  archive and OrcaXR's regenerated one, with identical per-tool move counts.
  Only the preview was short. Caps are now sized from that measurement
  (`inputCharacters` 256 MiB, `lines` 16M, `records` 4M, `pathPoints` 8M) and
  `GCODE_RENDER_HARD_CAPS.segments` was raised to 4M with them — the renderer
  *throws* above its cap rather than drawing part of a path, so a render cap
  below the parser's turns "shows the whole print" into "shows no preview at
  all". A surface that cannot afford that, the headset above all, passes its own
  smaller `maxRenderedSegments`. Full parse costs ~4.4 s and ~400 MB of typed
  columns at ~132 B per record, of which about a quarter is `RecordColumnsBuilder`
  doubling slack that `finish()` keeps because it hands out `subarray` views.
  The current browser viewer indexes before allocating rich columns. It parses
  the whole input only when the complete index fits 240,000 records and the
  path-point budget; otherwise it loads bounded windows immediately. An unusually
  large layer gets additional record checkpoints, and arc-heavy spans get
  checkpoints before a whole arc would overflow the path budget. A single arc
  larger than that budget remains explicitly incomplete; no partial arc is drawn.
  Index checkpoint metadata has a 64 MiB accounting budget, and input/line caps
  remain explicit. The index counts records without retaining columns or applying
  the window's record cap to the whole input.

  Checkpoints preserve machine state, absolute source offsets/lines and original
  semantic record IDs. Inspection reports original IDs; render projection indices
  stay local to the loaded columns and use `recordOffset` to recover source identity.
  Previous/Next moves controls in DOM and XR reach all chunks of a large layer;
  colour/filter changes preserve the selected chunk. Notices quantify the layers
  and records shown. A complete index means only that the supplied input was fully
  indexed, never proof that a slice finished. Incomplete input names its limiting
  reason and says that later input was not inspected. The standalone projection's
  truncated-parse notice follows the same rule: it reports the drawn height and
  record count without claiming that the sliced G-code is complete. Numeric range
  failures name the parser limit without describing a small input as oversized.

  `WorkerGcodePreviewSession` owns one browser worker per source. Indexing,
  window parsing and default projection/inspection run there; the main thread
  receives transferred bounded snapshots and reuses those projections across
  surfaces. Rust is the default computation adapter; `?previewCore=typescript`
  selects the reference when the host module loads and requires reload to change.
  The shared controller preserves window and view policy. Rust copies source
  chunks into its owner and returns checked packed buffers; after transfer the
  worker drops the host frame while Rust retains at most one parsed window.
  The main receiver validates exact column ranges in that one owned packet.
  Neither this transport nor the existing reference transport is zero-copy.
  The worker retains one source (at most 256 Mi UTF-16 code units),
  its index and one window; the main thread retains its current window. A source
  replacement/disposal terminates the old worker immediately. Window requests
  settle obsolete callers immediately and coalesce to one pending request while
  the active bounded parse finishes; obsolete replies are never published.
  Requests have a 120-second deadline; failure disables that preview visibly
  instead of falling back to a blocking main-thread parse. No worker holds old
  response buffers after transferring them. Engine completion releases its slicing
  slot before asynchronous preview completes, so a new slice can supersede a
  still-indexing artifact. This bounds live owners; garbage
  collection can temporarily retain unreachable previous windows.

  The generated 300,002-record single-layer regression previously retained all
  records and allocated a 524,288-element Float32 column. It now retains at most
  240,000 with no column allocation above that cap, and every remaining record is
  reachable. Index-first scanning is additional work for small files: the same
  Node fixture measured 426.6 ms before and 603.1 ms in the isolated bounded
  implementation. The improvement is bounded allocation and responsiveness,
  not a claim of faster total parsing. Production Chromium evidence records
  heartbeat progress during worker indexing rather than inventing a universal
  latency threshold. `bench:preview` alternates five whole-parse/reference and
  indexed-window opens after warmup and collection. The measured paired ratios
  were 1.45–1.65 (median 1.59); CI caps the median at 2.5, roughly 50% headroom
  over the observed worst pair. This compares work on the same runtime/host,
  with no absolute device latency assertion. Earlier narwhal measurements remain historical;
  hardware/XR qualification of this implementation is still pending.

  Worker-replacement qualification waits for the obsolete source's actual
  `open` submission and replaces it before the next response task can run. A
  fixed 20 ms delay sometimes cancelled source preparation before a worker
  existed, so it could not establish worker-lifetime cancellation. The test
  checks the specific submitted worker's termination on both computation adapters.

  The production regression now executes both adapters on the same generated
  300,002-record source, checks identical initial view state, DOM/XR window moves,
  empty-filter recovery and pending-work cancellation. It includes Rust source
  conversion, index, parsing, packet decoding and rendering in the open timing;
  those single-run observations are not the five-run device acceptance benchmark.
  The JS source and Rust source can coexist during initial conversion. WASM
  linear memory measurements exclude renderer storage, JS garbage and process RSS.

- Import feature detection walks typed volume emboss recipes, so unrelated
  extension flags do not generate geometry warnings and no project-wide JSON
  string is allocated. Save/slice snapshot preparation shares the frozen canonical
  state and cached hash, validates one defensive asset bundle once, and uses the
  repository's cached fingerprint for freshness. Public/untrusted byte boundaries
  still copy and validate; derived fingerprints never replace output SHA-256 or
  engine provenance.

  Native export now captures immutable project and asset versions together before
  background work. JSON serialization and asset transfer run on either of the
  actor's two preparation workers; all unsettled tasks remain bounded to 32.
  The JNI JSON writer stages at most 64 KiB and releases each callback local
  reference; no full-document output buffer is constructed on this path. Caller
  streams and metadata traversal have their own memory costs. Asset reads copy
  bounded chunks from immutable leases, preserving declaration order after edits,
  reset or source closure. Explicit JSON, asset-count and aggregate asset-byte
  budgets precede handoff. Raw buffered export remains available for explicit
  diagnostics; chunk reads from it still do not make serialization incremental.
  Complete-bundle consumption and successful host handoff precede any checkpoint.
  Cancellation refuses after the output callback starts; close invalidates native
  handles without joining blocked I/O and an unknown handoff is never retried.
  This supplies native task isolation and bounded output staging, not archive
  assembly, storage-provider durability, forced I/O interruption or device RAM
  and latency qualification.

- **A slice is not cancelled for going quiet.** Slicing the narwhal at 0.12 mm
  failed with an idle timeout, because the engine legitimately says nothing for
  long stretches: measured on that model, the longest silence is **77.8 s** — right
  after `5% Slicing mesh` — with a second gap of 51.8 s, in a 248 s slice. A
  browser worker is slower than that native measurement, so 120 s of silence is
  reachable on real hardware, and no fixed number is right because the silence
  belongs to one stage of one model. Nothing can tell a slow engine from a stuck
  one from outside, so `attemptIdleTimeoutMs` now defaults to `null` — silence is
  *reported* (`stallNoticeMs`, a repeating "still slicing, no update for N s"
  status) and never acted on. An unattended caller can still set a ceiling. The
  consequence is load-bearing: **stopping a slice is now only the operator's
  call, so `slice_cancel` had to exist** — `OrcaWorkspace.cancelSlice()` was
  already written but nothing invoked it, so before this there was no way to end
  a running slice at all. It sits on the primary bar beside Slice, enabled only
  while slicing. Removing an automatic stop without adding a manual one would
  have left a hung slice needing a page reload.

- **An upload deadline is a guess about someone else's network, and there is no
  way to measure the thing that would justify it.** Three deadlines were tried
  and all three were wrong: the shared 10 s request timeout could not carry
  95 MB; a size-derived deadline at a 256 kB/s floor collided with
  `positiveDuration`'s 5-minute bound and rejected every print over ~67 MB; and
  raising that bound then failed a real 93 MB upload at 402 s because the link
  was moving 237 kB/s — healthy, merely below a floor invented on its behalf.
  The tempting fix is "cancel only when progress stops", but **upload progress
  is unobservable here**: `fetch` exposes none, `XMLHttpRequest` does but cannot
  carry the `targetAddressSpace` opt-in that `fetchLocalNetwork` needs for
  Chrome's Local Network Access, and a streaming request body needs HTTP/2,
  which a LAN printer on HTTP/1.1 will not offer. So `timeoutMs: null` is now a
  supported value meaning *no deadline at all* (no timer is armed, verified by
  asserting the scheduler holds only the heartbeat), the upload reports elapsed
  time — never a percentage, which would be invented — so it is visibly alive,
  and the operator cancels via the send button, which already doubles as
  "Cancel send". A caller passing `null` **must** offer that cancel. Downloads
  keep their content-length-derived deadline: a response body's size is known
  in advance, so it is measured rather than guessed.

- **A hard reload removes cross-origin isolation; the guard against a reload
  loop must not also block recovery.** In-browser slicing needs
  SharedArrayBuffer, which needs cross-origin isolation, which on GitHub Pages
  comes from `public/coi-serviceworker.js` adding COOP/COEP to each response. A
  **hard** reload (Ctrl+Shift+R) bypasses service workers, so the document
  arrives with no isolation headers — it is the one kind of reload that removes
  isolation rather than restoring it. The shim's recovery reload was gated on
  `sessionStorage['coiReloaded']`, a boolean set on the first reload and *never
  cleared*, so after one successful load that flag permanently suppressed the
  recovery: the tab stayed un-isolated for the rest of the session and every
  slice failed with "needs a cross-origin-isolated context". The guard is now a
  timestamp with a 10 s cooldown and is **cleared on success** — it exists to
  stop a loop, not to stop recovery. `decideCoiReload` is a pure function
  exported through a CommonJS seam so the decision is unit-tested directly
  rather than by trying to reproduce a header-stripping reload in a headless
  browser. The three isolation errors in `SlicerClient` also shared one
  developer-facing sentence ("serve the page with COOP/COEP headers"), which is
  advice for whoever deploys the site, not for the person reading it; they now
  share `isolationFailureMessage`, which says to reload normally and warns that
  a hard reload is what breaks it.

- **A test double that accepts what the real server rejects is worse than no
  double.** Starting a print failed with `http_error` because `/printer/print/
  start` was sent as a **GET**; Moonraker serves it, and every other print
  command, for POST only and answers 405. `MoonrakerTransport.request` defaults
  to GET, and the call sites in `PrintJobSubmission` and `PrintJobControl`
  simply omitted the method — so start, pause, resume, cancel, emergency-stop
  and firmware-restart were *all* broken. Only the upload path worked, because
  it sets `method: 'POST'` explicitly, and `PrinterStorage.startStoredPrint`
  calls the identical endpoint correctly, which is what made the omission
  visible. It survived because **both** doubles — `scripts/moonraker-simulator.
  mjs` and the inline `Simulator` in `moonraker-print-simulator.test.ts` —
  dispatched on `url.pathname` alone and never looked at the method, so every
  test passed while nothing worked. Both now answer 405 exactly as Moonraker
  does, `METHOD_ONLY_ENDPOINTS` in the transport refuses a mutation sent as a
  GET before it reaches the wire (`invalid_request`), and the minimal transport
  interfaces these modules declare now include `method` — omitting it had made
  the correct call untypeable. Two further consequences worth keeping: a failed
  response's body is now read into `MoonrakerTransportError.detail`, because
  Moonraker explains its refusals there and discarding it left `http_error` as
  the entire story; and that detail is routed through the credential redactor
  first, since a server can echo back the API key it was sent — an existing
  security test caught exactly that leak when `detail` was added raw.

- **Printer commands belong to the job and connection the operator saw.**
  `PrinterSessionController` owns the selected transport, subscriptions, epoch,
  query publication, and pending commands. DOM dialogs and DOM/XR holds capture
  an immutable intent before confirmation; a single-use confirmation carries
  that exact intent. Fresh full queries reset the object accumulator; only
  WebSocket patches merge. Ordinary commands require matching Moonraker file
  metadata and history (`job_id`, `print_start_time`/`start_time`, filename,
  file size/modification and an active history row) and read them again after
  confirmation. Missing identity blocks with recovery guidance; a new run of
  the same filename, changed printer, reconnect, partial response, or failed
  refresh cannot authorize the old command. Pending ordinary commands are
  serialized, including their dialogs. After command verification begins, its
  completion or refusal invalidates the old job identity before releasing the
  command lock; only a completed authoritative refresh re-enables ordinary
  controls. This prevents a retry hold from capturing a just-rejected identity.
  Emergency stop and the distinct,
  confirmed firmware-restart action retain an authenticated, bounded HTTP path
  without a successful readiness/history query or WebSocket handshake. These
  checks close client stale-state paths; Moonraker offers no atomic comparison
  and command transaction against other clients. Simulator/browser evidence
  does not establish installed-firmware or supervised hardware qualification.

- **A send confirmation owns one artifact and printer session through completion.**
  `PrintWorkflowController` is shared by DOM and XR and owns cancellation,
  confirmation, upload, verification, explicit preparation, and start. Unknown
  or incomplete readiness blocks even upload-only; start requires Klipper ready,
  a recognized idle state, and an inactive virtual SD card. Session, artifact,
  used-tool mappings, and selected capabilities are revalidated after upload
  and before each preparation/start. Changed prerequisites retain the file and
  require another confirmation. Ambiguous POSTs are never retried; a bounded
  query reconciles current state without claiming the request failed to execute.
  Non-overwrite filenames use 128 random bits from LAN-compatible
  `crypto.getRandomValues`; listing failures block. Explicit overwrite names
  the exact target and its captured size/modification time, rechecks it before
  upload, and cannot replace an active file. Uploads use the published artifact's
  SHA-256 checksum and verify response root/path/size and upload-only flags.
  Both surfaces default to upload-only with overwrite and preparation off.
  Stored-file starts share the workflow lock and require their own session,
  metadata, and idle-state confirmation; they do not upload again.

- **A per-request deadline is a property of the payload, not of the transport.**
  Sending the narwhal failed with `invalid_state` *before a byte left the
  browser*. `fetchWith` validated the caller's `timeoutMs` with
  `positiveDuration` — the helper that bounds the transport's own configuration
  knobs (`requestTimeoutMs`, `socketOpenTimeoutMs`, the heartbeat pair) at five
  minutes. Once `PrintJobSubmission` began deriving an upload deadline from the
  artifact size, that bound silently became a **size** limit: at the 256 kB/s
  floor plus 30 s of setup, anything over ~67.5 MB asks for more than 300 s, so
  every print above that threshold was rejected outright — narwhal is 95 MB at
  0.20 mm and 124 MB at 0.12 mm, so both were. Configuration knobs keep
  `positiveDuration`; a per-request deadline now goes through `requestDeadline`,
  bounded by `MAXIMUM_REQUEST_DEADLINE_MS` (1 hour) purely to catch a runaway
  argument. Two lessons worth more than the fix. First, **a bad argument is not
  a bad connection**: `invalid_state` sent the investigation to the connection
  layer and cost a whole cycle chasing a real but unrelated bug, so argument
  validation now raises `invalid_request`. Second, **a size threshold is only
  found by testing a realistic size**: every existing test sent a few megabytes
  and passed by staying under the bound by accident. The regression test feeds
  the deadlines narwhal actually asks for (95/124/512 MB) through a real
  transport, checking the contract *between* the two modules rather than each
  side's opinion of it.

- **Moonraker's HTTP API does not depend on its websocket.** While chasing the
  `invalid_state` above — which this did *not* cause — `request`, `upload`, and
  `download` turned out to refuse unless `state.status === 'connected'`, so a
  socket that happened to be reconnecting blocked the readiness query that
  precedes every send. Worse, each re-checked `socketEpoch` *after* the transfer, and that
  epoch advances on every reconnect: a websocket blink during a multi-minute
  upload discarded a file that had already landed on the printer, reported as
  `cancelled`. Uploads, downloads, and REST queries go over HTTP and owe the
  JSON-RPC socket nothing, so they now require only a live *session*
  (`connected` or `reconnecting`, not disposed) and, afterwards, only that the
  session `generation` is unchanged — generation moves when the operator
  deliberately disconnects or switches printers, which is the only thing that
  should invalidate a finished transfer. The send workflow captures its session
  before confirmation and aborts when that session changes; it must never
  reconnect and transfer an old confirmation to the replacement session.

- **A transfer cannot be capped by duration.** Sending the narwhal to a printer
  failed with a timeout: `MoonrakerTransport` applied its flat 10 s
  `requestTimeoutMs` to every request including the upload, and 95 MB of G-code
  does not cross any real network in ten seconds. That timeout suits a status
  query — which either answers promptly or is broken — but a transfer's honest
  duration is a function of its bytes. An **upload** sends its body before any
  reply, so `PrintJobSubmission` uses no deadline, reports elapsed time, and
  exposes operator cancellation. The former 256 kB/s assumed floor rejected a
  healthy 237 kB/s link and was removed. A **download** cannot be sized in advance, so `fetchWith`
  keeps the short deadline for getting a reply and then re-arms from the
  response's `content-length` once the headers say how much is coming. An
  unknown length deliberately keeps the short deadline rather than guessing
  generously, since that would turn a hung connection into a long wait. The
  operator is the only one who can
  tell "my printer is on slow wifi" from "it is stuck". Note this is the same bug
  shape as the slice attempt cap: whenever a limit guards work whose duration
  scales with the input, it has to scale too, or measure silence instead.

- **What the external slicer container can and cannot fix.** Offloading helps the
  *slice* itself and nothing else: the costs above are all in the browser,
  between the user's input and the scene updating, and cannot survive a network
  round-trip. A server-side canonical importer is also explicitly the wrong
  answer — it would be a second canonical import path. Render-side LOD is the one
  genuinely container-shaped idea left, and it is not free: display meshes are
  what `faceIndex` is resolved against for paint, measure, and brim ears, so a
  decimated display mesh needs a separate full-resolution picking mesh first.

- **All-in-one container architecture, web UI serving, and same-origin trust.** The Dockerfile builds a unified all-in-one image combining the web front-end (`/app/public`), native CLI engine (`/app/orca/bin/snapmaker-orca`), versioned WASM engine (`/app/wasm-artifacts/current`), and Tailscale binaries. Build-time coherence asserts that `web/src/slicer/pinnedEngineProvenance.ts` commit and patch digests match `/app/orca/engine-provenance.json`. Static assets and SPA routes are served with exact `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`, and `Permissions-Policy` matching `web/vite.config.ts`. In `ORCAXR_TRUST=same-origin` mode, same-origin browser requests (`isSameOriginRequest`) are trusted on loopback and Tailscale Serve HTTPS boundaries without manual token entry, while non-browser API clients authenticate with an explicitly provisioned token (loopback-only same-origin setups can generate `~/.orcaxr/server-token`) (0600 permissions). `SlicerClient` probes the serving origin on startup via `autoDiscoverExternalSlicer`, connects only upon valid engine attestation, and preserves explicit user endpoints.
