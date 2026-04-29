package dev.orcaxr.app

import android.content.Context
import android.content.pm.ActivityInfo
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.contentColorFor
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.xr.compose.spatial.Subspace
import androidx.xr.compose.subspace.SceneCoreEntity
import androidx.xr.compose.subspace.SpatialPanel
import androidx.xr.compose.subspace.layout.SubspaceModifier
import androidx.xr.compose.subspace.layout.height as subspaceHeight
// SubspaceModifier.movable() is internal in androidx.xr.compose alpha12
// (the latest published version, confirmed via Maven). Once it goes
// public we can re-add the import and chain `.movable()` per panel; for
// now only the workspace's MovableComponent (XrShell) gives drag
// support, and individual SpatialPanels stay at their authored offsets.
import androidx.xr.compose.subspace.layout.offset
import androidx.xr.compose.subspace.layout.width as subspaceWidth
import androidx.xr.runtime.Session
import androidx.xr.runtime.SessionCreateSuccess
import androidx.xr.scenecore.GltfModel
import androidx.xr.scenecore.GltfModelEntity
import androidx.xr.scenecore.GroupEntity
import androidx.xr.scenecore.scene
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.io.File

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.RestartAlt
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.SettingsInputComponent
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.OpenWith
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.AspectRatio
import androidx.compose.material.icons.filled.VerticalAlignBottom
import androidx.compose.material.icons.filled.Architecture
import androidx.compose.material.icons.filled.AddCircleOutline
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Workspaces

/**
 * Hand-picked Material3 dark scheme that reads cleanly against the
 * Galaxy XR passthrough background. Replaces the empty `MaterialTheme {}`
 * default which left the panel rendering as solid black.
 */
private val OrcaXrColorScheme = darkColorScheme(
    primary = Color(0xFF7BC8FF),
    onPrimary = Color(0xFF002D45),
    surface = Color(0xFF1B1F23),
    onSurface = Color(0xFFE6EAEE),
    surfaceVariant = Color(0xFF2A2F35),
    onSurfaceVariant = Color(0xFFB6BEC8),
    background = Color(0xFF15181B),
    onBackground = Color(0xFFE6EAEE),
)

private val initialPanelPoses = mutableMapOf<String, androidx.xr.runtime.math.Pose>()
// Use a state-backed map so Compose recomposes when we change poses
private val panelPoses = androidx.compose.runtime.mutableStateMapOf<String, androidx.xr.runtime.math.Pose>()

@Composable
fun MovablePanelWrapper(
    id: String,
    width: androidx.compose.ui.unit.Dp,
    height: androidx.compose.ui.unit.Dp,
    initialOffset: androidx.xr.runtime.math.Vector3,
    session: Session,
    content: @Composable () -> Unit
) {
    val ctx = LocalContext.current

    // Convert dp to meters for SceneCore dimensions.
    // 1000dp is roughly 1 meter in default spatial scale.
    val widthMeters = width.value / 1000f
    val heightMeters = height.value / 1000f

    val initialPose = remember(id) {
        androidx.xr.runtime.math.Pose(initialOffset, androidx.xr.runtime.math.Quaternion.Identity)
    }

    LaunchedEffect(id) {
        if (!initialPanelPoses.containsKey(id)) {
            initialPanelPoses[id] = initialPose
            panelPoses[id] = initialPose
        }
    }

    val currentPose = panelPoses[id] ?: initialPose

    // Title-bar grab strip dimensions (in meters). Sized so a thumb /
    // laser hit at the top of the panel grabs to move; everything
    // below the strip falls through to the SpatialPanel's pointer
    // pipeline so Compose vertical-scroll gestures actually scroll
    // instead of moving the panel. Phase J's longer-than-tall left
    // project panel particularly needs this — the original full-
    // panel grab volume swallowed all drag gestures on the surface.
    val handleHeightMeters = 0.04f
    val handleDepthMeters = 0.02f
    SceneCoreEntity(
        factory = {
            val group = androidx.xr.scenecore.GroupEntity.create(session, "panel-$id")
            val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
            val listener = object : androidx.xr.scenecore.EntityMoveListener {
                override fun onMoveUpdate(
                    entity: androidx.xr.scenecore.Entity,
                    currentInputRay: androidx.xr.runtime.math.Ray,
                    currentPose: androidx.xr.runtime.math.Pose,
                    currentScale: Float,
                ) {
                    // Lock rotation to identity to keep panels facing
                    // forward. The MovableComponent moves the GROUP
                    // entity directly, which is also where the panel
                    // is parented — the panel follows.
                    val newPose = androidx.xr.runtime.math.Pose(
                        currentPose.translation,
                        androidx.xr.runtime.math.Quaternion.Identity,
                    )
                    panelPoses[id] = newPose
                    entity.setPose(newPose)
                }
            }
            val mc = androidx.xr.scenecore.MovableComponent.createCustomMovable(
                session,
                /* scaleInZ = */ false,
                executor,
                listener,
            )
            // Top-strip grab volume only. The volume sits on the
            // GROUP entity (which is centered on the panel's center
            // in our layout), so we size to (panel-width × 4cm
            // × 2cm depth) and the MovableComponent's listener
            // accepts drags only on that slim region. The slim Z
            // depth (2cm) keeps the volume in front of the panel
            // without a deep "shelf" sticking into the user's
            // gesture path.
            //
            // Caveat: the volume centers on the group's pose, which
            // is the panel's center. So the grab strip sits across
            // the MIDDLE of the panel, not the top, with the current
            // architecture. To actually put it at the top we'd need
            // to reparent the SpatialPanel to a child entity offset
            // downward by half the panel height — rather than
            // restructure for v1, we just accept the middle-strip
            // grab and document. The 4cm strip is much smaller than
            // the previous full-panel volume, so the bulk of the
            // panel is now scrollable.
            mc.size = androidx.xr.runtime.math.FloatSize3d(
                widthMeters,
                handleHeightMeters,
                handleDepthMeters,
            )
            group.addComponent(mc)

            group
        },
        modifier = SubspaceModifier.offset(
            x = (currentPose.translation.x * 1000f).dp,
            y = (currentPose.translation.y * 1000f).dp,
            z = (currentPose.translation.z * 1000f).dp
        ),
    ) {
        SpatialPanel(
            modifier = SubspaceModifier
                .subspaceWidth(width)
                .subspaceHeight(height),
            content = content
        )
    }
}

class MainActivity : ComponentActivity() {

    private val xrSession = MutableStateFlow<Session?>(null)
    private lateinit var prefs: UserPreferences
    private lateinit var userProfiles: UserProfilesStore
    private lateinit var printers: PrintersStore
    private lateinit var discovery: PrinterDiscovery
    private lateinit var filamentSlots: FilamentSlotsStore
    private lateinit var filamentEntries: FilamentEntriesStore
    private lateinit var mixedFilaments: MixedFilamentStore
    /** Roadmap D1 — paint state persisted by source-file SHA-256 so a
     *  reloaded STL/3MF restores its prior paint without the user
     *  having to redo every stroke. */
    private lateinit var paintCache: PaintCacheStore
    /** Roadmap B7 — most-recently-used model files, surfaced on the
     *  empty-state panel when [placedModels] is empty. */
    private lateinit var recentFiles: RecentFilesStore

    /**
     * Activity-scoped controller event sink. Galaxy XR controller plan
     * (docs/GALAXY_XR_CONTROLLER_PLAN.md). Lives as long as the Activity;
     * read inside `setContent` via [LocalControllerInput]. Reset in
     * [onPause] so a stick stuck deflected when the user removes the
     * headset doesn't keep scrubbing on resume.
     */
    private val controllerInput = ControllerInputBus()

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        // Disable HttpURLConnection's connection pool. Subnet scan
        // validations against working Moonraker URLs were failing with
        // SocketException("closed") because the pool returned sockets
        // whose far end (nginx in front of Moonraker) had already torn
        // down keepalive. Belt-and-suspenders alongside the
        // per-request "Connection: close" header in MoonrakerClient.
        System.setProperty("http.keepAlive", "false")
        prefs = UserPreferences(this)
        userProfiles = UserProfilesStore(this)
        printers = PrintersStore(this)
        discovery = PrinterDiscovery(this)
        filamentSlots = FilamentSlotsStore(this)
        filamentEntries = FilamentEntriesStore(this)
        mixedFilaments = MixedFilamentStore(this)
        paintCache = PaintCacheStore(this)
        recentFiles = RecentFilesStore(this)
        enableEdgeToEdge()

        // Pre-Compose XR setup: transparent window so passthrough
        // shows through, wide color gamut. Done synchronously before
        // setContent so the first frame has the right surface configuration.
        window.setBackgroundDrawable(ColorDrawable(android.graphics.Color.TRANSPARENT))
        window.colorMode = ActivityInfo.COLOR_MODE_WIDE_COLOR_GAMUT

        // Session.create registers a lifecycle observer against this Activity
        // — must be synchronous in onCreate, not inside a Composable
        // LaunchedEffect, to avoid races on config changes.
        xrSession.value = try {
            (Session.create(this) as? SessionCreateSuccess)?.session
        } catch (e: Throwable) {
            null
        }

        setContent {
            val session by xrSession.collectAsState()
            // Explicit colorScheme — empty MaterialTheme {} produced a
            // panel that read as solid black on XR (light scheme's white
            // surface was being composited against passthrough oddly).
            // Dark scheme with high-contrast colors reads cleanly on top
            // of the headset's passthrough.
            MaterialTheme(colorScheme = OrcaXrColorScheme) {
                CompositionLocalProvider(
                    LocalContentColor provides contentColorFor(MaterialTheme.colorScheme.background),
                    LocalControllerInput provides controllerInput,
                ) {
                    // One-time past-crash banner. Snapshotted at first
                    // composition so dismissing doesn't re-trigger if
                    // CrashReporter writes a new file mid-session
                    // (which would be the user crashing the app right
                    // now — we'll surface that on the NEXT launch, not
                    // mid-session). The banner shows the count plus
                    // file paths and offers a one-tap dismiss that
                    // deletes every past-crash file.
                    val pastCrashes = remember { CrashReporter.scanPastCrashes(this@MainActivity) }
                    var crashBannerDismissed by remember { mutableStateOf(false) }
                    if (pastCrashes.isNotEmpty() && !crashBannerDismissed) {
                        PastCrashBanner(
                            files = pastCrashes,
                            onDismiss = {
                                CrashReporter.clearPastCrashes(this@MainActivity)
                                crashBannerDismissed = true
                            },
                        )
                    }
                    val sliceState = remember { mutableStateOf<SliceUiState>(SliceUiState.Idle) }
                    val maxLayer = remember { mutableStateOf<Int?>(null) }
                    val selectedProfile = remember { mutableStateOf(prefs.lastProfileOrDefault()) }
                    val layerHeightOverride = remember { mutableStateOf(prefs.layerHeightOverride) }
                    // Phase XR_UI §3 — sparse user overrides for Speed /
                    // Support fields. Hoisted to MainActivity so the
                    // Save-as-profile path below can bake the user's
                    // current edits into the persisted SlicerProfile.
                    val printSettingsOverrides = remember { mutableStateOf(mapOf<String, String>()) }
                    val showTravels = remember { mutableStateOf(prefs.showTravels) }
                    // Roadmap A7 — toolpath rendering mode persisted in
                    // SharedPreferences. true = 4-sided tubes, false =
                    // single LINES; defaults to LINES because tubes
                    // are a follow-up enhancement and the lighter
                    // primitive ships fine on Galaxy XR.
                    val toolpathTubes = remember { mutableStateOf(prefs.toolpathTubes) }
                    val selectedPrinterId = remember { mutableStateOf(prefs.lastPrinterId) }
                    LaunchedEffect(selectedPrinterId.value) {
                        prefs.lastPrinterId = selectedPrinterId.value
                    }
                    val userProfilesList by userProfiles.profiles.collectAsState(initial = emptyList())
                    // Flattened OrcaSlicer JSON profiles bundled under
                    // app/src/main/assets/profiles/Snapmaker/. Loaded
                    // once per process and reused — the asset tree is
                    // immutable for a given install.
                    val bundledProfiles = remember { OrcaProfileLoader.loadCatalog(this@MainActivity) }
                    val allProfiles = remember(userProfilesList, bundledProfiles) {
                        bundledProfiles + Profiles.all + userProfilesList
                    }
                    val composeScope = rememberCoroutineScope()
                    LaunchedEffect(selectedProfile.value.id) {
                        prefs.lastProfileId = selectedProfile.value.id
                    }
                    LaunchedEffect(layerHeightOverride.value) {
                        prefs.layerHeightOverride = layerHeightOverride.value
                    }
                    LaunchedEffect(showTravels.value) {
                        prefs.showTravels = showTravels.value
                    }
                    LaunchedEffect(toolpathTubes.value) {
                        prefs.toolpathTubes = toolpathTubes.value
                    }
                    // Profile selection rules, in order:
                    //  1. If the user previously picked something and it
                    //     still exists in allProfiles, keep it.
                    //  2. If this is a fresh install (no saved id) and
                    //     the bundled Snapmaker U1 (0.4 nozzle, 0.20
                    //     Standard, Generic PLA) profile is available,
                    //     seed with that — that's our primary target
                    //     printer and it should show up out of the box.
                    //  3. Otherwise fall back to Profiles.default
                    //     (Elegoo Centauri Carbon) so the dropdown
                    //     still has something selected.
                    val hasSavedProfile = remember { prefs.hasSelectedProfileBefore }
                    val savedProfileId = remember { prefs.lastProfileId }
                    LaunchedEffect(allProfiles) {
                        val current = selectedProfile.value
                        if (allProfiles.any { it.id == current.id }) return@LaunchedEffect

                        // First pass: if the user previously picked a
                        // profile that lives in a JSON-loaded brand
                        // (Snapmaker, Elegoo) — Profiles.lastProfileOrDefault()
                        // can't see those because it only checks
                        // Profiles.all, which is empty now that all
                        // bundled profiles flow through the JSON loader.
                        // Re-resolve the saved id here against the full
                        // catalog before falling through to defaults.
                        val savedMatch = savedProfileId?.let { id -> allProfiles.firstOrNull { it.id == id } }
                        if (savedMatch != null) {
                            selectedProfile.value = savedMatch
                            return@LaunchedEffect
                        }

                        val preferred = if (!hasSavedProfile) {
                            allProfiles.firstOrNull { it.id == PREFERRED_DEFAULT_PROFILE_ID }
                        } else null
                        selectedProfile.value = preferred ?: Profiles.default
                    }
                    val onSaveAsProfile: (String) -> Unit = { name ->
                        composeScope.launch {
                            // Snapshot the current effective config —
                            // base profile + the user's runtime overrides.
                            // The new profile bakes in those tweaks so
                            // re-selecting it later restores the same
                            // slice settings.
                            //
                            // Slot colors are intentionally NOT baked
                            // into a saved profile (they're a per-
                            // printer concern, persisted by
                            // FilamentSlotsStore independently). Pass
                            // an empty palette so the saved profile
                            // doesn't lock to the current colors.
                            val merged = mergedConfig(
                                selectedProfile.value,
                                layerHeightOverride.value,
                                emptyList(),
                                extraOverrides = printSettingsOverrides.value,
                            )
                            val safeName = name.trim().ifBlank { "User profile" }
                            val safeId = name
                                .replace(Regex("[^A-Za-z0-9._-]"), "_")
                                .lowercase()
                                .ifBlank { "user" }
                            val newProfile = SlicerProfile(
                                id = "user_${System.currentTimeMillis().toString(36)}_$safeId",
                                displayName = safeName,
                                description = "User profile",
                                config = merged,
                            )
                            userProfiles.upsert(newProfile)
                            selectedProfile.value = newProfile
                        }
                    }
                    val onDeleteProfile: (String) -> Unit = { id ->
                        composeScope.launch { userProfiles.delete(id) }
                    }
                    val printersList by printers.printers.collectAsState(initial = emptyList())
                    val discoveredPrinters by discovery.services.collectAsState()
                    val filamentSlotsAll by filamentSlots.all.collectAsState(initial = emptyMap())
                    val filamentEntriesAll by filamentEntries.all.collectAsState(initial = emptyMap())
                    val mixedFilamentsAll by mixedFilaments.all.collectAsState(initial = emptyMap())
                    val s = session
                    if (s != null) {
                        XrShell(s, sliceState, maxLayer, selectedProfile, layerHeightOverride,
                            printSettingsOverrides = printSettingsOverrides,
                            showTravels = showTravels,
                            toolpathTubes = toolpathTubes,
                            allProfiles = allProfiles,
                            onSaveAsProfile = onSaveAsProfile,
                            onDeleteProfile = onDeleteProfile,
                            printers = printersList,
                            printersStore = printers,
                            discoveryService = discovery,
                            discoveredPrinters = discoveredPrinters,
                            selectedPrinterId = selectedPrinterId,
                            filamentSlotsStore = filamentSlots,
                            filamentSlotsAll = filamentSlotsAll,
                            filamentEntriesStore = filamentEntries,
                            filamentEntriesAll = filamentEntriesAll,
                            mixedFilamentsStore = mixedFilaments,
                            mixedFilamentsAll = mixedFilamentsAll,
                            paintCache = paintCache,
                            recentFiles = recentFiles)
                    } else {
                        FlatShell(sliceState, maxLayer, selectedProfile, layerHeightOverride, showTravels)
                    }
                }
            }
        }
    }

    // ---------------- Galaxy XR controller input ----------------
    //
    // Plan: docs/GALAXY_XR_CONTROLLER_PLAN.md §3.2.
    //
    // Rule: only consume events whose source is a gamepad/joystick.
    // SpatialPanel pointer events ride on `InputEvent`
    // (Source.CONTROLLER), populated by the XR runtime from OpenXR
    // action bindings — not from MotionEvent. Compose scrollables
    // react to SOURCE_TOUCHSCREEN / SOURCE_MOUSE / D-pad keys, not
    // joystick axes. Both pipelines target disjoint event types per
    // documentation, so Activity-level consumption here can't
    // accidentally swallow scroll/pinch/click input.
    //
    // The `repeatCount != 0` guard on key events prevents auto-repeat
    // firing of the contextual binding (matters for B/Y; A's "select"
    // is fine to repeat).

    override fun onGenericMotionEvent(event: android.view.MotionEvent): Boolean {
        val isStick = event.source and android.view.InputDevice.SOURCE_JOYSTICK ==
            android.view.InputDevice.SOURCE_JOYSTICK
        if (!isStick) return super.onGenericMotionEvent(event)

        // Both Galaxy XR sticks dispatch as AXIS_X/AXIS_Y from their
        // respective InputDevices. v1 treats them equivalently: take
        // whichever stick is non-zero this frame. Right-stick fallback
        // (AXIS_Z / AXIS_RZ) covers drivers that route the second stick
        // through the conventional gamepad axes.
        val xRaw = event.getAxisValue(android.view.MotionEvent.AXIS_X)
        val yRaw = event.getAxisValue(android.view.MotionEvent.AXIS_Y)
        val zRaw = event.getAxisValue(android.view.MotionEvent.AXIS_Z)
        val rzRaw = event.getAxisValue(android.view.MotionEvent.AXIS_RZ)

        // Apply MotionRange.flat to drop resting noise on a centered
        // stick. The scrubRate / nudge consumers also apply a deadband,
        // but pushing zero through the bus keeps the StateFlow honest
        // when the stick recenters (so debounced bindings see the
        // recenter and re-arm).
        val flatX = event.device?.getMotionRange(android.view.MotionEvent.AXIS_X, event.source)?.flat ?: 0.1f
        val flatY = event.device?.getMotionRange(android.view.MotionEvent.AXIS_Y, event.source)?.flat ?: 0.1f
        val flatZ = event.device?.getMotionRange(android.view.MotionEvent.AXIS_Z, event.source)?.flat ?: 0.1f
        val flatRz = event.device?.getMotionRange(android.view.MotionEvent.AXIS_RZ, event.source)?.flat ?: 0.1f

        val xLeft = if (kotlin.math.abs(xRaw) > flatX) xRaw else 0f
        val yLeft = if (kotlin.math.abs(yRaw) > flatY) yRaw else 0f
        val xRight = if (kotlin.math.abs(zRaw) > flatZ) zRaw else 0f
        val yRight = if (kotlin.math.abs(rzRaw) > flatRz) rzRaw else 0f

        val x = if (xLeft != 0f) xLeft else xRight
        // MotionEvent's Y axis points DOWN (positive = stick pushed away
        // from the user). Layer-scrub rate consumers expect "stick up =
        // forward through layers" / positive rate, so flip sign here.
        val yMerged = if (yLeft != 0f) yLeft else yRight
        val y = -yMerged

        controllerInput.setLeftStick(x, y)
        if (android.util.Log.isLoggable("OrcaXR/input", android.util.Log.VERBOSE)) {
            android.util.Log.v("OrcaXR/input", "axes x=$x y=$y (raw l=$xRaw,$yRaw r=$zRaw,$rzRaw)")
        }
        return true
    }

    override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent): Boolean {
        val src = event.device?.sources ?: 0
        val isGamepad = src and android.view.InputDevice.SOURCE_GAMEPAD ==
            android.view.InputDevice.SOURCE_GAMEPAD
        if (!isGamepad || event.repeatCount != 0) return super.onKeyDown(keyCode, event)
        val button = when (keyCode) {
            android.view.KeyEvent.KEYCODE_BUTTON_A -> ControllerButton.A
            android.view.KeyEvent.KEYCODE_BUTTON_B -> ControllerButton.B
            android.view.KeyEvent.KEYCODE_BUTTON_X -> ControllerButton.X
            android.view.KeyEvent.KEYCODE_BUTTON_Y -> ControllerButton.Y
            else -> return super.onKeyDown(keyCode, event)
        }
        controllerInput.emitButton(button)
        android.util.Log.v("OrcaXR/input", "button down $button (keyCode=$keyCode)")
        return true
    }

    override fun onKeyUp(keyCode: Int, event: android.view.KeyEvent): Boolean {
        // Symmetric source guard so the platform's default key handling
        // doesn't re-route an A-button release into something surprising.
        // We don't need a per-button release event — the SharedFlow only
        // fires on press — but we do need to claim the event so it
        // doesn't fall through.
        val src = event.device?.sources ?: 0
        val isGamepad = src and android.view.InputDevice.SOURCE_GAMEPAD ==
            android.view.InputDevice.SOURCE_GAMEPAD
        if (!isGamepad) return super.onKeyUp(keyCode, event)
        return when (keyCode) {
            android.view.KeyEvent.KEYCODE_BUTTON_A,
            android.view.KeyEvent.KEYCODE_BUTTON_B,
            android.view.KeyEvent.KEYCODE_BUTTON_X,
            android.view.KeyEvent.KEYCODE_BUTTON_Y -> true
            else -> super.onKeyUp(keyCode, event)
        }
    }

    override fun onPause() {
        // A stick stuck deflected when the user removes the headset
        // would keep scrubbing on resume — reset axis snapshots to 0.
        // SharedFlow doesn't need a reset (replay=0).
        controllerInput.resetAxes()
        super.onPause()
    }
}

