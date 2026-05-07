package dev.orcaxr.app.mcp

import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * AI-driven paint pillar — headless paint sessions (C9 milestone 4).
 *
 * Background: every existing paint MCP tool emits a
 * [WorkspaceAction.PaintTriangleSet] that flows through
 * `applyPaintMutation`, which (a) bumps `paintContentVersion`, (b)
 * triggers a colored-GLB rebake, (c) loads the rebaked GLB into a
 * fresh `GltfModelEntity` and swaps it into the SceneCore graph. That
 * cost is fine for one user-driven brush stamp but it's prohibitive
 * for an LLM-driven refinement loop: 40 small paint primitives during
 * "make Pikachu's cheeks look right" pays the rebake/swap cost 40
 * times AND interrupts the user's XR experience 40 times AND fills 40
 * undo steps for what's morally one creative act.
 *
 * A paint session decouples the LLM iteration from the spatial scene:
 *
 *   begin_paint_session(model_id) → session_id
 *      ├─ paint_sphere(session_id=…, …)        ← no scene rebake
 *      ├─ render_view(session_id=…, …)         ← reads session paint, not live
 *      ├─ paint_geodesic_disc(session_id=…, …) ← no scene rebake
 *      ├─ render_view(session_id=…, …)         ← reads session paint
 *      └─ commit_paint_session(session_id)     ← ONE LoadPaintState ⇒ ONE rebake
 *
 * The render path is already pure-Kotlin (`AiRenderEngine`), so
 * sessions don't lose render fidelity vs the live path — they GAIN
 * iteration speed by skipping the GLB bake / GltfModel reload that
 * happens on every committed paint mutation.
 *
 * Lifetime: per app run. LRU-bounded at [MAX_SESSIONS] (each session
 * holds 4 ByteArrays sized to the model's tri count; on a 1.4 M-tri
 * dragon that's ~5.6 MB per session, so 8 caps memory at ~45 MB).
 */
internal class AiPaintSessionStore internal constructor() {

    private val sessions = ConcurrentHashMap<String, AiPaintSession>()

    fun begin(
        modelId: String,
        triCount: Int,
        basePaintFilamentIndex: ByteArray?,
        baseSupportFlags: ByteArray?,
        baseSeamFlags: ByteArray?,
        baseFuzzySkinFlags: ByteArray?,
    ): AiPaintSession {
        val id = newId()
        val now = System.currentTimeMillis()
        val baseFp = fingerprint(
            basePaintFilamentIndex,
            baseSupportFlags,
            baseSeamFlags,
            baseFuzzySkinFlags,
        )
        val s = AiPaintSession(
            id = id,
            modelId = modelId,
            createdAtMs = now,
            triCount = triCount,
            baseFingerprint = baseFp,
        )
        // Snapshot the live paint into the session so commits + diffs
        // can reason about what actually changed during the session.
        // copyOf so the LLM's session can't accidentally retroactively
        // mutate the live model when the host's ByteArray is shared.
        s.snapshotInitial(
            basePaintFilamentIndex?.copyOf(),
            baseSupportFlags?.copyOf(),
            baseSeamFlags?.copyOf(),
            baseFuzzySkinFlags?.copyOf(),
        )
        synchronized(sessions) {
            sessions[id] = s
            evictIfNeededLocked()
        }
        return s
    }

    fun get(id: String): AiPaintSession? = sessions[id]

    fun all(): List<AiPaintSession> = sessions.values.sortedBy { it.createdAtMs }

    fun discard(id: String): Boolean = sessions.remove(id) != null

    fun clearAll() {
        sessions.clear()
    }

    /**
     * Audit H9 — must be called inside `synchronized(sessions)`. The
     * previous non-atomic check + eviction could drop a freshly-
     * inserted session under concurrent `begin()` calls (sort-then-
     * remove operates on a stale snapshot).
     */
    private fun evictIfNeededLocked() {
        if (sessions.size <= MAX_SESSIONS) return
        val sorted = sessions.values.sortedBy { it.lastTouchedAtMs }
        val toRemove = sessions.size - MAX_SESSIONS
        for (i in 0 until toRemove.coerceAtLeast(0)) {
            sessions.remove(sorted[i].id)
        }
    }

    private fun newId(): String = UUID.randomUUID().toString().replace("-", "").substring(0, 12)

    companion object {
        /** Tri-count capped at the largest mesh we expect (the dragon
         *  test fixture is 1.4 M tris; 4 byte arrays × 8 sessions ≈ 45 MB). */
        const val MAX_SESSIONS = 8

        @Volatile private var instance: AiPaintSessionStore? = null

        fun get(): AiPaintSessionStore {
            instance?.let { return it }
            return synchronized(this) {
                instance ?: AiPaintSessionStore().also { instance = it }
            }
        }

        /**
         * Stable 8-byte hex hash of the four paint arrays. Used to
         * record session start fingerprints AND to expose
         * "model paint matches what you started with" as a guarantee
         * the LLM can verify in `get_paint_session_diff` /
         * `commit_paint_session` responses.
         */
        fun fingerprint(
            paintFilamentIndex: ByteArray?,
            supportFlags: ByteArray?,
            seamFlags: ByteArray?,
            fuzzySkinFlags: ByteArray?,
        ): String {
            val md = MessageDigest.getInstance("SHA-256")
            fun feed(arr: ByteArray?) {
                if (arr == null) {
                    md.update(0.toByte())
                } else {
                    md.update(1.toByte())
                    // Length-prefix so a null vs empty distinction
                    // doesn't collide with content prefixes.
                    md.update((arr.size ushr 24).toByte())
                    md.update((arr.size ushr 16).toByte())
                    md.update((arr.size ushr 8).toByte())
                    md.update(arr.size.toByte())
                    md.update(arr)
                }
            }
            feed(paintFilamentIndex)
            feed(supportFlags)
            feed(seamFlags)
            feed(fuzzySkinFlags)
            val full = md.digest()
            val sb = StringBuilder(16)
            for (i in 0 until 8) sb.append(String.format("%02x", full[i]))
            return sb.toString()
        }
    }
}

/**
 * One LLM-driven paint session. Mutations are synchronous on a single
 * monitor lock — pipelined paint primitives from the same MCP client
 * apply in arrival order; concurrent renders read a coherent snapshot
 * via the volatile fields.
 *
 * Memory: holds independent copies of all four paint arrays (so a
 * commit / discard never touches the live `PlacedModel`). Allocates
 * each kind's array lazily — a session that only paints color
 * doesn't pay for support / seam / fuzzy buffers.
 */
internal class AiPaintSession internal constructor(
    val id: String,
    val modelId: String,
    val createdAtMs: Long,
    val triCount: Int,
    /** SHA-256 over the live model's paint arrays at session-begin. */
    val baseFingerprint: String,
) {
    @Volatile var paintFilamentIndex: ByteArray? = null
        private set
    @Volatile var supportFlags: ByteArray? = null
        private set
    @Volatile var seamFlags: ByteArray? = null
        private set
    @Volatile var fuzzySkinFlags: ByteArray? = null
        private set

    /** Frozen copies of the paint arrays as they were at session-begin.
     *  Used by `render_paint_session_diff` to render a "before" frame
     *  without holding the live model's pre-session bytes. Set once in
     *  [snapshotInitial] and never mutated thereafter. */
    @Volatile var initialPaintFilamentIndex: ByteArray? = null
        private set
    @Volatile var initialSupportFlags: ByteArray? = null
        private set
    @Volatile var initialSeamFlags: ByteArray? = null
        private set
    @Volatile var initialFuzzySkinFlags: ByteArray? = null
        private set

    @Volatile var lastTouchedAtMs: Long = createdAtMs
        private set

    /**
     * Audit H21 — test-only seam to set the LRU timestamp without
     * sleeping for wall-clock ordering. Tests call this immediately
     * after `begin()` to make eviction order deterministic. Production
     * paths never call this; the public mutators (applyTriangleSet)
     * stamp `System.currentTimeMillis()` inline.
     */
    @androidx.annotation.VisibleForTesting
    internal fun setLastTouchedAtMsForTest(ms: Long) {
        lastTouchedAtMs = ms
    }

    /** Bumped on every mutation. Vision tools include this in their
     *  cache key so a re-render after a paint always misses the
     *  artifact cache. */
    private val versionCounter = AtomicLong(0)
    val version: Long get() = versionCounter.get()

    /** Diagnostic counters. */
    @Volatile var totalActions: Int = 0
        private set
    @Volatile var totalTrianglesPainted: Long = 0L
        private set

    internal fun snapshotInitial(
        paint: ByteArray?,
        support: ByteArray?,
        seam: ByteArray?,
        fuzzy: ByteArray?,
    ) {
        paintFilamentIndex = paint
        supportFlags = support
        seamFlags = seam
        fuzzySkinFlags = fuzzy
        // Frozen copy retained for the diff renderer — `paint*` above
        // gets reassigned by every applyTriangleSet, so we need a
        // separate snapshot if we want the "before" state for the
        // session's lifetime.
        initialPaintFilamentIndex = paint?.copyOf()
        initialSupportFlags = support?.copyOf()
        initialSeamFlags = seam?.copyOf()
        initialFuzzySkinFlags = fuzzy?.copyOf()
    }

    fun arrayFor(kind: WorkspaceAction.PaintKind): ByteArray? = when (kind) {
        WorkspaceAction.PaintKind.Color -> paintFilamentIndex
        WorkspaceAction.PaintKind.Support -> supportFlags
        WorkspaceAction.PaintKind.Seam -> seamFlags
        WorkspaceAction.PaintKind.FuzzySkin -> fuzzySkinFlags
    }

    /**
     * Apply [PaintTriangleSet] semantics in-session. Returns the
     * triangle count actually mutated (after the merge filter), so the
     * tool response can report `painted_count` consistent with the
     * live-model emit path.
     */
    @Synchronized
    fun applyTriangleSet(
        kind: WorkspaceAction.PaintKind,
        indices: IntArray,
        tag: Int,
        mergeMode: WorkspaceAction.MergeMode,
        whereTag: Int,
    ): Int {
        val before = arrayFor(kind)
        val out = before?.copyOf(triCount) ?: ByteArray(triCount)
        val tagB = tag.toByte()
        val whereB = whereTag.toByte()
        var painted = 0
        for (idx in indices) {
            if (idx < 0 || idx >= triCount) continue
            val cur = out[idx]
            val accept = when (mergeMode) {
                WorkspaceAction.MergeMode.Replace -> true
                WorkspaceAction.MergeMode.OnlyUnpainted -> cur.toInt() == 0
                WorkspaceAction.MergeMode.OnlyTagged -> cur == whereB
            }
            if (accept) {
                if (out[idx] != tagB) painted++
                out[idx] = tagB
            }
        }
        when (kind) {
            WorkspaceAction.PaintKind.Color -> paintFilamentIndex = out
            WorkspaceAction.PaintKind.Support -> supportFlags = out
            WorkspaceAction.PaintKind.Seam -> seamFlags = out
            WorkspaceAction.PaintKind.FuzzySkin -> fuzzySkinFlags = out
        }
        totalActions++
        totalTrianglesPainted += painted
        lastTouchedAtMs = System.currentTimeMillis()
        versionCounter.incrementAndGet()
        return painted
    }

    /** Current paint state's content fingerprint. Compares against
     *  [baseFingerprint] to detect whether the session is in fact
     *  unchanged from the live model (no-op commit warning). */
    fun currentFingerprint(): String = AiPaintSessionStore.fingerprint(
        paintFilamentIndex,
        supportFlags,
        seamFlags,
        fuzzySkinFlags,
    )

    /** Per-kind triangle-count diff against the session's initial
     *  state. Each map entry is `tag → count`. Used by
     *  `get_paint_session_diff` so the LLM can sanity-check coverage
     *  before committing. */
    @Synchronized
    fun diffSummary(): Map<WorkspaceAction.PaintKind, IntArray> {
        // For each kind, count tris where (current != initial). The
        // session's "initial" is what we snapshotted at begin; we
        // didn't keep a separate copy because callers can recompute
        // from the live model. Instead we return a tag histogram of
        // the CURRENT state, which is what coverage_summary surfaces
        // on the live path.
        val result = HashMap<WorkspaceAction.PaintKind, IntArray>(4)
        for (kind in WorkspaceAction.PaintKind.values()) {
            val arr = arrayFor(kind) ?: continue
            // Tag histogram: support 0..32 (covers Color slots).
            val hist = IntArray(33)
            for (b in arr) {
                val t = b.toInt() and 0xff
                if (t < hist.size) hist[t]++
            }
            result[kind] = hist
        }
        return result
    }
}
