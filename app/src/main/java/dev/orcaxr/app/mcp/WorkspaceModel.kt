package dev.orcaxr.app.mcp

import dev.orcaxr.app.BedCollision
import dev.orcaxr.app.BedFit
import dev.orcaxr.app.GizmoTool
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

    /** Post an action. Suspends if the buffer is full. Used by MCP tools. */
    suspend fun emit(action: WorkspaceAction) {
        _actions.emit(action)
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

    fun setAttached(value: Boolean) { _attached.value = value }

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