@Composable
private fun XrShell(
    session: Session,
    sliceState: MutableState<SliceUiState>,
    maxLayer: MutableState<Int?>,
    selectedProfile: MutableState<SlicerProfile>,
    layerHeightOverride: MutableState<String>,
    /** Phase XR_UI §3 — sparse user overrides for the Right Settings
     *  panel's Speed and Support fields. Hoisted from MainActivity so
     *  saved profiles can bake them in. */
    printSettingsOverrides: MutableState<Map<String, String>>,
    showTravels: MutableState<Boolean>,
    /** Roadmap A7 — toolpath tubes toggle (4-sided prism per segment
     *  vs single LINES). Persisted via [UserPreferences.toolpathTubes]. */
    toolpathTubes: MutableState<Boolean>,
    allProfiles: List<SlicerProfile>,
    onSaveAsProfile: (String) -> Unit,
    onDeleteProfile: (String) -> Unit,
    printers: List<PrinterConfig>,
    printersStore: PrintersStore,
    discoveryService: PrinterDiscovery,
    discoveredPrinters: List<DiscoveredPrinter>,
    selectedPrinterId: MutableState<String?>,
    filamentSlotsStore: FilamentSlotsStore,
    filamentSlotsAll: Map<String, List<String>>,
    filamentEntriesStore: FilamentEntriesStore,
    filamentEntriesAll: Map<String, List<FilamentEntry>>,
    mixedFilamentsStore: MixedFilamentStore,
    mixedFilamentsAll: Map<String, List<MixedFilamentEntry>>,
    /** Roadmap D1 — paint state persisted by source-file SHA-256.
     *  Looked up on model load and written back on every paint
     *  mutation. */
    paintCache: PaintCacheStore,
    /** Roadmap B7 — most-recently-used model files for the empty-
     *  state panel. Updated on every successful onFileSelected. */
    recentFiles: RecentFilesStore,
) {
    val ctx = LocalContext.current
    var glbPath by remember { mutableStateOf<String?>(null) }
    var glbVersion by remember { mutableStateOf(0) } // bump per regeneration
    var stlPreviewPath by remember { mutableStateOf<String?>(null) }
    var stlPreviewVersion by remember { mutableStateOf(0) }
    var buildPlatePath by remember { mutableStateOf<String?>(null) }
    var showFilePicker by remember { mutableStateOf(false) }
    var workspaceMode by remember { mutableStateOf(WorkspaceMode.Prepare) }
    var bedFit by remember { mutableStateOf<BedFit?>(null) }
    // Roadmap A6 — full mesh-vs-bed collision check. Lives alongside
    // bedFit (which is bbox-only and remains the size summary banner)
    // and is the gating signal for the Slice button when a vertex
    // lands outside the printable polygon.
    var bedCollision by remember { mutableStateOf<BedCollision.Result?>(null) }

    // Phase J in-XR painting state. `paintBrush.mode == Off` is the
    // default — paint stays disabled until the user opts in via the
    // top-nav Paint↔Move toggle. While paint is active the per-model
    // MovableComponent (model-grab handle) is suppressed so the
    // controller laser hits the model entity directly.
    var paintBrush by remember { mutableStateOf(PaintBrush()) }
    val paintBrushLive = rememberUpdatedState(paintBrush)
    // Per-`PlacedModel` BVH cache. Built lazily when paint mode goes
    // active for a model that doesn't yet have one. Survives
    // rotation / scale because StlMesh transforms preserve triangle
    // order — only the source-mesh swap (replacing
    // `PlacedModel.source`) needs an explicit invalidate.
    val bvhCache = remember { MeshBvhCache() }

    // The active printer's slot palette padded to its profile's
    // extruder count, so a U1 always renders 4 swatches and a
    // single-extruder printer renders 1. Recomputed when the user
    // swaps profile, swaps active printer, or edits a slot color.
    val activePrinter = printers.firstOrNull { it.id == selectedPrinterId.value }
    // Slot count is a *hardware* property of the selected printer, not
    // the slicer profile. Snapmaker's Android fork hard-codes 4 for
    // the U1; the desktop fork reads `nozzle_diameter.size()` from
    // the printer profile (which always reports 4 for the U1
    // toolchanger). If the user picks a single-extruder slicer
    // profile (Generic PLA Standard) we used to drop to 1 slot
    // even with the U1 plugged in — surfaced as "no T1/T2/… options"
    // in the slot dropdown. Fix: detect U1 by name as the simplest
    // override; otherwise fall back to the profile's nozzle_diameter
    // length.
    val slotCount = slotCountForWithSaved(
        activePrinter,
        selectedProfile.value,
        activePrinter?.id?.let(filamentEntriesAll::get),
    )
    // Project-level filament list for the active printer, normalized to
    // exactly slotCount entries indexed by slot. Snapmaker fork's UX:
    // there's no "unassigned" filament — every slot has a row, edits
    // are addressed by slot index, no add/remove. Persisted entries
    // get re-keyed by slotIndex; missing slots are filled with a
    // default-palette synthetic entry so the UI is fully data-driven.
    val filamentList: List<FilamentEntry> = remember(activePrinter, filamentEntriesAll, slotCount, filamentSlotsStore) {
        val saved = activePrinter?.id?.let(filamentEntriesAll::get).orEmpty()
        val bySlot = saved.mapNotNull { e -> e.slotIndex?.let { it to e } }.toMap()
        (0 until slotCount).map { slot ->
            bySlot[slot] ?: FilamentEntry(
                id = "slot_${slot}_default",
                color = filamentSlotsStore.defaultPalette[slot % filamentSlotsStore.defaultPalette.size],
                slotIndex = slot,
            )
        }
    }
    // Effective slot palette = filamentList colors in slot order.
    // This is what we send to libslic3r as `extruder_colour`.
    val filamentsCatalog = remember(ctx) { OrcaProfileLoader.loadFilaments(ctx) }
    val paddedSlots = remember(filamentList) { filamentList.map { it.color } }
    // Per-project-filament override of which physical printer slot
    // emits the T-command for that filament's painted facets. Null at
    // index N = identity (project filament N → physical T_N), which
    // is the default until the user picks from the picker's "Loaded
    // in printer" row. Drives the libslic3r `filament_map` config
    // key in mergedConfig.
    val paddedSlotRemap = remember(filamentList) { filamentList.map { it.physicalSlot } }
    // FullSpectrum virtual remap. IntArray sized to the project filament
    // count where each entry is 0 (no remap) or K>0 (the user picked
    // virtual mixed filament K for this project filament). Drives
    // nativeSlice's face-state rewrite — when set, the painted faces
    // for that project filament get rewritten to virtual ID
    // (num_physical + K) right after model load, so PrintApply produces
    // a painted region tagged virtual and ToolOrdering's resolve_mixed_
    // 1based picks component A or B per layer.
    val paddedVirtualRemap: IntArray = remember(filamentList) {
        IntArray(filamentList.size) { i -> filamentList[i].virtualSlot ?: 0 }
    }

    // FullSpectrum mixed-filament rows for the active printer. The list is
    // serialized into the `mixed_filament_definitions` config key on each
    // slice via mergedConfig. The slicing engine picks them up in
    // PrintApply (patches/0018) and routes them through MixedFilamentManager;
    // ToolOrdering / 3MF metadata integration (phases C & D) lands later,
    // so today the rows show up in the panel and reach the engine but the
    // emitted G-code is still single-filament per slot. Persisting them
    // here means the moment those engine phases land, the wiring is ready.
    val mixedRows: List<MixedFilamentEntry> = remember(activePrinter, mixedFilamentsAll) {
        activePrinter?.id?.let(mixedFilamentsAll::get).orEmpty()
    }
    val mixedFilamentDefinitions = remember(mixedRows) {
        mixedFilamentsStore.toMixedFilamentDefinitions(mixedRows)
    }

    // Phase E (filament-vs-bed compatibility). The bundled rules JSON is
    // small and parsed once at composition time; the evaluator re-runs
    // whenever the filament list changes (so adding/removing/retyping a
    // slot updates the banner immediately). The bed type is currently
    // hardcoded to PEI in mergedConfig (curr_bed_type = "Textured PEI
    // Plate"), matching the U1's stock plate; when we add per-printer
    // bed-type selection this lookup picks up automatically via
    // bedKeyFor.
    val filamentRules = remember(ctx) { FilamentRules.loadFromAssets(ctx) }
    val filamentRuleResult: FilamentRules.Result = remember(filamentRules, filamentList) {
        FilamentRules.evaluate(
            filamentRules,
            FilamentRules.bedKeyFor("Textured PEI Plate"),
            filamentList.map { it.filamentType },
        )
    }
    // Phase H.2: top-cover hint from the active profile's
    // `requires_top_cover` array. Default-quiet today because no
    // bundled profile sets the key — the banner only surfaces once
    // a Phase B leaf for ABS-CF / PA-CF / etc. lands with the flag
    // set per the Snapmaker fork's filament JSONs. Reads off the
    // un-merged profile.config; mergedConfig pads to the slot count
    // but the rule treats a single "1" as enough to fire.
    val topCoverHint: TopCoverRule.Result = remember(selectedProfile.value) {
        TopCoverRule.evaluate(selectedProfile.value.config)
    }

    // Currently-plated models on the bed, waiting for the user to hit
    // Slice. Decoupling from sliceState matches OrcaSlicer's workflow:
    // the user adjusts profile / layer height / supports before any
    // slicing happens. We don't want to silently re-slice a 30 s job
    // every time they change their mind.
    //
    // Phase G replaces the single `loadedStl` with a list. The
    // `selectedModelId` picks which model the rotate/scale/grab tools
    // operate on; backward-compat derived values (loadedStl,
    // modelRotZDeg, etc.) read off the selected model so most consumers
    // didn't have to change.
    var placedModels by remember { mutableStateOf<List<PlacedModel>>(emptyList()) }
    var selectedModelId by remember { mutableStateOf<String?>(null) }
    // Phase XR_OBJ_1: tracks which model the laser is currently hovering
    // over. Set by the per-model InteractableComponent's HOVER_ENTER /
    // HOVER_EXIT events. The hover-ghost outline is deferred to a follow-
    // up; the state is wired now so future passes don't need to thread
    // it back through `GlbSceneEntity`.
    var hoveredModelId by remember { mutableStateOf<String?>(null) }
    // Path of the last 3mf whose embedded `filament_colour` we
    // synced into FilamentEntries. We only auto-overwrite on the
    // FIRST load of a given file path — subsequent renders (the
    // re-preview LaunchedEffect that fires on every paddedSlots
    // change, including the user's color edits) must NOT re-snap
    // colors back to the file's authored values. Otherwise the
    // user's tap-to-pick-color would be undone within milliseconds.
    var lastEmbeddedSyncPath by remember { mutableStateOf<String?>(null) }
    // Project-level flush-tower settings extracted from the most-
    // recently-loaded 3MF. Threaded into mergedConfig() at slice time
    // so the wipe tower honors what the file was authored with rather
    // than libslic3r's 280 mm³ × 0.3 multiplier compiled-in default
    // (which produces a tower 2-3× larger than necessary). Single-
    // value (not per-model) — flush settings are project-level in
    // OrcaSlicer's model too. STL/OBJ loads leave this null and
    // mergedConfig synthesizes a 30 mm³ default instead.
    var loadedFlushSettings by remember { mutableStateOf<SlicerEngine.FlushSettings?>(null) }
    // Process-level overrides extracted from the 3MF's project_settings
    // .config — layer_height, sparse_infill_density / pattern,
    // seam_position, etc. The desktop slicer's `; different_settings
    // _to_system =` header lists exactly these keys; honoring them
    // closes the +27 layer / +10% print time gap vs desktop on the
    // dragon fixture. Sparse map (only authored keys present);
    // empty map for STL/OBJ loads or 3MFs with no per-print tuning.
    var loadedProjectOverrides by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    // True between the moment the user picks a file and the moment
    // the preview GLB is ready on disk. Drives the spinner in the
    // Project panel's model row so big 3MFs (the dragon's
    // colored-GLB write takes ~10s) don't look like the app froze.
    var isLoadingModel by remember { mutableStateOf(false) }
    var loadingLabel by remember { mutableStateOf<String?>(null) }
    // Roadmap B7 — recents flow surfaces on the empty-state panel
    // when placedModels is empty. validRecents pre-filters entries
    // whose underlying file no longer exists, so a stale recents
    // list (deleted file, unmounted SD card) doesn't surface broken
    // shortcuts the user can't actually open.
    val recentFilesList by recentFiles.validRecents.collectAsState(initial = emptyList())

    val selectedModel: PlacedModel? =
        placedModels.firstOrNull { it.id == selectedModelId }
            ?: placedModels.firstOrNull()
    // Backward-compat: existing read sites (top-nav rotate/scale,
    // SaveAsStl, the test harness, BottomRightSummaryPanel) refer to
    // these names. They read off the selected model.
    val loadedStl: LoadedStl? = selectedModel?.let { LoadedStl(it.source, it.label) }
    val modelRotZDeg: Int = selectedModel?.rotZDeg ?: 0
    val modelScalePct: Int = selectedModel?.scalePct ?: 100
    val modelOffsetXmm: Float = selectedModel?.translateXmm ?: 0f
    val modelOffsetYmm: Float = selectedModel?.translateYmm ?: 0f
    // Helper to mutate the selected model. No-op when nothing's
    // selected. Snapshot-state reassignment routes through the
    // `placedModels` setter so Compose recomposes.
    fun updateSelected(transform: (PlacedModel) -> PlacedModel) {
        val id = selectedModelId ?: return
        placedModels = placedModels.map { if (it.id == id) transform(it) else it }
    }
    
    // Track world translation of the workspace and its grab handle
    var workspaceTx by remember { mutableStateOf(androidx.xr.runtime.math.Vector3(0f, WORKSPACE_Y_OFFSET, 0.0f)) }
    var bedHandleTx by remember { mutableStateOf(androidx.xr.runtime.math.Vector3(0f, WORKSPACE_Y_OFFSET, 0.20f)) }
    
    var devicesShown by remember { mutableStateOf(false) }
    // Roadmap B5 — Galaxy XR controller help card visibility. Toggled
    // via the TopNavigationPill's Help icon; renders as a side
    // SpatialPanel showing every binding the input pump consumes.
    var helpShown by remember { mutableStateOf(false) }
    var printerStatuses by remember { mutableStateOf<Map<String, PrinterStatus>>(emptyMap()) }
    var printerSnapshots by remember { mutableStateOf<Map<String, PrintSnapshot>>(emptyMap()) }
    var webcamFrames by remember { mutableStateOf<Map<String, androidx.compose.ui.graphics.ImageBitmap>>(emptyMap()) }
    // Tri-state per printer: null = unknown, true = webcam works, false
    // = 404 / no webcam. We stop hitting /webcam/?action=snapshot once
    // we've confirmed false so we don't burn requests for non-webcam
    // printers.
    var webcamSupported by remember { mutableStateOf<Map<String, Boolean>>(emptyMap()) }
    // Per-printer cache of the spools currently loaded in the printer
    // (queryFilamentSlots), keyed by printer id. Used by the inline
    // color picker to show "Loaded in printer" quick-pick swatches —
    // the user can copy any of those colors onto a project filament
    // with one tap. Populated on printer selection and on Detect.
    var printerLoadedFilaments by remember { mutableStateOf<Map<String, List<FilamentSlot>>>(emptyMap()) }
    var isScanning by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // "As will print" palette — what each project filament will actually
    // look like once the user's physical / virtual remap is applied.
    // Drives the in-XR preview GLB: the colored-GLB writer hands native a
    // per-project-filament palette indexed by the 3MF's MMU face tags, so
    // swapping authored colors for resolved colors at this seam makes the
    // preview match the printed result. Kept canonical (no toggle): the
    // panel rows already carry the model→print diff on the left swatch,
    // so a single source of truth in the 3D view keeps the UX simple.
    // Recomputed when filament list, virtual rows, or the printer's
    // detected loadout changes — that's exactly the set of inputs the
    // resolver reads.
    val activePrinterLoadedSlots: List<FilamentSlot> =
        activePrinter?.id?.let(printerLoadedFilaments::get).orEmpty()
    // Per-physical-slot palette — what's *physically loaded* in each of
    // the printer's hot ends, indexed by physical slot 0..slotCount-1.
    // Moonraker-detected color wins; falls back to defaultPalette[i].
    // This is the right index space for the toolpath GLB (after the JNI
    // post-processor rewrites every Tn through filament_map, gcode
    // segment.extruder == physical extruder, NOT project filament). It
    // is NOT the right index space for the colored-GLB STL preview —
    // that one indexes by 3MF MMU face state (project filament 1..N),
    // which is a different mapping.
    val physicalSlotPalette: List<String> = remember(
        activePrinterLoadedSlots, slotCount, filamentSlotsStore,
    ) {
        val byPhysical = activePrinterLoadedSlots.associateBy { it.slotIndex }
        (0 until slotCount).map { i ->
            byPhysical[i]?.colorHex
                ?: filamentSlotsStore.defaultPalette.getOrNull(i)
                ?: "#FFFFFF"
        }
    }
    val previewPalette: List<String> = remember(
        filamentList, activePrinterLoadedSlots, mixedRows, slotCount,
    ) {
        resolveAsWillPrintPalette(
            filaments = filamentList,
            printerLoadedSlots = activePrinterLoadedSlots,
            paletteSuggestions = filamentSlotsStore.defaultPalette,
            virtualRows = mixedRows,
            slotCount = slotCount,
        )
    }

    // Refresh the printer-loaded-filaments cache when the active
    // printer changes. Best-effort: silent on failure (Moonraker may
    // be offline, the printer firmware may be older than 1.2.0 and
    // not expose print_task_config — neither is fatal here, the
    // picker just falls back to "Common colors").
    LaunchedEffect(selectedPrinterId.value, printers) {
        val active = printers.firstOrNull { it.id == selectedPrinterId.value }
            ?: return@LaunchedEffect
        runCatching {
            val client = MoonrakerClient(active)
            val r = client.queryFilamentSlots()
            if (r is MoonrakerResult.Ok) {
                printerLoadedFilaments = printerLoadedFilaments + (active.id to r.value)
            }
        }
    }

    // Poll Moonraker for live print state. Runs whenever there's at
    // least one configured printer — independent of whether the user
    // has the device-management panel open — so the always-visible
    // PrintMonitorPanel below the workspace can surface bed/nozzle
    // temps and progress without a context switch.
    //
    // Tick rate adapts to state: 3 s while a print is active or paused
    // (responsive for the watch-it-progress UX), 15 s during standby
    // (catches the moment a remote print starts without burning the
    // network). Webcam snapshots only fire while a print is active.
    // Sequentially across printers — fine for 1-2 printers; revisit
    // with parallel polling once we have more.
    LaunchedEffect(printers) {
        if (printers.isEmpty()) return@LaunchedEffect
        while (true) {
            var anyActive = false
            for (p in printers) {
                val client = MoonrakerClient(p)
                val r = client.queryStatus()
                if (r is MoonrakerResult.Ok) {
                    printerSnapshots = printerSnapshots + (p.id to r.value)
                    if (r.value.isActive) anyActive = true

                    // While a print is active, fetch a fresh webcam
                    // snapshot. The first request decides webcamSupported
                    // for this printer — 404 disables future fetches.
                    val supported = webcamSupported[p.id]
                    if (r.value.isActive && supported != false) {
                        when (val w = client.fetchWebcamSnapshot()) {
                            is MoonrakerResult.Ok -> {
                                val bmp = runCatching {
                                    android.graphics.BitmapFactory.decodeByteArray(
                                        w.value, 0, w.value.size,
                                    )
                                }.getOrNull()
                                if (bmp != null) {
                                    webcamFrames = webcamFrames + (p.id to bmp.asImageBitmap())
                                    if (supported != true) {
                                        webcamSupported = webcamSupported + (p.id to true)
                                    }
                                }
                            }
                            is MoonrakerResult.NotFound -> {
                                webcamSupported = webcamSupported + (p.id to false)
                            }
                            else -> { /* transient — leave supported unchanged */ }
                        }
                    }
                }
                // Quiet on errors — the connection probe lives on the
                // Test button, polling stays out of the way if a
                // printer is offline mid-session.
            }
            kotlinx.coroutines.delay(if (anyActive) 3_000 else 15_000)
        }
    }

    // Stop discovery when the panel is closed or the shell goes away.
    // Multicast traffic isn't free; idle browsing wastes battery on
    // a portable headset.
    // Keep selectedPrinterId pointed at something real:
    //  - if nothing's chosen but at least one printer exists, pick the first
    //  - if the chosen id no longer exists (deleted), fall back to first or null
    LaunchedEffect(printers, selectedPrinterId.value) {
        val currentId = selectedPrinterId.value
        val exists = printers.any { it.id == currentId }
        if (!exists) {
            selectedPrinterId.value = printers.firstOrNull()?.id
        }
    }

    DisposableEffect(devicesShown) {
        onDispose {
            if (!devicesShown && isScanning) {
                discoveryService.stop()
                isScanning = false
            }
        }
    }
    DisposableEffect(Unit) {
        onDispose { discoveryService.stop() }
    }

    fun setStatus(id: String, status: PrinterStatus) {
        printerStatuses = printerStatuses + (id to status)
    }

    // Auto-flip to Preview the moment a slice completes. Otherwise the
    // user has to remember to tap the tab to actually see the toolpath
    // they just generated, which they consistently expect to "just
    // appear." Snap back to Prepare when a fresh STL loads.
    LaunchedEffect(glbPath) {
        if (glbPath != null) workspaceMode = WorkspaceMode.Preview
    }
    LaunchedEffect(stlPreviewPath, glbPath) {
        if (stlPreviewPath != null && glbPath == null) workspaceMode = WorkspaceMode.Prepare
    }

    // Build plate dimensions track the selected profile's
    // `printable_area`. Snapmaker U1 → 270×270, Bambu A1 → 256×256, etc.
    // Re-emit the GLB whenever the user picks a different profile so
    // the visualization stays honest.
    val (bedW, bedH) = remember(selectedProfile.value.id) {
        BuildPlateGlb.sizeFor(selectedProfile.value)
    }
    LaunchedEffect(bedW, bedH) {
        val out = File(ctx.cacheDir, "build_plate.glb")
        runCatching { BuildPlateGlb.write(out, sizeXmm = bedW, sizeYmm = bedH) }
        .onSuccess { buildPlatePath = out.absolutePath }
    }

    /**
     * Returns an on-disk STL for [file]. If [file] is already STL, it
     * comes back unchanged. For 3MF / AMF / OBJ we ask libslic3r to
     * read the container and merge all volumes into a single binary
     * STL in cache — that derived file is what feeds the in-XR preview
     * (StlReader is STL-only) and the rotate/scale transforms. Slicing
     * itself reads the original container directly, so a 3MF user
     * doesn't pay the STL-roundtrip cost on the actual print pipeline.
     */
    suspend fun deriveStlFor(file: File): File? {
        if (file.extension.equals("stl", ignoreCase = true)) return file
        val derived = File(ctx.cacheDir, "${file.nameWithoutExtension}_derived.stl")
        val ok = runCatching { SlicerEngine.convertToStl(file, derived) }.getOrDefault(false)
        return if (ok && derived.exists() && derived.length() > 0) derived else null
    }

    /** Delete prior stl_preview*.glb files belonging to [modelId] so
     *  each preview rebuild for a single model doesn't leave a 20 MB
     *  ghost behind. Files for other models are left alone — that's
     *  the multi-model invariant. Pass an empty modelId to sweep
     *  legacy single-model preview files (`stl_preview_v*.glb`). */
    fun sweepOldPreviews(keep: File, modelId: String) {
        runCatching {
            val perModelPrefix = "stl_preview_${modelId}_v"
            ctx.cacheDir.listFiles { f ->
                f.name.endsWith(".glb") &&
                    f.absolutePath != keep.absolutePath &&
                    (f.name.startsWith(perModelPrefix) ||
                        // Legacy filenames from the pre-Phase-G single-
                        // model preview pipeline. Sweep them on every
                        // run so an upgrade doesn't carry old GLBs
                        // forward indefinitely.
                        f.name.startsWith("stl_preview_v"))
            }?.forEach { it.delete() }
        }
    }

    /**
     * Render a preview GLB for [modelId] (looking it up in
     * [placedModels]) and update that model's `previewPath` /
     * `previewVersion`. No-op when the id has been removed mid-
     * suspend (typical in test-harness rapid-fire scenarios).
     *
     * Also keeps the global [stlPreviewPath] in sync with the most
     * recently produced preview path so the workspaceMode auto-flip
     * LE keeps firing on first preview after load — that LE doesn't
     * need to know about the multi-model list, just that a preview
     * is now ready.
     */
    suspend fun previewStl(modelId: String) {
        val tag = "OrcaXR/preview"
        val initial = placedModels.firstOrNull { it.id == modelId } ?: return
        val stlFile = initial.source
        val label = initial.label
        // Bump the version atomically up front so concurrent previewStl
        // invocations write to DISTINCT files. The 3mf-driven filament
        // sync (below) writes to filamentEntriesStore which fires the
        // re-preview LaunchedEffect on paddedSlots — that can race with
        // the still-running first call. Both calls used to compute the
        // same `stl_preview_${id}_v${version+1}` filename (because the
        // version only bumped after success), and the second call's
        // `outGlb.delete()` wiped the file mid-render → renderer hit
        // FileNotFoundException → empty bed.
        val outVersion = initial.previewVersion + 1
        placedModels = placedModels.map {
            if (it.id == modelId) it.copy(previewVersion = outVersion) else it
        }
        val out = File(ctx.cacheDir, "stl_preview_${modelId}_v${outVersion}.glb")
        val ext = stlFile.extension.lowercase()

        // 3MF / AMF: bypass the STL roundtrip entirely. The native
        // colored-GLB writer reads per-face MMU segmentation directly
        // from the source and emits a per-vertex-colored GLB using
        // the user's filament-slot palette. STL doesn't carry color
        // info, so .stl inputs continue to use the legacy path below.
        if (ext == "3mf" || ext == "amf") {
            // Snap the project's filament list to whatever the 3mf
            // was authored with — same behavior as desktop OrcaSlicer
            // and the Snapmaker fork. ONLY on the first load of a
            // given file path: the re-preview LaunchedEffect fires on
            // every paddedSlots change (which includes the user's
            // own color edits), so re-running this sync on every
            // preview would clobber edits within milliseconds. AMF
            // doesn't carry the same metadata; only .3mf gets synced.
            // First-time sync: pull embedded colors and overwrite the
            // entries store (so the UI reflects the file's authored
            // palette). Returns the colors-after-sync as a List<String>
            // so the same call can use them for THIS render —
            // filamentEntriesStore.set is async and paddedSlots
            // wouldn't be up-to-date until the next recomposition,
            // which would otherwise produce a brief wrong-color flash
            // on the initial preview.
            // Pre-populate the FullSpectrum mixed-filament panel from the
            // 3MF if it carries a serialized `mixed_filament_definitions`
            // string. Saves the user from having to reconfigure pairs
            // every time they open a project file authored elsewhere
            // (e.g., desktop FullSpectrum). Silent no-op when the field
            // is absent or the file isn't a 3MF.
            if (ext == "3mf") {
                runCatching {
                    val printerId = activePrinter?.id
                    val serialized = SlicerEngine.read3mfMixedFilamentDefinitions(stlFile)
                    if (printerId != null && !serialized.isNullOrEmpty()) {
                        val parsed = parseMixedDefinitionsForKotlin(serialized)
                        if (parsed.isNotEmpty()) {
                            scope.launch { mixedFilamentsStore.set(printerId, parsed) }
                            android.util.Log.i(
                                tag,
                                "loaded ${parsed.size} mixed-filament rows from 3mf for printer $printerId",
                            )
                        }
                    }
                }.onFailure {
                    android.util.Log.w(tag, "3mf mixed-filament read failed: ${it.message}")
                }
            }

            // Capture the embedded `flush_volumes_matrix` /
            // `flush_multiplier` (if any) so the next slice honors
            // them instead of libslic3r's oversized 84 mm³/toolchange
            // default. Refreshed on every load so a path swap (3mf-A
            // → STL → 3mf-B) clears stale settings from a previous
            // file. STL/OBJ loads return null, and mergedConfig
            // falls back to its synthesized 30 mm³ default.
            if (ext == "3mf") {
                runCatching {
                    loadedFlushSettings = SlicerEngine.read3mfFlushSettings(stlFile)
                    val fs = loadedFlushSettings
                    if (fs != null) {
                        android.util.Log.i(
                            tag,
                            "loaded flush settings from 3mf: matrix=${fs.matrix.length}b multiplier=${fs.multiplier.length}b",
                        )
                    }
                }.onFailure {
                    android.util.Log.w(tag, "3mf flush-settings read failed: ${it.message}")
                    loadedFlushSettings = null
                }
                runCatching {
                    loadedProjectOverrides = SlicerEngine.read3mfProjectOverrides(stlFile)
                    if (loadedProjectOverrides.isNotEmpty()) {
                        android.util.Log.i(
                            tag,
                            "loaded ${loadedProjectOverrides.size} project overrides from 3mf: ${loadedProjectOverrides.keys}",
                        )
                    }
                }.onFailure {
                    android.util.Log.w(tag, "3mf project-overrides read failed: ${it.message}")
                    loadedProjectOverrides = emptyMap()
                }
            } else {
                loadedFlushSettings = null
                loadedProjectOverrides = emptyMap()
            }

            // Sync the project filament list with the 3MF's embedded
            // palette on first load of a given file path. Side-effect
            // only (the preview palette below reads from filamentList /
            // the resolver, not from the freshly-synced colors), so
            // we don't capture a return value — the entries store
            // update propagates back through Compose to the panel's
            // left-side authored swatches on the next recomposition.
            if (ext == "3mf" && lastEmbeddedSyncPath != stlFile.absolutePath) {
                runCatching {
                    val embedded = SlicerEngine.read3mfFilamentColours(stlFile)
                    val printerId = activePrinter?.id
                    if (printerId != null && embedded.isNotEmpty() && slotCount > 0) {
                        val updated = (0 until slotCount).map { i ->
                            val embeddedColor = embedded.getOrNull(i)
                            val existing = filamentList.getOrNull(i)
                            FilamentEntry(
                                id = existing?.id ?: "slot_$i",
                                color = embeddedColor ?: (existing?.color ?: "#FFFFFF"),
                                slotIndex = i,
                                filamentType = existing?.filamentType ?: "PLA",
                                // Preserve any user-set physical-slot remap
                                // across 3MF loads — that remap is the
                                // user's "use what's loaded at T_M for
                                // this filament" preference, which is
                                // about the printer's spool layout, not
                                // about which model is loaded. Per spec:
                                // only an explicit picker action mutates
                                // the remap.
                                physicalSlot = existing?.physicalSlot,
                            )
                        }
                        filamentEntriesStore.set(printerId, updated)
                        android.util.Log.i(
                            tag,
                            "applied ${embedded.size} embedded filament colors from 3mf to printer $printerId (slotCount=$slotCount)",
                        )
                    }
                    lastEmbeddedSyncPath = stlFile.absolutePath
                }.onFailure {
                    android.util.Log.w(tag, "3mf filament-color sync failed: ${it.message}")
                }
            }

            // Pad palette to 16 RGB triples (the C++ MAX_SLOTS).
            // Slots beyond the user's filament list fall back to white
            // on the C++ side. Convert each "#RRGGBB" hex string to
            // three 0..1 floats. The palette is the resolved
            // "as will print" view (physicalSlot / virtualSlot /
            // identity-T_N) so the in-XR preview matches the printed
            // result; the panel rows still surface the authored color
            // on the left swatch as the diff.
            val raw = previewPalette
            val palette = FloatArray(16 * 3) { 1.0f }
            for (i in 0 until minOf(raw.size, 16)) {
                val hex = raw[i].trimStart('#').padStart(6, '0').take(6)
                val r = hex.substring(0, 2).toIntOrNull(16) ?: 255
                val g = hex.substring(2, 4).toIntOrNull(16) ?: 255
                val b = hex.substring(4, 6).toIntOrNull(16) ?: 255
                palette[i * 3 + 0] = r / 255f
                palette[i * 3 + 1] = g / 255f
                palette[i * 3 + 2] = b / 255f
            }
            // Phase J §G: paint state on the model overrides any
            // embedded 3MF facets in the preview, so the user sees
            // their in-XR edits reflected immediately. Null when
            // unpainted — the existing 3MF preview behavior is
            // preserved.
            val paintForPreview = initial.paintFilamentIndex.takeIf { hasAnyPaint(it) }
            val ok = try {
                SlicerEngine.writeColoredGlb(stlFile, out, palette, paintForPreview)
            } catch (t: Throwable) {
                android.util.Log.e(tag, "writeColoredGlb threw: ${t.message}", t)
                false
            }
            if (!ok) {
                android.util.Log.e(tag, "writeColoredGlb failed for ${stlFile.absolutePath}")
                return
            }
            android.util.Log.i(tag, "wrote colored preview GLB ${out.absolutePath} (${out.length() / 1024} KB)")
            // Roadmap A6 — derive an STL once for the bed-collision /
            // bedFit checks. The 3MF preview itself goes through
            // libslic3r's writeColoredGlb (above) which handles the
            // multi-volume layout natively; the derived STL collapses
            // volumes but is fine for a vertex-walked-bbox check
            // against the printable polygon. deriveStlFor caches the
            // result under cacheDir so a paint-driven re-bake doesn't
            // re-derive on every stroke.
            runCatching {
                val derived = deriveStlFor(stlFile)
                if (derived != null) {
                    val raw3mf = StlReader.read(derived)
                    val mesh3mf = applyPlacedTransforms(raw3mf, initial)
                    bedFit = computeBedFit(mesh3mf, bedW, bedH)
                    bedCollision = BedCollision.detect(mesh3mf, bedW, bedH, recenterToBed = true)
                }
            }.onFailure {
                android.util.Log.w(tag, "3mf bedCollision compute failed: ${it.message}")
            }
            sweepOldPreviews(out, modelId)
            // Version was already bumped at the top of previewStl so
            // concurrent calls land on distinct files. Just publish the
            // path for the renderer to pick up — both on the per-
            // model record (so the right SceneCore entity finds it)
            // and on stlPreviewPath (so the workspaceMode auto-flip
            // LE fires). Stamp previewRotZDeg/Scale with the values
            // that produced this GLB; the re-preview LE uses
            // [PlacedModel.isPreviewFresh] to skip redundant bakes
            // when the user navigates between already-rendered
            // models.
            val producedRot = initial.rotZDeg
            val producedScale = initial.scalePct
            placedModels = placedModels.map {
                if (it.id == modelId) it.copy(
                    previewPath = out.absolutePath,
                    previewRotZDeg = producedRot,
                    previewScalePct = producedScale,
                ) else it
            }
            stlPreviewPath = out.absolutePath
            return
        }

        // STL path: parse mesh, apply rotate/scale, write a single-
        // color GLB. Same as before, but per-model.
        val current = placedModels.firstOrNull { it.id == modelId } ?: return
        val readable = deriveStlFor(stlFile)
        if (readable == null) {
            android.util.Log.e(tag, "deriveStlFor returned null for ${stlFile.absolutePath}")
            return
        }
        android.util.Log.i(tag, "deriving preview from ${readable.absolutePath} (${readable.length() / 1024} KB)")
        val raw = try {
            StlReader.read(readable)
        } catch (e: OutOfMemoryError) {
            android.util.Log.e(tag, "StlReader OOM on ${readable.length() / 1024} KB STL — pure-Kotlin parser ran out of heap. Skipping preview; slicer can still consume the original.", e)
            return
        } catch (t: Throwable) {
            android.util.Log.e(tag, "StlReader threw: ${t.message}", t)
            return
        }
        android.util.Log.i(tag, "StlReader read ${raw.triCount} triangles, bbox=${raw.bboxMin}..${raw.bboxMax}")

        // Roadmap D1 — restore cached paint for this source on first
        // preview. Only runs when the model has no paint yet (so a
        // second previewStl call after the user stamped new triangles
        // doesn't clobber their fresh edits with a stale cache hit).
        // The triCount guard inside paintCache.restore drops cache
        // entries whose source mesh got re-tessellated.
        val needsRestore = !hasAnyPaint(current.paintFilamentIndex) &&
            !hasAnyPaint(current.supportFlags) &&
            !hasAnyPaint(current.seamFlags)
        if (needsRestore) {
            val restored = runCatching {
                val hash = paintCache.hashOf(stlFile)
                paintCache.restore(hash, raw.triCount)
            }.getOrNull()
            if (restored != null) {
                android.util.Log.i(tag,
                    "paint cache hit for $modelId (paint=${restored.paintFilamentIndex?.size}, " +
                        "support=${restored.supportFlags?.size}, seam=${restored.seamFlags?.size})")
                placedModels = placedModels.map {
                    if (it.id == modelId) it.copy(
                        paintFilamentIndex = restored.paintFilamentIndex,
                        supportFlags = restored.supportFlags,
                        seamFlags = restored.seamFlags,
                    ) else it
                }
            }
        }
        // Re-read current — the restore above may have copied cached
        // arrays into the model.
        val refreshed = placedModels.firstOrNull { it.id == modelId } ?: current

        val mesh = applyPlacedTransforms(raw, refreshed)
        bedFit = computeBedFit(mesh, bedW, bedH)
        // Roadmap A6 — vertex-walked collision check on the same
        // transformed mesh. recenterToBed=true mirrors the JNI's
        // pre-slice "auto-center on the printable area" pass for the
        // single-model path.
        val collision = BedCollision.detect(mesh, bedW, bedH, recenterToBed = true)
        bedCollision = collision
        // Phase J §G: pass paint state + palette so painted triangles
        // render in the slot color. applyTransforms preserves triangle
        // order so `current.paintFilamentIndex` remains aligned. Skip
        // when paint is empty / mismatched — StlPreviewGlb falls back
        // to single-color for that case.
        val paintForPreview = refreshed.paintFilamentIndex.takeIf { hasAnyPaint(it) }
        // Same "as will print" resolution as the 3MF path — STL paint
        // tags are project-filament indices, so feeding the resolved
        // palette renders painted faces in the spool the slice will
        // actually use.
        val paintPaletteRgb: FloatArray? = if (paintForPreview != null) {
            val pal = FloatArray(MAX_PAINT_SLOTS * 3) { 1f }
            for (i in 0 until minOf(previewPalette.size, MAX_PAINT_SLOTS)) {
                val hex = previewPalette[i].trimStart('#').padStart(6, '0').take(6)
                val r = hex.substring(0, 2).toIntOrNull(16) ?: 255
                val g = hex.substring(2, 4).toIntOrNull(16) ?: 255
                val b = hex.substring(4, 6).toIntOrNull(16) ?: 255
                pal[i * 3 + 0] = r / 255f
                pal[i * 3 + 1] = g / 255f
                pal[i * 3 + 2] = b / 255f
            }
            pal
        } else null
        // Roadmap A6 — when the just-detected collision flagged any
        // off-bed triangles, hand the indices to the GLB writer so the
        // user gets the visual cue ("which faces poke off the bed?")
        // alongside the existing red banner ("which axes overflow?").
        val offBedForPreview = (collision as? BedCollision.Result.Off)?.offendingTriIndices
        try {
            StlPreviewGlb.write(
                mesh,
                out,
                paintFilamentIndex = paintForPreview,
                paletteRgb = paintPaletteRgb,
                offBedTriIndices = offBedForPreview,
            )
        } catch (e: OutOfMemoryError) {
            android.util.Log.e(tag, "StlPreviewGlb OOM writing GLB", e)
            return
        } catch (t: Throwable) {
            android.util.Log.e(tag, "StlPreviewGlb threw: ${t.message}", t)
            return
        }
        android.util.Log.i(tag, "wrote preview GLB ${out.absolutePath} (${out.length() / 1024} KB)")

        sweepOldPreviews(out, modelId)
        // Version was already bumped at the top of previewStl. Cache
        // the base bbox so auto-arrange has the unrotated/unscaled
        // size to work with, and publish the per-model preview path.
        // Stamp previewRot/Scale with the values that produced the
        // baked GLB so the re-preview LE doesn't refire on pure
        // selection changes (gotcha #28).
        val producedRot = refreshed.rotZDeg
        val producedScale = refreshed.scalePct
        placedModels = placedModels.map {
            if (it.id == modelId) it.copy(
                previewPath = out.absolutePath,
                previewRotZDeg = producedRot,
                previewScalePct = producedScale,
                baseBboxXmm = raw.bboxMax.x - raw.bboxMin.x,
                baseBboxYmm = raw.bboxMax.y - raw.bboxMin.y,
                baseBboxZmm = raw.bboxMax.z - raw.bboxMin.z,
            ) else it
        }
        stlPreviewPath = out.absolutePath
    }

    /** Whether the next pick should REPLACE the selected model
     *  (the historical default — a fresh load clears the bed) or
     *  ADD a new placed model alongside (Phase G's multi-model UX,
     *  triggered by the "+ Add another" button in LeftProjectPanel).
     *  Reset to Replace after each pick. */
    var pickerMode by remember { mutableStateOf<PickerMode>(PickerMode.Replace) }

    // Phase XR_OBJ_6 — Boolean A/B picker. When the user taps
    // Union/Difference/Intersection in TransformPanel we capture the
    // currently-selected model as the "A" operand and stash the op in
    // [booleanPickerOp] (one of [SlicerEngine.BoolOp]). The next tap on
    // a *different* PlacedModel in the scene becomes "B" and fires
    // runBoolean(A, B, op). Both are cleared (-> idle) when the op
    // resolves, the user cancels, or the source model disappears (e.g.
    // gets deleted between arming and the second tap).
    var booleanPickerOp by remember { mutableStateOf<Int?>(null) }
    var booleanPickerSourceId by remember { mutableStateOf<String?>(null) }

    val launchPicker: () -> Unit = {
        pickerMode = PickerMode.Replace
        showFilePicker = true
    }
    val launchPickerForAdd: () -> Unit = {
        pickerMode = PickerMode.Add
        showFilePicker = true
    }
    /** Phase XR_OBJ_4 — open the file picker in "attach a volume of
     *  [type] to the selected model" mode. The selected file becomes
     *  a new [PlacedVolume] of the given type on
     *  `selectedModel.volumes`. No-op when nothing is selected (UI
     *  gates the trigger button). */
    val launchPickerForVolume: (ModelVolumeType) -> Unit = { type ->
        pickerMode = PickerMode.AddVolume(type)
        showFilePicker = true
    }
    /** Convenience: shorthand for the most common case. */
    val launchPickerForPart: () -> Unit = { launchPickerForVolume(ModelVolumeType.MODEL_PART) }

    fun onFileSelected(file: File) {
        val mode = pickerMode
        showFilePicker = false
        scope.launch {
            val label = file.name
            // Phase XR_OBJ_4 — AddVolume mode attaches the picked
            // file to the SELECTED PlacedModel as a new volume of
            // the requested type (MODEL_PART, PARAMETER_MODIFIER,
            // NEGATIVE_VOLUME, SUPPORT_ENFORCER, SUPPORT_BLOCKER),
            // rather than creating a new PlacedModel entry. Slice
            // state is preserved (the user is editing the model, not
            // loading a new one).
            if (mode is PickerMode.AddVolume) {
                val targetId = selectedModelId
                if (targetId == null) {
                    android.widget.Toast.makeText(
                        ctx,
                        "Select a model first, then add a volume.",
                        android.widget.Toast.LENGTH_LONG,
                    ).show()
                    return@launch
                }
                val volumeId = "vol_${System.currentTimeMillis().toString(36)}"
                val newVolume = PlacedVolume(
                    id = volumeId,
                    source = file,
                    type = mode.type,
                )
                placedModels = placedModels.map {
                    if (it.id == targetId) it.copy(volumes = it.volumes + newVolume) else it
                }
                val typeLabel = when (mode.type) {
                    ModelVolumeType.MODEL_PART -> "part"
                    ModelVolumeType.PARAMETER_MODIFIER -> "modifier"
                    ModelVolumeType.NEGATIVE_VOLUME -> "negative volume"
                    ModelVolumeType.SUPPORT_ENFORCER -> "support enforcer"
                    ModelVolumeType.SUPPORT_BLOCKER -> "support blocker"
                }
                android.widget.Toast.makeText(
                    ctx,
                    "Added $typeLabel: $label",
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
                return@launch
            }

            // Loading a fresh model clears any prior slice. The user will
            // hit Slice when they're ready — picking a file is no longer
            // an implicit "and start slicing now" command.
            glbPath = null
            maxLayer.value = null
            // In Replace mode, drop any prior models and start fresh
            // (the historical pre-Phase-G behavior). In Add mode, keep
            // the existing list and append a new entry — but cap at
            // MAX_PLACED_MODELS to bound the SceneCore draw-call budget.
            val newId = "model_${System.currentTimeMillis().toString(36)}_${placedModels.size}"
            val fresh = PlacedModel(id = newId, source = file, label = label)
            when (mode) {
                PickerMode.Replace -> {
                    placedModels = listOf(fresh)
                    selectedModelId = newId
                }
                PickerMode.Add -> {
                    if (placedModels.size >= MAX_PLACED_MODELS) {
                        android.widget.Toast.makeText(
                            ctx,
                            "Up to $MAX_PLACED_MODELS models per plate. Slice or remove some first.",
                            android.widget.Toast.LENGTH_LONG,
                        ).show()
                        return@launch
                    }
                    placedModels = placedModels + fresh
                    selectedModelId = newId
                }
                is PickerMode.AddVolume -> {
                    // Already handled above — the early return prevents
                    // this branch, but the exhaustive `when` keeps the
                    // compiler happy.
                }
            }
            sliceState.value = SliceUiState.Idle
            workspaceMode = WorkspaceMode.Prepare
            // Spinner in the Project panel's model row + a transient
            // toast so the user has feedback the moment they pick a
            // file. Both clear once the preview GLB lands on disk.
            isLoadingModel = true
            loadingLabel = label
            android.widget.Toast.makeText(
                ctx,
                "Loading $label…",
                android.widget.Toast.LENGTH_SHORT,
            ).show()
            try {
                previewStl(newId)
            } finally {
                isLoadingModel = false
                loadingLabel = null
            }
            // Roadmap B7 — bump the recents list AFTER a successful
            // load so a corrupt/unparseable file doesn't pollute the
            // empty-state shortcuts. Best-effort: a failed write to
            // DataStore (e.g. process killed mid-suspend) shouldn't
            // surface as a load failure.
            runCatching { recentFiles.add(file, label = label) }
                .onFailure { android.util.Log.w("OrcaXR/recents", "recentFiles.add failed: ${it.message}") }
        }
    }

    fun runSlice(file: File, label: String) {
        scope.launch {
            glbPath = null
            maxLayer.value = null
            sliceState.value = SliceUiState.Slicing(sourceLabel = label)
            // If the user transformed the model (rotation or scale),
            // write the transformed mesh to a side cache file and
            // slice that. For non-STL inputs (3MF/AMF/OBJ) we derive
            // a single STL via libslic3r first — StlReader/StlWriter
            // only speak binary STL. When no transforms are applied,
            // the original container goes straight to nativeSlice
            // (which handles all formats) so 3MF users skip the STL
            // roundtrip on the common path.
            // Phase XR_OBJ_2: any non-identity transform (legacy fields
            // OR new per-axis fields) goes through applyPlacedTransforms
            // and writes a transformed STL to cache.
            val selForTx = selectedModel
            val sliceInput = if (selForTx != null && (
                    selForTx.rotZDeg != 0 || selForTx.scalePct != 100 ||
                    selForTx.translateXmm != 0f || selForTx.translateYmm != 0f ||
                    selForTx.translateZmm != 0f ||
                    selForTx.rotXDeg != 0f || selForTx.rotYDeg != 0f ||
                    selForTx.scaleXPct != 100f || selForTx.scaleYPct != 100f || selForTx.scaleZPct != 100f ||
                    selForTx.mirrorX || selForTx.mirrorY || selForTx.mirrorZ
                )
            ) {
                runCatching {
                    val source = deriveStlFor(file) ?: file
                    val mesh = applyPlacedTransforms(StlReader.read(source), selForTx)
                    val tag = "r${selForTx.rotXDeg.toInt()}_${selForTx.rotYDeg.toInt()}_${selForTx.rotZDeg}_" +
                        "s${selForTx.scaleXPct.toInt()}_${selForTx.scaleYPct.toInt()}_${selForTx.scaleZPct.toInt()}_" +
                        "x${selForTx.translateXmm.toInt()}_y${selForTx.translateYmm.toInt()}"
                    val out = File(ctx.cacheDir, "transformed_${file.nameWithoutExtension}_$tag.stl")
                    StlWriter.write(mesh, out)
                    out
                }.getOrDefault(file)
            } else file
            // Phase J paint state for the selected model. The mesh
            // transforms above (rotate/scale/translate/mirror) preserve
            // triangle order — StlMesh.transformedFull walks positions[]
            // in place — so the per-triangle paint indices remain valid
            // against the transformed STL.
            val paintForSlice = selectedModel?.paintFilamentIndex
            val supportForSlice = selectedModel?.supportFlags
            val seamForSlice = selectedModel?.seamFlags
            // Phase XR_OBJ_4 — user-authored extra volumes ("Add Part"
            // etc.) ride alongside the primary mesh. Empty for models
            // the user hasn't added parts to.
            val extraVolumesForSlice = selectedModel?.volumes ?: emptyList()
            val result = sliceLocalFile(
                sliceInput,
                mergedConfig(
                    selectedProfile.value,
                    layerHeightOverride.value,
                    paddedSlots,
                    mixedFilamentDefinitions,
                    paddedSlotRemap,
                    extraOverrides = printSettingsOverrides.value,
                    flushFromProject = loadedFlushSettings,
                    projectOverrides = loadedProjectOverrides,
                    slotTypes = filamentList.map { it.filamentType },
                    allFilaments = filamentsCatalog,
                ),
                virtualRemap = paddedVirtualRemap,
                paintFilamentIndex = paintForSlice,
                extraVolumes = extraVolumesForSlice,
                supportFlags = supportForSlice,
                seamFlags = seamForSlice,
                objectConfigOverrides = selectedModel?.configOverrides ?: emptyMap(),
            ) { percent, message ->
                // Fires on a libslic3r worker thread; mutating
                // sliceState directly is fine — Compose's snapshot
                // state is thread-safe. Recompositions debounce
                // naturally because the C++ side already throttles
                // duplicate (percent, text) ticks.
                val cur = sliceState.value
                if (cur is SliceUiState.Slicing) {
                    sliceState.value = cur.copy(percent = percent, message = message)
                }
            }
            val parsed = (result as? SliceResult.Success)?.let {
                runCatching { GcodeParser.parse(File(it.outputPath)) }.getOrNull()
            }
            sliceState.value = SliceUiState.Done(label, result, parsed)
        }
    }

    /**
     * Multi-model slice path. Used when [placedModels].size >= 2.
     * Routes through [SlicerEngine.sliceMulti] with each model's
     * (translateX, translateY, rotZDeg, scalePct) packed into the
     * JNI's transforms array. The JNI auto-recenters the group bbox
     * on the printable area centroid, so the user's offsets are
     * relative-spacing only — Phase G's auto-arrange button is the
     * happy-path producer of those offsets.
     *
     * Caveat (documented in SNAPMAKER_PARITY_PLAN.md Phase G): the
     * JNI strips painted facets when it copies meshes into the
     * shared Model (`src.objects.front()->mesh()`). A 4-color 3MF
     * plated alongside another model will print as single-color.
     * Single-3MF + transforms takes the [runSlice] path below and
     * preserves painted facets via libslic3r reading the original
     * container directly.
     */
    /**
     * Phase XR_OBJ_7 — call libslic3r's arrange() to pack the plate
     * tightly. Falls back to the naive `autoArrangeModels` row layout
     * when the JNI returns null (read fail / arrange threw / single
     * model — naive helper handles that case more gracefully).
     *
     * The bed dimensions are hardcoded to 256×256 mm in v1 — that's
     * Centauri Carbon's bed, and packing for it on the U1's larger
     * 320×320 bed just leaves extra margin (no overflow risk). A
     * future pass can read `printable_area` from the active profile.
     */
    /**
     * Phase XR_OBJ_5 — run libslic3r's `Cut::perform_with_plane()` on
     * the selected model at [planeZmm]. After the JNI writes the cut
     * 3MF to cache, we load it back through the existing LOAD_3MF
     * flow — each cut piece becomes its own [PlacedModel], so the
     * user can plate / move / slice them independently.
     *
     * [attrMask] is the OR of [SlicerEngine.CutAttr] bits. Defaults
     * to KeepUpper | KeepLower | PlaceOnCutUpper | PlaceOnCutLower
     * — the common-case "split into two halves, both rest cut-side
     * down."
     */
    fun runCut(
        planeZmm: Float,
        attrMask: Int = SlicerEngine.CutAttr.KEEP_UPPER or
            SlicerEngine.CutAttr.KEEP_LOWER or
            SlicerEngine.CutAttr.PLACE_ON_CUT_UPPER or
            SlicerEngine.CutAttr.PLACE_ON_CUT_LOWER,
    ) {
        val source = selectedModel ?: run {
            android.widget.Toast.makeText(
                ctx,
                "Select a model to cut.",
                android.widget.Toast.LENGTH_LONG,
            ).show()
            return
        }
        val sourceId = source.id
        scope.launch {
            val out = File(ctx.cacheDir, "cut_${sourceId}_${planeZmm.toInt()}mm.3mf")
            val ok = runCatching {
                SlicerEngine.cutObject(source.source, out, planeZmm, attrMask)
            }.onFailure {
                android.util.Log.e("OrcaXR", "cutObject threw", it)
            }.getOrDefault(false)
            if (!ok) {
                android.widget.Toast.makeText(
                    ctx,
                    "Cut failed (see logs).",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
                return@launch
            }
            // Replace the source with the cut output. We re-use the
            // existing single-file load path, which means the cut 3MF
            // becomes a SINGLE PlacedModel even though it contains N
            // ModelObjects internally. libslic3r's
            // multi-volume / multi-object preservation in nativeSlice +
            // nativeSliceMulti picks up all pieces at slice time. Future
            // polish: split the 3MF into N PlacedModels so the user can
            // plate them separately.
            val newId = "model_${System.currentTimeMillis().toString(36)}_cut"
            val fresh = PlacedModel(id = newId, source = out, label = "Cut@${planeZmm.toInt()}mm")
            placedModels = placedModels.filter { it.id != sourceId } + fresh
            selectedModelId = newId
            sliceState.value = SliceUiState.Idle
            workspaceMode = WorkspaceMode.Prepare
            isLoadingModel = true
            loadingLabel = fresh.label
            try {
                previewStl(newId)
            } finally {
                isLoadingModel = false
                loadingLabel = null
            }
            android.widget.Toast.makeText(
                ctx,
                "Cut at z=${planeZmm.toInt()}mm",
                android.widget.Toast.LENGTH_SHORT,
            ).show()
        }
    }

    /**
     * Phase XR_OBJ_6 — boolean op between two PlacedModels. The
     * output 3MF replaces both source models with a single new
     * PlacedModel. [op] is one of [SlicerEngine.BoolOp].
     */
    fun runBoolean(aId: String, bId: String, op: Int) {
        val a = placedModels.firstOrNull { it.id == aId }
        val b = placedModels.firstOrNull { it.id == bId }
        if (a == null || b == null) {
            android.widget.Toast.makeText(
                ctx,
                "Need two models for boolean op.",
                android.widget.Toast.LENGTH_LONG,
            ).show()
            return
        }
        scope.launch {
            val opStr = when (op) {
                SlicerEngine.BoolOp.UNION -> "union"
                SlicerEngine.BoolOp.DIFFERENCE -> "diff"
                SlicerEngine.BoolOp.INTERSECTION -> "isect"
                else -> "op$op"
            }
            val out = File(ctx.cacheDir, "bool_${opStr}_${System.currentTimeMillis()}.3mf")
            val ok = runCatching {
                SlicerEngine.meshBoolean(a.source, b.source, op, out)
            }.onFailure {
                android.util.Log.e("OrcaXR", "meshBoolean threw", it)
            }.getOrDefault(false)
            if (!ok) {
                android.widget.Toast.makeText(
                    ctx,
                    "Boolean ${opStr} failed (see logs).",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
                return@launch
            }
            val newId = "model_${System.currentTimeMillis().toString(36)}_bool"
            val fresh = PlacedModel(id = newId, source = out, label = "Bool ${opStr}")
            // Replace BOTH sources with the boolean output.
            placedModels = placedModels.filter { it.id != aId && it.id != bId } + fresh
            selectedModelId = newId
            sliceState.value = SliceUiState.Idle
            workspaceMode = WorkspaceMode.Prepare
            isLoadingModel = true
            loadingLabel = fresh.label
            try {
                previewStl(newId)
            } finally {
                isLoadingModel = false
                loadingLabel = null
            }
            android.widget.Toast.makeText(
                ctx,
                "Boolean ${opStr} done.",
                android.widget.Toast.LENGTH_SHORT,
            ).show()
        }
    }

    /**
     * Phase XR_OBJ_8 — linear clone pattern. Duplicates the selected
     * model [count] times along [axis] with [spacingMm] between
     * footprints. Each clone gets a unique id so its preview GLB
     * cache file doesn't collide with the source's; paint state and
     * volumes are preserved.
     *
     * Caps at MAX_PLACED_MODELS — if appending the full pattern would
     * exceed, only the prefix that fits is added.
     */
    fun runClonePattern(sourceId: String, count: Int, spacingMm: Float, axis: Char) {
        val src = placedModels.firstOrNull { it.id == sourceId } ?: run {
            android.widget.Toast.makeText(
                ctx,
                "Select a model to clone.",
                android.widget.Toast.LENGTH_LONG,
            ).show()
            return
        }
        val n = count.coerceAtLeast(1)
        val capacity = (MAX_PLACED_MODELS - placedModels.size).coerceAtLeast(0)
        if (capacity == 0) {
            android.widget.Toast.makeText(
                ctx,
                "Up to $MAX_PLACED_MODELS models per plate. Remove some first.",
                android.widget.Toast.LENGTH_LONG,
            ).show()
            return
        }
        val toAdd = minOf(n, capacity)
        // Pure-helper offset list (footprint × pitch by axis), tested
        // in ClonePatternTest. snapAndClampOffset still happens here
        // because it depends on the source's existing translate.
        val offsets = clonePatternOffsets(src, toAdd, spacingMm, axis)
        scope.launch {
            val clones = mutableListOf<PlacedModel>()
            for (i in 1..toAdd) {
                val newId = "model_${System.currentTimeMillis().toString(36)}_clone_$i"
                val (dx, dy) = offsets[i - 1]
                val snapped = snapAndClampOffset(
                    src.translateXmm + dx,
                    src.translateYmm + dy,
                )
                val clone = src.copy(
                    id = newId,
                    translateXmm = snapped.x,
                    translateYmm = snapped.y,
                    previewPath = null,
                    previewVersion = 0,
                    previewRotZDeg = -1,
                    previewScalePct = -1,
                )
                clones += clone
            }
            placedModels = placedModels + clones
            for (c in clones) previewStl(c.id)
            android.widget.Toast.makeText(
                ctx,
                "Cloned ${toAdd}× along ${axis.uppercaseChar()}",
                android.widget.Toast.LENGTH_SHORT,
            ).show()
        }
    }

    /**
     * Phase XR_OBJ_6 — split a model into one PlacedModel per
     * disconnected mesh component via libslic3r's `ModelObject::split`.
     * No-op for single-component inputs (split returns a single
     * output equivalent to the source).
     */
    fun runSplit(sourceId: String) {
        val source = placedModels.firstOrNull { it.id == sourceId } ?: run {
            android.widget.Toast.makeText(
                ctx,
                "Select a model to split.",
                android.widget.Toast.LENGTH_LONG,
            ).show()
            return
        }
        scope.launch {
            val outDir = File(ctx.cacheDir, "split_${sourceId}")
            val pieces = runCatching {
                SlicerEngine.splitObject(source.source, outDir)
            }.onFailure {
                android.util.Log.e("OrcaXR", "splitObject threw", it)
            }.getOrNull()
            if (pieces == null || pieces.isEmpty()) {
                android.widget.Toast.makeText(
                    ctx,
                    "Split failed (see logs).",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
                return@launch
            }
            // Replace the source with N PlacedModels — one per piece.
            val newModels = pieces.mapIndexed { i, path ->
                PlacedModel(
                    id = "model_${System.currentTimeMillis().toString(36)}_split_$i",
                    source = File(path),
                    label = "${source.label} #${i + 1}",
                )
            }
            placedModels = placedModels.filter { it.id != sourceId } + newModels
            selectedModelId = newModels.firstOrNull()?.id
            sliceState.value = SliceUiState.Idle
            workspaceMode = WorkspaceMode.Prepare
            isLoadingModel = true
            loadingLabel = newModels.firstOrNull()?.label
            try {
                for (m in newModels) previewStl(m.id)
            } finally {
                isLoadingModel = false
                loadingLabel = null
            }
            android.widget.Toast.makeText(
                ctx,
                "Split into ${pieces.size} pieces.",
                android.widget.Toast.LENGTH_SHORT,
            ).show()
        }
    }

    fun runAutoArrange() {
        val models = placedModels
        if (models.size < 2) {
            placedModels = autoArrangeModels(models)
            return
        }
        scope.launch {
            // Build a 9-float-per-input prior tuple matching the JNI's
            // expected stride (txMm, tyMm, rotZdeg, sxPct, syPct, szPct,
            // mxSign, mySign, mzSign).
            val priors = FloatArray(models.size * 9) { idx ->
                val m = models[idx / 9]
                when (idx % 9) {
                    0 -> m.translateXmm
                    1 -> m.translateYmm
                    2 -> m.rotZDeg.toFloat()
                    3 -> m.effectiveScaleX * 100f
                    4 -> m.effectiveScaleY * 100f
                    5 -> m.effectiveScaleZ * 100f
                    6 -> if (m.mirrorX) -1f else 1f
                    7 -> if (m.mirrorY) -1f else 1f
                    8 -> if (m.mirrorZ) -1f else 1f
                    else -> 0f
                }
            }
            val results = runCatching {
                SlicerEngine.arrangeModels(
                    inputs = models.map { it.source },
                    priorTransforms = priors,
                    bedWmm = 256f,
                    bedHmm = 256f,
                    gapMm = 5f,
                )
            }.onFailure {
                android.util.Log.e("OrcaXR", "arrangeModels threw", it)
            }.getOrNull()
            if (results != null && results.size == models.size * 3) {
                placedModels = placedModels.mapIndexed { i, m ->
                    val tx = results[i * 3 + 0]
                    val ty = results[i * 3 + 1]
                    val rz = results[i * 3 + 2]
                    val snapped = snapAndClampOffset(tx, ty)
                    m.copy(
                        translateXmm = snapped.x,
                        translateYmm = snapped.y,
                        // arrange() returns the rotation it CHOSE (with
                        // allow_rotations = false this stays at the
                        // input). Round to integer degrees to match the
                        // Z-rotation field.
                        rotZDeg = ((rz.toInt() % 360) + 360) % 360,
                    )
                }
                android.util.Log.i("OrcaXR", "auto-arrange: libslic3r placed ${models.size} models")
            } else {
                android.util.Log.w("OrcaXR", "auto-arrange: JNI returned null, falling back to naive layout")
                placedModels = autoArrangeModels(placedModels)
            }
        }
    }

    /**
     * Phase G multi-model slice. Phase XR_OBJ_4-late gotcha #62b
     * fix: takes the resolved slot palette / profile / layer height
     * as EXPLICIT params instead of capturing them from the
     * Composable closure. Local-function captures inside a
     * `LaunchedEffect(Unit) { collect { runSliceMulti(...) } }`
     * snapshot Compose state at LE-creation time — so a long-lived
     * collector calling runSliceMulti reads the OLD paddedSlots
     * (typically empty before DataStore loaded), which collapses
     * `filament_diameter` to 1 entry and silently disables MMS.
     * Threading explicit args removes the risk for every caller.
     *
     * Default values pull the LIVE Composable-scoped state — UI
     * call sites still get the right values without typing them
     * out, AND get them fresh on every recomposition.
     */
    fun runSliceMulti(
        models: List<PlacedModel>,
        slots: List<String> = paddedSlots,
        slotRemap: List<Int?> = paddedSlotRemap,
        virtualRemap: IntArray? = paddedVirtualRemap,
        profile: SlicerProfile = selectedProfile.value,
        layerHeight: String = layerHeightOverride.value,
        slotTypes: List<String> = filamentList.map { it.filamentType },
        filamentsMap: Map<String, Map<String, String>> = filamentsCatalog,
    ) {
        if (models.isEmpty()) return
        scope.launch {
            glbPath = null
            maxLayer.value = null
            val multiLabel = "${models.size} models"
            sliceState.value = SliceUiState.Slicing(sourceLabel = multiLabel)
            val pairs = models.map { m ->
                m.source to SlicerEngine.ModelPlacement(
                    translateXmm = m.translateXmm,
                    translateYmm = m.translateYmm,
                    translateZmm = m.translateZmm,
                    rotXdeg = m.rotXDeg,
                    rotYdeg = m.rotYDeg,
                    rotZdeg = m.rotZDeg.toFloat(),
                    scalePct = m.scalePct.toFloat(),
                    scaleXPct = m.effectiveScaleX * 100f,
                    scaleYPct = m.effectiveScaleY * 100f,
                    scaleZPct = m.effectiveScaleZ * 100f,
                    mirrorX = m.mirrorX,
                    mirrorY = m.mirrorY,
                    mirrorZ = m.mirrorZ,
                )
            }
            val firstStl = models.first().source
            val outFile = File(firstStl.parentFile, "${firstStl.nameWithoutExtension}_multi.gcode")
            // Phase XR_OBJ_4-late gotcha #62b fix: read the EXPLICIT
            // params, not the closure-captured outer-scope values.
            // The signature defaults pull the live Composable state
            // for normal UI calls; the test pump can pass
            // testStateXxx values directly and dodge the LE-capture
            // staleness bug.
            val cfg = mergedConfig(
                profile,
                layerHeight,
                slots,
                mixedFilamentDefinitions,
                slotRemap,
                extraOverrides = printSettingsOverrides.value,
                flushFromProject = loadedFlushSettings,
                projectOverrides = loadedProjectOverrides,
                slotTypes = slotTypes,
                allFilaments = filamentsMap,
            )
            // Phase J: per-model paint state, parallel to `pairs`.
            // null entries skip paint authoring for that input.
            val paintsForMulti: List<ByteArray?>? =
                if (models.none { hasAnyPaint(it.paintFilamentIndex) }) null
                else models.map { it.paintFilamentIndex }
            val result = SlicerEngine.sliceMulti(pairs, outFile, cfg, paintsForMulti) { percent, message ->
                val cur = sliceState.value
                if (cur is SliceUiState.Slicing) {
                    sliceState.value = cur.copy(percent = percent, message = message)
                }
            }
            val parsed = (result as? SliceResult.Success)?.let {
                runCatching { GcodeParser.parse(File(it.outputPath)) }.getOrNull()
            }
            sliceState.value = SliceUiState.Done(multiLabel, result, parsed)
        }
    }

    // Re-preview when SELECTED model's rotation/scale OR slot palette
    // changes so the GLB on the bed reflects the latest mesh + colors.
    // The colored-GLB writer for 3MFs reads the current paddedSlots
    // palette every time it runs; without this key, hitting Detect
    // (which mutates the FilamentEntries store) wouldn't refresh
    // the on-bed preview until the user re-loaded the model
    // manually.
    //
    // Phase G: rotate/scale operate on the selected model only, so
    // we re-render JUST that model. Color-palette changes affect
    // every 3MF preview, so we re-render each one. STL previews
    // are flat-colored and don't need re-render on palette change,
    // so we filter them out of the palette-driven loop.
    //
    // A change also invalidates the prior toolpath — drop it and let
    // the user re-slice.
    LaunchedEffect(
        selectedModelId,
        selectedModel?.rotZDeg, selectedModel?.scalePct,
        // Phase XR_OBJ_2: per-axis transform fields drive a re-bake
        // when the user types a new value in TransformPanel.
        selectedModel?.rotXDeg, selectedModel?.rotYDeg,
        selectedModel?.scaleXPct, selectedModel?.scaleYPct, selectedModel?.scaleZPct,
        selectedModel?.mirrorX, selectedModel?.mirrorY, selectedModel?.mirrorZ,
    ) {
        val sel = selectedModel ?: return@LaunchedEffect
        // Skip when the selected model's preview already reflects the
        // current rotation + scale. Without this gate, switching
        // selection between two already-rendered 3MFs triggered a
        // 10 s colored-GLB re-bake on every tap. The freshness check
        // covers the legacy rotZDeg/scalePct axes; per-axis edits are
        // identified by direct PlacedModel snapshot equality (the LE
        // key list above), so toggling them always re-bakes.
        if (sel.isPreviewFresh() &&
            sel.rotXDeg == 0f && sel.rotYDeg == 0f &&
            sel.scaleXPct == 100f && sel.scaleYPct == 100f && sel.scaleZPct == 100f &&
            !sel.mirrorX && !sel.mirrorY && !sel.mirrorZ
        ) return@LaunchedEffect
        glbPath = null
        maxLayer.value = null
        previewStl(sel.id)
    }
    LaunchedEffect(previewPalette) {
        // Palette-change path: re-render every 3MF / AMF (their colored
        // GLB writer reads the resolved "as will print" palette), plus
        // any painted STL (paint tags are project-filament indices, so
        // a mapping change shifts those too). Keying on `previewPalette`
        // instead of `paddedSlots` means the LE also fires when the
        // user changes a mapping (physicalSlot / virtualSlot) or when
        // a virtual mix gets redefined / reordered — those don't touch
        // authored colors but DO change what the preview should look
        // like. Unpainted STLs render single-color, so the palette
        // change doesn't affect them and they stay out of the loop.
        val ids = placedModels
            .filter {
                val ext = it.source.extension.lowercase()
                ext in setOf("3mf", "amf") || hasAnyPaint(it.paintFilamentIndex)
            }
            .map { it.id }
        if (ids.isEmpty()) return@LaunchedEffect
        glbPath = null
        maxLayer.value = null
        for (id in ids) previewStl(id)
    }

    // Phase J §G: re-bake the colored preview GLB whenever paint
    // state changes on any model. Debounced (200ms) to coalesce
    // continuous drag-paint strokes into one re-bake at stroke end —
    // baking the dragon takes a couple seconds, so per-event re-
    // bakes would be unusable. Each `stampTriangle{,s}` returns a
    // new ByteArray instance, so referential identity over the list
    // is a cheap stable key — Compose's smart-cast on the LE keys
    // restarts the effect on identity change without us walking
    // 1.4M bytes for a contentHashCode.
    LaunchedEffect(placedModels.map { it.paintFilamentIndex }) {
        val painted = placedModels.filter { hasAnyPaint(it.paintFilamentIndex) }
        if (painted.isEmpty()) return@LaunchedEffect
        kotlinx.coroutines.delay(200)
        // After the debounce, capture the latest paint per model and
        // re-bake. The previewStl path reads `placedModels` lazily so
        // it picks up whatever the brush left at debounce-end.
        glbPath = null
        for (m in painted) previewStl(m.id)
    }

    // Roadmap D1 — persist paint state to the on-disk cache whenever
    // any of the three triangle-keyed arrays change. Debounced (300ms)
    // so a continuous drag-paint stroke writes once at stroke end
    // rather than per-event. Keyed on the SOURCE file hash, so two
    // PlacedModels backed by the same source share the same cache
    // entry (last-write-wins is fine — they have identical paint
    // surface). Coroutine runs on Dispatchers.IO to keep the
    // mtime-touch + atomic-rename out of the main thread.
    LaunchedEffect(placedModels.map {
        Triple(it.source.absolutePath, it.paintFilamentIndex, it.supportFlags) to it.seamFlags
    }) {
        kotlinx.coroutines.delay(300)
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            for (m in placedModels) {
                val anyPaint = hasAnyPaint(m.paintFilamentIndex) ||
                    hasAnyPaint(m.supportFlags) ||
                    hasAnyPaint(m.seamFlags)
                // Tri count is recoverable from any of the three
                // arrays (they're all sized to mesh.triCount on
                // first stamp). When every array is null/empty
                // (anyPaint == false) we still call save so the
                // cache prunes the prior entry — matches the
                // "user cleared paint, persist that" expectation.
                val triCount = m.paintFilamentIndex?.size
                    ?: m.supportFlags?.size
                    ?: m.seamFlags?.size
                    ?: 0
                if (!anyPaint && triCount == 0) continue
                runCatching {
                    val hash = paintCache.hashOf(m.source)
                    paintCache.save(
                        hash,
                        triCount = triCount,
                        PaintCacheStore.Entry(
                            paintFilamentIndex = m.paintFilamentIndex,
                            supportFlags = m.supportFlags,
                            seamFlags = m.seamFlags,
                        ),
                    )
                }.onFailure {
                    android.util.Log.w("OrcaXR/paintcache",
                        "save for ${m.label} failed: ${it.message}")
                }
            }
        }
    }

    LaunchedEffect(session) {
        runCatching { session.scene.requestFullSpaceMode() }
    }

    val controllerInput = LocalControllerInput.current

    // Phase J: build BVHs for plated models the first time paint mode
    // turns on. Keys on (paintBrush.mode != Off, placedModels) so a
    // newly-loaded model gets its BVH on-demand without rebuilding
    // existing entries.
    LaunchedEffect(paintBrush.mode != PaintMode.Off, placedModels.map { it.id }) {
        if (paintBrush.mode == PaintMode.Off) return@LaunchedEffect
        for (m in placedModels) {
            if (bvhCache.get(m.id) != null) continue
            val src = m.source
            // STL is read directly; non-STL goes through deriveStlFor
            // which writes a derived STL into cache via libslic3r. The
            // derived STL's triangle order matches what
            // nativeWriteColoredGlb sees on the slice path so the
            // BVH's triangle indices align with what the JNI authors
            // into mmu_segmentation_facets. (Caveat: derived 3MFs
            // collapse all volumes; per-volume paint is deferred.)
            val readStl = runCatching {
                if (src.extension.equals("stl", ignoreCase = true)) src
                else deriveStlFor(src) ?: return@runCatching null
            }.getOrNull() ?: continue
            val mesh = runCatching { StlReader.read(readStl) }.getOrNull() ?: continue
            val bvh = MeshBvh.build(mesh)
            bvhCache.put(m.id, bvh)
            android.util.Log.i("OrcaXR/paint",
                "BVH built for ${m.label} (${mesh.triCount} tris)")
        }
    }

    /**
     * Phase J: build paint hooks for [model] if paint mode is on AND
     * this model has a BVH cached. Returns null otherwise — null
     * means "no InteractableComponent attached, this entity stays
     * purely visual." The on-paint callback BFS-expands by
     * `paintBrush.radiusMm` and writes back into `placedModels`.
     */
    fun paintHooksFor(model: PlacedModel): PaintInputHooks? {
        if (paintBrush.mode == PaintMode.Off) return null
        val bvh = bvhCache.get(model.id) ?: return null
        return PaintInputHooks(
            brush = paintBrushLive.value,
            bvh = bvh,
            onPaint = { hitTri, action ->
                val brush = paintBrushLive.value
                when (brush.mode) {
                    PaintMode.Color -> {
                        val triIndices = if (brush.radiusMm <= 0f) intArrayOf(hitTri)
                            else bvh.radiusBfs(hitTri, brush.radiusMm)
                        val updated = stampTriangles(
                            previous = model.paintFilamentIndex,
                            triCount = bvh.triCount,
                            triangleIndices = triIndices,
                            slot = brush.activeSlot,
                        )
                        placedModels = placedModels.map {
                            if (it.id == model.id) it.copy(paintFilamentIndex = updated) else it
                        }
                        android.util.Log.i(
                            "OrcaXR/paint",
                            "stamped ${triIndices.size} tris (seed=$hitTri) slot=${brush.activeSlot} " +
                                "action=$action on ${model.label}",
                        )
                    }
                    PaintMode.LayOnFace -> {
                        // Phase XR_OBJ_3 — single-pick mode. PaintInputHooks
                        // already filters out HOVER_*; we ignore MOVE so a
                        // drag doesn't fire repeatedly. DOWN is the
                        // commit edge.
                        if (action != androidx.xr.scenecore.InputEvent.Action.DOWN) return@PaintInputHooks
                        val n = bvh.triangleNormal(hitTri)
                        val (rx, ry, rz) = rotationToLayOnFace(n)
                        placedModels = placedModels.map {
                            if (it.id == model.id) it.copy(
                                rotXDeg = rx,
                                rotYDeg = ry,
                                rotZDeg = rz.toInt(),
                                // Drop Z lift so the model rests flush
                                // on the bed; the per-object auto-bed-
                                // drop in nativeSliceMulti re-grounds it
                                // at slice time anyway, but the workspace
                                // preview reads from this field for the
                                // visual.
                                translateZmm = 0f,
                            ) else it
                        }
                        // Disengage immediately — one-shot pick.
                        paintBrush = paintBrush.copy(mode = PaintMode.Off)
                        android.util.Log.i(
                            "OrcaXR/paint",
                            "lay-on-face on ${model.label}: tri=$hitTri " +
                                "n=(${n.x},${n.y},${n.z}) → " +
                                "rot=(%.2f, %.2f, %.2f)°".format(rx, ry, rz),
                        )
                    }
                    PaintMode.SupportEnforcer, PaintMode.SupportBlocker -> {
                        // Phase XR_OBJ_8 — same flood-fill as Color
                        // paint, but stamps into supportFlags with
                        // EnforcerBlockerType::ENFORCER (1) or
                        // BLOCKER (2) instead of a filament slot.
                        // The user can switch between Enforcer and
                        // Blocker via PaintBrush.mode without
                        // disengaging the brush.
                        val triIndices = if (brush.radiusMm <= 0f) intArrayOf(hitTri)
                            else bvh.radiusBfs(hitTri, brush.radiusMm)
                        val state: Int = if (brush.mode == PaintMode.SupportEnforcer) 1 else 2
                        val updated = stampTriangles(
                            previous = model.supportFlags,
                            triCount = bvh.triCount,
                            triangleIndices = triIndices,
                            slot = state,
                        )
                        placedModels = placedModels.map {
                            if (it.id == model.id) it.copy(supportFlags = updated) else it
                        }
                        android.util.Log.i(
                            "OrcaXR/paint",
                            "stamped ${triIndices.size} support tris (seed=$hitTri) " +
                                "state=${if (state == 1) "ENFORCER" else "BLOCKER"} " +
                                "action=$action on ${model.label}",
                        )
                    }
                    PaintMode.SeamEnforcer, PaintMode.SeamBlocker -> {
                        // Phase XR_OBJ_8 — same shape as support
                        // paint but writes seamFlags. Layer-start
                        // seam routing.
                        val triIndices = if (brush.radiusMm <= 0f) intArrayOf(hitTri)
                            else bvh.radiusBfs(hitTri, brush.radiusMm)
                        val state: Int = if (brush.mode == PaintMode.SeamEnforcer) 1 else 2
                        val updated = stampTriangles(
                            previous = model.seamFlags,
                            triCount = bvh.triCount,
                            triangleIndices = triIndices,
                            slot = state,
                        )
                        placedModels = placedModels.map {
                            if (it.id == model.id) it.copy(seamFlags = updated) else it
                        }
                        android.util.Log.i(
                            "OrcaXR/paint",
                            "stamped ${triIndices.size} seam tris (seed=$hitTri) " +
                                "state=${if (state == 1) "ENFORCER" else "BLOCKER"} " +
                                "action=$action on ${model.label}",
                        )
                    }
                    PaintMode.Off -> { /* paintHooksFor already short-circuits */ }
                }
            },
        )
    }

    // Galaxy XR controller plan §3.3 / §3.5: layer scrubbing.
    //
    // Active only while the user is in toolpath view (Preview mode).
    // Reads the latest `leftStickY` / `leftStickX` snapshots — does
    // NOT collect every axis emission. Stick state is naturally
    // coalesced by StateFlow.
    //
    // Y axis: continuous velocity scrub via §3.5 curve.
    //   - Sign convention: stick UP = positive Y in the bus
    //     (Activity.onGenericMotionEvent flips MotionEvent's
    //     downward Y) → positive rate → step toward higher layers.
    //   - Boundary: when maxLayer is null ("show all") and the
    //     user pushes down, snap to topLayer-1 on the first nonzero
    //     rate so the scrub visibly starts. When pushing up past
    //     topLayer, return to null.
    // X axis: ±10-layer jump per threshold cross + recenter.
    //   Debounced — must recenter (|x| < 0.3) before re-firing.
    //   Jump direction matches stick deflection; positive X is right
    //   = forward (+10 layers).
    val sliceStateLive = rememberUpdatedState(sliceState.value)
    LaunchedEffect(workspaceMode, controllerInput) {
        if (workspaceMode != WorkspaceMode.Preview) return@LaunchedEffect
        var xArmed = true  // false while a previous threshold cross hasn't recentered yet
        while (kotlin.coroutines.coroutineContext[kotlinx.coroutines.Job]?.isActive != false) {
            val parsed = (sliceStateLive.value as? SliceUiState.Done)?.parsed
            val topLayer = parsed?.layerZs?.lastIndex ?: -1
            if (topLayer <= 0) {
                kotlinx.coroutines.delay(50)
                continue
            }
            val xRaw = controllerInput.leftStickX.value
            // X click: threshold + recenter debounce. 0.7 is past the
            // typical resting noise floor but well clear of incidental
            // diagonal deflection from a Y-axis user.
            val xMag = kotlin.math.abs(xRaw)
            if (xArmed && xMag > 0.7f) {
                val dir = if (xRaw > 0f) 1 else -1
                maxLayer.value = nextJumpLayer(maxLayer.value, dir, topLayer)
                xArmed = false
            } else if (!xArmed && xMag < 0.3f) {
                xArmed = true
            }

            val v = controllerInput.leftStickY.value
            val rate = scrubRate(v)
            if (rate != 0f) {
                val cur = maxLayer.value
                val next = nextScrubLayer(cur, rate, topLayer)
                if (cur == null && next == null) {
                    // Pushing up while already showing all — nothing to
                    // scrub toward.
                    kotlinx.coroutines.delay(16)
                    continue
                }
                maxLayer.value = next
                // Cap the busy-loop cost at high rates while still
                // letting the eye see continuous motion (~125 Hz).
                val dtMs = (1000f / kotlin.math.abs(rate).coerceAtLeast(1f)).toInt()
                kotlinx.coroutines.delay(dtMs.coerceAtLeast(8).toLong())
            } else {
                kotlinx.coroutines.delay(16)
            }
        }
    }

    // Galaxy XR controller plan §4.1 / §6 Phase 4: Prepare-mode model
    // manipulation.
    //
    // Stick X → rotate selected model by 90° per threshold cross +
    // recenter (matches PlacedModel.rotZDeg's quartet quantization
    // assumed by footprintMm).
    // Stick Y → nudge selected model along bed-Y by 5 mm per threshold
    // cross + recenter, going through snapAndClampOffset so it shares
    // clamping / snapping with the drag handle (no surprise drift onto
    // odd millimetre values).
    //
    // No-op when nothing's selected — explicitly do not move the
    // workspace; the bed grab handle already owns that interaction.
    LaunchedEffect(workspaceMode, controllerInput) {
        if (workspaceMode != WorkspaceMode.Prepare) return@LaunchedEffect
        var xArmed = true
        var yArmed = true
        while (kotlin.coroutines.coroutineContext[kotlinx.coroutines.Job]?.isActive != false) {
            val sel = selectedModelId
            if (sel != null) {
                val xRaw = controllerInput.leftStickX.value
                val yRaw = controllerInput.leftStickY.value
                val xMag = kotlin.math.abs(xRaw)
                val yMag = kotlin.math.abs(yRaw)
                if (xArmed && xMag > 0.7f) {
                    val dir = if (xRaw > 0f) 1 else -1
                    placedModels = placedModels.map {
                        if (it.id == sel) it.copy(rotZDeg = nextRotationDeg(it.rotZDeg, dir))
                        else it
                    }
                    xArmed = false
                } else if (!xArmed && xMag < 0.3f) {
                    xArmed = true
                }
                if (yArmed && yMag > 0.7f) {
                    val ySign = if (yRaw > 0f) 1f else -1f
                    placedModels = placedModels.map {
                        if (it.id == sel) {
                            val snapped = snapAndClampOffset(
                                it.translateXmm,
                                it.translateYmm + ySign * 5f,
                            )
                            it.copy(translateXmm = snapped.x, translateYmm = snapped.y)
                        } else it
                    }
                    yArmed = false
                } else if (!yArmed && yMag < 0.3f) {
                    yArmed = true
                }
            }
            kotlinx.coroutines.delay(16)
        }
    }

    // Test-harness command pump. TestController.commands is fed only by the
    // debug-only TestBroadcastReceiver (src/debug/) — in a release build
    // this collector is permanently idle. Drives onFileSelected / runSlice
    // through the same paths the UI does so the load + slice flow under
    // automation matches the human flow exactly.
    //
    // rememberUpdatedState wraps the closures over `loadedStl`,
    // `activePrinter`, and `printers` so the long-lived collect coroutine
    // sees the LATEST values rather than the ones at first composition
    // (which would otherwise be empty/null). Without this, SetPalette
    // arriving early reports "no printer available" because the
    // LaunchedEffect captured `printers = emptyList()` from the initial
    // collectAsState before DataStore had finished loading.
    val testStateLoadedStl by rememberUpdatedState(loadedStl)
    val testStatePlacedModels by rememberUpdatedState(placedModels)
    val testStateActivePrinter by rememberUpdatedState(activePrinter)
    val testStatePrinters by rememberUpdatedState(printers)
    val testStatePaddedSlots by rememberUpdatedState(paddedSlots)
    val testStatePaddedSlotRemap by rememberUpdatedState(paddedSlotRemap)
    val testStateProfile by rememberUpdatedState(selectedProfile.value)
    val testStateLayerHeight by rememberUpdatedState(layerHeightOverride.value)
    val testStateSlotTypes by rememberUpdatedState(filamentList.map { it.filamentType })
    LaunchedEffect(Unit) {
        TestController.commands.collect { cmd ->
            when (cmd) {
                is TestController.Command.LoadFile -> {
                    val f = java.io.File(cmd.path)
                    if (f.exists()) {
                        android.util.Log.i("OrcaXR/test", "dispatching LoadFile ${cmd.path}")
                        onFileSelected(f)
                    } else {
                        android.util.Log.e("OrcaXR/test", "LoadFile: not found: ${cmd.path}")
                    }
                }
                is TestController.Command.LoadFileAdd -> {
                    val f = java.io.File(cmd.path)
                    if (f.exists()) {
                        android.util.Log.i("OrcaXR/test", "dispatching LoadFileAdd ${cmd.path}")
                        // Drive the same path the UI's "+ Add another"
                        // button takes: pickerMode=Add, then the
                        // shared onFileSelected appends a new
                        // PlacedModel to placedModels and selects it.
                        pickerMode = PickerMode.Add
                        onFileSelected(f)
                    } else {
                        android.util.Log.e("OrcaXR/test", "LoadFileAdd: not found: ${cmd.path}")
                    }
                }
                TestController.Command.Slice -> {
                    val placed = testStatePlacedModels
                    val cur = testStateLoadedStl
                    if (placed.size >= 2) {
                        // Phase G multi-model path. Same dispatch as the
                        // UI's Slice button when 2+ models are plated.
                        // Phase XR_OBJ_4-late gotcha #62b fix: pass
                        // the rememberUpdatedState-tracked live values
                        // explicitly so runSliceMulti's mergedConfig
                        // sees populated paddedSlots. Without this the
                        // LE closure captured paddedSlots-at-composition
                        // (typically empty pre-DataStore-load) and
                        // collapsed filament_diameter to 1, silently
                        // disabling MMS even for painted 3MFs.
                        android.util.Log.i("OrcaXR/test",
                            "dispatching SliceMulti on ${placed.size} models " +
                            "with paddedSlots=${testStatePaddedSlots} " +
                            "activePrinter=${testStateActivePrinter?.id}")
                        runSliceMulti(
                            placed,
                            slots = testStatePaddedSlots,
                            slotRemap = testStatePaddedSlotRemap,
                            profile = testStateProfile,
                            layerHeight = testStateLayerHeight,
                            slotTypes = testStateSlotTypes,
                        )
                    } else if (cur != null) {
                        // runSlice() is captured stale by this LE — its closure has
                        // the paddedSlots / selectedProfile from when LE was created
                        // (often empty before DataStore loaded). Drive the slice via
                        // the SAME state path the UI does but with rememberUpdatedState
                        // captures so paddedSlots is the live value. The pump below
                        // mirrors the runSlice body (line ~853) one-for-one.
                        android.util.Log.i("OrcaXR/test",
                            "dispatching Slice on ${cur.label} " +
                            "with paddedSlots=${testStatePaddedSlots} " +
                            "activePrinter=${testStateActivePrinter?.id}")
                        glbPath = null
                        maxLayer.value = null
                        sliceState.value = SliceUiState.Slicing(sourceLabel = cur.label)
                        val cfg = mergedConfig(
                            testStateProfile,
                            testStateLayerHeight,
                            testStatePaddedSlots,
                            mixedFilamentDefinitions,
                            testStatePaddedSlotRemap,
                            extraOverrides = printSettingsOverrides.value,
                            flushFromProject = loadedFlushSettings,
                            projectOverrides = loadedProjectOverrides,
                            slotTypes = testStateSlotTypes,
                            allFilaments = filamentsCatalog,
                        )
                        // Phase J: pull paint from the selected
                        // PlacedModel (the test pump's `cur` is the
                        // legacy LoadedStl projection, but paint
                        // state lives on the source PlacedModel).
                        val paintForSlice = testStatePlacedModels.firstOrNull()?.paintFilamentIndex
                        // Phase XR_OBJ_8 — support paint travels via
                        // the same per-PlacedModel ByteArray pattern.
                        val supportForSlice = testStatePlacedModels.firstOrNull()?.supportFlags
                        val seamForSlice = testStatePlacedModels.firstOrNull()?.seamFlags
                        // Phase XR_OBJ_4 — extra volumes attached via
                        // ADD_PART broadcast (or "Add part" UI button)
                        // ride into the slice as MODEL_PART volumes
                        // on the loaded model's first ModelObject.
                        val extraVolumesForSlice = testStatePlacedModels.firstOrNull()?.volumes ?: emptyList()
                        val result = sliceLocalFile(
                            cur.file,
                            cfg,
                            virtualRemap = paddedVirtualRemap,
                            paintFilamentIndex = paintForSlice,
                            extraVolumes = extraVolumesForSlice,
                            supportFlags = supportForSlice,
                            seamFlags = seamForSlice,
                            objectConfigOverrides = testStatePlacedModels.firstOrNull()?.configOverrides ?: emptyMap(),
                        ) { percent, message ->
                            val now = sliceState.value
                            if (now is SliceUiState.Slicing) {
                                sliceState.value = now.copy(percent = percent, message = message)
                            }
                        }
                        val parsed = (result as? SliceResult.Success)?.let {
                            runCatching { GcodeParser.parse(File(it.outputPath)) }.getOrNull()
                        }
                        sliceState.value = SliceUiState.Done(cur.label, result, parsed)
                    } else {
                        android.util.Log.w("OrcaXR/test", "Slice: no model loaded")
                    }
                }
                is TestController.Command.GamepadAxis -> {
                    // Drive ControllerInputBus directly — bypasses the
                    // Activity's onGenericMotionEvent path so tests
                    // can run on any device without needing a paired
                    // gamepad. Mirrors what the real input pump
                    // would do for a non-zero stick deflection.
                    android.util.Log.i("OrcaXR/test",
                        "dispatching GamepadAxis x=${cmd.x} y=${cmd.y}")
                    controllerInput.setLeftStick(cmd.x, cmd.y)
                }
                is TestController.Command.GamepadButton -> {
                    android.util.Log.i("OrcaXR/test",
                        "dispatching GamepadButton ${cmd.button}")
                    controllerInput.emitButton(cmd.button)
                }
                is TestController.Command.Paint -> {
                    val placed = testStatePlacedModels
                    val target = placed.getOrNull(cmd.modelIndex)
                    if (target == null) {
                        android.util.Log.e("OrcaXR/test",
                            "Paint: model[${cmd.modelIndex}] out of range (size=${placed.size})")
                    } else {
                        // Triangle count is the source mesh's first
                        // volume's tri count. STL is single-volume by
                        // construction; for 3MFs we use the first
                        // volume to match the JNI authoring path.
                        val triCount = runCatching {
                            val src = if (target.source.extension.equals("stl", true)) target.source
                                else File(ctx.cacheDir, "${target.source.nameWithoutExtension}_derived.stl")
                                    .takeIf { it.exists() }
                                    ?: target.source
                            if (src.extension.equals("stl", true)) StlReader.read(src).triCount
                            else target.paintFilamentIndex?.size ?: 0
                        }.getOrDefault(0)
                        if (triCount <= 0) {
                            android.util.Log.e("OrcaXR/test",
                                "Paint: can't determine triangle count for ${target.label}")
                        } else if (cmd.triangleIdx !in 0 until triCount) {
                            android.util.Log.e("OrcaXR/test",
                                "Paint: tri=${cmd.triangleIdx} out of [0, $triCount)")
                        } else {
                            val updated = stampTriangle(
                                previous = target.paintFilamentIndex,
                                triCount = triCount,
                                triangleIdx = cmd.triangleIdx,
                                slot = cmd.slot,
                            )
                            placedModels = placedModels.map {
                                if (it.id == target.id) it.copy(paintFilamentIndex = updated) else it
                            }
                            android.util.Log.i("OrcaXR/test",
                                "Paint: stamped tri ${cmd.triangleIdx} = slot ${cmd.slot} on ${target.label}")
                        }
                    }
                }
                is TestController.Command.PaintMany -> {
                    val placed = testStatePlacedModels
                    val target = placed.getOrNull(cmd.modelIndex)
                    if (target == null) {
                        android.util.Log.e("OrcaXR/test",
                            "PaintMany: model[${cmd.modelIndex}] out of range (size=${placed.size})")
                    } else {
                        val triCount = runCatching {
                            val src = if (target.source.extension.equals("stl", true)) target.source
                                else File(ctx.cacheDir, "${target.source.nameWithoutExtension}_derived.stl")
                                    .takeIf { it.exists() }
                                    ?: target.source
                            if (src.extension.equals("stl", true)) StlReader.read(src).triCount
                            else target.paintFilamentIndex?.size ?: 0
                        }.getOrDefault(0)
                        if (triCount <= 0) {
                            android.util.Log.e("OrcaXR/test",
                                "PaintMany: can't determine tri count for ${target.label}")
                        } else {
                            val filtered = cmd.triangleIndices.filter { it in 0 until triCount }.toIntArray()
                            // Phase XR_OBJ_8: kind="support" / "seam"
                            // routes into supportFlags / seamFlags
                            // instead of paintFilamentIndex.
                            val previous = when (cmd.kind) {
                                "support" -> target.supportFlags
                                "seam" -> target.seamFlags
                                else -> target.paintFilamentIndex
                            }
                            val updated = stampTriangles(
                                previous = previous,
                                triCount = triCount,
                                triangleIndices = filtered,
                                slot = cmd.slot,
                            )
                            placedModels = placedModels.map {
                                if (it.id == target.id) {
                                    when (cmd.kind) {
                                        "support" -> it.copy(supportFlags = updated)
                                        "seam" -> it.copy(seamFlags = updated)
                                        else -> it.copy(paintFilamentIndex = updated)
                                    }
                                } else it
                            }
                            android.util.Log.i("OrcaXR/test",
                                "PaintMany: stamped ${filtered.size}/${cmd.triangleIndices.size} tris " +
                                "= ${cmd.kind} slot ${cmd.slot} on ${target.label}")
                        }
                    }
                }
                is TestController.Command.SetPalette -> {
                    val printerId = testStateActivePrinter?.id ?: testStatePrinters.firstOrNull()?.id
                    if (printerId == null) {
                        android.util.Log.e("OrcaXR/test", "SetPalette: no printer available")
                    } else {
                        val updated = cmd.colors.mapIndexed { i, c ->
                            FilamentEntry(
                                id = "slot_$i",
                                color = c,
                                slotIndex = i,
                                filamentType = "PLA",
                            )
                        }
                        // Both stores are DataStore-backed and suspend.
                        // Run the writes here (we're already inside the
                        // collect coroutine). Also pass a colors list to
                        // FilamentSlotsStore (its `set` takes List<String>,
                        // not a count) so the printer-side palette matches.
                        filamentEntriesStore.set(printerId, updated)
                        filamentSlotsStore.set(printerId, cmd.colors)
                        if (selectedPrinterId.value != printerId) {
                            selectedPrinterId.value = printerId
                        }
                        android.util.Log.i("OrcaXR/test",
                            "SetPalette: applied ${cmd.colors.size} colors to printer $printerId")
                    }
                }
                TestController.Command.Arrange -> {
                    if (testStatePlacedModels.size < 2) {
                        android.util.Log.e("OrcaXR/test", "Arrange: needs ≥2 models (have ${testStatePlacedModels.size})")
                    } else {
                        android.util.Log.i("OrcaXR/test", "Arrange: packing ${testStatePlacedModels.size} models")
                        runAutoArrange()
                    }
                }
                is TestController.Command.BoolOp -> {
                    val placed = testStatePlacedModels
                    if (placed.size < 2) {
                        android.util.Log.e("OrcaXR/test", "Boolean: needs ≥2 models (have ${placed.size})")
                    } else {
                        val a = placed[0]
                        val b = placed[1]
                        android.util.Log.i("OrcaXR/test", "Boolean: ${a.id} ${a.label} <op=${cmd.op}> ${b.id} ${b.label}")
                        // Drive the JNI directly — runBoolean uses
                        // selectedModel/placedModels which can be
                        // stale inside this collector.
                        scope.launch {
                            val out = File(ctx.cacheDir, "bool_${cmd.op}_${System.currentTimeMillis()}.3mf")
                            val ok = runCatching {
                                SlicerEngine.meshBoolean(a.source, b.source, cmd.op, out)
                            }.onFailure {
                                android.util.Log.e("OrcaXR/test", "meshBoolean threw", it)
                            }.getOrDefault(false)
                            android.util.Log.i("OrcaXR/test",
                                "Boolean: ok=$ok output=${out.absolutePath} (${if (out.exists()) out.length() else -1L} bytes)")
                        }
                    }
                }
                is TestController.Command.SetObjectConfig -> {
                    val target = testStatePlacedModels.firstOrNull { it.id == selectedModelId }
                        ?: testStatePlacedModels.firstOrNull()
                    if (target == null) {
                        android.util.Log.e("OrcaXR/test", "SetObjectConfig: no model loaded")
                    } else {
                        android.util.Log.i("OrcaXR/test",
                            "SetObjectConfig: ${target.id} ${cmd.key}=${cmd.value}")
                        placedModels = placedModels.map {
                            if (it.id == target.id) {
                                val newOverrides = if (cmd.value.isBlank())
                                    it.configOverrides - cmd.key
                                else
                                    it.configOverrides + (cmd.key to cmd.value)
                                it.copy(configOverrides = newOverrides)
                            } else it
                        }
                    }
                }
                is TestController.Command.ClonePattern -> {
                    val target = testStatePlacedModels.firstOrNull { it.id == selectedModelId }
                        ?: testStatePlacedModels.firstOrNull()
                    if (target == null) {
                        android.util.Log.e("OrcaXR/test", "ClonePattern: no model loaded")
                    } else {
                        android.util.Log.i("OrcaXR/test",
                            "ClonePattern: source=${target.id} count=${cmd.count} spacing=${cmd.spacingMm} axis=${cmd.axis}")
                        runClonePattern(target.id, cmd.count, cmd.spacingMm, cmd.axis)
                    }
                }
                TestController.Command.Split -> {
                    val placed = testStatePlacedModels
                    val target = placed.firstOrNull { it.id == selectedModelId } ?: placed.firstOrNull()
                    if (target == null) {
                        android.util.Log.e("OrcaXR/test", "Split: no model loaded")
                    } else {
                        android.util.Log.i("OrcaXR/test", "Split: ${target.id} ${target.label}")
                        scope.launch {
                            val outDir = File(ctx.cacheDir, "split_${target.id}_${System.currentTimeMillis()}")
                            val pieces = runCatching {
                                SlicerEngine.splitObject(target.source, outDir)
                            }.onFailure {
                                android.util.Log.e("OrcaXR/test", "splitObject threw", it)
                            }.getOrNull()
                            android.util.Log.i("OrcaXR/test",
                                "Split: pieces=${pieces?.size ?: -1}")
                            pieces?.forEach { android.util.Log.i("OrcaXR/test", "  $it") }
                        }
                    }
                }
                is TestController.Command.Cut -> {
                    val target = testStatePlacedModels.firstOrNull { it.id == selectedModelId }
                        ?: testStatePlacedModels.firstOrNull()
                    if (target == null) {
                        android.util.Log.e("OrcaXR/test", "Cut: no model loaded")
                    } else {
                        android.util.Log.i("OrcaXR/test", "Cut: ${target.id} (${target.label}) at z=${cmd.planeZmm}")
                        // Drive the JNI directly with the resolved
                        // target — bypasses runCut's read of
                        // `selectedModel`, which doesn't recompute
                        // synchronously inside this collector.
                        val out = File(ctx.cacheDir, "cut_${target.id}_${cmd.planeZmm.toInt()}mm.3mf")
                        val ok = runCatching {
                            SlicerEngine.cutObject(
                                target.source,
                                out,
                                cmd.planeZmm,
                                SlicerEngine.CutAttr.KEEP_UPPER or
                                    SlicerEngine.CutAttr.KEEP_LOWER or
                                    SlicerEngine.CutAttr.PLACE_ON_CUT_UPPER or
                                    SlicerEngine.CutAttr.PLACE_ON_CUT_LOWER,
                            )
                        }.onFailure {
                            android.util.Log.e("OrcaXR/test", "cutObject threw", it)
                        }.getOrDefault(false)
                        android.util.Log.i("OrcaXR/test", "Cut: ok=$ok output=${out.absolutePath} (${if (out.exists()) out.length() else -1L} bytes)")
                    }
                }
                is TestController.Command.AddPart -> {
                    val targetId = selectedModelId ?: testStatePlacedModels.firstOrNull()?.id
                    if (targetId == null) {
                        android.util.Log.e("OrcaXR/test", "AddPart: no model loaded")
                    } else {
                        val source = File(cmd.path)
                        if (!source.exists() || !source.canRead()) {
                            android.util.Log.e("OrcaXR/test", "AddPart: file not readable: ${cmd.path}")
                        } else {
                            val volumeId = "vol_${System.currentTimeMillis().toString(36)}"
                            val v = PlacedVolume(
                                id = volumeId,
                                source = source,
                                type = cmd.type,
                            )
                            placedModels = placedModels.map {
                                if (it.id == targetId) it.copy(volumes = it.volumes + v) else it
                            }
                            android.util.Log.i(
                                "OrcaXR/test",
                                "AddPart: attached ${source.name} to $targetId as ${cmd.type}",
                            )
                        }
                    }
                }
                TestController.Command.AutoOrient -> {
                    val sel = testStatePlacedModels.firstOrNull { it.id == selectedModelId }
                        ?: testStatePlacedModels.firstOrNull()
                    if (sel == null) {
                        android.util.Log.e("OrcaXR/test", "AutoOrient: no model loaded")
                    } else {
                        android.util.Log.i("OrcaXR/test", "AutoOrient: orienting ${sel.label}")
                        val rot = runCatching {
                            SlicerEngine.autoOrient(sel.source)
                        }.onFailure {
                            android.util.Log.e("OrcaXR/test", "autoOrient threw", it)
                        }.getOrNull()
                        if (rot != null && rot.size == 3) {
                            placedModels = placedModels.map {
                                if (it.id == sel.id) it.copy(
                                    rotXDeg = rot[0],
                                    rotYDeg = rot[1],
                                    rotZDeg = rot[2].toInt(),
                                ) else it
                            }
                            android.util.Log.i("OrcaXR/test",
                                "AutoOrient: applied (%.2f, %.2f, %.2f)°".format(rot[0], rot[1], rot[2]))
                        } else {
                            android.util.Log.w("OrcaXR/test", "AutoOrient: JNI returned null")
                        }
                    }
                }
            }
        }
    }

    // Galaxy XR controller plan §4.1 / §6 Phase 3: face-button quick
    // actions. Bindings are mode-aware where it matters, otherwise the
    // same action runs in both Prepare and Preview.
    //
    //   A: contextual confirm. Currently dispatches the same slice
    //      lambda the bottom Slice button does (multi → sliceMulti,
    //      single → runSlice, empty → bundled cube). XR runtime's
    //      trigger-click on InteractableComponents is unaffected.
    //   B: in-app contextual cancel — exit Preview back to Prepare,
    //      otherwise no-op. Does NOT route to system back; that stays
    //      with the OS/headset chrome.
    //   X: toggle Prepare ↔ Preview. Only when a slice exists; without
    //      one a Toast surfaces the requirement so the binding is
    //      discoverable.
    //   Y: toggle showTravels (matches the Prepare/Preview Travels
    //      switch).
    //
    // Each press goes through onKeyDown's `repeatCount == 0` guard at
    // the Activity level, so holding a button does not auto-repeat
    // these toggles.
    LaunchedEffect(controllerInput) {
        controllerInput.buttons.collect { button ->
            when (button) {
                ControllerButton.A -> {
                    val placed = placedModels
                    when {
                        placed.size >= 2 -> runSliceMulti(placed)
                        placed.size == 1 -> {
                            val target = placed.first()
                            runSlice(target.source, target.label)
                        }
                        else -> {
                            scope.launch {
                                val label = "cube_20mm.stl (bundled)"
                                val stl = copyBundledCube(ctx)
                                val cubeId = "model_cube_${System.currentTimeMillis().toString(36)}"
                                placedModels = listOf(PlacedModel(id = cubeId, source = stl, label = label))
                                selectedModelId = cubeId
                                previewStl(cubeId)
                                runSlice(stl, label)
                            }
                        }
                    }
                }
                ControllerButton.B -> {
                    if (workspaceMode == WorkspaceMode.Preview) {
                        workspaceMode = WorkspaceMode.Prepare
                    }
                }
                ControllerButton.X -> {
                    val sliceExists = glbPath != null
                    if (sliceExists) {
                        workspaceMode = if (workspaceMode == WorkspaceMode.Preview) {
                            WorkspaceMode.Prepare
                        } else {
                            WorkspaceMode.Preview
                        }
                    } else {
                        android.widget.Toast.makeText(
                            ctx,
                            "Slice first to use the toolpath toggle",
                            android.widget.Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
                ControllerButton.Y -> {
                    showTravels.value = !showTravels.value
                }
            }
        }
    }

    // Rebuild the GLB whenever the parsed toolpath OR the layer cap
    // changes. We write to a single cache file but bump glbVersion so
    // the SceneCoreEntity composable below tears down + reloads (GLB
    // model caches by path; reusing the path without disposing won't
    // pick up new bytes).
    LaunchedEffect(sliceState.value, maxLayer.value, showTravels.value, toolpathTubes.value, paddedSlots) {
        val st = sliceState.value
        if (st is SliceUiState.Done && st.parsed != null) {
            // Debounce: dragging the layer slider fires this LaunchedEffect
            // tens of times per second. Without the delay we wrote a 5 MB
            // GLB and re-loaded it into SceneCore on every tick, which
            // triggered IOException: close failed: EIO and ART JNI
            // warnings. The 200 ms grace period swallows continuous drags
            // and only the user's final value writes to disk; the
            // LaunchedEffect is cancelled+restarted on the next state
            // change, so the old in-flight write never lands.
            kotlinx.coroutines.delay(200)
            val outFile = File(ctx.cacheDir, "toolpath_v${glbVersion + 1}.glb")
            runCatching {
                ToolpathGlb.write(
                    toolpath = st.parsed,
                    out = outFile,
                    maxLayerInclusive = maxLayer.value,
                    includeTravels = showTravels.value,
                    // Toolpath segments are tagged with `extruder` from the
                    // gcode T-command, which (post-Phase-L post-processor)
                    // is the physical extruder index — NOT the project
                    // filament. Index by physicalSlotPalette so the
                    // toolpath shows what each physical hot-end will
                    // actually deposit, matching the printed result.
                    // paddedSlots (authored project-filament colors) was
                    // wrong here: a body region remapped onto T2 used to
                    // render with filament-2's authored color (cyan in
                    // the user's dragon test) instead of T2's loaded
                    // color (yellow).
                    extruderPalette = physicalSlotPalette,
                    tubes = toolpathTubes.value,
                )
            }
                .onSuccess {
                    // Drop any older toolpath_v*.glb files so the cache
                    // doesn't grow without bound. We've seen a single
                    // session leave 100+ MB of stale GLBs behind.
                    runCatching {
                        ctx.cacheDir.listFiles { f ->
                            f.name.startsWith("toolpath_v") &&
                                f.name.endsWith(".glb") &&
                                f.absolutePath != outFile.absolutePath
                        }?.forEach { it.delete() }
                    }
                    glbVersion += 1
                    glbPath = outFile.absolutePath
                }
                .onFailure { glbPath = null }
        }
    }

    // Create a root GroupEntity ahead of the
    // Subspace composition and wrap SpatialPanel in a SceneCoreEntity
    // bound to that root.
    val rootEntity = remember(session) {
        runCatching {
            val root = GroupEntity.create(session, "OrcaXR-root")
            // Push the entire UI shell back by 1.5 meters. 0.8 m put the
            // bed in the user's lap and made the panels feel oversized
            // because they were sitting right in front of the eyes; at
            // 1.5 m things sit at a comfortable reading distance.
            root.setPose(
                androidx.xr.runtime.math.Pose(
                    androidx.xr.runtime.math.Vector3(0f, 0f, -1.5f),
                    androidx.xr.runtime.math.Quaternion.Identity
                )
            )
            root
        }.getOrNull()
    }

    // The MovableComponent on the root entity is intentionally disabled because
    // its bounding box intercepts gaze/pinch raycasts, preventing clicks
    // from reaching the UI panels. Each SpatialPanel has its own system handle.

    // Workspace parent: a GroupEntity nested under rootEntity that
    // carries the bed/model/toolpath. Holding the workspace separately
    // gives us two things:
    //  1. The workspace pose (offset + axis-convention rotation) lives
    //     on this entity, so child GLBs only need WORLD_SCALE applied.
    //  2. We can attach a MovableComponent to *only* the workspace —
    //     the user can grab and reorient the bed independently of the
    //     info panels, without the grab box intercepting clicks on the
    //     panels (the workspace box sits below the panel column).
    val workspaceEntity = remember(session, rootEntity) {
        if (rootEntity == null) return@remember null
        runCatching {
            val ws = GroupEntity.create(session, "OrcaXR-workspace")
            ws.parent = rootEntity
            ws.setPose(
                androidx.xr.runtime.math.Pose(
                    androidx.xr.runtime.math.Vector3(0f, WORKSPACE_Y_OFFSET, 0.0f),
                    WORKSPACE_ROTATION,
                ),
            )
            ws
        }.getOrNull()
    }

    val bedGrabHandle = remember(session, rootEntity, workspaceEntity) {
        if (rootEntity == null || workspaceEntity == null) return@remember null
        runCatching {
            val handle = GroupEntity.create(session, "OrcaXR-bedGrab")
            handle.parent = rootEntity
            handle.setPose(
                androidx.xr.runtime.math.Pose(
                    androidx.xr.runtime.math.Vector3(0f, WORKSPACE_Y_OFFSET, 0.20f),
                    androidx.xr.runtime.math.Quaternion.Identity,
                )
            )
            val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
            val listener = object : androidx.xr.scenecore.EntityMoveListener {
                override fun onMoveUpdate(
                    entity: androidx.xr.scenecore.Entity,
                    currentInputRay: androidx.xr.runtime.math.Ray,
                    currentPose: androidx.xr.runtime.math.Pose,
                    currentScale: Float,
                ) {
                    val currentTx = currentPose.translation
                    val prevHandleTx = bedHandleTx
                    val deltaX = currentTx.x - prevHandleTx.x
                    val deltaY = currentTx.y - prevHandleTx.y
                    val deltaZ = currentTx.z - prevHandleTx.z
                    
                    val newWsTx = androidx.xr.runtime.math.Vector3(
                        workspaceTx.x + deltaX,
                        workspaceTx.y + deltaY,
                        workspaceTx.z + deltaZ,
                    )
                    
                    workspaceTx = newWsTx
                    bedHandleTx = currentTx
                    
                    workspaceEntity.setPose(
                        androidx.xr.runtime.math.Pose(
                            newWsTx,
                            WORKSPACE_ROTATION,
                        )
                    )
                    entity.setPose(androidx.xr.runtime.math.Pose(currentTx, androidx.xr.runtime.math.Quaternion.Identity))
                }
            }
            val mc = androidx.xr.scenecore.MovableComponent.createCustomMovable(
                session,
                /* scaleInZ = */ false,
                executor,
                listener,
            )
            mc.size = androidx.xr.runtime.math.FloatSize3d(0.45f, 0.025f, 0.05f)
            handle.addComponent(mc)
            handle
        }.getOrNull()
    }

    // Phase G: the grab handle drives the SELECTED model. When the
    // user picks a different model in the LeftProjectPanel, an LE
    // below repositions the handle to that model's translation. The
    // listener captures `selectedModelIdRef` (a rememberUpdatedState)
    // so the latest selection is always honored even though the
    // listener instance was constructed once at remember time.
    val selectedModelIdLive = rememberUpdatedState(selectedModelId)
    // Phase J: when paint mode is on, the model-grab volume gets out
    // of the laser's way so it can hit the model entity directly.
    // Re-keying on the paint flag means flipping paint on/off
    // disposes/recreates the handle. The model's translation isn't
    // lost — it lives on `PlacedModel.translateXmm/Ymm` and the
    // re-position LaunchedEffect re-poses the handle on creation.
    val paintModeOn = paintBrush.mode != PaintMode.Off
    val modelGrabHandle = remember(session, workspaceEntity, paintModeOn) {
        if (workspaceEntity == null || paintModeOn) return@remember null
        runCatching {
            val handle = GroupEntity.create(session, "OrcaXR-modelGrab")
            handle.parent = workspaceEntity
            handle.setPose(
                androidx.xr.runtime.math.Pose(
                    androidx.xr.runtime.math.Vector3(0f, 0f, 0f),
                    androidx.xr.runtime.math.Quaternion.Identity,
                )
            )
            val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
            val listener = object : androidx.xr.scenecore.EntityMoveListener {
                override fun onMoveUpdate(
                    entity: androidx.xr.scenecore.Entity,
                    currentInputRay: androidx.xr.runtime.math.Ray,
                    currentPose: androidx.xr.runtime.math.Pose,
                    currentScale: Float,
                ) {
                    val rawX = currentPose.translation.x / WORLD_SCALE
                    val rawY = currentPose.translation.y / WORLD_SCALE
                    val snapped = snapAndClampOffset(rawX, rawY)
                    val targetId = selectedModelIdLive.value
                    if (targetId != null) {
                        placedModels = placedModels.map {
                            if (it.id == targetId) it.copy(
                                translateXmm = snapped.x,
                                translateYmm = snapped.y,
                            ) else it
                        }
                    }
                    entity.setPose(
                        androidx.xr.runtime.math.Pose(
                            androidx.xr.runtime.math.Vector3(snapped.x * WORLD_SCALE, snapped.y * WORLD_SCALE, 0f),
                            androidx.xr.runtime.math.Quaternion.Identity,
                        )
                    )
                }
            }
            val mc = androidx.xr.scenecore.MovableComponent.createCustomMovable(
                session,
                /* scaleInZ = */ false,
                executor,
                listener,
            )
            mc.size = androidx.xr.runtime.math.FloatSize3d(0.25f, 0.125f, 0.25f)
            handle.addComponent(mc)
            handle
        }.getOrNull()
    }

    // Re-position the grab handle whenever the selected model
    // changes (or its translation is mutated by auto-arrange). The
    // handle is the user's affordance for "this is the model I'll
    // move next" — silently leaving it on the previous model
    // breaks the spatial mapping the workspace relies on.
    LaunchedEffect(modelGrabHandle, selectedModel?.id, selectedModel?.translateXmm, selectedModel?.translateYmm) {
        val handle = modelGrabHandle ?: return@LaunchedEffect
        val sel = selectedModel ?: run {
            // No selection — park the handle at workspace origin
            // so it doesn't strand on the previous model's position.
            handle.setPose(
                androidx.xr.runtime.math.Pose(
                    androidx.xr.runtime.math.Vector3(0f, 0f, 0f),
                    androidx.xr.runtime.math.Quaternion.Identity,
                ),
            )
            return@LaunchedEffect
        }
        handle.setPose(
            androidx.xr.runtime.math.Pose(
                androidx.xr.runtime.math.Vector3(
                    sel.translateXmm * WORLD_SCALE,
                    sel.translateYmm * WORLD_SCALE,
                    0f,
                ),
                androidx.xr.runtime.math.Quaternion.Identity,
            ),
        )
    }

    Subspace {
        rootEntity?.let { root ->
            SceneCoreEntity(
                factory = { root },
                modifier = SubspaceModifier,
            ) {
                // Top Navigation Pill
                MovablePanelWrapper(
                    id = "top-nav",
                    width = 800.dp,
                    height = 250.dp, // Increased height for two-tier layout
                    initialOffset = androidx.xr.runtime.math.Vector3(0f, 0.4f, -0.2f),
                    session = session,
                ) {
                    TopNavigationPill(
                        mode = workspaceMode,
                        onModeChange = { workspaceMode = it },
                        previewEnabled = glbPath != null,
                        onResetWorkspace = {
                            val newWsTx = androidx.xr.runtime.math.Vector3(0f, WORKSPACE_Y_OFFSET, 0.0f)
                            val newHandleTx = androidx.xr.runtime.math.Vector3(0f, WORKSPACE_Y_OFFSET, 0.20f)
                            workspaceTx = newWsTx
                            bedHandleTx = newHandleTx

                            // Reset model
                            workspaceEntity?.setPose(
                                androidx.xr.runtime.math.Pose(
                                    newWsTx,
                                    WORKSPACE_ROTATION,
                                ),
                            )
                            bedGrabHandle?.setPose(
                                androidx.xr.runtime.math.Pose(
                                    newHandleTx,
                                    androidx.xr.runtime.math.Quaternion.Identity,
                                ),
                            )
                            // Reset every plated model's XY offset (Phase G:
                            // multi-model state). Reset uses (0, 0) for
                            // every model — the user can re-run auto-arrange
                            // afterward to space them out cleanly.
                            placedModels = placedModels.map {
                                it.copy(translateXmm = 0f, translateYmm = 0f)
                            }
                            // Reset all panels
                            initialPanelPoses.forEach { (id, pose) ->
                                panelPoses[id] = pose
                            }
                        },
                        devicesShown = devicesShown,
                        onToggleDevices = { devicesShown = !devicesShown },
                        helpShown = helpShown,
                        onToggleHelp = { helpShown = !helpShown },
                        modelRotZDeg = modelRotZDeg,
                        rotateEnabled = selectedModel != null,
                        onRotateModel = {
                            updateSelected { it.copy(rotZDeg = (it.rotZDeg + 90) % 360) }
                        },
                        modelScalePct = modelScalePct,
                        scaleEnabled = selectedModel != null,
                        onScaleModel = {
                            updateSelected {
                                val idx = SCALE_PRESETS.indexOf(it.scalePct).coerceAtLeast(0)
                                it.copy(scalePct = SCALE_PRESETS[(idx + 1) % SCALE_PRESETS.size])
                            }
                        },
                        // Phase J controls: paint enabled iff at least one
                        // model is plated (paint without a model is a no-op
                        // and confuses the affordance). Toggling Paint flips
                        // mode between Color and Off; cycle slots / radius
                        // edit paintBrush in place. Max slot count tracks
                        // the active printer's filament-slot fleet.
                        paintBrush = paintBrush,
                        paintEnabled = placedModels.isNotEmpty(),
                        onTogglePaint = {
                            paintBrush = paintBrush.copy(
                                mode = if (paintBrush.mode == PaintMode.Off) PaintMode.Color
                                    else PaintMode.Off,
                            )
                        },
                        onPaintSlotChange = { newSlot ->
                            paintBrush = paintBrush.copy(activeSlot = newSlot)
                        },
                        onPaintRadiusChange = { newR ->
                            paintBrush = paintBrush.copy(radiusMm = newR)
                        },
                        paintMaxSlots = slotCount.coerceAtLeast(1),
                        // Resolved colors per paint slot — what each
                        // tagged region will physically print as,
                        // mirroring the in-XR Prepare/Preview view. The
                        // user paints by VISIBLE color, not by an
                        // abstract slot number.
                        paintPalette = previewPalette,
                    )
                }

                // Left Panel
                MovablePanelWrapper(
                    id = "left-project",
                    width = 400.dp,
                    height = 800.dp,
                    initialOffset = androidx.xr.runtime.math.Vector3(-0.6f, 0f, -0.1f),
                    session = session,
                ) {
                    LeftProjectPanel(
                        sliceState = sliceState.value,
                        bedFit = bedFit,
                        bedCollision = bedCollision,
                        printers = printers,
                        selectedPrinterId = selectedPrinterId.value,
                        onSelectPrinter = { selectedPrinterId.value = it },
                        onOpenDevices = { devicesShown = true },
                        filaments = filamentList,
                        slotCount = slotCount,
                        paletteSuggestions = filamentSlotsStore.defaultPalette,
                        printerLoadedSlots = activePrinter
                            ?.id
                            ?.let(printerLoadedFilaments::get)
                            .orEmpty(),
                        filamentTypes = filamentsCatalog.keys.sorted().toList(),
                        onChangeFilamentColor = { slotIdx, hex ->
                            val printerId = activePrinter?.id ?: return@LeftProjectPanel
                            // ColorMappingPanel separates color edits from
                            // mapping edits. A manual hex / common-color
                            // pick on a model row updates ONLY the swatch;
                            // the row's mapping target (physicalSlot or
                            // virtualSlot) survives the edit, since the
                            // user's "purple body prints from T2" intent
                            // doesn't change just because they picked a
                            // slightly darker purple. The picker no longer
                            // offers a way to bundle color + mapping in one
                            // tap — that was the source of the swatch-only-
                            // looks-right bug the redesign fixes.
                            val updated = applyChangeColor(filamentList, slotIdx, hex)
                            scope.launch { filamentEntriesStore.set(printerId, updated) }
                        },
                        onMapToPhysicalSlot = { slotIdx, physicalSlot ->
                            val printerId = activePrinter?.id ?: return@LeftProjectPanel
                            // User explicitly picked T[physicalSlot+1] as
                            // the destination for project filament [slotIdx].
                            // Persist the remap so mergedConfig emits
                            // filament_map[slotIdx] = physicalSlot+1
                            // (1-based for libslic3r). The model color stays
                            // visible on the row's left side; the chip on
                            // the right tells the user where it actually
                            // prints from. Mutually exclusive with
                            // virtualSlot.
                            val updated = applyMapToPhysical(filamentList, slotIdx, physicalSlot)
                            scope.launch { filamentEntriesStore.set(printerId, updated) }
                        },
                        onMapToVirtualSlot = { slotIdx, virtualSlot ->
                            val printerId = activePrinter?.id ?: return@LeftProjectPanel
                            // User picked V_K for project filament [slotIdx].
                            // Persist virtualSlot so the JNI face-state
                            // rewrite at slice time flips painted faces to
                            // (num_physical + virtualSlot) and ToolOrdering
                            // alternates per layer. Mutually exclusive with
                            // physicalSlot.
                            val updated = applyMapToVirtual(filamentList, slotIdx, virtualSlot)
                            scope.launch { filamentEntriesStore.set(printerId, updated) }
                        },
                        onClearMapping = { slotIdx ->
                            val printerId = activePrinter?.id ?: return@LeftProjectPanel
                            val updated = applyClearMapping(filamentList, slotIdx)
                            scope.launch { filamentEntriesStore.set(printerId, updated) }
                        },
                        onChangeFilamentType = { slotIdx, type ->
                            val printerId = activePrinter?.id ?: return@LeftProjectPanel
                            val updated = applyChangeType(filamentList, slotIdx, type)
                            scope.launch { filamentEntriesStore.set(printerId, updated) }
                        },
                        onSyncFromPrinter = activePrinter?.let { cfg ->
                            // Phase I.1: copy ALL printer-loaded slots
                            // into the project palette. Hidden until
                            // Detect has populated the cache (no
                            // entries → button hidden).
                            val cached = printerLoadedFilaments[cfg.id].orEmpty()
                            if (cached.isEmpty()) null else {
                                {
                                    scope.launch {
                                        val byIndex = cached.associateBy { it.slotIndex }
                                        val updated = (0 until slotCount).map { idx ->
                                            val phys = byIndex[idx]
                                            val existing = filamentList.getOrNull(idx)
                                                ?: FilamentEntry(
                                                    id = "slot_$idx",
                                                    color = "#FFFFFF",
                                                    slotIndex = idx,
                                                )
                                            if (phys != null) existing.copy(
                                                color = phys.colorHex,
                                                filamentType = phys.material,
                                                // Identity remap (project N
                                                // → physical T_N). Sync
                                                // realigns the project
                                                // palette TO the printer's
                                                // current loadout, so the
                                                // remap returns to default.
                                                physicalSlot = null,
                                                virtualSlot = null,
                                            ) else existing
                                        }
                                        filamentEntriesStore.set(cfg.id, updated)
                                        val syncedCount = (0 until slotCount).count { byIndex[it] != null }
                                        android.widget.Toast.makeText(
                                            ctx,
                                            "Synced $syncedCount slot${if (syncedCount == 1) "" else "s"} from ${cfg.name}",
                                            android.widget.Toast.LENGTH_LONG,
                                        ).show()
                                    }
                                }
                            }
                        },
                        onDetectFilaments = activePrinter?.let { cfg ->
                            {
                                scope.launch {
                                    // Detect refreshes the printer-
                                    // loaded-filaments cache. The cache
                                    // feeds the inline color picker's
                                    // "Loaded in printer" quick-pick
                                    // row so the user can copy any of
                                    // those colors onto a project
                                    // filament with one tap. We do NOT
                                    // overwrite the project filaments
                                    // here — that would clobber the
                                    // 3mf's authored palette and any
                                    // user edits the user has made.
                                    val client = MoonrakerClient(cfg)
                                    val result = client.queryFilamentSlots()
                                    val msg: String = when (result) {
                                        is MoonrakerResult.Ok -> {
                                            val slots = result.value
                                            printerLoadedFilaments =
                                                printerLoadedFilaments + (cfg.id to slots)
                                            if (slots.isEmpty()) {
                                                "No filaments loaded in ${cfg.name}"
                                            } else {
                                                "Detected ${slots.size} filament${if (slots.size == 1) "" else "s"} loaded in ${cfg.name}"
                                            }
                                        }
                                        is MoonrakerResult.NotFound -> result.message
                                        is MoonrakerResult.AuthError -> result.message
                                        is MoonrakerResult.HttpError -> "Detect HTTP ${result.code}"
                                        is MoonrakerResult.IoError -> "Detect: ${result.message}"
                                    }
                                    android.widget.Toast.makeText(
                                        ctx,
                                        msg,
                                        android.widget.Toast.LENGTH_LONG,
                                    ).show()
                                }
                            }
                        },
                        onPickStl = launchPicker,
                        onClearModel = {
                            sliceState.value = SliceUiState.Idle
                            glbPath = null
                            stlPreviewPath = null
                            bedFit = null
                            bedCollision = null
                            // Phase G: clear EVERY plated model. The
                            // per-row delete in the multi-model UI is
                            // handled by onDeletePlacedModel below;
                            // this ✕ button is the "wipe the bed"
                            // shortcut.
                            placedModels = emptyList()
                            selectedModelId = null
                            maxLayer.value = null
                            workspaceMode = WorkspaceMode.Prepare
                        },
                        placedModels = placedModels,
                        selectedPlacedModelId = selectedModelId,
                        onSelectPlacedModel = { id ->
                            // Tap-to-select. Re-running previewStl is
                            // not necessary — the model already has its
                            // own previewPath; the grab handle re-
                            // positions via the LE keyed on selection.
                            selectedModelId = id
                        },
                        onDeletePlacedModel = { id ->
                            // Drop just this model from the bed. Sweep
                            // its preview GLBs from the cache and re-
                            // pick a selection if we removed the
                            // currently-selected one.
                            val removed = placedModels.firstOrNull { it.id == id }
                            placedModels = placedModels.filter { it.id != id }
                            if (selectedModelId == id) {
                                selectedModelId = placedModels.firstOrNull()?.id
                            }
                            if (placedModels.isEmpty()) {
                                glbPath = null
                                stlPreviewPath = null
                                bedFit = null
                                bedCollision = null
                                sliceState.value = SliceUiState.Idle
                                workspaceMode = WorkspaceMode.Prepare
                            }
                            // Best-effort cleanup of the removed model's
                            // preview GLB cache. Stale files won't break
                            // anything but they pile up on long sessions.
                            if (removed != null) {
                                runCatching {
                                    ctx.cacheDir.listFiles { f ->
                                        f.name.startsWith("stl_preview_${removed.id}_v") &&
                                            f.name.endsWith(".glb")
                                    }?.forEach { it.delete() }
                                }
                            }
                        },
                        onAddPlacedModel = launchPickerForAdd,
                        onAutoArrangePlacedModels = {
                            // Phase XR_OBJ_7: libslic3r-backed packing
                            // (falls back to naive row-layout on
                            // null). Single model sets translation to
                            // (0, 0); 2+ models pack tightly within
                            // 256×256 mm bed bounds, 5 mm gaps. The
                            // LE that re-positions the grab handle
                            // picks up the new translateXmm/Ymm
                            // automatically.
                            runAutoArrange()
                        },
                        isLoadingModel = isLoadingModel,
                        loadingLabel = loadingLabel,
                        // Phase J: virtual mixes are now defined inline in
                        // the same panel as the mapping flow, replacing the
                        // standalone MixedColorsPanel toggle. The persistence
                        // path (MixedFilamentStore + mergedConfig serialization)
                        // is unchanged — only the surfacing UI moves.
                        virtualRows = mixedRows.filter { !it.deleted },
                        onUpdateVirtualRow = { row ->
                            val pid = activePrinter?.id ?: return@LeftProjectPanel
                            val updated = mixedRows.map { if (it.id == row.id) row else it }
                            scope.launch { mixedFilamentsStore.set(pid, updated) }
                        },
                        onAddVirtualRow = { row ->
                            val pid = activePrinter?.id ?: return@LeftProjectPanel
                            scope.launch { mixedFilamentsStore.set(pid, mixedRows + row) }
                        },
                        onRemoveVirtualRow = { row ->
                            val pid = activePrinter?.id ?: return@LeftProjectPanel
                            // Tombstone the row, then sweep any project
                            // filaments whose virtualSlot pointed at it.
                            // Without the sweep the slicer would still
                            // resolve a dangling virtualSlot to "missing"
                            // and the user's mapping would silently be
                            // wrong on the next slice.
                            val visibleBefore = mixedRows.filter { !it.deleted && it.enabled }
                            val removedSlot = visibleBefore.indexOfFirst { it.id == row.id } + 1
                            scope.launch {
                                mixedFilamentsStore.set(
                                    pid,
                                    mixedRows.map { if (it.id == row.id) it.copy(deleted = true) else it },
                                )
                                if (removedSlot > 0) {
                                    val cleared = filamentList.map { f ->
                                        if (f.virtualSlot == removedSlot)
                                            f.copy(virtualSlot = null) else f
                                    }
                                    if (cleared != filamentList) {
                                        filamentEntriesStore.set(pid, cleared)
                                    }
                                }
                            }
                        },
                        filamentRuleResult = filamentRuleResult,
                        topCoverHint = topCoverHint,
                    )
                }

                // Phase XR_OBJ_2 — Transform panel. Numeric X/Y/Z
                // translate / rotate / scale + mirror toggles + place-
                // on-bed / reset for the selected model. Lives to the
                // far left of LeftProjectPanel; users can drag-relocate
                // via the MovablePanelWrapper grab strip.
                var autoOrientBusy by remember { mutableStateOf(false) }
                MovablePanelWrapper(
                    id = "transform-panel",
                    width = 380.dp,
                    height = 600.dp,
                    initialOffset = androidx.xr.runtime.math.Vector3(-1.0f, -0.05f, -0.05f),
                    session = session,
                ) {
                    TransformPanel(
                        model = selectedModel,
                        onTranslateChange = { x, y, z ->
                            updateSelected {
                                val snapped = snapAndClampOffset(x, y)
                                it.copy(
                                    translateXmm = snapped.x,
                                    translateYmm = snapped.y,
                                    translateZmm = z,
                                )
                            }
                        },
                        onRotateChange = { rx, ry, rz ->
                            updateSelected {
                                it.copy(
                                    rotXDeg = rx,
                                    rotYDeg = ry,
                                    rotZDeg = rz.toInt(),
                                )
                            }
                        },
                        onScaleChange = { sx, sy, sz ->
                            updateSelected {
                                // Phase XR_OBJ_2: when all three axes
                                // are equal, keep the legacy uniform
                                // scalePct in sync so the TopNavPill's
                                // scale chip cycle still reads the
                                // user's current size.
                                val uniform = sx == sy && sy == sz
                                it.copy(
                                    scaleXPct = sx,
                                    scaleYPct = sy,
                                    scaleZPct = sz,
                                    scalePct = if (uniform) sx.toInt().coerceAtLeast(1) else it.scalePct,
                                )
                            }
                        },
                        onMirrorChange = { mx, my, mz ->
                            updateSelected { it.copy(mirrorX = mx, mirrorY = my, mirrorZ = mz) }
                        },
                        onPlaceOnBed = {
                            // The bed plane is z=0 in workspace mm.
                            // Place-on-bed clears the user-typed Z
                            // lift; the JNI's per-object auto-bed-drop
                            // handles the post-rotation grounding.
                            updateSelected { it.copy(translateZmm = 0f) }
                        },
                        onResetAll = {
                            updateSelected {
                                it.copy(
                                    translateXmm = 0f,
                                    translateYmm = 0f,
                                    translateZmm = 0f,
                                    rotXDeg = 0f,
                                    rotYDeg = 0f,
                                    rotZDeg = 0,
                                    scaleXPct = 100f,
                                    scaleYPct = 100f,
                                    scaleZPct = 100f,
                                    scalePct = 100,
                                    mirrorX = false,
                                    mirrorY = false,
                                    mirrorZ = false,
                                )
                            }
                        },
                        onAutoOrient = selectedModel?.let { sel ->
                            {
                                // Phase XR_OBJ_3 — fire libslic3r's
                                // orient(ModelObject*) on the worker
                                // dispatcher. The JNI call is fast for
                                // a single object (PCA over the mesh,
                                // no parallel_for entered) but reads
                                // disk for non-STL inputs, so we
                                // route off the main thread.
                                if (autoOrientBusy) return@let
                                autoOrientBusy = true
                                scope.launch {
                                    val rot = runCatching {
                                        SlicerEngine.autoOrient(sel.source)
                                    }.onFailure {
                                        android.util.Log.e("OrcaXR", "autoOrient threw", it)
                                    }.getOrNull()
                                    if (rot != null && rot.size == 3) {
                                        updateSelected {
                                            it.copy(
                                                rotXDeg = rot[0],
                                                rotYDeg = rot[1],
                                                rotZDeg = rot[2].toInt(),
                                            )
                                        }
                                    } else {
                                        android.util.Log.w("OrcaXR", "autoOrient returned no rotation")
                                    }
                                    autoOrientBusy = false
                                }
                            }
                        },
                        autoOrientBusy = autoOrientBusy,
                        onToggleLayOnFace = selectedModel?.let { _ ->
                            {
                                paintBrush = if (paintBrush.mode == PaintMode.LayOnFace) {
                                    paintBrush.copy(mode = PaintMode.Off)
                                } else {
                                    paintBrush.copy(mode = PaintMode.LayOnFace)
                                }
                            }
                        },
                        layOnFaceActive = paintBrush.mode == PaintMode.LayOnFace,
                        onAddVolume = selectedModel?.let { _ ->
                            { type -> launchPickerForVolume(type) }
                        },
                        volumes = selectedModel?.volumes ?: emptyList(),
                        onUpdateVolume = { vid, updated ->
                            updateSelected { m ->
                                m.copy(volumes = m.volumes.map { if (it.id == vid) updated else it })
                            }
                        },
                        onRemoveVolume = { vid ->
                            updateSelected { m ->
                                m.copy(volumes = m.volumes.filter { it.id != vid })
                            }
                        },
                        onCutAtZ = selectedModel?.let { _ -> { z -> runCut(z) } },
                        onSplit = selectedModel?.let { sel -> { runSplit(sel.id) } },
                        // Phase XR_OBJ_6 — Boolean A/B picker. The
                        // op is fed in as 0/1/2 (Union/Difference/
                        // Intersection); we capture the current
                        // selectedModel as the "A" operand and arm
                        // the picker. The next tap on a different
                        // PlacedModel runs the op (see onTap above).
                        // Disabled unless ≥2 models on the bed AND
                        // a model is selected to anchor "A".
                        onStartBoolean = if (selectedModel != null && placedModels.size >= 2) {
                            { op ->
                                booleanPickerSourceId = selectedModel.id
                                booleanPickerOp = op
                                android.widget.Toast.makeText(
                                    ctx,
                                    "Tap the second model to ${
                                        when (op) {
                                            SlicerEngine.BoolOp.UNION -> "union"
                                            SlicerEngine.BoolOp.DIFFERENCE -> "subtract"
                                            SlicerEngine.BoolOp.INTERSECTION -> "intersect"
                                            else -> "boolean op $op"
                                        }
                                    } with…",
                                    android.widget.Toast.LENGTH_SHORT,
                                ).show()
                            }
                        } else null,
                        booleanPickerOp = booleanPickerOp,
                        onCancelBoolean = {
                            booleanPickerOp = null
                            booleanPickerSourceId = null
                        },
                        onToggleSupportEnforcer = selectedModel?.let { _ ->
                            {
                                paintBrush = paintBrush.copy(
                                    mode = if (paintBrush.mode == PaintMode.SupportEnforcer)
                                        PaintMode.Off else PaintMode.SupportEnforcer
                                )
                            }
                        },
                        onToggleSupportBlocker = selectedModel?.let { _ ->
                            {
                                paintBrush = paintBrush.copy(
                                    mode = if (paintBrush.mode == PaintMode.SupportBlocker)
                                        PaintMode.Off else PaintMode.SupportBlocker
                                )
                            }
                        },
                        supportPaintMode = paintBrush.mode,
                        hasSupportPaint = hasAnyPaint(selectedModel?.supportFlags),
                        onClearSupportPaint = selectedModel?.let { _ ->
                            {
                                updateSelected { it.copy(supportFlags = null) }
                            }
                        },
                        onToggleSeamEnforcer = selectedModel?.let { _ ->
                            {
                                paintBrush = paintBrush.copy(
                                    mode = if (paintBrush.mode == PaintMode.SeamEnforcer)
                                        PaintMode.Off else PaintMode.SeamEnforcer
                                )
                            }
                        },
                        onToggleSeamBlocker = selectedModel?.let { _ ->
                            {
                                paintBrush = paintBrush.copy(
                                    mode = if (paintBrush.mode == PaintMode.SeamBlocker)
                                        PaintMode.Off else PaintMode.SeamBlocker
                                )
                            }
                        },
                        hasSeamPaint = hasAnyPaint(selectedModel?.seamFlags),
                        onClearSeamPaint = selectedModel?.let { _ ->
                            {
                                updateSelected { it.copy(seamFlags = null) }
                            }
                        },
                        onClonePattern = selectedModel?.let { sel ->
                            { count, spacingMm, axis ->
                                runClonePattern(sel.id, count, spacingMm, axis)
                            }
                        },
                        objectConfigOverrides = selectedModel?.configOverrides ?: emptyMap(),
                        onObjectConfigChange = selectedModel?.let { _ ->
                            { key, value ->
                                updateSelected { m ->
                                    val newOverrides = if (value.isBlank()) {
                                        m.configOverrides - key
                                    } else {
                                        m.configOverrides + (key to value)
                                    }
                                    m.copy(configOverrides = newOverrides)
                                }
                            }
                        },
                    )
                }

                // Right Panel
                MovablePanelWrapper(
                    id = "right-settings",
                    width = 400.dp,
                    height = 600.dp,
                    initialOffset = androidx.xr.runtime.math.Vector3(0.6f, 0.15f, -0.1f),
                    session = session,
                ) {
                    RightSettingsPanel(
                        allProfiles = allProfiles,
                        selectedProfile = selectedProfile.value,
                        onProfileSelect = { selectedProfile.value = it },
                        onSaveAsProfile = onSaveAsProfile,
                        onDeleteProfile = onDeleteProfile,
                        layerHeightOverride = layerHeightOverride.value,
                        onLayerHeightChange = { layerHeightOverride.value = it },
                        printSettingsOverrides = printSettingsOverrides.value,
                        onPrintSettingChange = { key, value ->
                            // Empty value reverts the field to the profile
                            // default (i.e. drop the override entirely).
                            // Non-empty replaces the prior override.
                            printSettingsOverrides.value = if (value.isBlank()) {
                                printSettingsOverrides.value - key
                            } else {
                                printSettingsOverrides.value + (key to value.trim())
                            }
                        },
                    )
                }


                // Bottom Center Panel (Layer Preview)
                val parsed = (sliceState.value as? SliceUiState.Done)?.parsed
                val maxIdx = parsed?.layerZs?.lastIndex ?: 0
                val currentLayer = maxLayer.value ?: maxIdx
                MovablePanelWrapper(
                    id = "bottom-layer",
                    width = 600.dp,
                    height = 200.dp,
                    initialOffset = androidx.xr.runtime.math.Vector3(0f, -0.5f, 0f),
                    session = session,
                ) {
                    BottomLayerPreviewPanel(
                        parsed = parsed,
                        currentLayer = currentLayer,
                        maxLayers = parsed?.layerZs?.size ?: 1,
                        onLayerChange = { newIdx ->
                            maxLayer.value = if (newIdx >= maxIdx) null else newIdx
                        },
                        tubesMode = toolpathTubes.value,
                        onTubesModeChange = { toolpathTubes.value = it },
                    )
                }

                // Bottom Right Summary Panel
                MovablePanelWrapper(
                    id = "bottom-summary",
                    width = 400.dp,
                    height = 250.dp,
                    initialOffset = androidx.xr.runtime.math.Vector3(0.6f, -0.475f, -0.05f),
                    session = session,
                ) {
                    val activePrinter = printers.firstOrNull { it.id == selectedPrinterId.value }
                    val sliceTargetLabel = when {
                        placedModels.size >= 2 -> "${placedModels.size} models"
                        else -> selectedModel?.label ?: "bundled 20 mm cube"
                    }
                    BottomRightSummaryPanel(
                        sliceState = sliceState.value,
                        sliceTarget = sliceTargetLabel,
                        activePrinterName = activePrinter?.name,
                        canSaveModel = selectedModel != null,
                        onSliceClick = {
                            // Phase G: 2+ plated models route through
                            // sliceMulti; single model takes the
                            // existing path (preserves painted facets
                            // for 3MFs); empty bed slices the bundled
                            // cube as the demo.
                            if (placedModels.size >= 2) {
                                runSliceMulti(placedModels)
                            } else {
                                val target = selectedModel
                                if (target != null) {
                                    runSlice(target.source, target.label)
                                } else {
                                    scope.launch {
                                        val label = "cube_20mm.stl (bundled)"
                                        val stl = copyBundledCube(ctx)
                                        val cubeId = "model_cube_${System.currentTimeMillis().toString(36)}"
                                        placedModels = listOf(PlacedModel(id = cubeId, source = stl, label = label))
                                        selectedModelId = cubeId
                                        previewStl(cubeId)
                                        runSlice(stl, label)
                                    }
                                }
                            }
                        },
                        onSaveGcode = {
                            val st = sliceState.value
                            val src = (st as? SliceUiState.Done)?.result as? SliceResult.Success
                            val dest = src?.let { saveGcodeToDownloads(ctx, File(it.outputPath), st.sourceLabel) }
                            android.widget.Toast.makeText(
                                ctx,
                                if (dest != null) "Saved to ${dest.absolutePath}"
                                else "Save failed — grant All Files Access first",
                                android.widget.Toast.LENGTH_LONG,
                            ).show()
                        },
                        onSaveModelStl = {
                            // Save acts on the SELECTED model. Multi-
                            // model "save the bed as one STL" is not
                            // supported — the user can save one model
                            // at a time, or use Save .3mf for project-
                            // level state.
                            val target = selectedModel ?: return@BottomRightSummaryPanel
                            scope.launch {
                                val dest = saveModelAsStlToDownloads(
                                    ctx,
                                    target.source,
                                    target.label,
                                    target.rotZDeg,
                                    target.scalePct,
                                    target.translateXmm,
                                    target.translateYmm,
                                )
                                android.widget.Toast.makeText(
                                    ctx,
                                    if (dest != null) "Saved to ${dest.absolutePath}"
                                    else "Save STL failed — check All Files Access + logs",
                                    android.widget.Toast.LENGTH_LONG,
                                ).show()
                            }
                        },
                        onSaveProject3mf = {
                            val target = selectedModel ?: return@BottomRightSummaryPanel
                            scope.launch {
                                val cfg = mergedConfig(
                                    selectedProfile.value,
                                    layerHeightOverride.value,
                                    emptyList(),
                                    extraOverrides = printSettingsOverrides.value,
                                )
                                val dest = saveProjectAs3mfToDownloads(target.source, target.label, cfg)
                                android.widget.Toast.makeText(
                                    ctx,
                                    if (dest != null) "Saved to ${dest.absolutePath}"
                                    else "Save 3MF failed — check All Files Access + logs",
                                    android.widget.Toast.LENGTH_LONG,
                                ).show()
                            }
                        },
                        onSendAndPrint = {
                            val cfg = activePrinter ?: return@BottomRightSummaryPanel
                            val src = (sliceState.value as? SliceUiState.Done)?.result as? SliceResult.Success
                                ?: return@BottomRightSummaryPanel
                            devicesShown = true
                            setStatus(cfg.id, PrinterStatus("Uploading ${File(src.outputPath).name}…", PrinterStatusTone.Info))
                            android.widget.Toast.makeText(
                                ctx,
                                "Sending to ${cfg.name}…",
                                android.widget.Toast.LENGTH_SHORT,
                            ).show()
                            scope.launch {
                                val client = MoonrakerClient(cfg)
                                val gcode = File(src.outputPath)
                                val remote = "orcaxr-${gcode.name}"
                                val sizeKB = gcode.length() / 1024
                                // Throttle progress emissions: OkHttp ticks at
                                // 8 KB granularity which would flood Compose
                                // recomposition. Update at most once per 1%.
                                val tickStart = System.currentTimeMillis()
                                var lastPct = -1
                                val onProgress: (Long, Long) -> Unit = { sent, total ->
                                    val pct = if (total > 0) ((sent * 100) / total).toInt() else 0
                                    if (pct != lastPct) {
                                        lastPct = pct
                                        val sentKB = sent / 1024
                                        val elapsed = (System.currentTimeMillis() - tickStart) / 1000
                                        val msg = "Uploading ${gcode.name}… ${sentKB}/${sizeKB} KB ($pct%, ${elapsed}s)"
                                        setStatus(cfg.id, PrinterStatus(msg, PrinterStatusTone.Info, progress = pct / 100f))
                                    }
                                }
                                when (val up = client.uploadGcode(gcode, remote, onProgress)) {
                                    is MoonrakerResult.Ok -> {
                                        setStatus(cfg.id, PrinterStatus("Starting print…", PrinterStatusTone.Info))
                                        when (val st = client.startPrint(up.value)) {
                                            is MoonrakerResult.Ok -> setStatus(
                                                cfg.id,
                                                PrinterStatus("Print started: ${up.value}", PrinterStatusTone.Success),
                                            )
                                            is MoonrakerResult.AuthError -> setStatus(cfg.id, PrinterStatus(st.message, PrinterStatusTone.Error))
                                            is MoonrakerResult.NotFound -> setStatus(cfg.id, PrinterStatus(st.message, PrinterStatusTone.Error))
                                            is MoonrakerResult.HttpError -> setStatus(cfg.id, PrinterStatus("Start HTTP ${st.code}", PrinterStatusTone.Error))
                                            is MoonrakerResult.IoError -> setStatus(cfg.id, PrinterStatus("Start: ${st.message}", PrinterStatusTone.Error))
                                        }
                                    }
                                    is MoonrakerResult.AuthError -> setStatus(cfg.id, PrinterStatus(up.message, PrinterStatusTone.Error))
                                    is MoonrakerResult.NotFound -> setStatus(cfg.id, PrinterStatus(up.message, PrinterStatusTone.Error))
                                    is MoonrakerResult.HttpError -> setStatus(cfg.id, PrinterStatus("Upload HTTP ${up.code}", PrinterStatusTone.Error))
                                    is MoonrakerResult.IoError -> setStatus(cfg.id, PrinterStatus("Upload: ${up.message}", PrinterStatusTone.Error))
                                }
                            }
                        },
                        filamentRuleResult = filamentRuleResult,
                        bedCollisionForbidden = bedCollision is BedCollision.Result.Off,
                    )
                }

                // Centered loading overlay — only present while the
                // colored-GLB writer or STL reader is in flight. Big
                // 3MFs (~10 s for the dragon) need an attention-grab
                // visual; the inline spinner in LeftProjectPanel was
                // too easy to miss at headset distance. Z=+200 puts
                // it forward of the workspace + side panels so it
                // floats over them, plus a slightly transparent dark
                // surface lets the user still see where the model is
                // landing as it loads.
                if (isLoadingModel) {
                    SpatialPanel(
                        modifier = SubspaceModifier
                            .subspaceWidth(440.dp)
                            .subspaceHeight(220.dp)
                            .offset(x = 0.dp, y = 100.dp, z = 200.dp),
                    ) {
                        ModelLoadingOverlayPanel(label = loadingLabel ?: "Loading…")
                    }
                }

                // Live print monitor
                run {
                    val cfg = activePrinter
                    val snap = cfg?.id?.let { printerSnapshots[it] }
                    if (cfg != null && snap != null && snap.state != "standby" && snap.state.isNotBlank()) {
                        MovablePanelWrapper(
                            id = "print-monitor",
                            width = 420.dp,
                            height = 220.dp,
                            initialOffset = androidx.xr.runtime.math.Vector3(0.61f, -0.235f, -0.05f),
                            session = session,
                        ) {
                            PrintMonitorPanel(
                                printerName = cfg.name,
                                snapshot = snap,
                                onPause = {
                                    setStatus(cfg.id, PrinterStatus("Pausing…", PrinterStatusTone.Info))
                                    scope.launch {
                                        val r = MoonrakerClient(cfg).pausePrint()
                                        setStatus(cfg.id, when (r) {
                                            is MoonrakerResult.Ok -> PrinterStatus("Paused", PrinterStatusTone.Success)
                                            is MoonrakerResult.AuthError -> PrinterStatus(r.message, PrinterStatusTone.Error)
                                            is MoonrakerResult.NotFound -> PrinterStatus(r.message, PrinterStatusTone.Error)
                                            is MoonrakerResult.HttpError -> PrinterStatus("Pause HTTP ${r.code}", PrinterStatusTone.Error)
                                            is MoonrakerResult.IoError -> PrinterStatus("Pause: ${r.message}", PrinterStatusTone.Error)
                                        })
                                    }
                                },
                                onResume = {
                                    setStatus(cfg.id, PrinterStatus("Resuming…", PrinterStatusTone.Info))
                                    scope.launch {
                                        val r = MoonrakerClient(cfg).resumePrint()
                                        setStatus(cfg.id, when (r) {
                                            is MoonrakerResult.Ok -> PrinterStatus("Resumed", PrinterStatusTone.Success)
                                            is MoonrakerResult.AuthError -> PrinterStatus(r.message, PrinterStatusTone.Error)
                                            is MoonrakerResult.NotFound -> PrinterStatus(r.message, PrinterStatusTone.Error)
                                            is MoonrakerResult.HttpError -> PrinterStatus("Resume HTTP ${r.code}", PrinterStatusTone.Error)
                                            is MoonrakerResult.IoError -> PrinterStatus("Resume: ${r.message}", PrinterStatusTone.Error)
                                        })
                                    }
                                },
                                onCancel = {
                                    setStatus(cfg.id, PrinterStatus("Cancelling…", PrinterStatusTone.Info))
                                    scope.launch {
                                        val r = MoonrakerClient(cfg).cancelPrint()
                                        setStatus(cfg.id, when (r) {
                                            is MoonrakerResult.Ok -> PrinterStatus("Cancelled", PrinterStatusTone.Success)
                                            is MoonrakerResult.AuthError -> PrinterStatus(r.message, PrinterStatusTone.Error)
                                            is MoonrakerResult.NotFound -> PrinterStatus(r.message, PrinterStatusTone.Error)
                                            is MoonrakerResult.HttpError -> PrinterStatus("Cancel HTTP ${r.code}", PrinterStatusTone.Error)
                                            is MoonrakerResult.IoError -> PrinterStatus("Cancel: ${r.message}", PrinterStatusTone.Error)
                                        })
                                    }
                                },
                            )
                        }
                    }
                }

                // Radial Menu (Left side). Add / Duplicate / Delete /
                // Arrange operate on the same `placedModels` state the left
                // project panel does. Group / multi-select is intentionally
                // absent — there is no group concept yet, and a button that
                // does nothing is worse than no button.
                MovablePanelWrapper(
                    id = "radial-menu",
                    width = 200.dp,
                    height = 200.dp,
                    initialOffset = androidx.xr.runtime.math.Vector3(-0.4f, -0.2f, 0.05f),
                    session = session,
                ) {
                    RadialMenuPanel(
                        onAdd = launchPickerForAdd,
                        onDuplicate = {
                            val src = selectedModel ?: return@RadialMenuPanel
                            if (placedModels.size >= MAX_PLACED_MODELS) {
                                android.widget.Toast.makeText(
                                    ctx,
                                    "Up to $MAX_PLACED_MODELS models per plate. Slice or remove some first.",
                                    android.widget.Toast.LENGTH_LONG,
                                ).show()
                                return@RadialMenuPanel
                            }
                            val newId = "model_${System.currentTimeMillis().toString(36)}_${placedModels.size}"
                            // Clone identity-mutable fields. previewPath is
                            // intentionally left null so the clone re-bakes
                            // its own GLB (the cache key includes the model
                            // id, so reusing src.previewPath would mean the
                            // original's file is mistaken for the clone's
                            // output and gets swept on the next render).
                            // Paint state is preserved so a duplicated
                            // body-painted model copies its slot tags too.
                            val clone = src.copy(
                                id = newId,
                                translateXmm = src.translateXmm + 20f,
                                translateYmm = src.translateYmm + 20f,
                                previewPath = null,
                                previewVersion = 0,
                                previewRotZDeg = -1,
                                previewScalePct = -1,
                            )
                            placedModels = placedModels + clone
                            selectedModelId = newId
                            scope.launch { previewStl(newId) }
                        },
                        onDelete = {
                            val id = selectedModelId ?: return@RadialMenuPanel
                            val removed = placedModels.firstOrNull { it.id == id }
                            placedModels = placedModels.filter { it.id != id }
                            if (selectedModelId == id) {
                                selectedModelId = placedModels.firstOrNull()?.id
                            }
                            if (placedModels.isEmpty()) {
                                glbPath = null
                                stlPreviewPath = null
                                bedFit = null
                                bedCollision = null
                                sliceState.value = SliceUiState.Idle
                                workspaceMode = WorkspaceMode.Prepare
                            }
                            if (removed != null) {
                                runCatching {
                                    ctx.cacheDir.listFiles { f ->
                                        f.name.startsWith("stl_preview_${removed.id}_v") &&
                                            f.name.endsWith(".glb")
                                    }?.forEach { it.delete() }
                                }
                            }
                        },
                        onArrange = { runAutoArrange() },
                        duplicateEnabled = selectedModel != null &&
                            placedModels.size < MAX_PLACED_MODELS,
                        deleteEnabled = selectedModelId != null,
                        arrangeEnabled = placedModels.size >= 2,
                    )
                }


                // (Phase J: standalone MixedColorsPanel removed — the
                // virtual-mix editor lives inside ColorMappingPanel in the
                // left project panel now, alongside the model-color mapping
                // flow it feeds into.)

                if (showFilePicker) {
                    MovablePanelWrapper(
                        id = "file-picker",
                        width = 600.dp,
                        height = 500.dp,
                        initialOffset = androidx.xr.runtime.math.Vector3(0f, 0f, 0f),
                        session = session,
                    ) {
                        FilePickerPanel(
                            onFileSelected = { onFileSelected(it) },
                            onClose = { showFilePicker = false }
                        )
                    }
                }

                // Roadmap B7 — empty-state guidance. Drop a CTA panel
                // over the empty bed when the user hasn't loaded
                // anything yet so they always have a clear next step.
                // Hide once the picker is open (it takes over the same
                // floor space) or while a load is in flight.
                val showEmptyState = placedModels.isEmpty() &&
                    !showFilePicker &&
                    !isLoadingModel
                if (showEmptyState) {
                    MovablePanelWrapper(
                        id = "empty-state",
                        width = 520.dp,
                        height = 560.dp,
                        initialOffset = androidx.xr.runtime.math.Vector3(0f, 0.1f, 0f),
                        session = session,
                    ) {
                        EmptyStatePanel(
                            recents = recentFilesList,
                            onPickFile = { launchPicker() },
                            onSliceBundledCube = {
                                // Mirrors the controller-A "empty bed
                                // → slice bundled cube" path in
                                // onKeyDown: copy the bundled STL,
                                // create a PlacedModel, preview, then
                                // slice. The empty-state panel
                                // disappears once placedModels gains
                                // an entry.
                                scope.launch {
                                    val label = "cube_20mm.stl (bundled)"
                                    val stl = copyBundledCube(ctx)
                                    val cubeId = "model_cube_${System.currentTimeMillis().toString(36)}"
                                    placedModels = listOf(PlacedModel(id = cubeId, source = stl, label = label))
                                    selectedModelId = cubeId
                                    previewStl(cubeId)
                                    runSlice(stl, label)
                                }
                            },
                            onOpenRecent = { path ->
                                val f = File(path)
                                if (f.exists()) {
                                    pickerMode = PickerMode.Replace
                                    onFileSelected(f)
                                } else {
                                    // File vanished between the flow
                                    // emitting and the user clicking.
                                    // Drop it silently and let the
                                    // next emission heal the row.
                                    scope.launch {
                                        runCatching { recentFiles.remove(path) }
                                    }
                                    android.widget.Toast.makeText(
                                        ctx,
                                        "File no longer available",
                                        android.widget.Toast.LENGTH_SHORT,
                                    ).show()
                                }
                            },
                        )
                    }
                }

                if (devicesShown) {
                    val canSendCurrentSlice = (sliceState.value as? SliceUiState.Done)?.result is SliceResult.Success
                    val gcodeFile: File? = ((sliceState.value as? SliceUiState.Done)
                        ?.result as? SliceResult.Success)?.outputPath?.let(::File)
                    MovablePanelWrapper(
                        id = "printer-manager",
                        width = 600.dp,
                        height = 600.dp,
                        initialOffset = androidx.xr.runtime.math.Vector3(0f, 0.1f, 0f),
                        session = session,
                    ) {
                        PrinterPanel(
                            printers = printers,
                            statuses = printerStatuses,
                            snapshots = printerSnapshots,
                            webcamFrames = webcamFrames,
                            canSendCurrentSlice = canSendCurrentSlice && gcodeFile != null,
                            discovery = discoveredPrinters,
                            isScanning = isScanning,
                            onScanToggle = {
                                if (isScanning) {
                                    discoveryService.stop()
                                    isScanning = false
                                } else {
                                    discoveryService.start()
                                    isScanning = true
                                    // Kick off a parallel subnet scan
                                    // — mDNS finds things that
                                    // advertise; subnet scan finds
                                    // anything that *responds* to
                                    // Moonraker. Snapmaker U1 stock
                                    // firmwares often skip mDNS so
                                    // this is the reliable fallback.
                                    scope.launch {
                                        val hits = SubnetScanner.scanLan(ctx)
                                        discoveryService.addResults(hits)
                                        android.util.Log.i(
                                            "OrcaXR/discovery",
                                            "subnet-scan added ${hits.size} host(s)",
                                        )
                                    }
                                }
                            },
                            onAddDiscovered = { d ->
                                // Skip if we already have a printer
                                // record at this host. The user is
                                // tapping a discovery row, not editing,
                                // so re-adding shouldn't multiply
                                // entries.
                                val existing = printers.firstOrNull { it.host == d.host }
                                if (existing != null) {
                                    setStatus(
                                        existing.id,
                                        PrinterStatus(
                                            "Already added as \"${existing.name}\"",
                                            PrinterStatusTone.Info,
                                        ),
                                    )
                                    return@PrinterPanel
                                }
                                scope.launch {
                                    val cfg = PrinterConfig(
                                        id = "printer_${System.currentTimeMillis().toString(36)}",
                                        // Prefer the SN if Snapmaker
                                        // gave us one — survives DHCP
                                        // renames better than the
                                        // service label.
                                        name = d.sn?.let { "Snapmaker $it" } ?: d.name,
                                        host = d.host,
                                        port = d.port,
                                        apiKey = null,
                                    )
                                    printersStore.upsert(cfg)
                                }
                            },
                            onAddPrinter = { name, host, port, apiKey ->
                                scope.launch {
                                    val cfg = PrinterConfig(
                                        id = "printer_${System.currentTimeMillis().toString(36)}",
                                        name = name,
                                        host = host,
                                        port = port,
                                        apiKey = apiKey,
                                    )
                                    printersStore.upsert(cfg)
                                }
                            },
                            onTestPrinter = { p ->
                                setStatus(p.id, PrinterStatus("Connecting…", PrinterStatusTone.Info))
                                scope.launch {
                                    val (workingCfg, r) = MoonrakerClient.probe(p)
                                    when (r) {
                                        is MoonrakerResult.Ok -> {
                                            // If probe found a different
                                            // port than saved, persist
                                            // the corrected config so
                                            // subsequent uploads go
                                            // straight there.
                                            val portNote = if (workingCfg.port != p.port) {
                                                printersStore.upsert(workingCfg)
                                                " — saved port ${workingCfg.port}"
                                            } else ""
                                            setStatus(
                                                p.id,
                                                PrinterStatus(
                                                    "OK · klippy=${r.value.klippyState}$portNote",
                                                    PrinterStatusTone.Success,
                                                ),
                                            )
                                        }
                                        is MoonrakerResult.AuthError -> setStatus(p.id, PrinterStatus(r.message, PrinterStatusTone.Error))
                                        is MoonrakerResult.NotFound -> setStatus(p.id, PrinterStatus(r.message, PrinterStatusTone.Error))
                                        is MoonrakerResult.HttpError -> setStatus(p.id, PrinterStatus("HTTP ${r.code}", PrinterStatusTone.Error))
                                        is MoonrakerResult.IoError -> setStatus(p.id, PrinterStatus("Network: ${r.message}", PrinterStatusTone.Error))
                                    }
                                }
                            },
                            onSendSlice = { p ->
                                val gcode = gcodeFile ?: return@PrinterPanel
                                setStatus(p.id, PrinterStatus("Uploading ${gcode.name}…", PrinterStatusTone.Info))
                                scope.launch {
                                    val client = MoonrakerClient(p)
                                    val remote = "orcaxr-${gcode.name}"
                                    val sizeKB = gcode.length() / 1024
                                    val tickStart = System.currentTimeMillis()
                                    var lastPct = -1
                                    val onProgress: (Long, Long) -> Unit = { sent, total ->
                                        val pct = if (total > 0) ((sent * 100) / total).toInt() else 0
                                        if (pct != lastPct) {
                                            lastPct = pct
                                            val sentKB = sent / 1024
                                            val elapsed = (System.currentTimeMillis() - tickStart) / 1000
                                            val msg = "Uploading ${gcode.name}… ${sentKB}/${sizeKB} KB ($pct%, ${elapsed}s)"
                                            setStatus(p.id, PrinterStatus(msg, PrinterStatusTone.Info, progress = pct / 100f))
                                        }
                                    }
                                    when (val up = client.uploadGcode(gcode, remote, onProgress)) {
                                        is MoonrakerResult.Ok -> {
                                            setStatus(p.id, PrinterStatus("Starting print…", PrinterStatusTone.Info))
                                            when (val st = client.startPrint(up.value)) {
                                                is MoonrakerResult.Ok -> setStatus(
                                                    p.id,
                                                    PrinterStatus("Print started: ${up.value}", PrinterStatusTone.Success),
                                                )
                                                is MoonrakerResult.AuthError -> setStatus(p.id, PrinterStatus(st.message, PrinterStatusTone.Error))
                                                is MoonrakerResult.NotFound -> setStatus(p.id, PrinterStatus(st.message, PrinterStatusTone.Error))
                                                is MoonrakerResult.HttpError -> setStatus(p.id, PrinterStatus("Start HTTP ${st.code}", PrinterStatusTone.Error))
                                                is MoonrakerResult.IoError -> setStatus(p.id, PrinterStatus("Start: ${st.message}", PrinterStatusTone.Error))
                                            }
                                        }
                                        is MoonrakerResult.AuthError -> setStatus(p.id, PrinterStatus(up.message, PrinterStatusTone.Error))
                                        is MoonrakerResult.NotFound -> setStatus(p.id, PrinterStatus(up.message, PrinterStatusTone.Error))
                                        is MoonrakerResult.HttpError -> setStatus(p.id, PrinterStatus("Upload HTTP ${up.code}", PrinterStatusTone.Error))
                                        is MoonrakerResult.IoError -> setStatus(p.id, PrinterStatus("Upload: ${up.message}", PrinterStatusTone.Error))
                                    }
                                }
                            },
                            onPausePrinter = { p ->
                                setStatus(p.id, PrinterStatus("Pausing…", PrinterStatusTone.Info))
                                scope.launch {
                                    val r = MoonrakerClient(p).pausePrint()
                                    setStatus(p.id, when (r) {
                                        is MoonrakerResult.Ok -> PrinterStatus("Paused", PrinterStatusTone.Success)
                                        is MoonrakerResult.AuthError -> PrinterStatus(r.message, PrinterStatusTone.Error)
                                        is MoonrakerResult.NotFound -> PrinterStatus(r.message, PrinterStatusTone.Error)
                                        is MoonrakerResult.HttpError -> PrinterStatus("Pause HTTP ${r.code}", PrinterStatusTone.Error)
                                        is MoonrakerResult.IoError -> PrinterStatus("Pause: ${r.message}", PrinterStatusTone.Error)
                                    })
                                }
                            },
                            onResumePrinter = { p ->
                                setStatus(p.id, PrinterStatus("Resuming…", PrinterStatusTone.Info))
                                scope.launch {
                                    val r = MoonrakerClient(p).resumePrint()
                                    setStatus(p.id, when (r) {
                                        is MoonrakerResult.Ok -> PrinterStatus("Resumed", PrinterStatusTone.Success)
                                        is MoonrakerResult.AuthError -> PrinterStatus(r.message, PrinterStatusTone.Error)
                                        is MoonrakerResult.NotFound -> PrinterStatus(r.message, PrinterStatusTone.Error)
                                        is MoonrakerResult.HttpError -> PrinterStatus("Resume HTTP ${r.code}", PrinterStatusTone.Error)
                                        is MoonrakerResult.IoError -> PrinterStatus("Resume: ${r.message}", PrinterStatusTone.Error)
                                    })
                                }
                            },
                            onCancelPrint = { p ->
                                setStatus(p.id, PrinterStatus("Cancelling…", PrinterStatusTone.Info))
                                scope.launch {
                                    val r = MoonrakerClient(p).cancelPrint()
                                    setStatus(p.id, when (r) {
                                        is MoonrakerResult.Ok -> PrinterStatus("Cancelled", PrinterStatusTone.Success)
                                        is MoonrakerResult.AuthError -> PrinterStatus(r.message, PrinterStatusTone.Error)
                                        is MoonrakerResult.NotFound -> PrinterStatus(r.message, PrinterStatusTone.Error)
                                        is MoonrakerResult.HttpError -> PrinterStatus("Cancel HTTP ${r.code}", PrinterStatusTone.Error)
                                        is MoonrakerResult.IoError -> PrinterStatus("Cancel: ${r.message}", PrinterStatusTone.Error)
                                    })
                                }
                            },
                            onRenamePrinter = { p, newName ->
                                scope.launch {
                                    printersStore.upsert(p.copy(name = newName))
                                }
                            },
                            onDeletePrinter = { p ->
                                scope.launch { printersStore.delete(p.id) }
                            },
                            onClose = { devicesShown = false },
                        )
                    }
                }

                if (helpShown) {
                    // Roadmap B5 — controller binding reference card.
                    // Mounted next to the top nav so the user can keep
                    // it open while testing inputs.
                    //
                    // Roadmap D1 — paint cache size + clear button
                    // surfaces here too. Recomputed inside a
                    // remember(helpVersion) so flipping helpShown
                    // re-reads the current bytes — avoids the user
                    // seeing a stale "12 MB" after they paint a new
                    // model in this session. helpVersion is bumped on
                    // Clear so the row refreshes immediately without
                    // re-opening the panel.
                    var helpVersion by remember { mutableStateOf(0) }
                    val paintCacheBytes = remember(helpVersion) { paintCache.sizeBytes() }
                    val paintCacheEntries = remember(helpVersion) { paintCache.size() }
                    MovablePanelWrapper(
                        id = "controller-help",
                        width = 600.dp,
                        height = 700.dp,
                        initialOffset = androidx.xr.runtime.math.Vector3(0.5f, 0.1f, -0.2f),
                        session = session,
                    ) {
                        ControllerHelpCard(
                            onClose = { helpShown = false },
                            paintCacheBytes = paintCacheBytes,
                            paintCacheEntryCount = paintCacheEntries,
                            onClearPaintCache = {
                                paintCache.clear()
                                helpVersion += 1
                                android.widget.Toast.makeText(
                                    ctx,
                                    "Paint cache cleared",
                                    android.widget.Toast.LENGTH_SHORT,
                                ).show()
                            },
                        )
                    }
                }
            }
        }

        // Build plate first so the toolpath/STL render on top of it.
        buildPlatePath?.let { path ->
            key(path) {
                BuildPlateSceneEntity(session = session, glbPath = path, parentEntity = workspaceEntity)
            }
        }

        // Workspace mode picks which model we render on the bed:
        //  Prepare = show every plated model's preview at its own offset.
        //  Preview = show the toolpath wireframe if available; otherwise
        //            fall back to the per-model previews so the bed isn't
        //            empty when the user clicks the tab early.
        //
        // Phase G: Prepare iterates `placedModels` and renders one
        // SceneCoreEntity per model at its (translateXmm, translateYmm).
        // The selected model is the one the grab handle drives; the
        // others sit at their last-known offset.
        when (workspaceMode) {
            WorkspaceMode.Prepare -> {
                for (m in placedModels) {
                    val path = m.previewPath ?: continue
                    key(m.id, path) {
                        StlPreviewSceneEntity(
                            session = session,
                            glbPath = path,
                            parentEntity = workspaceEntity,
                            offsetXmm = m.translateXmm,
                            offsetYmm = m.translateYmm,
                            paintHooks = paintHooksFor(m),
                            // Phase XR_OBJ_1: tap a model to select it.
                            // The callbacks no-op when paint mode is on
                            // (paintHooks takes priority inside
                            // GlbSceneEntity), so painting still works
                            // unchanged.
                            //
                            // Phase XR_OBJ_6 (Boolean A/B picker UX):
                            // when [booleanPickerOp] is armed, the next
                            // model tap on a *different* PlacedModel
                            // becomes the "B" operand and fires the op
                            // immediately. Tapping the same model that
                            // armed the picker is a no-op (boolean of a
                            // mesh with itself is degenerate).
                            onTap = {
                                val op = booleanPickerOp
                                val srcId = booleanPickerSourceId
                                if (op != null && srcId != null) {
                                    if (m.id == srcId) {
                                        android.widget.Toast.makeText(
                                            ctx,
                                            "Pick a *different* model for the second operand.",
                                            android.widget.Toast.LENGTH_SHORT,
                                        ).show()
                                    } else {
                                        booleanPickerOp = null
                                        booleanPickerSourceId = null
                                        runBoolean(srcId, m.id, op)
                                    }
                                } else {
                                    selectedModelId = m.id
                                }
                            },
                            onHoverChange = { entered ->
                                if (entered) {
                                    hoveredModelId = m.id
                                } else if (hoveredModelId == m.id) {
                                    hoveredModelId = null
                                }
                            },
                        )
                    }
                }
                // Phase XR_OBJ_1: render a yellow bbox outline for the
                // currently-selected model. Skipped while paint mode is
                // on — the user's focus is on triangle picks, the bbox
                // would just be visual noise, and the bbox entity
                // doesn't participate in the InteractableComponent
                // pipeline so it can occlude paint hits if it overlaps
                // the model. Keyed on (id, footprint, height) so the
                // GLB rebakes when the user rotates / scales.
                val selected = placedModels.firstOrNull { it.id == selectedModelId }
                if (selected != null && paintBrush.mode == PaintMode.Off) {
                    val (fw, fd) = selected.footprintMm()
                    val fh = selected.baseBboxZmm * (selected.scalePct / 100f)
                    if (fw > 0f && fd > 0f && fh > 0f) {
                        key(selected.id, fw, fd, fh) {
                            SelectionBboxEntity(
                                session = session,
                                parentEntity = workspaceEntity,
                                modelId = selected.id,
                                offsetXmm = selected.translateXmm,
                                offsetYmm = selected.translateYmm,
                                sizeXmm = fw,
                                sizeYmm = fd,
                                sizeZmm = fh,
                            )
                        }
                    }
                }
            }
            WorkspaceMode.Preview -> {
                val toolpath = glbPath
                if (toolpath != null) {
                    key(toolpath) {
                        ToolpathSceneEntity(session = session, glbPath = toolpath, parentEntity = workspaceEntity)
                    }
                } else {
                    for (m in placedModels) {
                        val path = m.previewPath ?: continue
                        key(m.id, path) {
                            StlPreviewSceneEntity(
                                session = session,
                                glbPath = path,
                                parentEntity = workspaceEntity,
                                offsetXmm = m.translateXmm,
                                offsetYmm = m.translateYmm,
                            )
                        }
                    }
                }
            }
        }
    }

    DisposableEffect(rootEntity, workspaceEntity) {
        onDispose {
            // Dispose children first so SceneCore doesn't keep stale
            // parent refs when we re-create on a new session.
            workspaceEntity?.dispose()
            rootEntity?.dispose()
        }
    }
}

/**
 * World scale shared by the build plate, STL preview, and toolpath GLBs.
 * 1 GLB unit (= 1 mm in source) renders as [WORLD_SCALE] meters. Tuned
 * to make a 256 mm bed read at ~38 cm so the workspace is the visual
 * centerpiece, comparable to the height of the side panels rather than
 * a small object floating near them. Keep this in step with the panel
 * sizes / offsets below — bumping the scale without pushing the lower
 * panels down again puts the model envelope into the layer-preview
 * panel.
 */
private const val WORLD_SCALE = 0.0015f

/**
 * Profile id we seed the dropdown with on a fresh install. Matches
 * the bundled Snapmaker U1 (0.4 nozzle) × 0.20 Standard process ×
 * Generic PLA filament leaf produced by [OrcaProfileLoader.compose].
 * Format: `bundled_<slug(machineName)>.<slug(processShort)>.<slug(filamentName)>`
 * — see [OrcaProfileLoader.slug] for the slug rules (dots preserved,
 * everything else collapsed to underscore).
 *
 * Hard-coded rather than discovered because it has to be available
 * synchronously when MainActivity composes; the loader itself runs
 * inside `remember` and isn't visible until first composition.
 */
private const val PREFERRED_DEFAULT_PROFILE_ID =
    "bundled_snapmaker_u1_0.4_nozzle.0.20_standard.generic_pla"

/**
 * Local Y offset (in world meters) for the bed. Sits the bed slightly
 * below scene center so the model envelope (typically 5–15 cm tall)
 * occupies the middle of the field of view, leaving room above for the
 * top nav pill and below for the layer-preview panel.
 */
private const val WORKSPACE_Y_OFFSET = -0.10f

/**
 * Rotation that maps printer space (X right, Y front, Z up) onto
 * SceneCore world space (X right, Y up, Z forward toward user). Without
 * this the bed would render as a vertical wall behind the panels and the
 * print would extrude into the user's face. -90° around X:
 *   R_x(-90°)·(0,0,1) = (0, 1, 0)   — printer-Z (up) -> world-Y (up)
 *   R_x(-90°)·(0,1,0) = (0, 0,-1)   — printer-Y (front) -> world -Z (away)
 * Quaternion: (sin(-45°), 0, 0, cos(-45°)).
 *
 * The +90° variant we briefly used flipped the model under the bed:
 * R_x(+90°) sends Z->-Y (down) and Y->+Z (toward user).
 */
private val WORKSPACE_ROTATION = androidx.xr.runtime.math.Quaternion(
    -0.70710678f, 0f, 0f, 0.70710678f,
)

private fun applyWorkspacePose(ent: androidx.xr.scenecore.Entity, parent: androidx.xr.scenecore.Entity?) {
    // The workspace parent (a GroupEntity created in XrShell) already
    // carries WORKSPACE_Y_OFFSET + WORKSPACE_ROTATION, so child GLBs
    // only need the unit-conversion scale. Pose stays at identity.
    ent.parent = parent
    ent.setScale(WORLD_SCALE)
}

@Composable
private fun ToolpathSceneEntity(session: Session, glbPath: String, parentEntity: androidx.xr.scenecore.Entity?) {
    GlbSceneEntity(session, glbPath, parentEntity)
}

@Composable
private fun StlPreviewSceneEntity(
    session: Session,
    glbPath: String,
    parentEntity: androidx.xr.scenecore.Entity?,
    offsetXmm: Float = 0f,
    offsetYmm: Float = 0f,
    /** Phase J: when non-null, attaches an `InteractableComponent`
     *  to the model's GltfModelEntity and forwards `Source.CONTROLLER`
     *  events through the hooks. Null = no paint pipeline (the entity
     *  is purely visual; the workspace grab handle owns input). */
    paintHooks: PaintInputHooks? = null,
    /** Phase XR_OBJ_1: tap-to-select. Fires on `Action.DOWN`. Ignored
     *  when [paintHooks] is non-null — paint mode owns the laser. */
    onTap: (() -> Unit)? = null,
    /** Phase XR_OBJ_1: hover state. true on `HOVER_ENTER`, false on
     *  `HOVER_EXIT`. Same paint-mode caveat as [onTap]. */
    onHoverChange: ((Boolean) -> Unit)? = null,
) {
    GlbSceneEntity(session, glbPath, parentEntity, offsetXmm, offsetYmm, paintHooks, onTap, onHoverChange)
}

@Composable
private fun BuildPlateSceneEntity(session: Session, glbPath: String, parentEntity: androidx.xr.scenecore.Entity?) {
    GlbSceneEntity(session, glbPath, parentEntity)
}

/**
 * Phase XR_OBJ_1 selection feedback. Bakes a wireframe-bbox GLB sized
 * to the selected model's effective footprint and mounts it as a sibling
 * of the model entity. The bbox itself carries no `InteractableComponent`
 * — it's purely visual. Cache files live at
 * `${cacheDir}/sel_bbox_${modelId}_${dimsHash}.glb` so a rotation /
 * scale change produces a new file rather than re-using a stale one.
 *
 * We don't reuse `GlbSceneEntity` because its DisposableEffect chain
 * tries to attach an InteractableComponent when callbacks are non-null,
 * which we explicitly DON'T want here (the bbox sits a hair outside the
 * model and would steal hits otherwise).
 */
@Composable
private fun SelectionBboxEntity(
    session: Session,
    parentEntity: androidx.xr.scenecore.Entity?,
    modelId: String,
    offsetXmm: Float,
    offsetYmm: Float,
    sizeXmm: Float,
    sizeYmm: Float,
    sizeZmm: Float,
) {
    val ctx = LocalContext.current
    var entity by remember { mutableStateOf<GltfModelEntity?>(null) }

    LaunchedEffect(modelId, sizeXmm, sizeYmm, sizeZmm, parentEntity) {
        // Bake on a worker dispatcher so we don't stall the frame.
        // 144 triangles is trivial but the GLB write touches disk.
        val dimsHash = java.util.Objects.hash(sizeXmm, sizeYmm, sizeZmm)
        val out = File(ctx.cacheDir, "sel_bbox_${modelId}_${Integer.toHexString(dimsHash)}.glb")
        if (!out.exists()) {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching {
                    writeBboxOutlineGlb(
                        file = out,
                        sizeXmm = sizeXmm,
                        sizeYmm = sizeYmm,
                        sizeZmm = sizeZmm,
                    )
                }.onFailure {
                    android.util.Log.e("OrcaXR", "selection bbox write failed", it)
                }
            }
        }
        if (!out.exists()) return@LaunchedEffect
        android.util.Log.i(
            "OrcaXR",
            "SelectionBboxEntity loading ${out.name} for $modelId " +
                "(${sizeXmm}×${sizeYmm}×${sizeZmm} mm)",
        )
        val bytes = runCatching { out.readBytes() }
            .onFailure { android.util.Log.e("OrcaXR", "selection bbox read failed", it) }
            .getOrNull() ?: return@LaunchedEffect
        val model = runCatching { GltfModel.create(session, bytes, out.name) }
            .onFailure { android.util.Log.e("OrcaXR", "selection bbox GltfModel.create failed", it) }
            .getOrNull() ?: return@LaunchedEffect
        val ent = GltfModelEntity.create(session, model)
        applyWorkspacePose(ent, parentEntity ?: session.scene.activitySpace)
        ent.setPose(
            androidx.xr.runtime.math.Pose(
                androidx.xr.runtime.math.Vector3(
                    offsetXmm * WORLD_SCALE, offsetYmm * WORLD_SCALE, 0f,
                ),
                androidx.xr.runtime.math.Quaternion.Identity,
            ),
        )
        // Replace any prior entity (e.g. footprint changed): dispose first
        // so SceneCore doesn't keep two stacked bbox glyphs alive.
        entity?.dispose()
        entity = ent
        android.util.Log.i("OrcaXR", "SelectionBboxEntity attached ${out.name}")
    }

    LaunchedEffect(offsetXmm, offsetYmm) {
        entity?.setPose(
            androidx.xr.runtime.math.Pose(
                androidx.xr.runtime.math.Vector3(
                    offsetXmm * WORLD_SCALE, offsetYmm * WORLD_SCALE, 0f,
                ),
                androidx.xr.runtime.math.Quaternion.Identity,
            ),
        )
    }

    DisposableEffect(modelId) {
        onDispose {
            entity?.dispose()
            entity = null
        }
    }
}

@Composable
private fun GlbSceneEntity(
    session: Session,
    glbPath: String,
    parentEntity: androidx.xr.scenecore.Entity?,
    offsetXmm: Float = 0f,
    offsetYmm: Float = 0f,
    paintHooks: PaintInputHooks? = null,
    onTap: (() -> Unit)? = null,
    onHoverChange: ((Boolean) -> Unit)? = null,
) {
    var entity by remember { mutableStateOf<GltfModelEntity?>(null) }
    val ctx = LocalContext.current
    // Capture the LATEST hooks so the long-lived InputEvent listener
    // sees current brush state (radius / slot edits between strokes
    // shouldn't restart the listener).
    val hooksLive = rememberUpdatedState(paintHooks)
    // Phase XR_OBJ_1: capture the latest selection callbacks. The
    // listener is built once per (entity, paintHooksActive,
    // selectionActive) tuple — re-keying on every recomposition would
    // tear down the InteractableComponent, which costs a frame of
    // missed events.
    val onTapLive = rememberUpdatedState(onTap)
    val onHoverLive = rememberUpdatedState(onHoverChange)

    LaunchedEffect(glbPath, parentEntity) {
        // SceneCore's GltfModel.create(Session, Path) expects a path
        // *relative to assets/* and rejects absolute filesystem paths
        // with an IllegalArgumentException. Our GLBs are generated into
        // the app's cache dir at runtime, so we read the bytes ourselves
        // and use the byte[] overload instead.
        val bytes = runCatching { File(glbPath).readBytes() }
            .onFailure { android.util.Log.e("OrcaXR", "GLB read failed for $glbPath", it) }
            .getOrNull() ?: return@LaunchedEffect
        android.util.Log.i("OrcaXR", "GlbSceneEntity loading $glbPath (${bytes.size / 1024} KB)")
        val model = runCatching { GltfModel.create(session, bytes, File(glbPath).name) }
            .onFailure { android.util.Log.e("OrcaXR", "GltfModel.create failed for $glbPath", it) }
            .getOrNull() ?: return@LaunchedEffect
        val ent = GltfModelEntity.create(session, model)
        applyWorkspacePose(ent, parentEntity ?: session.scene.activitySpace)
        ent.setPose(androidx.xr.runtime.math.Pose(
            androidx.xr.runtime.math.Vector3(offsetXmm * WORLD_SCALE, offsetYmm * WORLD_SCALE, 0f),
            androidx.xr.runtime.math.Quaternion.Identity
        ))
        android.util.Log.i("OrcaXR", "GlbSceneEntity attached $glbPath, entity=$ent")
        entity = ent
    }

    LaunchedEffect(offsetXmm, offsetYmm) {
        entity?.setPose(androidx.xr.runtime.math.Pose(
            androidx.xr.runtime.math.Vector3(offsetXmm * WORLD_SCALE, offsetYmm * WORLD_SCALE, 0f),
            androidx.xr.runtime.math.Quaternion.Identity
        ))
    }

    // Attach / detach an InteractableComponent based on what the entity
    // needs to react to. Three modes, picked in priority order:
    //   1. `paintHooks` non-null  → paint pipeline (Phase J).
    //   2. `onTap` or `onHoverChange` non-null → selection pipeline
    //      (Phase XR_OBJ_1: tap to set selectedModelId, hover to set
    //      hoveredModelId).
    //   3. Neither → no component attached.
    //
    // The keyed restart on (entity, paintHooksActive, selectionActive)
    // means flipping paint mode (or toggling selection callbacks)
    // re-creates the component cleanly. The listener captures
    // `hooksLive` / `onTapLive` / `onHoverLive` for live edits so we
    // don't need to restart on every brush radius / slot change or
    // every selection-id mutation.
    val paintHooksActive = paintHooks != null
    val selectionActive = !paintHooksActive && (onTap != null || onHoverChange != null)
    DisposableEffect(entity, paintHooksActive, selectionActive) {
        val ent = entity
        if (ent == null || (!paintHooksActive && !selectionActive)) {
            onDispose { /* nothing attached */ }
        } else {
            val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
            val listener = java.util.function.Consumer<androidx.xr.scenecore.InputEvent> { event ->
                // Phase J.0 hardware-verification log: capture every
                // event the runtime dispatches to this entity, before
                // any filter, so we can see the source / action /
                // pointer / hit shape on real hardware. Drop to V
                // post-J.0 once the input shape is locked.
                val firstHit = event.hitInfoList.firstOrNull()
                if (android.util.Log.isLoggable("OrcaXR/paint", android.util.Log.VERBOSE)) {
                    val origin = event.origin
                    val dir = event.direction
                    android.util.Log.v(
                        "OrcaXR/paint",
                        "InputEvent src=${event.source} action=${event.action} " +
                            "ptr=${event.pointerType} " +
                            "origin=(${origin?.x},${origin?.y},${origin?.z}) " +
                            "dir=(${dir?.x},${dir?.y},${dir?.z}) " +
                            "hits=${event.hitInfoList.size} " +
                            (firstHit?.let {
                                val p = it.hitPosition
                                "hitPos=(${p?.x},${p?.y},${p?.z})"
                            } ?: "")
                    )
                }
                if (paintHooksActive) {
                    runCatching { hooksLive.value?.handle(event) }
                        .onFailure {
                            android.util.Log.e("OrcaXR/paint", "PaintInputHooks.handle threw", it)
                        }
                } else {
                    when (event.action) {
                        androidx.xr.scenecore.InputEvent.Action.HOVER_ENTER ->
                            onHoverLive.value?.invoke(true)
                        androidx.xr.scenecore.InputEvent.Action.HOVER_EXIT ->
                            onHoverLive.value?.invoke(false)
                        androidx.xr.scenecore.InputEvent.Action.DOWN ->
                            onTapLive.value?.invoke()
                        else -> { /* MOVE / UP / HOVER_MOVE / CANCEL — no-op */ }
                    }
                }
            }
            val ic = runCatching {
                androidx.xr.scenecore.InteractableComponent.create(session, executor, listener)
            }.onFailure {
                android.util.Log.e("OrcaXR/paint", "InteractableComponent.create failed", it)
            }.getOrNull()
            val attached = ic != null && runCatching { ent.addComponent(ic!!) }.getOrDefault(false)
            if (attached) {
                android.util.Log.i(
                    "OrcaXR/paint",
                    "InteractableComponent attached to $glbPath (mode=${
                        if (paintHooksActive) "paint" else "select"
                    })",
                )
            }
            onDispose {
                if (attached) {
                    runCatching { ent.removeComponent(ic!!) }
                    android.util.Log.i("OrcaXR/paint", "InteractableComponent detached from $glbPath")
                }
            }
        }
    }

    DisposableEffect(glbPath) {
        onDispose {
            android.util.Log.i("OrcaXR", "GlbSceneEntity disposing $glbPath")
            entity?.dispose()
            entity = null
        }
    }
}

@Composable
private fun FlatShell(
    sliceState: MutableState<SliceUiState>,
    maxLayer: MutableState<Int?>,
    selectedProfile: MutableState<SlicerProfile>,
    layerHeightOverride: MutableState<String>,
    showTravels: MutableState<Boolean>,
) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        ShellContent(sliceState, maxLayer, selectedProfile, layerHeightOverride, showTravels)
    }
}

