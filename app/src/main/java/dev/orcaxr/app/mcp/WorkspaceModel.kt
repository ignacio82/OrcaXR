package dev.orcaxr.app.mcp

import dev.orcaxr.app.BedCollision
import dev.orcaxr.app.BedFit
import dev.orcaxr.app.GizmoTool
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PaintBrush
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.SlicerProfile
import dev.orcaxr.app.SliceUiState
import dev.orcaxr.app.WorkspaceMode
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.withLock

/**
 * Process-scoped mirror of MainActivity's in-session state. The Compose
 * tree is still the source of truth for the live UI; MainActivity
 * publishes each tracked `remember { mutableStateOf(...) }` into the
 * matching MutableStateFlow here on every change. MCP tools READ from
 * those flows directly.
 *
 * Mutations are not direct writes — tools post a [WorkspaceAction] on
 * [actions], MainActivity collects from that flow and applies it to
 * its remember{} state, which in turn re-publishes through this
 * model's flows. This unidirectional shape avoids recomposition
 * cycles and keeps every action observable from one place (which
 * helps when we add Phase 3's "what did the LLM just do?" log).
 *
 * Fields the MCP exposes are a deliberate subset — we DON'T mirror
 * transient UI state (hover, modal-open booleans, animation phase),
 * BVH caches, or anything ephemeral. See GEMINI.md "MCP server (C6)
 * — architecture" for the cut.
 */
class WorkspaceModel internal constructor() {

    // ---- Live state ----

    private val _placedModels = MutableStateFlow<List<PlacedModel>>(emptyList())
    val placedModels: StateFlow<List<PlacedModel>> = _placedModels.asStateFlow()

    private val _selectedModelIds = MutableStateFlow<Set<String>>(emptySet())
    val selectedModelIds: StateFlow<Set<String>> = _selectedModelIds.asStateFlow()

    private val _gizmoTool = MutableStateFlow(GizmoTool.Move)
    val gizmoTool: StateFlow<GizmoTool> = _gizmoTool.asStateFlow()

    private val _paintBrush = MutableStateFlow(PaintBrush())
    val paintBrush: StateFlow<PaintBrush> = _paintBrush.asStateFlow()

    private val _workspaceMode = MutableStateFlow(WorkspaceMode.Prepare)
    val workspaceMode: StateFlow<WorkspaceMode> = _workspaceMode.asStateFlow()

    private val _activePlateId = MutableStateFlow(1)
    val activePlateId: StateFlow<Int> = _activePlateId.asStateFlow()

    private val _selectedProfile = MutableStateFlow<SlicerProfile?>(null)
    val selectedProfile: StateFlow<SlicerProfile?> = _selectedProfile.asStateFlow()

    private val _selectedPrinterId = MutableStateFlow<String?>(null)
    val selectedPrinterId: StateFlow<String?> = _selectedPrinterId.asStateFlow()

    private val _layerHeightOverride = MutableStateFlow("")
    val layerHeightOverride: StateFlow<String> = _layerHeightOverride.asStateFlow()

    private val _printSettingsOverrides = MutableStateFlow<Map<String, String>>(emptyMap())
    val printSettingsOverrides: StateFlow<Map<String, String>> = _printSettingsOverrides.asStateFlow()

    private val _sliceState = MutableStateFlow<SliceUiState>(SliceUiState.Idle)
    val sliceState: StateFlow<SliceUiState> = _sliceState.asStateFlow()

    private val _maxLayer = MutableStateFlow<Int?>(null)
    val maxLayer: StateFlow<Int?> = _maxLayer.asStateFlow()

    private val _bedFit = MutableStateFlow<BedFit?>(null)
    val bedFit: StateFlow<BedFit?> = _bedFit.asStateFlow()

    private val _bedCollision = MutableStateFlow<BedCollision.Result?>(null)
    val bedCollision: StateFlow<BedCollision.Result?> = _bedCollision.asStateFlow()

    private val _showTravels = MutableStateFlow(false)
    val showTravels: StateFlow<Boolean> = _showTravels.asStateFlow()

    private val _toolpathTubes = MutableStateFlow(true)
    val toolpathTubes: StateFlow<Boolean> = _toolpathTubes.asStateFlow()

    /**
     * Workspace-grab toggle. The XR shell's `plateMovable` flag —
     * exposed so MCP clients can flip the bed between "grab to
     * reposition" and "model gizmos take pinches" without entering
     * the bed-only mode by accident.
     */
    private val _plateMovable = MutableStateFlow(false)
    val plateMovable: StateFlow<Boolean> = _plateMovable.asStateFlow()

    /**
     * Live "as-will-print" palette. Each entry is a `#RRGGBB` hex
     * color; index `i` corresponds to filament tag `i+1` in paint
     * primitives (0 = unpainted). Sourced from
     * `resolveAsWillPrintPalette` in MainActivity which combines the
     * configured filaments + Moonraker's reported loaded spools +
     * virtual mixtures. This is what the on-bed colored-GLB renderer
     * sees, so MCP tools that need the LLM to know the actual paint
     * colors should query this rather than `list_filaments` (which
     * returns the user-configured filament list — different when the
     * printer has different spools physically loaded).
     */
    private val _previewPalette = MutableStateFlow<List<String>>(emptyList())
    val previewPalette: StateFlow<List<String>> = _previewPalette.asStateFlow()

    /**
     * True iff MainActivity has hooked itself up to this model. MCP
     * tools that mutate state should refuse with a useful error
     * message when this is false (e.g. the user backgrounded the app
     * mid-call) instead of silently dropping the action.
     */
    private val _attached = MutableStateFlow(false)
    val attached: StateFlow<Boolean> = _attached.asStateFlow()

    // ---- Actions ----

    /**
     * Mutation channel. Replay 0 (we don't want late-attached
     * collectors to re-run already-applied actions). Buffer 64 so a
     * burst of "select all and rotate everything 90°" tool calls
     * doesn't block the JSON-RPC handler. SUSPEND on overflow because
     * dropping commands would be worse than backpressure.
     */
    private val _actions = MutableSharedFlow<WorkspaceAction>(
        replay = 0,
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.SUSPEND,
    )
    val actions: SharedFlow<WorkspaceAction> = _actions.asSharedFlow()

    /**
     * D18g — sequence numbers for action drain tracking. Each
     * `emit` returns a monotonically-increasing id; the binding's
     * collector calls `markDrained(id)` after handling. The MCP
     * `flush_actions` tool then suspends until
     * `lastDrainedActionId.value >= my_id`, so a tool sequence like
     * `replace_paint_tag → flush_actions → paint_slab(only_tagged)`
     * sees post-drain state on the second read instead of racing
     * the queue.
     */
    private val _lastEmittedId = MutableStateFlow(0L)
    val lastEmittedActionId: StateFlow<Long> = _lastEmittedId.asStateFlow()

    private val _lastDrainedId = MutableStateFlow(0L)
    val lastDrainedActionId: StateFlow<Long> = _lastDrainedId.asStateFlow()

    private val emitMutex = kotlinx.coroutines.sync.Mutex()

    /**
     * Post an action. Suspends if the buffer is full. Returns the
     * action's monotonic emit id so callers (the `paint_*` tools)
     * can pass it to `flush_actions` to wait for the binding to
     * drain.
     */
    suspend fun emit(action: WorkspaceAction): Long {
        val id = emitMutex.withLock {
            val next = _lastEmittedId.value + 1
            _lastEmittedId.value = next
            next
        }
        _actions.emit(action)
        return id
    }

    /** Called by `WorkspaceBinding`'s collector after each
     *  action has been dispatched onto the host setters. */
    fun markDrained(id: Long) {
        // SharedFlow collection is FIFO so ids arrive in order, but
        // be defensive against future reordering: only ratchet up.
        val cur = _lastDrainedId.value
        if (id > cur) _lastDrainedId.value = id
    }

    // ---- Publisher API (called from MainActivity LaunchedEffects) ----

    fun publishPlacedModels(value: List<PlacedModel>) { _placedModels.value = value }
    fun publishSelectedModelIds(value: Set<String>) { _selectedModelIds.value = value }
    fun publishGizmoTool(value: GizmoTool) { _gizmoTool.value = value }
    fun publishPaintBrush(value: PaintBrush) { _paintBrush.value = value }
    fun publishWorkspaceMode(value: WorkspaceMode) { _workspaceMode.value = value }
    fun publishActivePlateId(value: Int) { _activePlateId.value = value }
    fun publishSelectedProfile(value: SlicerProfile?) { _selectedProfile.value = value }
    fun publishSelectedPrinterId(value: String?) { _selectedPrinterId.value = value }
    fun publishLayerHeightOverride(value: String) { _layerHeightOverride.value = value }
    fun publishPrintSettingsOverrides(value: Map<String, String>) { _printSettingsOverrides.value = value }
    fun publishSliceState(value: SliceUiState) { _sliceState.value = value }
    fun publishMaxLayer(value: Int?) { _maxLayer.value = value }
    fun publishBedFit(value: BedFit?) { _bedFit.value = value }
    fun publishBedCollision(value: BedCollision.Result?) { _bedCollision.value = value }
    fun publishShowTravels(value: Boolean) { _showTravels.value = value }
    fun publishToolpathTubes(value: Boolean) { _toolpathTubes.value = value }
    fun publishPlateMovable(value: Boolean) { _plateMovable.value = value }
    fun publishPreviewPalette(value: List<String>) { _previewPalette.value = value }

    fun setAttached(value: Boolean) { _attached.value = value }

    // ---- BVH provider (C9 — AI paint pillar) ----
    //
    // The XR brush keeps its own BVH cache (built lazily on first
    // paint-mode toggle in MainActivity, see comment at LE_3166). MCP
    // tools also need that BVH so spatial paint primitives (sphere /
    // slab / normal-cone / surface-region / connected-component /
    // projected-mask) can compute triangle index sets. We keep them
    // sharing the SAME cache via this provider — registered by
    // MainActivity once `bvhCache` is in scope, called from the
    // suspend tool body. The provider builds on demand if the cache is
    // cold (XR paint mode never touched), which lets an LLM-driven
    // session start straight from a cold paint state.
    fun interface BvhProvider {
        suspend fun getBvh(modelId: String): MeshBvh?
    }

    @Volatile private var bvhProvider: BvhProvider? = null

    fun setBvhProvider(provider: BvhProvider?) {
        bvhProvider = provider
    }

    /**
     * Suspend-safe lookup. Returns null if no provider is registered
     * (tests / app backgrounded) or the model id is unknown / the
     * source mesh fails to read.
     */
    suspend fun getBvh(modelId: String): MeshBvh? =
        bvhProvider?.getBvh(modelId)

    companion object {
        @Volatile private var instance: WorkspaceModel? = null

        fun get(): WorkspaceModel {
            instance?.let { return it }
            return synchronized(this) {
                instance ?: WorkspaceModel().also { instance = it }
            }
        }
    }
}