/** STL the user has loaded but not yet sliced. Phase G keeps this
 *  type as a backward-compat lens onto the selected [PlacedModel] —
 *  several call sites (test harness, save-as helpers,
 *  BottomRightSummaryPanel) read `loadedStl?.file` / `.label` and
 *  don't need to know about the multi-model list. New code should
 *  read [PlacedModel] directly. */
data class LoadedStl(val file: File, val label: String)

/** Whether a file picked from the file picker should replace the
 *  selected model (the historical pre-Phase-G default — one model
 *  on the bed) or add a new model alongside the existing list. */
/** What the file picker should do with the selected file. Sealed
 *  interface so [AddVolume] can carry the [ModelVolumeType] —
 *  Add Part, Add Modifier, Add Negative Volume, Add Support
 *  Enforcer/Blocker all share the same flow with the type as the
 *  only differentiator. */
sealed interface PickerMode {
    /** Drop existing models and load the new file as the only
     *  [PlacedModel] (historical default). */
    data object Replace : PickerMode
    /** Append a new [PlacedModel] alongside the existing ones
     *  (Phase G multi-model). */
    data object Add : PickerMode
    /** Append a [PlacedVolume] of [type] to the currently-selected
     *  [PlacedModel] (Phase XR_OBJ_4). The volume rides into the
     *  slice via [SlicerEngine.slice]'s `extraVolumes` parameter. */
    data class AddVolume(val type: ModelVolumeType) : PickerMode
}

/** UI state for the slice flow. */
sealed interface SliceUiState {
    data object Idle : SliceUiState
    data class Slicing(
        val sourceLabel: String,
        /** 0..100, or -1 if libslic3r hasn't reported a number yet. */
        val percent: Int = -1,
        /** libslic3r's status message; empty until first real tick. */
        val message: String = "",
        /** Wall-clock millis when the slice started (System.currentTimeMillis).
         *  Used by the UI to show an elapsed-time counter. The percent
         *  bar alone misleads the user during long silent phases like
         *  MMU segmentation: libslic3r reports 5% at the start of
         *  slice_volumes and then nothing until 15% "Generating walls",
         *  which on serial-TBB Android is many minutes later. */
        val startedAtMs: Long = System.currentTimeMillis(),
    ) : SliceUiState
    data class Done(
        val sourceLabel: String,
        val result: SliceResult,
        val parsed: ParsedToolpath? = null,
    ) : SliceUiState
}

@Composable
private fun ShellContent(
    sliceState: MutableState<SliceUiState>,
    maxLayer: MutableState<Int?>,
    selectedProfile: MutableState<SlicerProfile>,
    layerHeightOverride: MutableState<String>,
    showTravels: MutableState<Boolean>,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var versionText by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        versionText = runCatching { SlicerEngine.versionString() }.getOrElse {
            "libslic3r unavailable: ${it.message}"
        }
    }

    val pickStl = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent(),
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val label = uri.lastPathSegment ?: "selected.stl"
            sliceState.value = SliceUiState.Slicing(sourceLabel = label)
            val stl = copyUriToCache(ctx, uri)
            // FlatShell has no printer concept, so no slot palette.
            val result = stl?.let {
                sliceLocalFile(
                    it,
                    mergedConfig(selectedProfile.value, layerHeightOverride.value, emptyList()),
                ) { percent, message ->
                    val cur = sliceState.value
                    if (cur is SliceUiState.Slicing) {
                        sliceState.value = cur.copy(percent = percent, message = message)
                    }
                }
            } ?: SliceResult.NativeError(-1, "could not open content URI")
            val parsed = (result as? SliceResult.Success)?.let {
                runCatching { GcodeParser.parse(File(it.outputPath)) }.getOrNull()
            }
            sliceState.value = SliceUiState.Done(label, result, parsed)
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF15181B)),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(48.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                "OrcaXR",
                style = MaterialTheme.typography.displayLarge,
                color = Color.White,
            )
            Text(
                versionText ?: "loading…",
                style = MaterialTheme.typography.bodyLarge,
            )

            ProfilePicker(
                selected = selectedProfile.value,
                onSelect = { selectedProfile.value = it },
                enabled = sliceState.value !is SliceUiState.Slicing,
            )

            LayerHeightOverride(
                value = layerHeightOverride.value,
                onChange = { layerHeightOverride.value = it },
                profileDefault = selectedProfile.value.config["layer_height"] ?: "",
                enabled = sliceState.value !is SliceUiState.Slicing,
            )

            Spacer(Modifier.height(16.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Button(
                    enabled = sliceState.value !is SliceUiState.Slicing,
                    onClick = {
                        scope.launch {
                            val label = "cube_20mm.stl (bundled)"
                            sliceState.value = SliceUiState.Slicing(sourceLabel = label)
                            val stl = copyBundledCube(ctx)
                            val result = sliceLocalFile(
                                stl,
                                mergedConfig(selectedProfile.value, layerHeightOverride.value, emptyList()),
                            ) { percent, message ->
                                val cur = sliceState.value
                                if (cur is SliceUiState.Slicing) {
                                    sliceState.value = cur.copy(percent = percent, message = message)
                                }
                            }
                            val parsed = (result as? SliceResult.Success)?.let {
                                runCatching { GcodeParser.parse(File(it.outputPath)) }.getOrNull()
                            }
                            sliceState.value = SliceUiState.Done(label, result, parsed)
                        }
                    },
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Text("Slice bundled 20mm cube")
                }
                Button(
                    enabled = sliceState.value !is SliceUiState.Slicing,
                    onClick = { pickStl.launch("*/*") },
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Text("Load model…")
                }
            }

            Spacer(Modifier.height(24.dp))
            SliceStateView(state = sliceState.value)

            val parsed = (sliceState.value as? SliceUiState.Done)?.parsed
            if (parsed != null && parsed.layerZs.size > 1) {
                LayerScrubber(parsed = parsed, maxLayer = maxLayer)
            }
            if (parsed != null && parsed.travels.isNotEmpty()) {
                Row(
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Switch(
                        checked = showTravels.value,
                        onCheckedChange = { showTravels.value = it },
                    )
                    Text(
                        "Show travels (${parsed.travels.size} segments, dimmed gray)",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
    }
}

// ----------------------------------------------------------------------
// Filament-entry mutation helpers (Phase J).
//
// Extracted as pure top-level functions so the Compose call site in
// LeftProjectPanel and the unit tests in FilamentSlotEditIsolationTest can
// share a single source of truth. The previous in-line lambdas in MainActivity
// got out of sync with the test mirrors twice during the original mapping
// rework; pulling them out here makes the contract obvious.
//
// New shape (vs. pre-Phase-J):
//   • applyChangeColor(slot, hex) — color edit ONLY. Mapping target survives.
//     Pre-Phase-J this also cleared physicalSlot/virtualSlot, conflating "I
//     want a different shade of purple" with "and stop printing it from T2."
//     Post-Phase-J the mapping is owned by the right-side picker, not by the
//     color row.
//   • applyMapToPhysical(slot, physical) — set physicalSlot, clear virtualSlot.
//     Color is NOT changed; the model's authored color stays visible while
//     the chip on the right tells the user where it actually prints.
//   • applyMapToVirtual(slot, virtual) — set virtualSlot, clear physicalSlot.
//   • applyClearMapping(slot) — both back to null (identity: filament N → T_N).
//   • applyChangeType(slot, type) — material picker.
//
// Out-of-range slot index is a no-op everywhere — the picker shouldn't emit
// such an index, but defending here keeps a buggy caller from rewriting an
// adjacent slot.
// ----------------------------------------------------------------------

internal fun applyChangeColor(list: List<FilamentEntry>, slot: Int, hex: String): List<FilamentEntry> =
    list.mapIndexed { i, f -> if (i == slot) f.copy(color = hex) else f }

internal fun applyMapToPhysical(list: List<FilamentEntry>, slot: Int, physicalSlot: Int): List<FilamentEntry> =
    list.mapIndexed { i, f ->
        if (i == slot) f.copy(physicalSlot = physicalSlot, virtualSlot = null) else f
    }

internal fun applyMapToVirtual(list: List<FilamentEntry>, slot: Int, virtualSlot: Int): List<FilamentEntry> =
    list.mapIndexed { i, f ->
        if (i == slot) f.copy(physicalSlot = null, virtualSlot = virtualSlot) else f
    }

internal fun applyClearMapping(list: List<FilamentEntry>, slot: Int): List<FilamentEntry> =
    list.mapIndexed { i, f ->
        if (i == slot) f.copy(physicalSlot = null, virtualSlot = null) else f
    }

internal fun applyChangeType(list: List<FilamentEntry>, slot: Int, type: String): List<FilamentEntry> =
    list.mapIndexed { i, f -> if (i == slot) f.copy(filamentType = type) else f }

/**
 * Build libslic3r's `filament_map` from the project's filament count
 * `n`, the physical extruder count `numPhysical`, and an optional
 * per-filament override `slotRemap`. Returns a 1-based comma-joined
 * string of length `n`. Modulo cycles indices ≥ numPhysical back into
 * the physical-extruder range (e.g. 5 filaments × 4 nozzles → slot 4
 * routes to physical T0). Visible for testing.
 */
internal fun computeFilamentMap(
    n: Int,
    numPhysical: Int,
    slotRemap: List<Int?> = emptyList(),
): String {
    val phys = numPhysical.coerceAtLeast(1)
    return (0 until n).joinToString(",") { i ->
        val target = (slotRemap.getOrNull(i) ?: i).coerceIn(0, n - 1)
        ((target % phys) + 1).toString()
    }
}

/**
 * Merge the selected profile's config with an optional layer-height
 * override typed by the user. Empty / unparseable override keeps the
 * profile's value. Range-clamps to [0.05, 0.50] mm — below 0.05 the
 * extruder rarely builds enough flow, above 0.50 we're past most
 * 0.4 mm-nozzle limits and into specialty territory.
 */
/**
 * Build a reasonable `flush_volumes_matrix` for [filaments] filaments
 * across [nozzles] independent extruders. Output length matches
 * `filaments² × nozzles` — the size libslic3r expects in
 * `WipeTowerIntegration::plan_toolchange` (Print.cpp:3240). For each
 * nozzle's `filaments × filaments` block, the diagonal (same-color
 * "transition") is `0.0` and every off-diagonal entry is [defaultMm3].
 *
 * The 30 mm³ default this is typically called with sits well below
 * libslic3r's 280-mm³ compiled-in default and matches the average
 * FullSpectrum / OrcaSlicer authored value for similar-color flushes.
 * It pairs with a 1.0 `flush_multiplier`, so the matrix value is the
 * literal mm³ purged per toolchange — no further scaling.
 */
internal fun synthesizeFlushMatrix(
    filaments: Int,
    nozzles: Int,
    defaultMm3: Double,
): String {
    val safeFilaments = filaments.coerceAtLeast(1)
    val safeNozzles = nozzles.coerceAtLeast(1)
    val sb = StringBuilder()
    val diagonal = "0"
    // Pre-format `defaultMm3` once so the resulting CSV doesn't carry
    // locale-specific decimal separators (libslic3r's parser reads
    // `,` as a vector separator and `.` as the decimal — see
    // ConfigOptionFloatsTempl::deserialize).
    val off = if (defaultMm3 == defaultMm3.toLong().toDouble()) {
        defaultMm3.toLong().toString()
    } else {
        "%.3f".format(java.util.Locale.US, defaultMm3)
    }
    for (n in 0 until safeNozzles) {
        for (i in 0 until safeFilaments) {
            for (j in 0 until safeFilaments) {
                if (sb.isNotEmpty()) sb.append(',')
                sb.append(if (i == j) diagonal else off)
            }
        }
    }
    return sb.toString()
}

internal fun mergedConfig(
    profile: SlicerProfile,
    layerHeightInput: String,
    slotColors: List<String>,
    mixedFilamentDefinitions: String = "",
    /**
     * Per-project-filament override of which physical printer slot
     * (0-based) emits T-commands for that filament. When [slotRemap]
     * has fewer entries than [slotColors], or an entry is null, the
     * slicer falls back to identity (project filament N → physical
     * T_N) — which is the historical behavior. Populated from each
     * [FilamentEntry.physicalSlot] at the call site so a user pick
     * from the picker's "Loaded in printer" row rewires which spool
     * actually prints, instead of just relabeling the swatch.
     */
    slotRemap: List<Int?> = emptyList(),
    /**
     * User-typed Speed / Support tab overrides (Phase XR_UI §3). Sparse map
     * — only keys the user actually edited. Applied AFTER the per-slot
     * resize step so overrides win cleanly over profile defaults; values
     * are pre-validated by the UI layer (numeric ranges checked in the
     * TextField onValueChange path), so this map is trusted on entry.
     * The layer-height knob keeps its own dedicated parameter because it
     * has a separate persistence story (DataStore prefs) that the rest
     * of the print-settings overrides don't share yet.
     */
    extraOverrides: Map<String, String> = emptyMap(),
    /**
     * Project-level flush-tower settings extracted from a freshly-
     * loaded 3MF (see `SlicerEngine.read3mfFlushSettings`). When the
     * matrix size is consistent with the active slot/nozzle count,
     * these win over the libslic3r 280-default and any matrix the
     * machine profile happens to ship. When the matrix size doesn't
     * match (e.g. 3MF authored for 4 slots, project has 5), we fall
     * back to a synthesized small-default matrix rather than feed an
     * OOB-sized vector to `WipeTowerIntegration::plan_toolchange`
     * (Print.cpp:3240). null = no 3MF loaded / non-multicolor source.
     */
    flushFromProject: SlicerEngine.FlushSettings? = null,
    /**
     * Process-level overrides authored in the 3MF's project_settings
     * .config (layer_height, sparse_infill_density, sparse_infill_
     * pattern, seam_position, etc.). Keys mirror the libslic3r
     * config namespace (snake_case). Sparse — only authored keys.
     * Applied as a layer ON TOP of the bundled profile + slot resize
     * but UNDER `extraOverrides`, so a UI knob still wins over the
     * 3MF authoring. Empty map for STL/OBJ loads.
     */
    projectOverrides: Map<String, String> = emptyMap(),
    /**
     * B3: per-slot filament-type names (e.g. "Generic PLA",
     * "Elegoo PLA Matte"), parallel to [slotColors]. When a slot's
     * material has a flattened config in [allFilaments], its key
     * values win over the active profile's vector at the per-slot
     * resize step — this is how the user's "Generic PETG" pick on slot
     * 2 raises that extruder's nozzle_temperature without rewriting
     * the profile.
     */
    slotTypes: List<String> = emptyList(),
    /**
     * B3: catalog of every flattened filament profile
     * (Material name → key/value config map), produced by
     * [OrcaProfileLoader.loadFilaments]. Empty map disables the
     * per-slot override and falls back to the active profile's
     * vector (legacy behavior).
     */
    allFilaments: Map<String, Map<String, String>> = emptyMap(),
): Map<String, String> {
    val withLayer = run {
        val parsed = layerHeightInput.trim().toFloatOrNull()
        if (parsed == null || parsed.isNaN()) profile.config
        else profile.config + ("layer_height" to "%.3f".format(parsed.coerceIn(0.05f, 0.50f)))
    }
    if (slotColors.isEmpty()) return withLayer + projectOverrides + extraOverrides

    // ----------------------------------------------------------------
    // Real multi-tool slicing for the U1 toolchanger.
    //
    // libslic3r's toolchanger code path
    // (`update_values_to_printer_extruders_for_multiple_filaments`,
    // PrintConfig.cpp:9161) reads extruder_type / nozzle_volume_type /
    // filament_map and runs once `extruder_count > 1`. Both enum keys
    // route through ConfigOptionEnumsGeneric, which used to SIGSEGV in
    // deserialize because their `keys_map` runtime pointer was never
    // populated. slic3r_jni.cpp now patches keys_map at startup, so
    // those keys deserialize cleanly. We can finally pass real
    // per-extruder vectors instead of collapsing to one tool.
    //
    // The U1 has 4 independent direct-drive extruders — explicitly
    // NOT a Bambu/Prusa-style single-extruder-multi-material printer.
    // Embedded Snapmaker profiles may set
    // single_extruder_multi_material=1; we force false here, matching
    // u1-slicer-for-android's `applyConfigToPrusa` (sapil_print.cpp).
    // ----------------------------------------------------------------
    val n = slotColors.size

    // Pad/truncate every per-extruder vector to exactly n entries.
    // libslic3r's `WipeTowerIntegration` and `multi_material_segmentation`
    // index by tool ID; arrays shorter than n cause OOB reads.
    //
    // CRITICAL: libslic3r parses ConfigOptionStrings (coStrings) with
    // `unescape_strings_cstyle` which splits on SEMICOLON, NOT comma —
    // because string values may legitimately contain commas (G-code
    // snippets, file paths, etc.). Numeric vectors (coFloats, coInts)
    // and point vectors (coPoints) DO split on comma. So separators
    // depend on the option type. Pass `sep` accordingly.
    fun resize(key: String, count: Int, fillFromIndex0: Boolean = true, sep: String = ","): String {
        val value = withLayer[key]
        val parts = value.orEmpty().split(sep).map { it.trim() }
            .filter { it.isNotEmpty() }
        
        val first = parts.firstOrNull() ?: ""
        return (0 until count).joinToString(sep) { i ->
            val slotType = slotTypes.getOrNull(i)
            val slotCfg = slotType?.let { allFilaments[it] }
            val slotVal = slotCfg?.get(key)?.split(sep)?.firstOrNull()?.trim()

            slotVal?.takeIf { it.isNotEmpty() }
                ?: parts.getOrNull(i)
                ?: if (fillFromIndex0) first else parts.lastOrNull() ?: ""
        }
    }

    // filament_map: which physical printer slot each project filament
    // drives. libslic3r is 1-based (see PrintConfig.cpp:9168
    // `filament_maps[f_index] - 1`); painted-facet indices in the 3MF
    // are *project* filament indices, and GCode.cpp:3484-3488 looks up
    // `filament_map[f] - 1` to pick the physical extruder for the T-
    // command.  Default identity (filament N → T_N) gets overridden
    // per-slot whenever the user picked the project filament's color
    // from the picker's "Loaded in printer" row — that pick is the
    // user's "I want what's loaded at T_M for this filament" signal,
    // and is the entire fix for the UX bug where changing a swatch's
    // color changed nothing about which physical filament got laid
    // down. Out-of-range values would be unsafe in libslic3r (vector
    // index), so we coerce to 0..n-1 before adding 1.
    //
    // Phase C: when filament count > physical extruder count (e.g. a
    // 5-color project on the U1's 4 hot-ends), filament_map MUST cycle
    // by modulo into the physical-extruder range. Without this, slot 4
    // routes to T4 — which doesn't exist on a 4-extruder U1 (T0..T3),
    // and Snapmaker firmware errors / Klipper shuts down. The cycled
    // value (slot 4 → physical T0) matches the cycle-from-index-0
    // semantics of the resize() helper for nozzle_diameter / retraction_
    // length / etc., so per-physical config arrays already report the
    // right physical-extruder values at the cycled index.
    //
    // numPhysical is derived from the un-resized profile nozzle_diameter
    // (one entry per physical hot-end). Falls back to n when missing
    // (single-extruder Klipper printers; modulo collapses to identity).
    // This is the minimal port of Snapmaker fork PR #160 — it captures
    // the user-visible "5th filament fails on U1" bug without taking
    // the full ~600 LoC libslic3r-side patch (the broader Snapmaker
    // change makes libslic3r aware of the modular mapping at every
    // call site; we get there via filament_map enforcement here).
    val numPhysical = (withLayer["nozzle_diameter"]?.split(",")
        ?.count { it.trim().isNotEmpty() } ?: n).coerceAtLeast(1)
    val filamentMap = computeFilamentMap(n, numPhysical, slotRemap)

    val withSlots = withLayer +
        // Numeric vectors (coFloats, coInts) and point vectors (coPoints)
        // use comma as separator — libslic3r's ConfigOptionFloats/Ints/
        // Points parsers split on `,`.
        ("nozzle_diameter" to resize("nozzle_diameter", n)) +
        ("filament_diameter" to resize("filament_diameter", n)) +
        // String vectors (coStrings) use SEMICOLON. See unescape_strings_
        // cstyle in libslic3r/Config.cpp:146 — it splits on `;` because
        // string values may legitimately contain commas. Comma-separated
        // string lists collapse to a single string and break MMU
        // segmentation (filament_colour.size() == 1, num_facets_states
        // == 2, all painted regions get dropped).
        ("filament_type" to resize("filament_type", n, sep = ";")) +
        ("filament_density" to resize("filament_density", n)) +
        ("filament_flow_ratio" to resize("filament_flow_ratio", n)) +
        ("filament_max_volumetric_speed" to resize("filament_max_volumetric_speed", n)) +
        ("nozzle_temperature" to resize("nozzle_temperature", n)) +
        ("nozzle_temperature_initial_layer" to resize("nozzle_temperature_initial_layer", n)) +
        ("cool_plate_temp" to resize("cool_plate_temp", n)) +
        ("cool_plate_temp_initial_layer" to resize("cool_plate_temp_initial_layer", n)) +
        ("eng_plate_temp" to resize("eng_plate_temp", n)) +
        ("eng_plate_temp_initial_layer" to resize("eng_plate_temp_initial_layer", n)) +
        ("hot_plate_temp" to resize("hot_plate_temp", n)) +
        ("hot_plate_temp_initial_layer" to resize("hot_plate_temp_initial_layer", n)) +
        ("textured_plate_temp" to resize("textured_plate_temp", n)) +
        ("textured_plate_temp_initial_layer" to resize("textured_plate_temp_initial_layer", n)) +
        ("retraction_length" to resize("retraction_length", n)) +
        ("retraction_speed" to resize("retraction_speed", n)) +
        ("deretraction_speed" to resize("deretraction_speed", n)) +
        // Per-extruder filament vectors that newly flow through
        // SAFE_KEYS. coBools / coFloats — comma-separated.
        // filament_minimal_purge_on_wipe_tower governs per-tool purge
        // volume; the multitool_ramming family controls the U1
        // toolchanger's ramming behavior on tool change; pressure
        // advance and reduce_fan_stop_start_freq are per-extruder
        // toggles. All are sized 1-per-filament in Snapmaker leaves
        // and must match the slot count once the toolchanger code
        // path engages.
        ("filament_minimal_purge_on_wipe_tower" to resize("filament_minimal_purge_on_wipe_tower", n)) +
        ("filament_multitool_ramming" to resize("filament_multitool_ramming", n)) +
        ("filament_multitool_ramming_volume" to resize("filament_multitool_ramming_volume", n)) +
        ("filament_multitool_ramming_flow" to resize("filament_multitool_ramming_flow", n)) +
        ("enable_pressure_advance" to resize("enable_pressure_advance", n)) +
        ("pressure_advance" to resize("pressure_advance", n)) +
        ("reduce_fan_stop_start_freq" to resize("reduce_fan_stop_start_freq", n)) +
        // Tool-change loading/unloading and cooling vectors. Snapmaker
        // fork's fdm_filament_common.json supplies these per-tool;
        // without resizing, libslic3r's update_values_to_printer_
        // extruders_for_multiple_filaments OOB-reads when slot count
        // exceeds the source array length (gotcha #6).
        ("filament_loading_speed" to resize("filament_loading_speed", n)) +
        ("filament_loading_speed_start" to resize("filament_loading_speed_start", n)) +
        ("filament_unloading_speed" to resize("filament_unloading_speed", n)) +
        ("filament_unloading_speed_start" to resize("filament_unloading_speed_start", n)) +
        ("filament_toolchange_delay" to resize("filament_toolchange_delay", n)) +
        ("filament_cooling_moves" to resize("filament_cooling_moves", n)) +
        ("filament_cooling_initial_speed" to resize("filament_cooling_initial_speed", n)) +
        ("filament_cooling_final_speed" to resize("filament_cooling_final_speed", n)) +
        // coStrings — semicolon-joined.
        ("filament_colour" to slotColors.joinToString(";")) +
        ("extruder_colour" to slotColors.joinToString(";")) +
        ("filament_map" to filamentMap) +
        // filament_map_mode MUST be "Manual" or libslic3r's
        // Print::process re-runs `get_recommended_filament_maps` and
        // overwrites our user-supplied filament_map (Print.cpp:2378-2381).
        // Default is "Auto For Flush" which silently discards the
        // user's physical-slot picks — that was the load-bearing reason
        // the dragon body still printed black after Phase J even with
        // the libslic3r-side T-command patch (0027) in place. See
        // GEMINI.md gotcha #34.
        ("filament_map_mode" to "Manual") +
        // ConfigOptionEnumsGeneric: comma-joined enum-name strings.
        // (Confirmed: enum vectors use comma like other numeric-style
        // vectors, not semicolon — they're stored as int enums, just
        // serialized with their name tokens.)
        // "Direct Drive" is the etDirectDrive token registered via
        // PrintConfig.cpp:4880. The U1 is direct-drive across all 4
        // toolheads. Standard nozzle volume across all 4.
        ("extruder_type" to List(n) { "Direct Drive" }.joinToString(",")) +
        ("nozzle_volume_type" to List(n) { "Standard" }.joinToString(",")) +
        // U1 toolchanger != SEMM. False forces the per-extruder path
        // instead of bowden-style unload/reload + ramming.
        ("single_extruder_multi_material" to "0") +
        // U1 firmware handles per-tool offsets; report (0,0) per slot.
        ("extruder_offset" to List(n) { "0x0" }.joinToString(",")) +
        // Prime/wipe tower for multi-color prints. OrcaSlicer's
        // default for `enable_prime_tower` is false (PrintConfig.cpp
        // line 6299). Multi-extruder prints NEED a tower so the
        // toolchanger can purge each new tool before depositing on
        // the part — without it, the first few mm of each color
        // change drag old filament onto the model. Snapmaker's
        // desktop slicer enables it automatically for >1 filament;
        // we mirror that here whenever we have ≥2 slots.
        //
        // Geometry (prime_tower_width, prime_tower_brim_width) is
        // intentionally NOT force-set here — the bundled Snapmaker U1
        // leaf tunes these (width=30, brim=5) along with the wipe
        // tower's rib/cone shape, and those values now flow through
        // SAFE_KEYS. Only `enable_prime_tower` needs an unconditional
        // override because some profile leaves leave it 0.
        ("enable_prime_tower" to (if (n >= 2) "1" else "0")) +
        // Flush sizing for the wipe tower. libslic3r's compiled-in
        // defaults are 280 mm³ off-diagonal × 0.3 multiplier = 84 mm³
        // per toolchange, which is wildly oversized vs. what a typical
        // FullSpectrum / OrcaSlicer multicolor 3MF actually authors
        // (30-50 mm³ for similar colors). Three-tier resolution:
        //   1. 3MF-supplied values, IF the matrix size matches
        //      `n*n*nozzle_count` (otherwise libslic3r's
        //      `get_flush_volumes_matrix` would OOB-read at
        //      Print.cpp:3240). Multiplier likewise sized to nozzle_count.
        //   2. Synthesized small-default — zeros on the per-block
        //      diagonal, 30 mm³ elsewhere. Applies to STL/OBJ loads
        //      and to 3MFs with mismatched-size embedded matrices.
        //      Multiplier = 1.0 per nozzle so the matrix value is
        //      taken literally.
        //   3. Profile-supplied keys still flow through `withLayer`
        //      (above) but are last-write overridden by this block
        //      whenever we're in the multi-slot branch — the
        //      synthesized default's slot/nozzle sizing is more
        //      reliable than what a single static profile JSON can
        //      anticipate across user-driven slot counts.
        ("flush_volumes_matrix" to run {
            val expected = n * n * numPhysical
            val embedded = flushFromProject?.matrix.orEmpty()
                .split(',').map { it.trim() }.filter { it.isNotEmpty() }
            when (embedded.size) {
                // Already sized to per-nozzle x per-pair blocks. Pass
                // through verbatim — this matches PresetBundle's
                // post-resize shape after load_bbs_3mf has been
                // through `validate_flush_volumes_matrix`.
                expected -> embedded.joinToString(",")
                // 3MF authored at "single-nozzle" size (n²). Most
                // BBS / FullSpectrum exports store the matrix this way
                // because the per-pair calibration is identical across
                // physical extruders. Replicate the n²-block once per
                // nozzle to reach `n² × numPhysical` — matches the
                // expansion PresetBundle.cpp:4316-4350 does on desktop.
                n * n -> List(numPhysical) { embedded.joinToString(",") }.joinToString(",")
                // Anything else (size mismatch with current slot count)
                // is unsafe to forward — `WipeTowerIntegration::plan_
                // toolchange` (Print.cpp:3240) would OOB-read. Fall
                // back to the synthesized small default so the slice
                // succeeds with conservative purges.
                else -> synthesizeFlushMatrix(n, numPhysical, defaultMm3 = 30.0)
            }
        }) +
        ("flush_multiplier" to run {
            val expected = numPhysical
            val embedded = flushFromProject?.multiplier.orEmpty()
                .split(',').map { it.trim() }.filter { it.isNotEmpty() }
            when (embedded.size) {
                expected -> embedded.joinToString(",")
                // Single-nozzle authored value (the FullSpectrum /
                // OrcaSlicer 3MFs we've seen ship one scalar like
                // "0.9" even on 4-nozzle U1 prints — the multiplier
                // is per-pair-of-filaments, not per-physical-extruder).
                // Replicate to numPhysical so `flush_multiplier.get_at
                // (nozzle_id)` (Print.cpp:3272) returns the same value
                // for every physical extruder.
                1 -> List(numPhysical) { embedded[0] }.joinToString(",")
                else -> List(numPhysical) { "1.0" }.joinToString(",")
            }
        }) +
        // Scalar tower-geometry overrides from the 3MF. Pass-through
        // ONLY when authored — otherwise leave the bundled profile /
        // libslic3r default intact. These are co-tuned with the matrix
        // / multiplier in desktop authoring tools (FullSpectrum,
        // OrcaSlicer): prime_volume defaults 45 mm³ (tuned 3MFs ~38),
        // prime_tower_width default 35 mm (U1 leaf ships 30, tuned
        // 3MFs ~28). prime_volume is the dominant per-print mass term
        // — `prime_volume × layer_count × n_filaments` accounts for
        // ~5 g of the gap vs desktop on a 300-layer 4-color print.
        flushFromProject?.primeVolume
            ?.takeIf { it.isNotBlank() }
            ?.let { mapOf("prime_volume" to it) }.orEmpty() +
        flushFromProject?.primeTowerWidth
            ?.takeIf { it.isNotBlank() }
            ?.let { mapOf("prime_tower_width" to it) }.orEmpty() +
        flushFromProject?.primeTowerBrimWidth
            ?.takeIf { it.isNotBlank() }
            ?.let { mapOf("prime_tower_brim_width" to it) }.orEmpty() +
        // curr_bed_type drives bed-temperature resolution. The U1
        // ships with a textured PEI plate; without this override
        // OrcaSlicer falls back to the cool-plate path and emits
        // M190 S35 (PLA's cool_plate_temp_initial_layer default)
        // instead of M190 S65 (hot_plate_temp_initial_layer). Mirrors
        // u1-slicer-for-android's `applyConfigToPrusa` setting
        // `ConfigOptionEnum<BedType>(btPEI)` (sapil_print.cpp:214).
        // Safe to deserialize because curr_bed_type is a typed
        // ConfigOptionEnum<BedType> (not a generic-enum that needed
        // the keys_map fixup).
        ("curr_bed_type" to "Textured PEI Plate")

    // Inject the GENERIC_KLIPPER_*_GCODE fallback ONLY when the profile
    // didn't supply its own machine_start_gcode. The bundled Snapmaker
    // U1 profile carries the canonical 2026-01-28 production text
    // (PRINT_START + SM_PRINT_AUTO_FEED + BED_MESH_CALIBRATE + per-tool
    // feeds + final M109 T{initial_extruder} S<temp>). Overriding it
    // with our naive M104/M109 (no T param) caused M109 deadlocks: the
    // U1 firmware's [gcode_macro M104] override routes bare M104 to a
    // parallel heater controller that doesn't update Klipper's
    // extruder.target field, so M109's wait-on-target never unblocks
    // even though the nozzle physically heats. Trust the profile.
    val profileStart = withSlots["machine_start_gcode"]?.takeIf { it.isNotBlank() }
    val profileEnd = withSlots["machine_end_gcode"]?.takeIf { it.isNotBlank() }
    // Precedence ladder (lowest → highest):
    //   1. profile.config (bundled JSON)
    //   2. layerHeightInput parameter (UI default)
    //   3. withSlots (per-tool resize + flush + tower scalars)
    //   4. start/end gcode fallback (only when profile didn't set it)
    //   5. projectOverrides (3MF-authored process tunings — wins over
    //      everything below it but loses to user UI edits)
    //   6. extraOverrides (user Speed/Support edits in the UI)
    //   7. mixed_filament_definitions (runtime-built FullSpectrum data)
    //
    // The split between projectOverrides and extraOverrides matches
    // desktop OrcaSlicer's UX expectation: opening a 3MF replaces the
    // active preset's values, but a runtime knob in the UI still wins
    // — same model OrcaXR's UI follows for layer-height edits.
    return withSlots +
        ("machine_start_gcode" to (profileStart ?: GENERIC_KLIPPER_START_GCODE)) +
        ("machine_end_gcode" to (profileEnd ?: GENERIC_KLIPPER_END_GCODE)) +
        projectOverrides +
        extraOverrides +
        ("mixed_filament_definitions" to mixedFilamentDefinitions)
}

/**
 * Generic Klipper start G-code. Used ONLY when the profile didn't
 * supply its own `machine_start_gcode` — i.e., for non-Snapmaker
 * Klipper hosts. The Snapmaker U1 leaf profile carries the canonical
 * production text and we must NOT override it (overriding caused the
 * M109 deadlock the user hit five times: bare M104/M109 without
 * `T{initial_extruder}` gets rerouted by the U1 firmware's
 * [gcode_macro M104] override to a parallel heater controller that
 * doesn't update Klipper's `extruder.target`, so M109's
 * wait-on-target never unblocks).
 *
 * Sequence:
 *   1. Home all axes (heat-up overlaps the homing move).
 *   2. M190 with `hot_plate_temp_initial_layer` so the bed lands on
 *      the PEI/textured-plate temperature.
 *   3. T[initial_extruder] activates the toolhead BEFORE any heater
 *      command — toolchanger Klipper builds drop M104/M109 issued
 *      against an unset active extruder.
 *   4. M104/M109 carry an explicit `T[initial_extruder]` parameter so
 *      that any [gcode_macro M104] / [gcode_macro M109] override the
 *      host firmware ships still routes to the correct physical
 *      extruder AND updates Klipper's `extruder<n>.target` field.
 *      Both Snapmaker's official OrcaSlicer fork and
 *      taylormadearmy/u1-slicer-for-android carry the T param on
 *      every M104/M109 for this reason.
 *   5. G92 E0 + small lift so the slicer's first travel doesn't
 *      drag a blob across the bed.
 */
private val GENERIC_KLIPPER_START_GCODE: String = """
; OrcaXR generic Klipper start
G28 ; home all axes
M190 S[hot_plate_temp_initial_layer] ; wait for bed
T[initial_extruder] ; activate first toolhead BEFORE any heater command
M104 T[initial_extruder] S[nozzle_temperature_initial_layer] ; nozzle target
M109 T[initial_extruder] S[nozzle_temperature_initial_layer] ; wait for nozzle
G92 E0 ; reset extruder
G1 Z5 F3000 ; lift
""".trim()

/**
 * Generic Klipper end G-code. Cuts power to the hotend and bed, lifts
 * Z, parks X at home, and disables motors. Mirrors what most Klipper
 * `END_PRINT` macros do; safe on any printer that responds to the
 * stock M-codes.
 */
private val GENERIC_KLIPPER_END_GCODE: String = """
; OrcaXR generic Klipper end
M104 S0 ; nozzle off
M140 S0 ; bed off
M107 ; fan off
G91 ; relative
G1 Z10 F600 ; lift
G90 ; absolute
G28 X0 ; park X at home
M84 ; motors off
""".trim()


/** Curated scale presets the Scale tool cycles through. 100% first so
 *  tap-tap returns home; the rest cover the common "shrink/enlarge"
 *  ranges users actually print at without inviting a numeric input. */
val SCALE_PRESETS = listOf(100, 50, 75, 125, 150, 200)

data class BedXY(val x: Float, val y: Float)

fun snapAndClampOffset(rawX: Float, rawY: Float, snap: Float = 5f, halfBed: Float = 128f): BedXY {
    var snX = kotlin.math.round(rawX / snap) * snap
    var snY = kotlin.math.round(rawY / snap) * snap
    if (snX == -0f) snX = 0f
    if (snY == -0f) snY = 0f
    return BedXY(
        x = snX.coerceIn(-halfBed, halfBed),
        y = snY.coerceIn(-halfBed, halfBed),
    )
}

/**
 * Apply the user's translation + rotation + scale to a freshly-parsed STL mesh.
 * Order: scale first (preserves origin), then rotate around Z, then translate.
 * All default to no-op so the call is cheap when the user hasn't touched
 * the tools. Phase XR_OBJ_2 keeps this 4-arg signature for the legacy
 * call sites (test-harness export) that only know about Z rotation +
 * uniform scale + XY translate; [applyPlacedTransforms] is the
 * full-axis path for the per-model preview pipeline.
 */
private fun applyTransforms(mesh: StlMesh, rotZDeg: Int, scalePct: Int, dx: Float = 0f, dy: Float = 0f): StlMesh {
    val scaled = if (scalePct == 100) mesh else mesh.scaled(scalePct / 100f)
    val rotated = if (rotZDeg == 0) scaled else scaled.rotatedZ(rotZDeg)
    return if (dx == 0f && dy == 0f) rotated else rotated.translated(dx, dy)
}

/**
 * Phase XR_OBJ_2 — apply a [PlacedModel]'s full per-axis transforms to
 * a freshly-parsed STL mesh. Uses [StlMesh.transformedFull] so the
 * scale, mirror, X/Y/Z rotation, and X/Y/Z translation all compose into
 * a single allocation (the legacy [applyTransforms] makes 1–3 separate
 * arrays).
 *
 * Z translation is intentionally NOT applied to the preview mesh — the
 * per-model preview GLB sits at zMin=0 by [StlPreviewGlb]'s recentering
 * convention and the entity's local pose ignores Z (the auto-bed-drop
 * in the JNI re-grounds the model at slice time). For the slicer path
 * we send tz separately through [SlicerEngine.nativeSliceMulti]'s
 * widened transforms array.
 */
private fun applyPlacedTransforms(mesh: StlMesh, m: PlacedModel): StlMesh {
    return mesh.transformedFull(
        rotXDeg = m.rotXDeg,
        rotYDeg = m.rotYDeg,
        rotZDeg = m.rotZDeg.toFloat(),
        scaleX = m.effectiveScaleX,
        scaleY = m.effectiveScaleY,
        scaleZ = m.effectiveScaleZ,
        mirrorX = m.mirrorX,
        mirrorY = m.mirrorY,
        mirrorZ = m.mirrorZ,
        tx = m.translateXmm,
        ty = m.translateYmm,
        tz = 0f,
    )
}

/**
 * Parse libslic3r's serialized `mixed_filament_definitions` string back
 * into Kotlin [MixedFilamentEntry] objects. Format mirrors
 * `MixedFilamentManager::serialize_custom_entries`:
 *
 *   row := A,B,enabled,custom,mix_b_pct,pointillism,gIDS,wWEIGHTS,
 *          mDIST,zZMAX,xaA_OFF,xbB_OFF,dDELETED,oORIGIN_AUTO,uSTABLE_ID
 *   serialized := row(;row)*
 *
 * Tokens after the leading positional ints carry single/double-letter
 * prefixes. We only read the fields the XR UI needs (componentA, B,
 * enabled, mix percentage, deleted, stable_id for the row id) — the
 * advanced cadence/dithering fields stay defaulted on the Kotlin side
 * since the XR panel doesn't expose them yet.
 */
private fun parseMixedDefinitionsForKotlin(serialized: String): List<MixedFilamentEntry> {
    if (serialized.isBlank()) return emptyList()
    val out = mutableListOf<MixedFilamentEntry>()
    for (rawRow in serialized.split(';')) {
        val row = rawRow.trim()
        if (row.isEmpty()) continue
        val fields = row.split(',').map { it.trim() }
        if (fields.size < 5) continue
        val a = fields[0].toIntOrNull() ?: continue
        val b = fields[1].toIntOrNull() ?: continue
        val enabled = fields[2].toIntOrNull() != 0
        // fields[3] = custom (ignored — Kotlin treats every row as live)
        val mixB = fields[4].toIntOrNull()?.coerceIn(0, 100) ?: 50
        var deleted = false
        var stableId: String? = null
        for (f in fields.drop(5)) {
            when {
                f.startsWith("d") -> deleted = (f.removePrefix("d").toIntOrNull() ?: 0) != 0
                f.startsWith("u") -> stableId = f.removePrefix("u")
            }
        }
        if (deleted) continue
        out += MixedFilamentEntry(
            id = stableId?.let { "fs_$it" } ?: "fs_${a}_${b}_${out.size}",
            componentA = a,
            componentB = b,
            biasPercent = mixB,
            enabled = enabled,
        )
    }
    return out
}

/**
 * Number of physical filament slots the active printer + profile
 * exposes. We resolve in this order:
 *   1. If the printer's name suggests a known toolchanger (e.g.
 *      Snapmaker U1), use the hardware count even when the slicer
 *      profile is single-extruder. Matches Snapmaker's Android-fork
 *      convention (`ExtruderPreset.kt::defaultExtruderPresets`
 *      hard-codes 0..3).
 *   2. Otherwise, fall back to the profile's `nozzle_diameter`
 *      array length — that's the desktop Plater's convention.
 */
private fun slotCountFor(printer: PrinterConfig?, profile: SlicerProfile): Int {
    if (printer != null) {
        val name = printer.name.lowercase()
        if ("u1" in name || "snapmaker" in name) return 4
    }
    return extruderCount(profile)
}

// Slot count widened by any persisted filament-entry list. Used by
// the call site so that whenever the user (or the test harness) has
// stored 4 entries for a printer, the slot palette stays at 4 even if
// the printer's name doesn't trip the U1 detection above. Callers that
// want the "default by hardware" answer should keep using slotCountFor.
private fun slotCountForWithSaved(
    printer: PrinterConfig?,
    profile: SlicerProfile,
    savedEntries: List<FilamentEntry>?,
): Int {
    val base = slotCountFor(printer, profile)
    val saved = savedEntries?.size ?: 0
    return maxOf(base, saved)
}

/**
 * Number of extruders / tool slots a profile defines. Read from the
 * comma-joined `nozzle_diameter` (4 entries on the U1, 1 on most
 * single-tool printers). Falls back to 1.
 */
private fun extruderCount(profile: SlicerProfile): Int {
    val nd = profile.config["nozzle_diameter"] ?: return 1
    return nd.split(',').count { it.isNotBlank() }.coerceAtLeast(1)
}

@Composable
private fun LayerHeightOverride(
    value: String,
    onChange: (String) -> Unit,
    profileDefault: String,
    enabled: Boolean,
) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            enabled = enabled,
            singleLine = true,
            label = { Text("Layer height override (mm)") },
            placeholder = { Text("profile default: $profileDefault") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        )
        Text(
            "Empty = use profile default. Range 0.05 – 0.50 mm.",
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

@Composable
private fun ProfilePicker(
    selected: SlicerProfile,
    onSelect: (SlicerProfile) -> Unit,
    enabled: Boolean,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Slicer profile", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (p in Profiles.all) {
                val isSelected = p.id == selected.id
                val containerColor = if (isSelected) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.surfaceVariant
                val contentColor = if (isSelected) MaterialTheme.colorScheme.onPrimary
                else MaterialTheme.colorScheme.onSurfaceVariant
                Button(
                    enabled = enabled,
                    onClick = { onSelect(p) },
                    shape = RoundedCornerShape(8.dp),
                    colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                        containerColor = containerColor,
                        contentColor = contentColor,
                    ),
                ) {
                    Column {
                        Text(p.displayName, style = MaterialTheme.typography.labelLarge)
                        Text(p.description, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}

@Composable
private fun LayerScrubber(
    parsed: ParsedToolpath,
    maxLayer: MutableState<Int?>,
) {
    val maxIdx = parsed.layerZs.lastIndex
    // null == show all == upper bound. Slider state is the inclusive
    // index (0..maxIdx).
    val current = maxLayer.value ?: maxIdx
    Column {
        Text(
            "Layer ${current + 1} / ${parsed.layerZs.size}  (Z = %.2f mm)".format(
                parsed.layerZs[current],
            ),
            style = MaterialTheme.typography.bodyMedium,
        )
        Slider(
            value = current.toFloat(),
            onValueChange = { v ->
                val newIdx = v.toInt().coerceIn(0, maxIdx)
                maxLayer.value = if (newIdx >= maxIdx) null else newIdx
            },
            valueRange = 0f..maxIdx.toFloat(),
            steps = (maxIdx - 1).coerceAtLeast(0),
        )
    }
}

@Composable
private fun SliceStateView(state: SliceUiState) {
    when (state) {
        SliceUiState.Idle -> Text(
            "Idle",
            style = MaterialTheme.typography.bodyMedium,
        )
        is SliceUiState.Slicing -> Column(
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                CircularProgressIndicator()
                val pctText = if (state.percent in 0..100) " (${state.percent}%)" else ""
                Text(
                    "Slicing ${state.sourceLabel}…$pctText",
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
            if (state.percent in 0..100) {
                LinearProgressIndicator(
                    progress = { state.percent / 100f },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (state.message.isNotBlank()) {
                Text(
                    state.message,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        is SliceUiState.Done -> when (val r = state.result) {
            is SliceResult.Success -> Column(
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "Sliced ${state.sourceLabel}",
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    "${r.sizeBytes / 1024} KB → ${r.outputPath}",
                    style = MaterialTheme.typography.bodyMedium,
                )
                state.parsed?.let {
                    ToolpathStatsView(it.stats)
                    ToolpathLegend(it)
                }
            }
            is SliceResult.NativeError -> Text(
                "Slicing ${state.sourceLabel} failed (${r.code}): ${r.message}",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ToolpathLegend(parsed: ParsedToolpath) {
    // Roles actually present in this toolpath, ordered by first
    // appearance — keeps the legend short. For a simple cube it shows
    // outer/inner wall + infill + top/bottom rather than the full
    // 20-role catalog. Skip Unknown — it doesn't tell the user
    // anything useful.
    val rolesInOrder: List<ExtrusionRole> = parsed.segments
        .asSequence()
        .map { it.role }
        .filter { it != ExtrusionRole.Unknown }
        .distinct()
        .toList()
    if (rolesInOrder.isEmpty()) return

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Toolpath colors", style = MaterialTheme.typography.titleSmall)
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            for (role in rolesInOrder) {
                val rgb = RoleColors.colorFor(role)
                Row(
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .height(12.dp)
                            .width(24.dp)
                            .background(Color(rgb.r, rgb.g, rgb.b, 1f)),
                    )
                    Text(role.tag, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun ToolpathStatsView(stats: GcodeStats) {
    val sizeMm = with(stats) {
        Triple(bboxMax.x - bboxMin.x, bboxMax.y - bboxMin.y, bboxMax.z - bboxMin.z)
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        // Print summary line (the bit users actually care about):
        // weight + estimated time, when libslic3r reports them.
        val summary = buildList {
            stats.filamentWeightG?.let { add("%.1f g filament".format(it)) }
            stats.estimatedPrintTime?.let { add(it) }
            stats.reportedLayerCount?.let { add("$it layers") }
        }.joinToString("  ·  ")
        if (summary.isNotEmpty()) {
            Text(summary, style = MaterialTheme.typography.titleSmall)
        }
        Text(
            "${stats.extrusionSegments} extrusion / " +
                "${stats.travelSegments} travel segments, " +
                "${stats.distinctZLayers} parsed layers",
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(
            "bbox %.1f × %.1f × %.1f mm  ·  extrusion length %.0f mm".format(
                sizeMm.first, sizeMm.second, sizeMm.third, stats.totalExtrusionLengthMm,
            ),
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

/** Copies the bundled cube_20mm.stl to cache and returns the local file. */
/**
 * Compares the loaded mesh's bbox against the build-plate dimensions
 * and returns a fit summary the project panel can render. Z is treated
 * as print height; we don't yet track per-printer Z height, so use a
 * generous 250 mm default — printers below that are rare in our
 * profile catalog.
 */
private fun computeBedFit(mesh: StlMesh, bedXmm: Float, bedYmm: Float, bedZmm: Float = 250f): BedFit {
    val sx = mesh.bboxMax.x - mesh.bboxMin.x
    val sy = mesh.bboxMax.y - mesh.bboxMin.y
    val sz = mesh.bboxMax.z - mesh.bboxMin.z
    val sizeText = "%.1f × %.1f × %.1f mm".format(sx, sy, sz)
    val overflows = buildList {
        if (sx > bedXmm) add("X by %.1f mm".format(sx - bedXmm))
        if (sy > bedYmm) add("Y by %.1f mm".format(sy - bedYmm))
        if (sz > bedZmm) add("Z by %.1f mm".format(sz - bedZmm))
    }
    return if (overflows.isEmpty()) {
        BedFit.Ok(sizeText)
    } else {
        BedFit.Warn(
            sizeText = sizeText,
            reason = "Overflows " + overflows.joinToString(", "),
        )
    }
}

/**
 * Copies the cached *.gcode out to /sdcard/Download/orcaxr-{stem}.gcode
 * so the user can grab it via Quick Share / USB / file manager. Filename
 * derives from the slice's source label, sanitized to alphanumerics +
 * underscores. Requires the MANAGE_EXTERNAL_STORAGE permission the file
 * picker already prompts for; returns null if writing fails (typical
 * cause: permission not granted yet).
 */
private fun saveGcodeToDownloads(ctx: Context, src: File, sourceLabel: String): File? {
    if (!src.exists()) return null
    val downloads = android.os.Environment.getExternalStoragePublicDirectory(
        android.os.Environment.DIRECTORY_DOWNLOADS,
    )
    if (!downloads.exists()) downloads.mkdirs()
    val stem = sourceLabel
        .substringBeforeLast('.', sourceLabel)
        .replace(Regex("[^A-Za-z0-9._-]"), "_")
        .ifBlank { "slice" }
    val dest = File(downloads, "orcaxr-$stem.gcode")
    return runCatching {
        src.inputStream().use { input ->
            dest.outputStream().use { input.copyTo(it) }
        }
        dest
    }.getOrNull()
}

/**
 * Build a clean output path under Downloads/ for a saved model. The
 * stem strips path separators and any prior extension; the supplied
 * [extension] (e.g. "stl", "3mf") is appended after a single dot.
 * Always overwrites an existing file with the same name.
 */
private fun downloadsPathFor(sourceLabel: String, extension: String): File {
    val downloads = android.os.Environment.getExternalStoragePublicDirectory(
        android.os.Environment.DIRECTORY_DOWNLOADS,
    )
    if (!downloads.exists()) downloads.mkdirs()
    val stem = sourceLabel
        .substringBeforeLast('.', sourceLabel)
        .replace(Regex("[^A-Za-z0-9._-]"), "_")
        .ifBlank { "model" }
    return File(downloads, "orcaxr-$stem.$extension")
}

/**
 * Write the currently-loaded model (after any rotate / scale
 * transforms) as a binary STL into Downloads/. Reads the original
 * input via [SlicerEngine.convertToStl] (handles 3MF/AMF/OBJ
 * sources transparently), reapplies the user's transforms via
 * [StlReader] + [StlWriter], and writes to disk. Returns null on
 * any failure.
 */
private suspend fun saveModelAsStlToDownloads(
    ctx: Context,
    sourceFile: File,
    sourceLabel: String,
    rotZDeg: Int,
    scalePct: Int,
    offsetXmm: Float = 0f,
    offsetYmm: Float = 0f,
): File? {
    if (!sourceFile.exists()) return null
    val baseStl = if (sourceFile.extension.equals("stl", ignoreCase = true)) {
        sourceFile
    } else {
        val derived = File(ctx.cacheDir, "${sourceFile.nameWithoutExtension}_for_save.stl")
        if (!SlicerEngine.convertToStl(sourceFile, derived)) return null
        derived
    }
    val dest = downloadsPathFor(sourceLabel, "stl")
    return runCatching {
        val mesh = StlReader.read(baseStl).let {
            if (rotZDeg == 0 && scalePct == 100 && offsetXmm == 0f && offsetYmm == 0f) it else applyTransforms(it, rotZDeg, scalePct, offsetXmm, offsetYmm)
        }
        StlWriter.write(mesh, dest)
        dest
    }.getOrNull()
}

/**
 * Wrap the model + active slicer config into a 3MF and drop it into
 * Downloads/. Re-opening the 3MF in OrcaXR (or desktop OrcaSlicer)
 * brings back the same slice settings. The 3MF source is the
 * caller-supplied [sourceFile] — the embedded mesh is whatever
 * libslic3r reads from it. We don't currently bake transforms into
 * the saved 3MF (would need a transformed-mesh write path); the
 * project file represents the ORIGINAL mesh and the user's chosen
 * settings.
 */
private suspend fun saveProjectAs3mfToDownloads(
    sourceFile: File,
    sourceLabel: String,
    config: Map<String, String>,
): File? {
    if (!sourceFile.exists()) return null
    val dest = downloadsPathFor(sourceLabel, "3mf")
    return if (SlicerEngine.saveAs3mf(sourceFile, dest, config)) dest else null
}

private fun copyBundledCube(ctx: Context): File =
    File(ctx.cacheDir, "cube_20mm.stl").also { dst ->
        ctx.assets.open("cube_20mm.stl").use { input ->
            dst.outputStream().use { input.copyTo(it) }
        }
    }

/** Slices an already-on-disk STL file and writes the G-code next to it. */
private suspend fun sliceLocalFile(
    stl: File,
    config: Map<String, String>,
    /**
     * FullSpectrum virtual-filament remap. Empty / null = no remap.
     * See SlicerEngine.slice for the semantics — this passes straight
     * through to the JNI face-state rewrite path. Empty arrays are
     * normalized to null for the JNI side. Placed before [onProgress]
     * so callers using the trailing-lambda syntax for progress
     * callbacks keep working without named arguments.
     */
    virtualRemap: IntArray? = null,
    /**
     * Phase J in-XR paint state. Per-triangle filament-slot byte
     * array sized to the source mesh's first volume's triangle count.
     * Null / all-zero = no paint authored; embedded 3MF facets pass
     * through. See SlicerEngine.slice for the full contract.
     */
    paintFilamentIndex: ByteArray? = null,
    /**
     * Phase XR_OBJ_4 — user-authored extra volumes (Add Part / Add
     * Modifier / etc.). Default empty preserves existing behavior.
     */
    extraVolumes: List<PlacedVolume> = emptyList(),
    /**
     * Phase XR_OBJ_8 — per-triangle support paint state (1=ENFORCER,
     * 2=BLOCKER, 0=unpainted). Null / all-zero = no support paint;
     * embedded 3MF supported_facets pass through.
     */
    supportFlags: ByteArray? = null,
    /**
     * Phase XR_OBJ_8 — per-triangle seam paint state. Same encoding
     * as [supportFlags] but flows into `mv->seam_facets`.
     */
    seamFlags: ByteArray? = null,
    /**
     * Phase XR_OBJ_4 (final) — per-object config overrides applied to
     * `mo->config()` after load. Default empty preserves existing
     * behavior.
     */
    objectConfigOverrides: Map<String, String> = emptyMap(),
    onProgress: ((percent: Int, message: String) -> Unit)? = null,
): SliceResult {
    val gcode = File(stl.parentFile, "${stl.name}.gcode")
    val effectiveRemap = if (virtualRemap == null || virtualRemap.all { it == 0 }) null else virtualRemap
    val effectivePaint = if (paintFilamentIndex == null || !hasAnyPaint(paintFilamentIndex)) null else paintFilamentIndex
    val effectiveSupport = if (supportFlags == null || !hasAnyPaint(supportFlags)) null else supportFlags
    val effectiveSeam = if (seamFlags == null || !hasAnyPaint(seamFlags)) null else seamFlags
    return SlicerEngine.slice(
        stl, gcode, config, effectiveRemap, effectivePaint, extraVolumes,
        effectiveSupport, effectiveSeam, objectConfigOverrides, onProgress,
    )
}

/** Copies a picker URI into the app cache. Returns null on read failure. */
/**
 * One-time toast on app launch when CrashReporter found crash JSON
 * files from prior runs. Doesn't block the UI; the JSON files stay
 * on disk under `${filesDir}/crashes/` until the user dismisses, at
 * which point they're all deleted. A richer in-XR review surface
 * (scrollable dialog, per-crash inspect, "Save to Downloads") is
 * deferred — for now logcat + the on-disk JSON are enough for the
 * developer-style debugging the project's at.
 */
@Composable
private fun PastCrashBanner(files: List<File>, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    LaunchedEffect(files) {
        val msg = "OrcaXR crashed last session — ${files.size} crash file" +
            (if (files.size == 1) "" else "s") +
            " in ${files.firstOrNull()?.parentFile?.absolutePath ?: ""}"
        android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_LONG).show()
        android.util.Log.w("OrcaXR/crash", msg)
        files.take(3).forEach { f ->
            android.util.Log.w("OrcaXR/crash", "  ${f.name} (${f.length() / 1024} KB)")
        }
        // Auto-dismiss after surfacing — the toast is the
        // notification, the JSON files are the persistent record.
        // User can retrieve via `adb pull` if they want details.
        onDismiss()
    }
}

private fun copyUriToCache(ctx: Context, uri: Uri): File? {
    val name = uri.lastPathSegment?.substringAfterLast('/') ?: "input.stl"
    val safeName = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
    val dst = File(ctx.cacheDir, safeName)
    val input = ctx.contentResolver.openInputStream(uri) ?: return null
    input.use { dst.outputStream().use { out -> it.copyTo(out) } }
    return dst
}
