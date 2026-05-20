package dev.orcaxr.app

import android.content.Context
import android.content.Intent
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.xr.compose.material3.EnableXrComponentOverrides
import androidx.xr.compose.material3.ExperimentalMaterial3XrApi
import androidx.xr.compose.material3.XrComponentOverride
import androidx.xr.compose.material3.XrComponentOverrideEnabler
import androidx.xr.compose.material3.XrComponentOverrideEnablerContext
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

import androidx.xr.runtime.Session
import androidx.xr.runtime.SessionCreateSuccess

import androidx.xr.scenecore.Entity
import androidx.xr.scenecore.GltfModel
import androidx.xr.scenecore.GltfModelEntity
import androidx.xr.scenecore.scene
import java.io.File
import java.util.zip.ZipFile

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

// OrcaXR's dark color scheme + typography moved to dev.orcaxr.app.ui.OrcaXrTheme.
// The previous inline `darkColorScheme(...)` block here was replaced when the
// "OrcaXR Spatial UI" design palette (mint-on-dark-navy + Instrument Sans /
// Space Grotesk / JetBrains Mono via downloadable Google Fonts) shipped.

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
            val group = Entity.create(session, "panel-$id")
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
    /** Phase E3 — persistent virtual build plates. */
    private lateinit var plateStore: PlateStore

    /** A11 — persistent custom-gcode-per-print-Z ticks per plate. */
    private lateinit var customGcodeStore: CustomGcodeStore

    /**
     * Activity-scoped controller event sink. Galaxy XR controller plan
     * (docs/GALAXY_XR_CONTROLLER_PLAN.md). Lives as long as the Activity;
     * read inside `setContent` via [LocalControllerInput]. Reset in
     * [onPause] so a stick stuck deflected when the user removes the
     * headset doesn't keep scrubbing on resume.
     */
    private val controllerInput = ControllerInputBus()

    /**
     * Roadmap B14 — share-target file ingestion.
     *
     * `onCreate` and `onNewIntent` extract URIs from the launching
     * Intent (ACTION_VIEW / ACTION_SEND / ACTION_SEND_MULTIPLE),
     * stage each one to cacheDir/shared/ via [SharedIntentHandler],
     * and emit the resulting File on this flow. The `setContent`
     * body collects from this flow and routes each File through the
     * same `onFileSelected` codepath the in-app picker uses — paint
     * restore + GLB bake + bedFit + recents bump fire identically.
     *
     * `extraBufferCapacity = 8` is enough headroom for an
     * ACTION_SEND_MULTIPLE that happens to hand us 8 sibling files at
     * once (rare in practice; MakerWorld's "share" tops out at 1).
     */
    private val pendingSharedFiles =
        kotlinx.coroutines.flow.MutableSharedFlow<java.io.File>(
            replay = 0,
            extraBufferCapacity = 8,
            onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
        )

    /**
     * Activity-scoped scope used by the share-intent ingestion path
     * — the file copy off `content://` URIs is IO-bound and must not
     * block the main thread inside onCreate / onNewIntent. Cancelled
     * automatically when the Activity is destroyed.
     */
    private val activityIoScope =
        kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.Dispatchers.IO + kotlinx.coroutines.SupervisorJob()
        )

    @OptIn(ExperimentalMaterial3XrApi::class)
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
        plateStore = PlateStore(this)
        customGcodeStore = CustomGcodeStore(this)
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

        // Phone / tablet fallback — if the device isn't XR-capable
        // (Session.create failed or returned null) AND we don't have
        // a runtime override forcing the XR shell, hand off to the
        // dedicated MobileActivity. The mobile shell ships the full
        // Material 3 phone/tablet experience (nav rail / bottom nav,
        // 9 destinations) while reusing the same stores + MoonrakerClient
        // + libslic3r + AiRenderEngine that the XR shell uses.
        //
        // We forward via an explicit Intent so any VIEW/SEND data
        // (file shares) ride along — MobileActivity drains the URI
        // list into its `pendingSharedUris` Flow on receipt.
        if (xrSession.value == null && !intent.getBooleanExtra(EXTRA_FORCE_FLAT_SHELL, false)) {
            val forward = Intent(this, MobileActivity::class.java).apply {
                if (intent.action != null) action = intent.action
                if (intent.data != null) data = intent.data
                if (intent.type != null) type = intent.type
                if (intent.extras != null) putExtras(intent.extras!!)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            }
            startActivity(forward)
            finish()
            return
        }

        // Roadmap B14 — if the Activity launched from a VIEW / SEND
        // intent (a share-to-OrcaXR), drain the URI list now so the
        // first thing the user sees is "your model is loading" not
        // an empty bed. The collector inside setContent picks up the
        // emitted Files and routes them through onFileSelected.
        ingestSharedIntent(intent)

        setContent {
            val session by xrSession.collectAsState()
            // OrcaXrTheme provides the mint-on-dark-navy palette, the
            // SpaceGrotesk / InstrumentSans / JetBrainsMono typography,
            // and re-asserts LocalContentColor (GEMINI gotcha #4 — a
            // missing provider lets a SpatialPanel content surface paint
            // with Color.Unspecified).
            dev.orcaxr.app.ui.OrcaXrTheme {
                CompositionLocalProvider(
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
                    // Roadmap A14 — toolpath color mode (auto / extruder /
                    // feature). Persisted in SharedPreferences alongside
                    // the tubes toggle; the bake LE keys on this so a
                    // mode flip triggers a one-shot re-bake.
                    val toolpathColorMode = remember { mutableStateOf(prefs.toolpathColorMode) }
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
                    LaunchedEffect(toolpathColorMode.value) {
                        prefs.toolpathColorMode = toolpathColorMode.value
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
                        // Spatialize ONLY Material3 AlertDialog in the
                        // XR shell. Without an EnableXrComponentOverrides
                        // ancestor, AlertDialogs (Smart Paint, Gamut
                        // Match, Save Profile, Rename Plate) render into
                        // the flat 2D activity window and are invisible
                        // in full-space XR. Scoped to BasicAlertDialog
                        // so the hand-rolled spatial nav/toolbars stay
                        // untouched; degrades to a normal Dialog in 2D.
                        EnableXrComponentOverrides(
                            object : XrComponentOverrideEnabler {
                                @Composable
                                override fun XrComponentOverrideEnablerContext.shouldOverrideComponent(
                                    component: XrComponentOverride,
                                ): Boolean = component == XrComponentOverride.BasicAlertDialog
                            }
                        ) {
                        XrShell(s, sliceState, maxLayer, selectedProfile, layerHeightOverride,
                            printSettingsOverrides = printSettingsOverrides,
                            showTravels = showTravels,
                            toolpathTubes = toolpathTubes,
                            toolpathColorMode = toolpathColorMode,
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
                            recentFiles = recentFiles,
                            plateStore = plateStore,
                            customGcodeStore = customGcodeStore,
                            pendingSharedFiles = pendingSharedFiles)
                        }
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

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        // launchMode="singleTask" routes a second VIEW / SEND through
        // here instead of spawning a fresh MainActivity instance — see
        // AndroidManifest.xml. We update setIntent so getIntent()
        // reflects the latest payload (some Android-internal callsites
        // assume that), then drain.
        setIntent(intent)
        ingestSharedIntent(intent)
    }

    override fun onDestroy() {
        activityIoScope.cancel()
        super.onDestroy()
    }

    /**
     * Roadmap B14 — turn an inbound share/view Intent into staged
     * `cacheDir/shared/` files and emit them on [pendingSharedFiles].
     * Pure dispatch on the main thread; the actual byte copy runs on
     * [activityIoScope]'s IO dispatcher because content:// URIs are
     * file-system-backed and the MIME query alone touches a Cursor.
     *
     * Idempotent: an Intent we don't recognize (e.g. Android's MAIN +
     * LAUNCHER on cold start) returns an empty URI list and this is
     * a no-op. That's why it's safe to call from both onCreate and
     * onNewIntent — the cold-start cost on a normal launch is one
     * `intent.action` read.
     */
    private fun ingestSharedIntent(intent: android.content.Intent?) {
        if (intent == null) return
        val action = intent.action ?: return
        if (action != android.content.Intent.ACTION_VIEW &&
            action != android.content.Intent.ACTION_SEND &&
            action != android.content.Intent.ACTION_SEND_MULTIPLE
        ) return
        // Mark the Intent as consumed so a configuration change (e.g.
        // headset orientation flip) doesn't re-ingest the same URI.
        intent.action = android.content.Intent.ACTION_MAIN
        activityIoScope.launch {
            val files = SharedIntentHandler.resolveAllBounded(this@MainActivity, intent)
            files.forEach { f ->
                pendingSharedFiles.tryEmit(f)
            }
        }
    }

    companion object {
        /** Set to `true` on the launching Intent to keep MainActivity
         *  alive even when no XR session is available — used by the
         *  in-app debug menu to verify the FlatShell still works on
         *  Android XR devices. The phone / tablet fallback otherwise
         *  routes the user to [MobileActivity]. */
        const val EXTRA_FORCE_FLAT_SHELL = "dev.orcaxr.app.FORCE_FLAT_SHELL"
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
    /** Roadmap A14 — toolpath color mode picker. One of `auto`
     *  (per-extruder when multi-tool, per-role otherwise), `extruder`,
     *  `feature`. Persisted via [UserPreferences.toolpathColorMode]. */
    toolpathColorMode: MutableState<String>,
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
    /** Phase E3 — persistent virtual build plates. */
    plateStore: PlateStore,
    /** A11 — persistent custom-gcode-per-print-Z ticks per plate. */
    customGcodeStore: CustomGcodeStore,
    /** Roadmap B14 — Activity-side share-target ingestion flow.
     *  XrShell collects from this and routes each File through the
     *  same `onFileSelected` codepath the in-app picker uses. */
    pendingSharedFiles: kotlinx.coroutines.flow.SharedFlow<java.io.File> =
        kotlinx.coroutines.flow.MutableSharedFlow(),
) {
    val ctx = LocalContext.current

    // Phase E3 — virtual build plates from DataStore. Default to plate 1
    // being active.
    val allPlates by plateStore.plates.collectAsState(initial = listOf(PlateMetadata(1, "Plate 1")))
    var activePlateId by remember { mutableIntStateOf(1) }

    // A11 — custom G-code ticks per plate, hydrated from the
    // CustomGcodeStore. The map is keyed by plate id (1-based);
    // missing keys mean "no ticks on that plate". Persistence happens
    // on every mutation via the WorkspaceAction handlers below.
    val customGcodeTicksByPlate by customGcodeStore.ticksByPlate
        .collectAsState(initial = emptyMap())

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
    // Trace brush state changes so we can correlate "I toggled paint
    // on" / "I picked slot 2" with downstream InputEvent flow on a
    // headset where there's no DevTools console to dump state to.
    LaunchedEffect(paintBrush) {
        android.util.Log.i(
            "OrcaXR/paint",
            "PaintBrush change: mode=${paintBrush.mode} slot=${paintBrush.activeSlot} " +
                "radiusMm=${paintBrush.radiusMm} smartFill=${paintBrush.smartFill} " +
                "smartFillAngleDeg=${paintBrush.smartFillAngleDeg}",
        )
    }
    // Per-`PlacedModel` BVH cache. Built lazily when paint mode goes
    // active for a model that doesn't yet have one. Survives
    // rotation / scale because StlMesh transforms preserve triangle
    // order — only the source-mesh swap (replacing
    // `PlacedModel.source`) needs an explicit invalidate.
    //
    // `bvhCacheVersion` is bumped after every successful put so that
    // `paintHooksFor(m)` (which is read by the GlbSceneEntity
    // composables and returns null while the BVH is missing)
    // recomposes when a build finishes. Without this counter the
    // map mutation is invisible to Compose, paint mode stays armed
    // but `paintHooks=null`, and the user's pinches keep routing to
    // the selection branch even after the BVH is cached. Bug
    // (2026-05-02): `BVH built` log fired and the IC stayed in
    // route=select for ~1.5 minutes until the user toggled the
    // brush slot, which was the only thing that triggered a
    // recomposition.
    val bvhCache = remember { MeshBvhCache() }
    var bvhCacheVersion by remember { mutableIntStateOf(0) }
    // Last triangle the active stroke stamped on, per-model. Mutable
    // IntArray of size 1 so the onPaint lambda can read/write
    // without triggering recomposition (a `MutableState<Int>` would).
    // Reset to -1 on DOWN; suppresses redundant `stampTriangles` +
    // `placedModels.map` allocations when the user holds still on
    // the same triangle for many MOVE events. Without this guard, a
    // 1.37M-tri mesh hits OOM after ~1 minute of held pinch
    // (each MOVE clones a 1.37 MB ByteArray + a 1.37 MB BooleanArray
    // from radiusBfs, at ~60 Hz). See bug log 2026-05-02 13:42:44.
    val lastStampedTri = remember { intArrayOf(-1) }
    // Last wall-clock time (uptimeMillis) we ran a Color/support/seam
    // stamp. Used to cap the stamp rate at ~30 Hz during MOVE drags
    // so a 1.4M-tri mesh doesn't OOM the JVM. Each stamp clones
    // model.paintFilamentIndex (1.4 MB) and a radiusBfs visited
    // BooleanArray (1.4 MB), and the user's MOVE events arrive at
    // ~60 Hz; without a time cap, even with the same-tri guard,
    // dragging across many triangles allocates ~170 MB/s and
    // exhausts the 512 MB heap in seconds. A 33 ms minimum gap is
    // imperceptible visually but halves the allocation rate.
    val lastStampMs = remember { longArrayOf(0L) }
    // Bumped on every successful in-place stamp so the debounced
    // GLB-rebake LaunchedEffect (`Phase J §G`) can re-key on this
    // counter instead of on `placedModels.map { it.paintFilamentIndex }`.
    // After moving paint to in-place mutation (2026-05-02), the
    // ByteArray reference no longer changes between MOVE events —
    // the rebake LE would never fire if it kept its old key.
    var paintContentVersion by remember { mutableIntStateOf(0) }
    // Paint full-feature-parity (Undo/Redo) — per-model history of
    // paint mutations. In-session only (PaintCacheStore is the on-
    // disk current-state cache; this is the volatile undo log).
    val paintHistory = remember { PaintHistory() }
    // Bumped when undo/redo state changes, since PaintHistory is a
    // mutable object whose changes Compose can't otherwise observe.
    var paintHistoryVersion by remember { mutableIntStateOf(0) }

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
        // Variable-length project palette. A model can use MORE colors
        // than the printer has physical slots (the gamut-match feature's
        // whole reason to exist). The list is keyed by slotIndex (=
        // model-palette position, set at 3MF import for every color),
        // so it must span up to the highest saved slot, not just
        // slotCount. For a ≤slotCount model maxSlot == slotCount and
        // this is byte-for-byte the old behavior — zero regression on
        // the common path. Painted-face index k resolves to the k-th
        // entry here; paddedSlots / paddedSlotRemap / paddedVirtualRemap
        // / computeFilamentMap all derive their length from this list,
        // so widening it widens the whole slice config in lockstep.
        val maxSlot = maxOf(slotCount, bySlot.keys.maxOrNull()?.plus(1) ?: 0)
        (0 until maxSlot).map { slot ->
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
    // `selectedModelIds.firstOrNull()` picks which model the rotate/scale/grab tools
    // operate on; backward-compat derived values (loadedStl,
    // modelRotZDeg, etc.) read off the selected model so most consumers
    // didn't have to change.
    var placedModels by remember { mutableStateOf<List<PlacedModel>>(emptyList()) }
    var selectedModelIds by remember { mutableStateOf<Set<String>>(emptySet()) }
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
    // Bake-in-flight gate (gotcha #13/#22). The 3MF load fires two
    // bakes — the first publishes the v1 entity, the embedded-color
    // sync inside it propagates to previewPalette, and the palette
    // LE schedules a second bake whose v1→v2 swap can race against
    // workspace MovableComponent setPose calls coming from an active
    // user drag (the v1 GltfModelEntity's Filament material is queued
    // for deferred dispose, but the render thread may have a setPose
    // referencing material instance N that the swap freed → SIGABRT
    // "unknown material instance id"). We track in-flight bakes by
    // model id and silently drop workspace pose updates while any
    // bake is mid-swap. Drag stays attached (removing the component
    // mid-drag would itself trip #13); only the per-frame setPose
    // is suppressed. The user sees the workspace freeze for the
    // ~200-500ms swap window, then drag resumes.
    var bakeInFlight by remember { mutableStateOf(setOf<String>()) }
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
    // Result of the Bambu Studio 3MF translation pass — empty
    // (`wasBambu=false`, no banner) for non-Bambu 3MFs and for STL/OBJ
    // loads. Drives the import info banner + filament-profile
    // suggestion overlay. The .translatedOverrides is what gets
    // assigned into `loadedProjectOverrides` so the slice path sees
    // the filtered map; we keep the full Result around so the banner
    // can surface what was dropped.
    var bambuImport by remember {
        mutableStateOf<dev.orcaxr.app.bambu.BambuImportTranslator.Result?>(null)
    }
    // Audit H12 (2026-05-07) — the 3MF's authored layer_height. NOT
    // applied to the slice (layer-height keys are deliberately
    // excluded from PROJECT_OVERRIDE_KEYS so the user's profile pick
    // + textfield always wins). Surfaced as an info chip in the
    // Quality tab so the user knows what the 3MF wanted; one tap to
    // apply if they actually want it. Null for STL/OBJ loads, 3MFs
    // without an authored layer_height, or unparseable values.
    var loadedLayerHeightHintMm by remember { mutableStateOf<Float?>(null) }
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

    // Phase E3 — Plate-filtered models. Only models on the active plate
    // are rendered and reachable in the UI.
    val placedModelsOnActivePlate = remember(placedModels, activePlateId) {
        placedModels.filter { it.plateId == activePlateId }
    }

    val selectedModel: PlacedModel? =
        placedModels.filter { it.plateId == activePlateId }.firstOrNull { it.id == selectedModelIds.firstOrNull() }
            ?: placedModels.filter { it.plateId == activePlateId }.firstOrNull()
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
        val id = selectedModelIds.firstOrNull() ?: return
        placedModels = placedModels.map { if (it.id == id) transform(it) else it }
    }
    
    // Track world translation of the workspace.
    var workspaceTx by remember { mutableStateOf(androidx.xr.runtime.math.Vector3(0f, WORKSPACE_Y_OFFSET, 0.0f)) }
    var isWorkspaceGrabbing by remember { mutableStateOf(false) }
    // Plate-move mode. When true a MovableComponent on the workspace
    // entity makes any pinch over the bed footprint drag the build
    // plate; when false the component is removed so model gizmos and
    // selection get pinches unobstructed. Default OFF so models can be
    // manipulated freely on first launch.
    var plateMovable by remember { mutableStateOf(false) }

    // Live transform override applied while a gizmo is being dragged. Keys
    // are the model IDs the override applies to (one for single-select, all
    // selected ids for multi-select). The renderer (GlbSceneEntity) reads
    // the override for its model and applies it as setPose+setScale on the
    // existing GltfModelEntity so the user sees a continuous preview while
    // dragging — without this, every MOVE event triggered a full GLB re-bake
    // and the model flickered/disappeared until the bake finished.
    var liveDragOverride by remember {
        mutableStateOf<Pair<Set<String>, GizmoDragOverride>?>(null)
    }

    // Active transform tool (Move / Rotate / Scale) selected from the
    // top nav. Default Move so loading a model and grabbing it Just
    // Works without a tool tap. Tapping the active tool's button cycles
    // back to Select (no gizmo) — handy when the user wants the gizmo
    // out of the way to inspect the model.
    var gizmoTool by remember { mutableStateOf(GizmoTool.Move) }
    
    var devicesShown by remember { mutableStateOf(false) }
    // Pre-print options sheet shown between tapping Send & Print and
    // the actual upload+start. Null = sheet hidden. Non-null carries
    // the printer + sliced output file the user is sending to so the
    // confirm path doesn't have to re-derive them.
    var sendOptionsRequest by remember { mutableStateOf<SendOptionsRequest?>(null) }
    // Cached "is moonraker-timelapse installed on this printer" probe.
    // Keyed by printer id so switching printers doesn't carry a stale
    // verdict. Populated lazily when the user opens the options sheet
    // for a given printer.
    var timelapseSupportedByPrinter by remember { mutableStateOf<Map<String, Boolean>>(emptyMap()) }
    // App-wide preferences SpatialPanel (in-app LLM assistant + future
    // cards). Distinct from Devices, which is for printer connections
    // and the MCP server toggle. Toggled from the Settings icon on the
    // TopNavigationPill.
    var settingsShown by remember { mutableStateOf(false) }
    // Roadmap B5 — Galaxy XR controller help card visibility. Toggled
    // via the TopNavigationPill's Help icon; renders as a side
    // SpatialPanel showing every binding the input pump consumes.
    var helpShown by remember { mutableStateOf(false) }
    // Roadmap D12 — AddPrimitivePanel SpatialPanel visibility. Toggled
    // from the top nav; UI mirror of the add_primitive MCP tool so
    // dropping a stock cube/cylinder/sphere/etc. doesn't require an
    // LLM round-trip.
    var addPrimitiveShown by remember { mutableStateOf(false) }
    // Roadmap A11 — CustomGcodePanel SpatialPanel visibility. Toggled
    // from the top nav; UI mirror of the add_custom_gcode_tick MCP
    // surface so authoring a pause-at-Z (the magnet-insert workflow)
    // doesn't require an LLM round-trip.
    var customGcodeShown by remember { mutableStateOf(false) }
    // Roadmap A10 — toggle for the Adaptive Layer Height SpatialPanel.
    // Mirrors the customGcodeShown pattern; mounted from the top nav.
    var adaptiveLayerShown by remember { mutableStateOf(false) }
    // Roadmap D17 — toggle for the Mesh Simplify SpatialPanel.
    var simplifyShown by remember { mutableStateOf(false) }
    // Roadmap C8 — voice command panel toggle. Mounting this kicks
    // off the SpeechRecognizer permission flow on first open.
    var voiceShown by remember { mutableStateOf(false) }
    // Optional in-app LLM assistant. Toggled from the AI assistant
    // card in Settings once a provider key is set; renders the chat
    // SpatialPanel on the right side of the workspace.
    var assistantShown by remember { mutableStateOf(false) }
    // Roadmap D4 — emboss panel target. When non-null, the EmbossPanel
    // SpatialPanel is rendered next to the project list and operates on
    // the named PlacedModel. Set by the per-row Emboss icon; cleared on
    // panel dismiss or successful Apply.
    var embossTargetModelId by remember { mutableStateOf<String?>(null) }
    var magnetTargetModelId by remember { mutableStateOf<String?>(null) }
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

    // C6 — moved further down (post-runSliceMulti) so the Tier-B
    // callbacks can close over the slice / save / arrange functions.
    // See `dev.orcaxr.app.mcp.BindWorkspaceModel(...)` near the bottom
    // of XrShell, after all local fun declarations.

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
    // Per-printer webcam session, lazily constructed and cached so
    // discovery + the U1 wake keepalive only fire once per printer.
    // The session is reused across polling iterations.
    val webcamSessions = remember { mutableMapOf<String, WebcamSession>() }
    val webcamScope = rememberCoroutineScope()
    LaunchedEffect(printers) {
        if (printers.isEmpty()) return@LaunchedEffect
        // Drop sessions for printers that were removed since last
        // tick so their wake jobs don't outlive the printer config.
        val liveIds = printers.map { it.id }.toSet()
        val stale = webcamSessions.keys - liveIds
        stale.forEach { id -> webcamSessions.remove(id)?.stopWakePulse() }
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
                    // for this printer — repeated 404 disables future
                    // fetches (the discovery+fallback list inside
                    // WebcamSession only surfaces NotFound after every
                    // candidate has failed, so a true "no webcam" host
                    // settles quickly).
                    val supported = webcamSupported[p.id]
                    if (r.value.isActive && supported != false) {
                        val session = webcamSessions.getOrPut(p.id) {
                            client.webcamSession().also { it.startWakePulse(webcamScope) }
                        }
                        when (val w = session.fetchFrame()) {
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
                                session.stopWakePulse()
                                webcamSessions.remove(p.id)
                            }
                            else -> { /* transient — leave supported unchanged */ }
                        }
                    } else if (!r.value.isActive) {
                        // Print finished — release the wake job; we'll
                        // rebuild the session next time the printer
                        // goes active.
                        webcamSessions.remove(p.id)?.stopWakePulse()
                    }
                }
                // Quiet on errors — the connection probe lives on the
                // Test button, polling stays out of the way if a
                // printer is offline mid-session.
            }
            kotlinx.coroutines.delay(if (anyActive) 1_000 else 15_000)
        }
    }
    DisposableEffect(Unit) {
        onDispose {
            webcamSessions.values.forEach { it.stopWakePulse() }
            webcamSessions.clear()
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
        if (file.extension.equals("stl", ignoreCase = true)) {
            // Probe-read with the binary-only Kotlin parser. If it
            // succeeds, the source is already binary STL and we can
            // hand it back unchanged (saves a libslic3r round-trip
            // on the common case). If it fails — e.g. the bundled
            // cube_20mm.stl ASCII test asset — fall through to the
            // libslic3r conversion below, which always emits binary
            // STL. Without this guard, ASCII-STL inputs hit
            // `StlReader threw: STL triangle count looks corrupt`
            // in every consumer (previewStl, BVH builder, paint
            // BVH).
            if (runCatching { StlReader.read(file) }.isSuccess) return file
        }
        val derived = File(ctx.cacheDir, "${file.nameWithoutExtension}_derived.stl")
        val ok = runCatching { SlicerEngine.convertToStl(file, derived) }.getOrDefault(false)
        return if (ok && derived.exists() && derived.length() > 0) derived else null
    }

    fun getExtractedStl(groupId: String, index: Int): File {
        val dir = File(ctx.cacheDir, "extracted/$groupId").also { it.mkdirs() }
        return File(dir, "part_$index.stl")
    }

    /** Delete prior stl_preview*.glb files belonging to [modelId] so
     *  each preview rebuild for a single model doesn't leave a 20 MB
     *  ghost behind. Files for other models are left alone — that's
     *  the multi-model invariant. Pass an empty modelId to sweep
     *  legacy single-model preview files (`stl_preview_v*.glb`). */
    fun sweepOldPreviews(keep: File, modelId: String) {
        runCatching {
            val perModelPrefix = "stl_preview_${modelId}_v"
            // Parse a version number out of "stl_preview_<id>_v<N>.glb".
            // Files we can't parse are treated as "unknown version" and
            // only deleted when keep is empty (model-removal sweep).
            fun versionOf(name: String): Int? {
                if (!name.startsWith(perModelPrefix)) return null
                val tail = name.substringAfter(perModelPrefix)
                val numStr = tail.substringBefore('.')
                return numStr.toIntOrNull()
            }
            val keepName = keep.name
            val keepVersion = versionOf(keepName)
            val explicitDeleteAll = keep.absolutePath.isEmpty() || keepName.isEmpty()
            ctx.cacheDir.listFiles { f ->
                if (!f.name.endsWith(".glb")) return@listFiles false
                if (f.absolutePath == keep.absolutePath) return@listFiles false
                if (f.name.startsWith("stl_preview_v")) {
                    // Legacy single-model filenames — always sweep.
                    return@listFiles true
                }
                if (!f.name.startsWith(perModelPrefix)) return@listFiles false
                if (explicitDeleteAll) return@listFiles true
                val v = versionOf(f.name) ?: return@listFiles false
                // Only delete strictly OLDER versions. A concurrent
                // previewStl can have an in-flight bake at version > keep
                // (its writeColoredGlb just opened the file for write but
                // hasn't published the path yet); deleting that file
                // unlinks the directory entry while the JNI keeps writing
                // to the open FD, so the bytes vanish at FD close —
                // exactly the cause of the v2.glb ENOENT race that left
                // the model invisible after a 3MF load.
                keepVersion != null && v < keepVersion
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
        // Mark this bake in-flight before any native work begins so
        // the workspace move listener sees the gate the moment we
        // start producing the v1→v2 swap. Cleared in the finally
        // below regardless of bake outcome.
        bakeInFlight = bakeInFlight + modelId
        try {
        
        // Phase B9/J: For extracted 3MF objects, re-load from the
        // original container to pull per-triangle paint colors.
        val bakeSource = initial.originalSource ?: stlFile
        val bakeIndex = if (initial.originalSource != null) initial.groupOrdinal else -1

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
        val ext = bakeSource.extension.lowercase()

        // 3MF / AMF: bypass the STL roundtrip entirely. The native
        // colored-GLB writer reads per-face MMU segmentation directly
        // from the source and emits a per-vertex-colored GLB using
        // the user's filament-slot palette. STL doesn't carry color
        // info, so .stl inputs continue to use the legacy path below.
        if (ext == "3mf" || ext == "amf") {
            // gotcha #13: set by the embedded-colour sync below so the
            // FIRST bake of a freshly-loaded 3MF uses the resolved
            // synced palette instead of the not-yet-recomposed
            // previewPalette. Without this v1 bakes with the stale
            // palette and the echo recomposition bakes a DIFFERENT v2,
            // producing a v1→v2 heavy-GLB swap whose SceneCore
            // attach/detach churn trips the Impress material-instance
            // SIGABRT. With it, v1 == v2 byte-for-byte so the
            // GlbSceneEntity byte-identical guard collapses them to a
            // single stable attach.
            var syncedFirstBakePalette: List<String>? = null
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
                    val serialized = SlicerEngine.read3mfMixedFilamentDefinitions(bakeSource)
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
                    loadedFlushSettings = SlicerEngine.read3mfFlushSettings(bakeSource)
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
                    val rawOverrides = SlicerEngine.read3mfProjectOverrides(bakeSource)
                    val fp = SlicerEngine.read3mfBambuFingerprint(bakeSource)
                    val result = dev.orcaxr.app.bambu.BambuImportTranslator.translate(
                        rawOverrides = rawOverrides,
                        fingerprint = fp,
                        slotCount = slotCount,
                    )
                    loadedProjectOverrides = result.translatedOverrides
                    bambuImport = if (result.wasBambu) result else null
                    if (result.wasBambu) {
                        android.util.Log.i(
                            tag,
                            "Bambu 3mf detected (printer_model='${fp.printerModel}', settings_id='${fp.printerSettingsId}'): " +
                                "dropped ${result.droppedKeys.size} filament-tuning key(s) ${result.droppedKeys}, " +
                                "suggesting filament profiles ${result.filamentProfileSuggestion}",
                        )
                    } else if (loadedProjectOverrides.isNotEmpty()) {
                        android.util.Log.i(
                            tag,
                            "loaded ${loadedProjectOverrides.size} project overrides from 3mf: ${loadedProjectOverrides.keys}",
                        )
                    }
                }.onFailure {
                    android.util.Log.w(tag, "3mf project-overrides read failed: ${it.message}")
                    loadedProjectOverrides = emptyMap()
                    bambuImport = null
                }
                // Audit H12 — capture authored layer_height as an
                // informational hint (NOT applied to the slice).
                runCatching {
                    loadedLayerHeightHintMm = SlicerEngine.read3mfLayerHeight(bakeSource)
                    val h = loadedLayerHeightHintMm
                    if (h != null) {
                        android.util.Log.i(tag, "loaded layer-height hint from 3mf: $h mm (not applied; profile pick wins)")
                    }
                }.onFailure {
                    android.util.Log.w(tag, "3mf layer-height-hint read failed: ${it.message}")
                    loadedLayerHeightHintMm = null
                }
            } else {
                loadedFlushSettings = null
                loadedProjectOverrides = emptyMap()
                loadedLayerHeightHintMm = null
                bambuImport = null
            }

            // Sync the project filament list with the 3MF's embedded
            // palette on first load of a given file path. Side-effect
            // only (the preview palette below reads from filamentList /
            // the resolver, not from the freshly-synced colors), so
            // we don't capture a return value — the entries store
            // update propagates back through Compose to the panel's
            // left-side authored swatches on the next recomposition.
            if (ext == "3mf" && lastEmbeddedSyncPath != bakeSource.absolutePath) {
                runCatching {
                    val embedded = SlicerEngine.read3mfFilamentColours(bakeSource)
                    val printerId = activePrinter?.id
                    if (printerId != null && embedded.isNotEmpty() && slotCount > 0) {
                        // Preserve EVERY embedded model color, not just
                        // the first slotCount. A 6-color model on a
                        // 4-slot printer must surface all 6 as project
                        // filaments so the gamut matcher (and manual
                        // mapping) can route colors 5+ to a physical
                        // slot or a FullSpectrum blend. slotIndex = i
                        // for all i (model-palette position); indices
                        // ≥ slotCount have no identity physical slot but
                        // are still addressable by painted-face index
                        // and the resolver/slice config.
                        val updated = (0 until maxOf(embedded.size, slotCount)).map { i ->
                            val embeddedColor = embedded.getOrNull(i)
                            val existing = filamentList.getOrNull(i)
                            FilamentEntry(
                                id = existing?.id ?: "slot_$i",
                                color = embeddedColor ?: (existing?.color ?: "#FFFFFF"),
                                slotIndex = i,
                                filamentType = existing?.filamentType ?: "PLA",
                                // Preserve any user-set physical/virtual
                                // remap across 3MF loads — that remap is
                                // the user's "use what's loaded at T_M /
                                // FullSpectrum V_K for this filament"
                                // preference, about the printer's spool
                                // layout, not which model is loaded. Per
                                // spec only an explicit picker (or the
                                // gamut-match) action mutates the remap.
                                physicalSlot = existing?.physicalSlot,
                                virtualSlot = existing?.virtualSlot,
                            )
                        }
                        filamentEntriesStore.set(printerId, updated)
                        // gotcha #13: resolve the "as will print"
                        // palette synchronously from the just-synced
                        // entries (same pure fn + inputs as the
                        // previewPalette derivation) so this first bake
                        // is already correct — previewPalette won't
                        // reflect the set() until the next
                        // recomposition.
                        syncedFirstBakePalette = resolveAsWillPrintPalette(
                            filaments = updated,
                            printerLoadedSlots = activePrinterLoadedSlots,
                            paletteSuggestions = filamentSlotsStore.defaultPalette,
                            virtualRows = mixedRows,
                            slotCount = slotCount,
                        )
                        android.util.Log.i(
                            tag,
                            "applied ${embedded.size} embedded filament colors from 3mf to printer $printerId (slotCount=$slotCount)",
                        )
                    }
                    lastEmbeddedSyncPath = bakeSource.absolutePath
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
            // gotcha #13: prefer the synchronously-resolved synced
            // palette when the embedded-colour sync just fired, so the
            // first bake is correct and byte-identical to the echo
            // re-bake (which the GlbSceneEntity guard then collapses).
            val raw = syncedFirstBakePalette ?: previewPalette
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
            android.util.Log.i(tag, "writeColoredGlb: source=${bakeSource.name} index=$bakeIndex")
            val ok = try {
                SlicerEngine.writeColoredGlb(bakeSource, out, palette, paintForPreview, bakeIndex)
            } catch (t: Throwable) {
                android.util.Log.e(tag, "writeColoredGlb threw: ${t.message}", t)
                false
            }
            if (!ok) {
                android.util.Log.e(tag, "writeColoredGlb failed for ${bakeSource.absolutePath}")
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
            // Derive an STL of the bake source for the bedCollision /
            // bedFit checks. The collision check uses the FULL 3MF mesh,
            // which is correct for "does anything overflow the bed."
            //
            // For baseBbox sizing we deliberately do NOT use the full
            // derived STL bbox when this is a per-object render
            // (bakeIndex >= 0): that bbox spans every object in the
            // 3MF (a 5-unicorn 3MF would give a 134x108 footprint to
            // each per-object PlacedModel), which blows up the
            // selection bbox / gizmo size and makes footprintMm()
            // useless for layout. Per-object dims set by
            // nativeRead3mfObjectMetadata at load time are already
            // accurate and preserved.
            var dims: androidx.xr.runtime.math.Vector3? = null
            runCatching {
                val derived = deriveStlFor(bakeSource)
                if (derived != null) {
                    val raw3mf = StlReader.read(derived)
                    if (bakeIndex < 0) {
                        dims = androidx.xr.runtime.math.Vector3(
                            raw3mf.bboxMax.x - raw3mf.bboxMin.x,
                            raw3mf.bboxMax.y - raw3mf.bboxMin.y,
                            raw3mf.bboxMax.z - raw3mf.bboxMin.z
                        )
                    }
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
                    baseBboxXmm = dims?.x ?: it.baseBboxXmm,
                    baseBboxYmm = dims?.y ?: it.baseBboxYmm,
                    baseBboxZmm = dims?.z ?: it.baseBboxZmm,
                ) else it
            }
            stlPreviewPath = out.absolutePath
            return
        }

        // STL path: parse mesh, apply rotate/scale, write a single-
        // color GLB. Same as before, but per-model.
        val current = placedModels.firstOrNull { it.id == modelId } ?: return
        val readable = deriveStlFor(bakeSource)
        if (readable == null) {
            android.util.Log.e(tag, "deriveStlFor returned null for ${bakeSource.absolutePath}")
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
            !hasAnyPaint(current.seamFlags) &&
            !hasAnyPaint(current.fuzzySkinFlags)
        if (needsRestore) {
            val restored = runCatching {
                val hash = paintCache.hashOf(bakeSource)
                paintCache.restore(hash, raw.triCount)
            }.getOrNull()
            if (restored != null) {
                android.util.Log.i(tag,
                    "paint cache hit for $modelId (paint=${restored.paintFilamentIndex?.size}, " +
                        "support=${restored.supportFlags?.size}, seam=${restored.seamFlags?.size}, " +
                        "fuzzy=${restored.fuzzySkinFlags?.size})")
                placedModels = placedModels.map {
                    if (it.id == modelId) it.copy(
                        paintFilamentIndex = restored.paintFilamentIndex,
                        supportFlags = restored.supportFlags,
                        seamFlags = restored.seamFlags,
                        fuzzySkinFlags = restored.fuzzySkinFlags,
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
        val defaultPreviewRgb = previewRgbForFilamentIndex(
            refreshed.previewFilamentIndex,
            previewPalette,
        )
        // Roadmap A6 — when the just-detected collision flagged any
        // off-bed triangles, hand the indices to the GLB writer so the
        // user gets the visual cue ("which faces poke off the bed?")
        // alongside the existing red banner ("which axes overflow?").
        val offBedForPreview = (collision as? BedCollision.Result.Off)?.offendingTriIndices
        try {
            StlPreviewGlb.write(
                mesh,
                out,
                defaultRgb = defaultPreviewRgb,
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
        } finally {
            bakeInFlight = bakeInFlight - modelId
        }
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
        // Guard against re-entry. Without this, tapping a recent file
        // multiple times before the loading panel appears (the first
        // tap kicks off ~5 s of read3mfObjectMetadata before the panel
        // shows) launches a coroutine PER TAP — each doing the full
        // expensive 3MF parse, fighting over placedModels assignment,
        // and eventually crashing the SceneCore material binder when
        // both finish near-simultaneously. The same guard covers
        // accidental long-press / multi-finger pinches.
        if (isLoadingModel) {
            android.util.Log.i(
                "OrcaXR/recents",
                "onFileSelected ignored — already loading: ${file.name}",
            )
            return
        }
        // Flip the loading flag SYNCHRONOUSLY (before scope.launch) so
        // the on-bed loading panel + project-row spinner appear on the
        // very next composition, not 5 s later after the first 3MF
        // parse fires read3mfObjectMetadata. The whole scope.launch
        // body sits inside a try/finally below so every return path
        // (AddVolume early-return, error paths, normal completion)
        // clears the flag — keeping the re-entry guard's invariant
        // tight: isLoadingModel is true from the moment a tap is
        // registered until the load fully resolves.
        isLoadingModel = true
        loadingLabel = file.name
        scope.launch {
            try {
            val label = file.name
            // Phase XR_OBJ_4 — AddVolume mode attaches the picked
            // file to the SELECTED PlacedModel as a new volume of
            // the requested type (MODEL_PART, PARAMETER_MODIFIER,
            // NEGATIVE_VOLUME, SUPPORT_ENFORCER, SUPPORT_BLOCKER),
            // rather than creating a new PlacedModel entry. Slice
            // state is preserved (the user is editing the model, not
            // loading a new one).
            if (mode is PickerMode.AddVolume) {
                val targetId = selectedModelIds.firstOrNull()
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
            val meta = SlicerEngine.read3mfObjectMetadata(file)

            // Multi-plate handling. BBS 3MFs carry a 1-based
            // `plateIndex` per object; standard 3MFs and STLs return
            // 1 for everything. We translate the file's plate indices
            // to app plate ids based on import mode:
            //   Replace : 1..N from the 3MF map onto plate ids 1..N,
            //             upsert PlateMetadata with the 3MF's plate
            //             names, and switch activePlateId to 1 so the
            //             user sees plate 1's models on landing.
            //   Add     : plate 1 of the 3MF lands on the current
            //             activePlateId; 2..N get fresh ids allocated
            //             above the current max so existing plates
            //             stay untouched.
            val maxPlateIndex = meta?.maxOfOrNull { it.plateIndex } ?: 1
            val plateLabels: Array<String>? = if (maxPlateIndex > 1) {
                SlicerEngine.read3mfPlateLabels(file)
            } else null
            val importPlateToApp: Map<Int, Int> = when {
                maxPlateIndex <= 1 -> mapOf(
                    1 to if (mode is PickerMode.Replace) 1 else activePlateId,
                )
                mode is PickerMode.Replace -> (1..maxPlateIndex).associateWith { it }
                else -> buildMap {
                    put(1, activePlateId)
                    val baseId = (allPlates.maxOfOrNull { it.id } ?: 0) + 1
                    for (i in 2..maxPlateIndex) put(i, baseId + i - 2)
                }
            }
            if (maxPlateIndex > 1) {
                val plateIdsToUpsert = if (mode is PickerMode.Replace) {
                    (1..maxPlateIndex).toList()
                } else {
                    (2..maxPlateIndex).toList()
                }
                for (i in plateIdsToUpsert) {
                    val appId = importPlateToApp.getValue(i)
                    val label = plateLabels?.getOrNull(i - 1)
                        ?.takeIf { it.isNotBlank() }
                        ?: "Plate $appId"
                    plateStore.upsert(PlateMetadata(id = appId, label = label))
                }
            }

            // D9 — read per-object config overrides out of the 3MF
            // so the load preserves what desktop OrcaSlicer (or a
            // previous OrcaXR session) authored. Single-object 3MFs +
            // STLs return an empty list cheaply. We pair these against
            // the freshList by OBJECT INDEX (which matches `meta`'s
            // order — one ObjectConfig per ModelObject).
            val objectConfigs = SlicerEngine.read3mfObjectConfigs(file)
            // A11 — custom-gcode ticks for the file's active plate
            // (always plate index 0 for non-BBS 3MFs / STLs). Loaded
            // only on Replace mode so an "Add another model" import
            // doesn't silently overwrite the user's existing ticks.
            val importedTicks = if (mode is PickerMode.Replace) {
                SlicerEngine.read3mfCustomGcodes(file, plateIndex = 0)
            } else emptyList()

            val freshList = if (meta != null && meta.size > 1) {
                val gid = paintCache.hashOf(file)
                meta.mapIndexed { index, m ->
                    val outStl = getExtractedStl(gid, index)
                    if (!outStl.exists()) {
                        SlicerEngine.extractObjectAsStl(file, index, outStl)
                    }
                    val newId = "model_${System.currentTimeMillis().toString(36)}_${placedModels.size + index}"
                    PlacedModel(
                        id = newId,
                        source = outStl,
                        originalSource = file,
                        label = "${file.name} - ${m.name.ifEmpty { "Part ${index + 1}" }}",
                        translateXmm = m.offsetX,
                        translateYmm = m.offsetY,
                        translateZmm = m.offsetZ,
                        previewFilamentIndex = m.defaultExtruder.coerceAtLeast(0),
                        groupId = gid,
                        groupOrdinal = index,
                        baseBboxXmm = m.bboxX,
                        baseBboxYmm = m.bboxY,
                        baseBboxZmm = m.bboxZ,
                        plateId = importPlateToApp[m.plateIndex] ?: importPlateToApp.getValue(1),
                        needsRepair = m.openEdgeCount > 0,
                        // D9 — apply per-object config overrides from
                        // the 3MF, indexed by object position. Empty
                        // map for objects that didn't author any.
                        configOverrides = objectConfigs.getOrNull(index)?.objectOverrides ?: emptyMap(),
                        // A12 — height-range bands from the 3MF.
                        heightRanges = objectConfigs.getOrNull(index)?.heightRanges ?: emptyList(),
                    )
                }
            } else {
                val newId = "model_${System.currentTimeMillis().toString(36)}_${placedModels.size}"
                val singlePlate = meta?.firstOrNull()?.plateIndex ?: 1
                val singleNeedsRepair = (meta?.firstOrNull()?.openEdgeCount ?: 0) > 0
                listOf(
                    PlacedModel(
                        id = newId,
                        source = file,
                        label = label,
                        plateId = importPlateToApp[singlePlate] ?: importPlateToApp.getValue(1),
                        needsRepair = singleNeedsRepair,
                        // D9 — single-object 3MFs put their per-object
                        // overrides at index 0; STLs return [] (empty
                        // list) so this falls through to no overrides.
                        configOverrides = objectConfigs.firstOrNull()?.objectOverrides ?: emptyMap(),
                        heightRanges = objectConfigs.firstOrNull()?.heightRanges ?: emptyList(),
                    ),
                )
            }

            when (mode) {
                PickerMode.Replace -> {
                    placedModels = freshList
                    selectedModelIds = setOfNotNull(freshList.first().id)
                    // Land on plate 1 of the import so plate-1 models
                    // are visible immediately (otherwise they'd be
                    // filtered out if the user was on a different
                    // plate before importing).
                    activePlateId = importPlateToApp.getValue(1)
                    // A11 — write imported custom-gcode ticks onto
                    // plate 1 of the new project so save → reopen
                    // round-trips. Replace clears any prior ticks the
                    // user had on plate 1 (matches "Replace clears the
                    // bed"). Empty list = clear (the imported file had
                    // no ticks).
                    customGcodeStore.set(importPlateToApp.getValue(1), importedTicks)
                }
                PickerMode.Add -> {
                    if (placedModels.size + freshList.size > MAX_PLACED_MODELS) {
                        android.widget.Toast.makeText(
                            ctx,
                            "Up to $MAX_PLACED_MODELS models per plate. Slice or remove some first.",
                            android.widget.Toast.LENGTH_LONG,
                        ).show()
                        return@launch
                    }
                    placedModels = placedModels + freshList
                    selectedModelIds = setOfNotNull(freshList.first().id)
                }
                is PickerMode.AddVolume -> {
                    // Already handled above — the early return prevents
                    // this branch, but the exhaustive `when` keeps the
                    // compiler happy.
                }
            }
            sliceState.value = SliceUiState.Idle
            workspaceMode = WorkspaceMode.Prepare
            // Toast still fires here so the user gets a transient
            // confirmation; the persistent on-bed loading panel +
            // project-row spinner driven by `isLoadingModel` were
            // already raised at the top of `onFileSelected` (before
            // the coroutine even started) so there's no panel-delay
            // gap to bridge anymore.
            android.widget.Toast.makeText(
                ctx,
                "Loading $label…",
                android.widget.Toast.LENGTH_SHORT,
            ).show()
            for (m in freshList) {
                previewStl(m.id)
            }
            // Roadmap B7 — bump the recents list AFTER a successful
            // load so a corrupt/unparseable file doesn't pollute the
            // empty-state shortcuts. Best-effort: a failed write to
            // DataStore (e.g. process killed mid-suspend) shouldn't
            // surface as a load failure.
            runCatching { recentFiles.add(file, label = label) }
                .onFailure { android.util.Log.w("OrcaXR/recents", "recentFiles.add failed: ${it.message}") }
            } finally {
                // Always clear the flag — covers the AddVolume early
                // returns above, exception paths, and the normal
                // completion path. The re-entry guard at the top of
                // onFileSelected reads this flag, so leaving it stuck
                // would lock the user out of every subsequent file
                // load until app restart.
                isLoadingModel = false
                loadingLabel = null
            }
        }
    }

    // Roadmap B14 — collect share-target staged files and route each
    // one through the same onFileSelected codepath the in-app picker
    // uses. This sits AFTER the onFileSelected definition so the lambda
    // captures it directly (no rememberUpdatedState needed; XrShell
    // recomposes if the parameter list changes, which it doesn't for
    // the share flow). pickerMode is reset to Add explicitly because
    // a stale AddVolume mode left over from an in-flight UI flow would
    // otherwise interpret the shared file as "attach this as a new
    // volume to the selected model" — wrong intent for an external
    // share, which always means "open this".
    LaunchedEffect(pendingSharedFiles) {
        pendingSharedFiles.collect { file ->
            pickerMode = PickerMode.Add
            onFileSelected(file)
        }
    }

    fun runSlice(file: File, label: String) {
        scope.launch {
            // Roadmap E8 — register with the slice-lifetime foreground
            // service so the OS doesn't kill the process if the user
            // takes off the XR headset mid-slice. The try/finally below
            // makes sure the service is released on every return path
            // including exceptions.
            SliceLifecycle.beginSlice(ctx, label)
            try {
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
            val fuzzyForSlice = selectedModel?.fuzzySkinFlags
            val brimEarsForSlice = selectedModel?.brimEars?.toBrimEarsFloatArray()
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
                    extraOverrides = printSettingsOverrides.value + wipeTowerExtraOverrides(ctx) + fullSpectrumExtraOverrides(mixedFilamentDefinitions.isNotBlank()),
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
                fuzzySkinFlags = fuzzyForSlice,
                brimEars = brimEarsForSlice,
                objectConfigOverrides = selectedModel?.configOverrides ?: emptyMap(),
                layerHeightProfile = selectedModel?.layerHeightProfile,
                customGcodeTicks = customGcodeTicksByPlate[activePlateId] ?: emptyList(),
                heightRanges = selectedModel?.heightRanges ?: emptyList(),
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
                // Roadmap E8 — mirror the percent into the foreground-
                // service notification so the user sees progress on
                // the lock screen / shade with the headset off.
                SliceLifecycle.updateProgress(percent, message)
            }
            val parsed = (result as? SliceResult.Success)?.let {
                runCatching { GcodeParser.parse(File(it.outputPath)) }.getOrNull()
            }
            sliceState.value = SliceUiState.Done(label, result, parsed)
            } finally {
                // Roadmap E8 — release the foreground-service hold.
                SliceLifecycle.endSlice(ctx)
            }
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
        // C6: MCP route can pass an explicit source instead of relying
        // on `selectedModel`. The XR-button path leaves it null and
        // continues to use the currently-selected model.
        sourceOverride: PlacedModel? = null,
    ) {
        val source = sourceOverride ?: selectedModel ?: run {
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
            selectedModelIds = setOfNotNull(newId)
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
            val ts = System.currentTimeMillis()
            val out = File(ctx.cacheDir, "bool_${opStr}_${ts}.3mf")
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
            // Audit H23 (2026-05-07) — when a Difference splits A into
            // two parts, or a Union of two non-touching meshes
            // produces a disjoint result, the merged 3MF carries
            // multiple connected components. The user expects each
            // component as a separately-grabbable PlacedModel (matches
            // the Split tool's contract). Compose `meshBoolean` →
            // `splitObject`: cheap, no JNI signature change, shared
            // code path with the standalone Split tool. Single-
            // component output still produces one PlacedModel (split
            // is idempotent on a connected mesh).
            val splitDir = File(ctx.cacheDir, "bool_${opStr}_${ts}_split").apply { mkdirs() }
            val splits = runCatching {
                SlicerEngine.splitObject(out, splitDir)
            }.getOrNull().orEmpty()
            // Fall back to the merged 3MF when split returns nothing
            // (split failure shouldn't sink the operation; the merged
            // result is still meaningful).
            val resultPaths = if (splits.isNotEmpty()) splits else listOf(out.absolutePath)
            val freshModels = resultPaths.mapIndexed { idx, path ->
                val newId = "model_${ts.toString(36)}_bool_$idx"
                val label = if (resultPaths.size == 1) "Bool $opStr"
                            else "Bool $opStr (${idx + 1}/${resultPaths.size})"
                PlacedModel(id = newId, source = File(path), label = label)
            }
            // Replace BOTH source models with the boolean output(s).
            placedModels = placedModels.filter { it.id != aId && it.id != bId } + freshModels
            selectedModelIds = freshModels.map { it.id }.toSet()
            sliceState.value = SliceUiState.Idle
            workspaceMode = WorkspaceMode.Prepare
            isLoadingModel = true
            loadingLabel = freshModels.firstOrNull()?.label
            try {
                // Bake the preview for each fresh model. They're sequential
                // because previewStl mutates shared state; parallelizing
                // would race the colored-GLB writer (gotcha #22).
                for (m in freshModels) {
                    previewStl(m.id)
                }
            } finally {
                isLoadingModel = false
                loadingLabel = null
            }
            val pieceText = if (freshModels.size > 1) " (${freshModels.size} pieces)" else ""
            android.widget.Toast.makeText(
                ctx,
                "Boolean ${opStr} done${pieceText}.",
                android.widget.Toast.LENGTH_SHORT,
            ).show()
        }
    }

    /**
     * Phase D4 — emboss / engrave a text string or SVG path on the
     * given PlacedModel.
     *
     * Pipeline:
     * 1. Build the emboss mesh from [spec] (text or SVG) via
     *    [SlicerEngine.buildTextMesh] / [SlicerEngine.buildSvgMesh].
     * 2. Compute a placement transform — top-of-bbox by default (the
     *    emboss block sits on the host's top face, centered in XY).
     *    For SUB the transform also pushes the emboss down by its
     *    own depth so the boolean carves a recess of [EmbossSpec.depthMm].
     * 3. [SlicerEngine.applyEmboss] runs the boolean and emits a 3MF.
     * 4. PlacedModel.source is swapped to the result, paint state is
     *    cleared (topology changed → per-triangle indices invalid),
     *    and the preview is re-baked.
     *
     * On any failure step a Toast surfaces the cause and the model is
     * left untouched. The emboss / boolean is on the libslic3r
     * dispatcher, so the UI thread doesn't block.
     */
    fun runEmboss(
        modelId: String,
        spec: EmbossSpec,
        mode: EmbossMode,
        translateXmm: Float = 0f,
        translateYmm: Float = 0f,
        rotZDeg: Float = 0f,
    ) {
        val src = placedModels.firstOrNull { it.id == modelId } ?: return
        val originalLabel = src.label
        scope.launch {
            isLoadingModel = true
            loadingLabel = "Embossing $originalLabel"
            val embossOut = File(
                ctx.cacheDir,
                "emboss_src_${modelId}_${System.currentTimeMillis()}.3mf",
            )
            val builtEmboss = runCatching {
                when (spec) {
                    is EmbossSpec.Text -> SlicerEngine.buildTextMesh(
                        fontFile = spec.fontFile,
                        text = spec.text,
                        sizeMm = spec.sizeMm,
                        depthMm = spec.depthMm,
                        output = embossOut,
                    )
                    is EmbossSpec.Svg -> SlicerEngine.buildSvgMesh(
                        svgFile = spec.svgFile,
                        targetSizeMm = spec.sizeMm,
                        depthMm = spec.depthMm,
                        output = embossOut,
                    )
                }
            }.onFailure {
                android.util.Log.e("OrcaXR", "buildEmbossMesh threw", it)
            }.getOrNull()
            if (builtEmboss == null) {
                isLoadingModel = false
                loadingLabel = null
                android.widget.Toast.makeText(
                    ctx,
                    "Emboss build failed (see logs).",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
                return@launch
            }

            // Top-of-bbox placement: bottom of emboss = host-top - sink.
            // ADD: sink=0 (raised letters sit on top).
            // SUB: sink=depth (carved letters cut down by depth).
            val hostTopZmm = src.baseBboxZmm * src.effectiveScaleZ
            val sinkMm = if (mode == EmbossMode.SUB) spec.depthMm else 0f
            val placement = EmbossOp.transformForTopOfBbox(
                hostBboxMaxZmm = hostTopZmm,
                embossDepthMm = spec.depthMm,
                sinkDepthMm = sinkMm,
                translateXmm = translateXmm,
                translateYmm = translateYmm,
            )
            val xform = if (rotZDeg != 0f) {
                EmbossOp.compose(placement, EmbossOp.rotationZ(rotZDeg))
            } else placement

            val outBoolean = File(
                ctx.cacheDir,
                "emboss_${mode.name.lowercase()}_${modelId}_${System.currentTimeMillis()}.3mf",
            )
            val ok = runCatching {
                SlicerEngine.applyEmboss(
                    host = src.source,
                    emboss = builtEmboss,
                    mode = mode,
                    transform4x4 = xform,
                    output = outBoolean,
                )
            }.onFailure {
                android.util.Log.e("OrcaXR", "applyEmboss threw", it)
            }.getOrDefault(false)
            if (!ok) {
                isLoadingModel = false
                loadingLabel = null
                android.widget.Toast.makeText(
                    ctx,
                    "Emboss apply failed (see logs).",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
                return@launch
            }

            // Replace the model in-place. Paint state is dropped — the
            // CGAL/mcut boolean re-meshes the host so per-triangle
            // indices won't survive (gotcha #27 lesson). Mirrors the
            // runRepair sweep.
            placedModels = placedModels.map {
                if (it.id != modelId) it else it.copy(
                    source = outBoolean,
                    originalSource = null,
                    groupId = null,
                    groupOrdinal = 0,
                    paintFilamentIndex = null,
                    supportFlags = null,
                    seamFlags = null,
                    fuzzySkinFlags = null,
                    brimEars = emptyList(),
                    volumes = emptyList(),
                    previewVersion = it.previewVersion + 1,
                    previewRotZDeg = -1,
                    previewScalePct = -1,
                )
            }
            sliceState.value = SliceUiState.Idle
            try {
                previewStl(modelId)
            } finally {
                isLoadingModel = false
                loadingLabel = null
            }
            val verb = if (mode == EmbossMode.ADD) "Embossed" else "Engraved"
            android.widget.Toast.makeText(
                ctx,
                "$verb $originalLabel.",
                android.widget.Toast.LENGTH_SHORT,
            ).show()
        }
    }

    /**
     * "Add Magnets" — recess N magnet-shaped pockets into [modelId] as
     * `NEGATIVE_VOLUME`s and auto-author one `PausePrint` tick so the
     * user can drop physical magnets into the open pockets mid-print
     * before the model bridges a roof over them.
     *
     * Unlike [runEmboss] this is NON-destructive: `source` is NOT
     * swapped (libslic3r boolean-subtracts the negative volumes at
     * slice time), so paint / support / seam / fuzzy state and any
     * existing volumes are PRESERVED — we only append.
     *
     * v1 gate: only the single-model slice path (`runSlice` →
     * `SlicerEngine.slice`) threads per-model `extraVolumes`;
     * `sliceMulti` does not yet. So magnets require exactly one model
     * on the bed and a non-decomposed source (`originalSource == null`).
     */
    fun runMagnets(action: dev.orcaxr.app.mcp.WorkspaceAction.AddMagnets) {
        val src = placedModels.firstOrNull { it.id == action.modelId } ?: return
        if (placedModels.size != 1 || src.originalSource != null) {
            android.widget.Toast.makeText(
                ctx,
                "Add Magnets needs a single standalone model on the bed " +
                    "(multi-object plates aren't supported yet).",
                android.widget.Toast.LENGTH_LONG,
            ).show()
            return
        }
        val shape = when (action.shape.trim().lowercase()) {
            "disc", "cylinder", "round" -> MagnetShape.DISC
            "block", "cube", "rect", "rectangular" -> MagnetShape.BLOCK
            else -> {
                android.widget.Toast.makeText(
                    ctx,
                    "Unknown magnet shape '${action.shape}' (use disc or block).",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
                return
            }
        }
        if (action.count < 1) {
            android.widget.Toast.makeText(
                ctx, "Magnet count must be ≥ 1.", android.widget.Toast.LENGTH_LONG,
            ).show()
            return
        }
        val originalLabel = src.label
        scope.launch {
            isLoadingModel = true
            loadingLabel = "Adding magnets to $originalLabel"

            // Resolve the slice layer height the SAME way mergedConfig
            // does (gotcha #22): override TextField wins, else the
            // active profile's layer_height, clamped. Never derive it
            // from the 3MF or the bbox — the pause must land on a real
            // slice layer boundary.
            val lh = run {
                val parsed = layerHeightOverride.value.trim().toFloatOrNull()
                val v = if (parsed == null || parsed.isNaN()) {
                    selectedProfile.value.config["layer_height"]?.toFloatOrNull() ?: 0.2f
                } else parsed
                v.coerceIn(0.05f, 0.50f)
            }

            val spec = MagnetSpec(
                count = action.count,
                shape = shape,
                diameterMm = action.diameterMm,
                discHeightMm = action.heightMm,
                blockXmm = action.blockXmm,
                blockYmm = action.blockYmm,
                blockZmm = action.blockZmm,
                clearanceMm = action.clearanceMm,
                roofThicknessMm = action.roofThicknessMm,
                edgeMarginMm = action.edgeMarginMm,
            )

            // Placement is in the host's mesh-local (unscaled) frame —
            // the per-volume transform is applied before the instance
            // scale, so use baseBbox*, NOT footprintMm() (post-scale).
            val placement = MagnetOp.placeCavities(
                footprintXmm = src.baseBboxXmm,
                footprintYmm = src.baseBboxYmm,
                hostHeightMm = src.baseBboxZmm,
                spec = spec,
                resolvedLayerHeightMm = lh,
            )
            val warnings = placement.warnings.toMutableList()
            // A scaled host scales its negative volumes too — the
            // physical pocket would no longer match the magnet.
            if (src.effectiveScaleX != 1f || src.effectiveScaleY != 1f ||
                src.effectiveScaleZ != 1f) {
                warnings += "Model is scaled; magnet pockets scale with it " +
                    "and may not fit the physical magnet."
            }
            if (warnings.isNotEmpty()) {
                android.widget.Toast.makeText(
                    ctx, warnings.joinToString("\n"), android.widget.Toast.LENGTH_LONG,
                ).show()
            }

            val magnetStl = File(
                ctx.cacheDir,
                "magnet_${action.modelId}_${System.currentTimeMillis()}.stl",
            )
            val built = runCatching {
                SlicerEngine.buildPrimitiveStl(
                    kind = placement.primitiveKind,
                    params = placement.primitiveParams,
                    output = magnetStl,
                )
            }.onFailure {
                android.util.Log.e("OrcaXR", "buildPrimitiveStl (magnet) threw", it)
            }.getOrNull()
            if (built == null) {
                isLoadingModel = false
                loadingLabel = null
                android.widget.Toast.makeText(
                    ctx, "Magnet mesh build failed (see logs).",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
                return@launch
            }

            val stamp = System.currentTimeMillis()
            val newVolumes = placement.cavities.mapIndexed { i, c ->
                PlacedVolume(
                    id = "magnet_${stamp}_$i",
                    source = built,
                    type = ModelVolumeType.NEGATIVE_VOLUME,
                    translateXmm = c.centerXmm,
                    translateYmm = c.centerYmm,
                    translateZmm = placement.floorZmm,
                )
            }
            // Append, preserving source/paint/support/existing volumes.
            placedModels = placedModels.map {
                if (it.id != action.modelId) it else it.copy(
                    volumes = it.volumes + newVolumes,
                    previewVersion = it.previewVersion + 1,
                    previewRotZDeg = -1,
                    previewScalePct = -1,
                )
            }

            // Author ONE PausePrint tick at the pocket top, de-duping
            // any prior magnet pause within half a layer on this plate.
            val plateId = src.plateId
            val existing = customGcodeTicksByPlate[plateId] ?: emptyList()
            val eps = lh / 2f
            val deduped = existing.filterNot {
                it.kind == SlicerEngine.CustomGcodeKind.PausePrint &&
                    kotlin.math.abs(it.printZmm - placement.pauseZmm) <= eps
            }
            val merged = (deduped + SlicerEngine.CustomGcodeTick(
                printZmm = placement.pauseZmm,
                kind = SlicerEngine.CustomGcodeKind.PausePrint,
                color = "Insert magnets",
            )).sortedBy { it.printZmm }
            customGcodeStore.set(plateId, merged)

            sliceState.value = SliceUiState.Idle
            try {
                previewStl(action.modelId)
            } finally {
                isLoadingModel = false
                loadingLabel = null
            }
            android.widget.Toast.makeText(
                ctx,
                "Added ${placement.cavities.size} magnet ${shape.name.lowercase()} " +
                    "pocket(s) + pause @ ${"%.2f".format(placement.pauseZmm)} mm to " +
                    originalLabel + ".",
                android.widget.Toast.LENGTH_SHORT,
            ).show()
        }
    }

    /**
     * Phase A5 ("Fix Model") — run cross-platform mesh repair on the
     * given PlacedModel. Replaces its `source` with the repaired 3MF,
     * clears all paint state (topology may have changed → per-triangle
     * indices would misalign), and re-bakes the preview.
     *
     * On full failure (read fail / OOM in outer try) surfaces a toast
     * and leaves the model untouched. On partial repair (CGAL bailed
     * out, ADMesh-only result returned) the model still gets the
     * partial fix and the toast says "partial".
     */
    fun runRepair(modelId: String) {
        val src = placedModels.firstOrNull { it.id == modelId } ?: return
        val originalLabel = src.label
        scope.launch {
            isLoadingModel = true
            loadingLabel = "Fixing $originalLabel"
            val out = File(ctx.cacheDir, "repair_${modelId}_${System.currentTimeMillis()}.3mf")
            val result = runCatching {
                SlicerEngine.repairModel(src.source, out)
            }.onFailure {
                android.util.Log.e("OrcaXR", "repairModel threw", it)
            }.getOrNull()
            if (result == null) {
                isLoadingModel = false
                loadingLabel = null
                android.widget.Toast.makeText(
                    ctx,
                    "Fix Model failed for $originalLabel (see logs).",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
                return@launch
            }
            // Replace the model in-place with a copy whose source is
            // the repaired 3MF. Drop everything that depended on the
            // original triangle topology — paint, brim ears, modifier
            // volumes — because their per-facet indices won't survive
            // the CGAL re-mesh.
            placedModels = placedModels.map {
                if (it.id != modelId) it else it.copy(
                    source = out,
                    originalSource = null,
                    groupId = null,
                    groupOrdinal = 0,
                    paintFilamentIndex = null,
                    supportFlags = null,
                    seamFlags = null,
                    fuzzySkinFlags = null,
                    brimEars = emptyList(),
                    volumes = emptyList(),
                    previewVersion = it.previewVersion + 1,
                    previewRotZDeg = -1,
                    previewScalePct = -1,
                    needsRepair = result.openEdgesOut > 0,
                )
            }
            sliceState.value = SliceUiState.Idle
            try {
                previewStl(modelId)
            } finally {
                isLoadingModel = false
                loadingLabel = null
            }
            val deltaTris = result.trianglesOut - result.trianglesIn
            val deltaOpen = result.openEdgesIn - result.openEdgesOut
            val msg = if (result.partial) {
                "Partial fix: $deltaOpen open edges closed " +
                    "(CGAL self-union skipped — too large)."
            } else {
                "Fix done: ${result.trianglesIn} → ${result.trianglesOut} tris, " +
                    "$deltaOpen open edges closed."
            }
            android.widget.Toast.makeText(
                ctx,
                msg,
                android.widget.Toast.LENGTH_LONG,
            ).show()
        }
    }

    /**
     * D17 — quadric edge collapse mesh simplification. Replaces the
     * model's source with a simplified version targeting
     * [targetTriangleCount]. Like runRepair, drops paint state +
     * brim ears + per-volume metadata because the topology change
     * invalidates per-triangle indices (gotcha #27).
     */
    fun runSimplify(modelId: String, targetTriangleCount: Int, maxError: Float) {
        val src = placedModels.firstOrNull { it.id == modelId } ?: return
        val originalLabel = src.label
        scope.launch {
            isLoadingModel = true
            loadingLabel = "Simplifying $originalLabel"
            val out = File(ctx.cacheDir, "simplify_${modelId}_${System.currentTimeMillis()}.3mf")
            val result = runCatching {
                SlicerEngine.simplifyMesh(src.source, out, targetTriangleCount, maxError)
            }.onFailure {
                android.util.Log.e("OrcaXR", "simplifyMesh threw", it)
            }.getOrNull()
            if (result == null) {
                isLoadingModel = false
                loadingLabel = null
                android.widget.Toast.makeText(
                    ctx,
                    "Simplify failed for $originalLabel (see logs).",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
                return@launch
            }
            placedModels = placedModels.map {
                if (it.id != modelId) it else it.copy(
                    source = out,
                    originalSource = null,
                    groupId = null,
                    groupOrdinal = 0,
                    paintFilamentIndex = null,
                    supportFlags = null,
                    seamFlags = null,
                    fuzzySkinFlags = null,
                    brimEars = emptyList(),
                    volumes = emptyList(),
                    previewVersion = it.previewVersion + 1,
                    previewRotZDeg = -1,
                    previewScalePct = -1,
                )
            }
            sliceState.value = SliceUiState.Idle
            try {
                previewStl(modelId)
            } finally {
                isLoadingModel = false
                loadingLabel = null
            }
            android.widget.Toast.makeText(
                ctx,
                "Simplified: ${result.trianglesIn} → ${result.trianglesOut} tris " +
                    "(${"%.1f".format(result.reductionPct)}% reduction).",
                android.widget.Toast.LENGTH_LONG,
            ).show()
        }
    }

    /**
     * A10 — compute libslic3r's adaptive layer-height profile for one
     * PlacedModel and write it into `placedModels[modelId].layerHeightProfile`.
     * Bumps `previewVersion` so any UI that visualizes per-Z layer
     * thickness rebakes; the actual slice doesn't fire — the profile
     * threads through `nativeSlice` / `nativeSliceMulti` on the next
     * Slice button press (or `slice_active_plate` MCP call).
     *
     * Sources the profile against the active config so the
     * SlicingParameters min/max layer-height bounds match what the
     * upcoming slice will use. Falls back to FullPrintConfig defaults
     * when no profile is selected (rare — the picker has a default).
     */
    fun runComputeAdaptiveLayerHeights(
        action: dev.orcaxr.app.mcp.WorkspaceAction.ComputeAdaptiveLayerHeights,
    ) {
        val src = placedModels.firstOrNull { it.id == action.modelId } ?: run {
            android.util.Log.w(
                "OrcaXR/A10",
                "ComputeAdaptiveLayerHeights: no model id=${action.modelId}",
            )
            return
        }
        scope.launch {
            isLoadingModel = true
            loadingLabel = "Computing adaptive layer heights"
            val cfg = mergedConfig(
                selectedProfile.value,
                layerHeightOverride.value,
                paddedSlots,
                mixedFilamentDefinitions,
                paddedSlotRemap,
                extraOverrides = printSettingsOverrides.value + wipeTowerExtraOverrides(ctx) + fullSpectrumExtraOverrides(mixedFilamentDefinitions.isNotBlank()),
                flushFromProject = loadedFlushSettings,
                projectOverrides = loadedProjectOverrides,
                slotTypes = filamentList.map { it.filamentType },
                allFilaments = filamentsCatalog,
            )
            // The auto-profile only needs the per-object slicing
            // parameters (min/max layer heights, nozzle, raft, etc.).
            // Pass the merged config so the bounds match what the
            // upcoming slice would compute against the same profile.
            val source = src.originalSource ?: src.source
            val profile = runCatching {
                SlicerEngine.computeAdaptiveLayerHeights(
                    input = source,
                    config = cfg,
                    quality = action.quality,
                    smoothingRadius = action.smoothingRadius,
                    smoothingKeepMin = action.smoothingKeepMin,
                )
            }.onFailure {
                android.util.Log.e("OrcaXR", "computeAdaptiveLayerHeights threw", it)
            }.getOrNull()
            isLoadingModel = false
            loadingLabel = null
            if (profile == null || profile.size < 4) {
                android.widget.Toast.makeText(
                    ctx,
                    "Adaptive layer heights failed for ${src.label} (see logs).",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
                return@launch
            }
            placedModels = placedModels.map { m ->
                if (m.id == action.modelId) m.copy(layerHeightProfile = profile) else m
            }
            android.widget.Toast.makeText(
                ctx,
                "Computed ${profile.size / 2} layer-height waypoints (Z ${"%.1f".format(profile[0])}..${"%.1f".format(profile[profile.size - 2])}mm).",
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
            selectedModelIds = setOfNotNull(newModels.firstOrNull()?.id)
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
        val allModels = placedModels
        val models = allModels.filter { it.plateId == activePlateId }
        if (models.isEmpty()) return
        if (models.size < 2) {
            placedModels = allModels.map { m ->
                if (m.plateId == activePlateId) {
                    m.copy(translateXmm = 0f, translateYmm = 0f)
                } else m
            }
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
                val updatedModels = models.mapIndexed { i, m ->
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
                val updatedMap = updatedModels.associateBy { it.id }
                placedModels = allModels.map { m -> updatedMap[m.id] ?: m }
                android.util.Log.i("OrcaXR", "auto-arrange: libslic3r placed ${models.size} models on plate $activePlateId")
            } else {
                android.util.Log.w("OrcaXR", "auto-arrange: JNI returned null, falling back to naive layout")
                val arranged = autoArrangeModels(models)
                val updatedMap = arranged.associateBy { it.id }
                placedModels = allModels.map { m -> updatedMap[m.id] ?: m }
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
            val multiLabel = "${models.size} models"
            // Roadmap E8 — see runSlice; same lifecycle pattern.
            SliceLifecycle.beginSlice(ctx, multiLabel)
            try {
            glbPath = null
            maxLayer.value = null
            sliceState.value = SliceUiState.Slicing(sourceLabel = multiLabel)
            // For PlacedModels created by decomposing a multi-object
            // 3MF (gotcha #21), `source` points at a per-object STL —
            // STL has no facet annotations, so going through it strips
            // mmu_segmentation_facets / supported_facets / seam_facets
            // and the slice prints single-color (the "4 painted unicorns
            // on one plate, gcode emits 10 toolchanges across 1.6M
            // lines" symptom). Re-route to `originalSource` whenever
            // we have one and tell nativeSliceMulti which ordinal to
            // pick out of the loaded 3MF; the cloned ModelObject then
            // arrives with its painted volumes intact.
            val pairs = models.map { m ->
                val src = m.originalSource ?: m.source
                src to SlicerEngine.ModelPlacement(
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
            val ordinals = IntArray(models.size) { i ->
                if (models[i].originalSource != null) models[i].groupOrdinal else -1
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
                extraOverrides = printSettingsOverrides.value + wipeTowerExtraOverrides(ctx) + fullSpectrumExtraOverrides(mixedFilamentDefinitions.isNotBlank()),
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
            // A10: per-input variable layer-height profile, parallel
            // to `pairs`. Null whole-list when no model has authored
            // a profile so the JNI side short-circuits the per-input
            // walk; per-entry null when this specific model has none.
            val lhpsForMulti: List<FloatArray?>? =
                if (models.none { it.layerHeightProfile != null && it.layerHeightProfile.size >= 4 }) null
                else models.map { m ->
                    m.layerHeightProfile?.takeIf { it.size >= 4 && (it.size and 1) == 0 }
                }
            // A12 — per-input height-range bands. Null whole-list when
            // no model authored ranges; the JNI side then short-
            // circuits the per-input walk.
            val heightRangesForMulti: List<List<HeightRange>>? =
                if (models.none { it.heightRanges.isNotEmpty() }) null
                else models.map { it.heightRanges }
            val result = SlicerEngine.sliceMulti(
                pairs,
                outFile,
                cfg,
                paintFilamentIndices = paintsForMulti,
                objectOrdinals = ordinals,
                layerHeightProfilesPerInput = lhpsForMulti,
                customGcodeTicks = customGcodeTicksByPlate[activePlateId] ?: emptyList(),
                heightRangesPerInput = heightRangesForMulti,
            ) { percent, message ->
                val cur = sliceState.value
                if (cur is SliceUiState.Slicing) {
                    sliceState.value = cur.copy(percent = percent, message = message)
                }
                // Roadmap E8 — mirror the percent into the foreground-
                // service notification so the user sees progress on
                // the lock screen / shade with the headset off.
                SliceLifecycle.updateProgress(percent, message)
            }
            val parsed = (result as? SliceResult.Success)?.let {
                runCatching { GcodeParser.parse(File(it.outputPath)) }.getOrNull()
            }
            sliceState.value = SliceUiState.Done(multiLabel, result, parsed)
            } finally {
                // Roadmap E8 — release the foreground-service hold.
                SliceLifecycle.endSlice(ctx)
            }
        }
    }

    // C6 — paint-mutation helper. Wraps the transform in
    // PaintHistory.beginStroke / endStroke so an MCP-driven clear /
    // remap is undoable, AND bumps `paintContentVersion` so the
    // LE_3076 colored-GLB rebake LaunchedEffect fires (it keys on the
    // counter, NOT on placedModels-list identity or
    // paintFilamentIndex reference, because the in-XR stamp pipeline
    // mutates the array in place — see comment at LE_3076). Without
    // the bump, MCP-driven paint changes update in-memory state but
    // the on-bed preview doesn't refresh until the user restarts the
    // app or re-selects the model.
    fun applyPaintMutation(
        modelId: String,
        history: PaintHistory,
        transform: (PlacedModel) -> PlacedModel,
    ) {
        val before = placedModels.firstOrNull { it.id == modelId } ?: return
        history.beginStroke(
            modelId,
            PaintHistory.Snapshot(
                paintFilamentIndex = before.paintFilamentIndex,
                supportFlags = before.supportFlags,
                seamFlags = before.seamFlags,
                fuzzySkinFlags = before.fuzzySkinFlags,
            ),
        )
        placedModels = placedModels.map { if (it.id == modelId) transform(it) else it }
        val after = placedModels.firstOrNull { it.id == modelId } ?: return
        history.endStroke(
            modelId,
            PaintHistory.Snapshot(
                paintFilamentIndex = after.paintFilamentIndex,
                supportFlags = after.supportFlags,
                seamFlags = after.seamFlags,
                fuzzySkinFlags = after.fuzzySkinFlags,
            ),
        )
        paintContentVersion++
    }

    // C7 — bulk plane-split paint. Reads the model's source mesh off
    // the IO dispatcher, classifies every triangle by which side of an
    // axis-aligned plane its centroid lies on (in the SAME centered
    // preview frame `nativeWriteColoredGlb` and the BVH builder use,
    // see GEMINI.md gotcha #11d), then commits the resulting tag array
    // through `applyPaintMutation` so PaintHistory + LE_2800 rebake
    // fire identically to a brush stamp. Used by the
    // `paint_split_plane` MCP tool to do "left red, right blue" in
    // one call.
    fun runPaintPlaneSplit(action: dev.orcaxr.app.mcp.WorkspaceAction.PaintPlaneSplit) {
        val model = placedModels.firstOrNull { it.id == action.modelId } ?: return
        scope.launch {
            val arr = withContext(Dispatchers.IO) {
                val derived = deriveStlFor(model.source) ?: return@withContext null
                val mesh = runCatching { StlReader.read(derived) }.getOrNull() ?: return@withContext null
                val shiftX = -(mesh.bboxMin.x + mesh.bboxMax.x) / 2f
                val shiftY = -(mesh.bboxMin.y + mesh.bboxMax.y) / 2f
                val shiftZ = -mesh.bboxMin.z
                val centered = mesh.translatedXyz(shiftX, shiftY, shiftZ)
                val pos = centered.positions
                val out = ByteArray(centered.triCount)
                val negB = action.negativeTag.toByte()
                val posB = action.positiveTag.toByte()
                val plane = action.planeMm
                var i = 0
                var t = 0
                while (t < centered.triCount) {
                    val a = when (action.axis) {
                        dev.orcaxr.app.mcp.WorkspaceAction.SplitAxis.X ->
                            (pos[i] + pos[i + 3] + pos[i + 6]) / 3f
                        dev.orcaxr.app.mcp.WorkspaceAction.SplitAxis.Y ->
                            (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3f
                        dev.orcaxr.app.mcp.WorkspaceAction.SplitAxis.Z ->
                            (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3f
                    }
                    out[t] = if (a < plane) negB else posB
                    t += 1
                    i += 9
                }
                out
            } ?: run {
                android.util.Log.w(
                    "OrcaXR/paint",
                    "PaintPlaneSplit: failed to read mesh for ${model.id}",
                )
                return@launch
            }
            applyPaintMutation(action.modelId, paintHistory) { m ->
                when (action.kind) {
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Color ->
                        m.copy(paintFilamentIndex = arr)
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Support ->
                        m.copy(supportFlags = arr)
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Seam ->
                        m.copy(seamFlags = arr)
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.FuzzySkin ->
                        m.copy(fuzzySkinFlags = arr)
                }
            }
            paintHistoryVersion++
        }
    }

    // C6 — bind the in-session shell state to the process-scoped
    // WorkspaceModel so MCP tools can observe it and post mutations.
    // The binding is unidirectional in both directions: publishers push
    // remember{} state into the model on change; the action collector
    // posts back through the same setters the UI uses, so observers
    // (re-bake, validation, GLB regenerate) fire identically whether
    // the change came from a user pinch or an LLM tool call. Tier-B
    // callbacks (slice / save / arrange) close over the same `runSlice`
    // / `runAutoArrange` / `saveGcodeToDownloads` family the buttons
    // call, so an LLM-driven slice is byte-identical to a tap-driven
    // one.
    dev.orcaxr.app.mcp.BindWorkspaceModel(
        placedModels = placedModels,
        setPlacedModels = { placedModels = it },
        selectedModelIds = selectedModelIds,
        setSelectedModelIds = { selectedModelIds = it },
        gizmoTool = gizmoTool,
        setGizmoTool = { gizmoTool = it },
        paintBrush = paintBrush,
        setPaintBrush = { paintBrush = it },
        workspaceMode = workspaceMode,
        setWorkspaceMode = { workspaceMode = it },
        activePlateId = activePlateId,
        setActivePlateId = { activePlateId = it },
        selectedProfile = selectedProfile.value,
        setSelectedProfile = { selectedProfile.value = it },
        selectedPrinterId = selectedPrinterId.value,
        setSelectedPrinterId = { selectedPrinterId.value = it },
        layerHeightOverride = layerHeightOverride.value,
        setLayerHeightOverride = { layerHeightOverride.value = it },
        printSettingsOverrides = printSettingsOverrides.value,
        sliceState = sliceState.value,
        maxLayer = maxLayer.value,
        setMaxLayer = { maxLayer.value = it },
        bedFit = bedFit,
        bedCollision = bedCollision,
        showTravels = showTravels.value,
        setShowTravels = { showTravels.value = it },
        toolpathTubes = toolpathTubes.value,
        setToolpathTubes = { toolpathTubes.value = it },
        plateMovable = plateMovable,
        setPlateMovable = { plateMovable = it },
        allProfiles = allProfiles,
        previewPalette = previewPalette,
        customGcodeTicksByPlate = customGcodeTicksByPlate,
        // Tier-B mirrors of the BottomRightSummaryPanel button paths.
        // Routing through the existing onSliceClick logic (multi-vs-
        // single, fallback to bundled cube) keeps the slicer behavior
        // identical to a manual tap.
        onSliceActivePlate = {
            if (placedModelsOnActivePlate.size >= 2) {
                runSliceMulti(placedModelsOnActivePlate)
            } else {
                val target = selectedModel ?: placedModelsOnActivePlate.firstOrNull()
                if (target != null) runSlice(target.source, target.label)
            }
        },
        onAutoArrangePlate = { runAutoArrange() },
        onDropToBed = { modelId ->
            placedModels = placedModels.map { m ->
                if (m.id == modelId) m.copy(translateZmm = 0f) else m
            }
        },
        onSaveGcode = {
            val st = sliceState.value
            val src = (st as? SliceUiState.Done)?.result as? SliceResult.Success
            src?.let { saveGcodeToDownloads(ctx, File(it.outputPath), st.sourceLabel) }
        },
        onSaveProject3mf = {
            val target = selectedModel ?: return@BindWorkspaceModel
            scope.launch {
                val cfg = mergedConfig(
                    selectedProfile.value,
                    layerHeightOverride.value,
                    emptyList(),
                    extraOverrides = printSettingsOverrides.value + wipeTowerExtraOverrides(ctx) + fullSpectrumExtraOverrides(mixedFilamentDefinitions.isNotBlank()),
                )
                // D9 / A11 — bundle per-object + per-volume overrides
                // and the active plate's custom-gcode ticks into the
                // saved 3MF so a save → reopen round-trip preserves
                // every authored setting.
                val volMap = target.volumes.associate { v ->
                    // Volume index 0 is the primary mesh; user-added
                    // extras start at 1. PlacedVolume order matches
                    // declaration order.
                    val volIdx = target.volumes.indexOfFirst { it.id == v.id } + 1
                    volIdx to v.configOverrides
                }.filterValues { it.isNotEmpty() }
                saveProjectAs3mfToDownloads(
                    sourceFile = target.source,
                    sourceLabel = target.label,
                    config = cfg,
                    paintFilamentIndex = target.paintFilamentIndex,
                    supportFlags = target.supportFlags,
                    seamFlags = target.seamFlags,
                    fuzzySkinFlags = target.fuzzySkinFlags,
                    brimEars = target.brimEars.toBrimEarsFloatArray(),
                    objectConfigOverrides = target.configOverrides,
                    volumeConfigOverrides = volMap,
                    customGcodeTicks = customGcodeTicksByPlate[activePlateId] ?: emptyList(),
                )
            }
        },
        onSaveModelStl = {
            val target = selectedModel ?: return@BindWorkspaceModel
            scope.launch {
                saveModelAsStlToDownloads(
                    ctx,
                    target.source,
                    target.label,
                    target.rotZDeg,
                    target.scalePct,
                    target.translateXmm,
                    target.translateYmm,
                )
            }
        },
        // Route through the same onFileSelected codepath the file
        // picker triggers — copies the file to cacheDir, bakes the
        // colored GLB, restores paint state from PaintCacheStore,
        // updates bedFit / bedCollision. Identical observable result
        // to a manual pick.
        onLoadModelFromPath = { file, loadMode ->
            pickerMode = when (loadMode) {
                dev.orcaxr.app.mcp.WorkspaceAction.LoadMode.Replace -> PickerMode.Replace
                dev.orcaxr.app.mcp.WorkspaceAction.LoadMode.Add -> PickerMode.Add
            }
            onFileSelected(file)
        },
        // Model-editing flows: each maps to the existing Activity-
        // local function that the per-row context menu / TransformPanel
        // buttons already drive. runCut/runBoolean read selectedModel
        // through closure capture, so set selection first.
        onRepairModel = { id -> runRepair(id) },
        onSimplifyModel = { id, target, maxErr -> runSimplify(id, target, maxErr) },
        onComputeAdaptiveLayerHeights = { action ->
            runComputeAdaptiveLayerHeights(action)
        },
        onSetLayerHeightProfile = { action ->
            // Validation matches the JNI: even count >= 4 with monotonic
            // Z values. Anything else clears the profile rather than
            // silently corrupting the model.
            val raw = action.profile
            val valid = raw == null ||
                (raw.size >= 4 && (raw.size and 1) == 0 &&
                    run {
                        var ok = true
                        var prev = Float.NEGATIVE_INFINITY
                        var i = 0
                        while (i < raw.size && ok) {
                            if (raw[i] < prev) ok = false
                            prev = raw[i]
                            i += 2
                        }
                        ok
                    })
            val effective = if (valid) raw else null
            placedModels = placedModels.map { m ->
                if (m.id == action.modelId) m.copy(layerHeightProfile = effective) else m
            }
        },
        onSetVolumeOverrides = { action ->
            placedModels = placedModels.map { m ->
                if (m.id != action.modelId) m
                else m.copy(volumes = m.volumes.map { v ->
                    if (v.id != action.volumeId) v
                    else v.copy(configOverrides = action.overrides)
                })
            }
        },
        // D9 — replace PlacedModel.configOverrides; threads through
        // both nativeSlice and nativeSaveAs3mf at the next slice / save.
        onSetObjectOverrides = { action ->
            placedModels = placedModels.map { m ->
                if (m.id == action.modelId) m.copy(configOverrides = action.overrides) else m
            }
        },
        // A11 — persist tick mutations through CustomGcodeStore. The
        // store's `ticksByPlate` Flow re-publishes via the
        // `customGcodeTicksByPlate` collectAsState above, which
        // propagates back into `WorkspaceModel.customGcodeTicks` via
        // the LaunchedEffect at the bottom of BindWorkspaceModel's
        // call site.
        onAddCustomGcodeTick = { action ->
            val kind = runCatching { SlicerEngine.CustomGcodeKind.valueOf(action.kind) }
                .getOrDefault(SlicerEngine.CustomGcodeKind.Custom)
            scope.launch {
                customGcodeStore.add(
                    plateId = action.plateId,
                    tick = SlicerEngine.CustomGcodeTick(
                        printZmm = action.zMm,
                        kind = kind,
                        extruder = action.extruder,
                        color = action.color,
                        extra = action.extra,
                    ),
                )
            }
        },
        onRemoveCustomGcodeTick = { action ->
            scope.launch {
                customGcodeStore.removeAt(action.plateId, action.index)
            }
        },
        onClearCustomGcodeTicks = { action ->
            scope.launch {
                customGcodeStore.clear(action.plateId)
            }
        },
        onCutModel = { id, plane ->
            val src = placedModels.firstOrNull { it.id == id }
            if (src != null) runCut(plane, sourceOverride = src)
        },
        onMeshBoolean = { aId, bId, op -> runBoolean(aId, bId, op) },
        onSplitModel = { id -> runSplit(id) },
        onEmbossModel = { action ->
            scope.launch {
                val spec = when (val src = action.source) {
                    is dev.orcaxr.app.mcp.WorkspaceAction.EmbossSource.Text -> {
                        val font = EmbossAssets.BUNDLED_FONTS.firstOrNull { it.id == src.fontId }
                            ?: EmbossAssets.DEFAULT_FONT
                        val fontFile = EmbossAssets.stageBundledFont(ctx, font)
                        EmbossSpec.Text(
                            fontFile = fontFile,
                            text = src.text,
                            sizeMm = action.sizeMm,
                            depthMm = action.depthMm,
                        )
                    }
                    is dev.orcaxr.app.mcp.WorkspaceAction.EmbossSource.Svg -> {
                        EmbossSpec.Svg(
                            svgFile = File(src.svgPath),
                            sizeMm = action.sizeMm,
                            depthMm = action.depthMm,
                        )
                    }
                }
                val mode = when (action.mode) {
                    dev.orcaxr.app.mcp.WorkspaceAction.EmbossMode.Add -> EmbossMode.ADD
                    dev.orcaxr.app.mcp.WorkspaceAction.EmbossMode.Sub -> EmbossMode.SUB
                }
                runEmboss(
                    modelId = action.modelId,
                    spec = spec,
                    mode = mode,
                    translateXmm = action.translateXmm,
                    translateYmm = action.translateYmm,
                    rotZDeg = action.rotZDeg,
                )
            }
        },
        // D15 — standalone text/SVG primitive: build the extruded
        // mesh and feed it into the same onFileSelected codepath the
        // file picker uses, so the result lands as a fresh
        // PlacedModel with paint cache restore + bedFit + bedCollision
        // running identically.
        onAddTextOrSvgObject = { action ->
            scope.launch {
                isLoadingModel = true
                loadingLabel = when (action.source) {
                    is dev.orcaxr.app.mcp.WorkspaceAction.EmbossSource.Text ->
                        "Building text \"${action.source.text.take(24)}\""
                    is dev.orcaxr.app.mcp.WorkspaceAction.EmbossSource.Svg ->
                        "Building SVG ${File(action.source.svgPath).name}"
                }
                val outFile = File(
                    ctx.cacheDir,
                    "emboss_object_${System.currentTimeMillis()}.3mf",
                )
                val built = runCatching {
                    when (val src = action.source) {
                        is dev.orcaxr.app.mcp.WorkspaceAction.EmbossSource.Text -> {
                            val font = EmbossAssets.BUNDLED_FONTS.firstOrNull { it.id == src.fontId }
                                ?: EmbossAssets.DEFAULT_FONT
                            val fontFile = EmbossAssets.stageBundledFont(ctx, font)
                            SlicerEngine.buildTextMesh(
                                fontFile = fontFile,
                                text = src.text,
                                sizeMm = action.sizeMm,
                                depthMm = action.depthMm,
                                output = outFile,
                            )
                        }
                        is dev.orcaxr.app.mcp.WorkspaceAction.EmbossSource.Svg -> {
                            SlicerEngine.buildSvgMesh(
                                svgFile = File(src.svgPath),
                                targetSizeMm = action.sizeMm,
                                depthMm = action.depthMm,
                                output = outFile,
                            )
                        }
                    }
                }.onFailure {
                    android.util.Log.e("OrcaXR", "AddTextOrSvgObject build threw", it)
                }.getOrNull()
                if (built == null) {
                    isLoadingModel = false
                    loadingLabel = null
                    android.widget.Toast.makeText(
                        ctx,
                        "Build failed (see logs).",
                        android.widget.Toast.LENGTH_LONG,
                    ).show()
                    return@launch
                }
                pickerMode = when (action.loadMode) {
                    dev.orcaxr.app.mcp.WorkspaceAction.LoadMode.Replace -> PickerMode.Replace
                    dev.orcaxr.app.mcp.WorkspaceAction.LoadMode.Add -> PickerMode.Add
                }
                onFileSelected(built)
                // onFileSelected runs async in its own scope and clears
                // its own loading flags; release ours so the spinner
                // doesn't double-display.
                isLoadingModel = false
                loadingLabel = null
            }
        },
        // D15 (deferred piece) — text/SVG as a volume on an existing
        // PlacedModel. Composes the AddTextOrSvgObject mesh-build with
        // the AddVolumeToModel attach codepath so a single MCP call
        // can deboss letters into a host model.
        onAddTextOrSvgVolume = { action ->
            scope.launch {
                val host = placedModels.firstOrNull { it.id == action.modelId }
                val volType = runCatching { ModelVolumeType.valueOf(action.volumeType) }.getOrNull()
                if (host == null) {
                    android.util.Log.w("OrcaXR/D15", "AddTextOrSvgVolume: no model id=${action.modelId}")
                    return@launch
                }
                if (volType == null) {
                    android.util.Log.w("OrcaXR/D15", "AddTextOrSvgVolume: bad volumeType=${action.volumeType}")
                    return@launch
                }
                isLoadingModel = true
                loadingLabel = when (action.source) {
                    is dev.orcaxr.app.mcp.WorkspaceAction.EmbossSource.Text ->
                        "Building text \"${action.source.text.take(24)}\" volume"
                    is dev.orcaxr.app.mcp.WorkspaceAction.EmbossSource.Svg ->
                        "Building SVG ${File(action.source.svgPath).name} volume"
                }
                val outFile = File(
                    ctx.cacheDir,
                    "emboss_volume_${System.currentTimeMillis()}.3mf",
                )
                val built = runCatching {
                    when (val src = action.source) {
                        is dev.orcaxr.app.mcp.WorkspaceAction.EmbossSource.Text -> {
                            val font = EmbossAssets.BUNDLED_FONTS.firstOrNull { it.id == src.fontId }
                                ?: EmbossAssets.DEFAULT_FONT
                            val fontFile = EmbossAssets.stageBundledFont(ctx, font)
                            SlicerEngine.buildTextMesh(
                                fontFile = fontFile,
                                text = src.text,
                                sizeMm = action.sizeMm,
                                depthMm = action.depthMm,
                                output = outFile,
                            )
                        }
                        is dev.orcaxr.app.mcp.WorkspaceAction.EmbossSource.Svg -> {
                            SlicerEngine.buildSvgMesh(
                                svgFile = File(src.svgPath),
                                targetSizeMm = action.sizeMm,
                                depthMm = action.depthMm,
                                output = outFile,
                            )
                        }
                    }
                }.onFailure {
                    android.util.Log.e("OrcaXR", "AddTextOrSvgVolume build threw", it)
                }.getOrNull()
                if (built == null) {
                    isLoadingModel = false
                    loadingLabel = null
                    android.widget.Toast.makeText(
                        ctx,
                        "Build failed (see logs).",
                        android.widget.Toast.LENGTH_LONG,
                    ).show()
                    return@launch
                }
                // Route through the AddVolume codepath — selects the
                // host, sets pickerMode, then calls onFileSelected
                // which runs the colored-GLB re-bake + paint
                // propagation just like a manual file-picker volume
                // attach. Same shape as `onAddVolumeToModel` below.
                selectedModelIds = setOf(action.modelId)
                pickerMode = PickerMode.AddVolume(volType)
                onFileSelected(built)
                isLoadingModel = false
                loadingLabel = null
            }
        },
        // Volume operations: AddVolume routes through the same
        // PickerMode.AddVolume codepath the file picker uses (so the
        // colored-GLB re-bake / paint propagation runs identically).
        // RemoveVolume is a direct PlacedModel.copy(volumes = ...).
        onAddVolumeToModel = { modelId, sourcePath, typeName ->
            val type = runCatching { ModelVolumeType.valueOf(typeName) }.getOrNull()
            val src = File(sourcePath)
            if (type != null && src.exists() && src.canRead()) {
                selectedModelIds = setOf(modelId)
                pickerMode = PickerMode.AddVolume(type)
                onFileSelected(src)
            }
        },
        onRemoveVolume = { modelId, volumeId ->
            placedModels = placedModels.map { m ->
                if (m.id == modelId) m.copy(volumes = m.volumes.filterNot { it.id == volumeId })
                else m
            }
        },
        onAddMagnets = { action -> runMagnets(action) },
        // Paint state mutations route through PaintHistory so MCP edits
        // are undoable in XR (and vice versa). The auto-debounced
        // observers above (LE_2800 paint→GLB rebake, LE_2819 paint→
        // PaintCacheStore write) fire automatically on placedModels
        // change.
        onClearPaint = { id, kind ->
            applyPaintMutation(id, paintHistory) { m ->
                when (kind) {
                    null -> m.copy(
                        paintFilamentIndex = null,
                        supportFlags = null,
                        seamFlags = null,
                        fuzzySkinFlags = null,
                    )
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Color ->
                        m.copy(paintFilamentIndex = null)
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Support ->
                        m.copy(supportFlags = null)
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Seam ->
                        m.copy(seamFlags = null)
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.FuzzySkin ->
                        m.copy(fuzzySkinFlags = null)
                }
            }
            paintHistoryVersion++
        },
        onReplacePaintTag = { id, kind, fromTag, toTag ->
            applyPaintMutation(id, paintHistory) { m ->
                val from = fromTag.toByte()
                val to = toTag.toByte()
                fun remap(arr: ByteArray?): ByteArray? {
                    if (arr == null) return arr
                    val out = arr.copyOf()
                    var anyChange = false
                    for (i in out.indices) {
                        if (out[i] == from) { out[i] = to; anyChange = true }
                    }
                    return if (anyChange) out else arr
                }
                when (kind) {
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Color ->
                        m.copy(paintFilamentIndex = remap(m.paintFilamentIndex))
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Support ->
                        m.copy(supportFlags = remap(m.supportFlags))
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Seam ->
                        m.copy(seamFlags = remap(m.seamFlags))
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.FuzzySkin ->
                        m.copy(fuzzySkinFlags = remap(m.fuzzySkinFlags))
                }
            }
            paintHistoryVersion++
        },
        onPaintPlaneSplit = { action -> runPaintPlaneSplit(action) },
        onPaintUndo = { id ->
            if (paintHistory.canUndo(id)) {
                val snap = paintHistory.undo(id)
                if (snap != null) {
                    placedModels = placedModels.map { m ->
                        if (m.id == id) m.copy(
                            paintFilamentIndex = snap.paintFilamentIndex ?: m.paintFilamentIndex,
                            supportFlags = snap.supportFlags ?: m.supportFlags,
                            seamFlags = snap.seamFlags ?: m.seamFlags,
                            fuzzySkinFlags = snap.fuzzySkinFlags ?: m.fuzzySkinFlags,
                        ) else m
                    }
                    paintHistoryVersion++
                    paintContentVersion++
                }
            }
        },
        onPaintRedo = { id ->
            if (paintHistory.canRedo(id)) {
                val snap = paintHistory.redo(id)
                if (snap != null) {
                    placedModels = placedModels.map { m ->
                        if (m.id == id) m.copy(
                            paintFilamentIndex = snap.paintFilamentIndex ?: m.paintFilamentIndex,
                            supportFlags = snap.supportFlags ?: m.supportFlags,
                            seamFlags = snap.seamFlags ?: m.seamFlags,
                            fuzzySkinFlags = snap.fuzzySkinFlags ?: m.fuzzySkinFlags,
                        ) else m
                    }
                    paintHistoryVersion++
                    paintContentVersion++
                }
            }
        },
        // C9 milestone 1: AI-paint triangle-set application. Walks the
        // merge mode (Replace / OnlyUnpainted / OnlyTagged) and routes
        // through `applyPaintMutation` so PaintHistory + paint cache
        // + paintContentVersion all bump exactly once per MCP call.
        onPaintTriangleSet = { action ->
            applyPaintMutation(action.modelId, paintHistory) { m ->
                val before = when (action.kind) {
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Color -> m.paintFilamentIndex
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Support -> m.supportFlags
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Seam -> m.seamFlags
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.FuzzySkin -> m.fuzzySkinFlags
                }
                // Determine the working buffer's size. If the kind has
                // never been authored we infer it from any other paint
                // array (they're parallel to the source mesh's tri
                // count); failing that, fall back to the largest
                // triangle index in the action + 1.
                val triCount = before?.size
                    ?: m.paintFilamentIndex?.size
                    ?: m.supportFlags?.size
                    ?: m.seamFlags?.size
                    ?: m.fuzzySkinFlags?.size
                    ?: ((action.triangleIndices.maxOrNull() ?: -1) + 1)
                if (triCount <= 0) return@applyPaintMutation m
                val out = before?.copyOf(triCount) ?: ByteArray(triCount)
                val tagB = action.tag.toByte()
                val whereB = action.whereTag.toByte()
                for (idx in action.triangleIndices) {
                    if (idx < 0 || idx >= triCount) continue
                    val cur = out[idx]
                    val accept = when (action.mergeMode) {
                        dev.orcaxr.app.mcp.WorkspaceAction.MergeMode.Replace -> true
                        dev.orcaxr.app.mcp.WorkspaceAction.MergeMode.OnlyUnpainted -> cur.toInt() == 0
                        dev.orcaxr.app.mcp.WorkspaceAction.MergeMode.OnlyTagged -> cur == whereB
                    }
                    if (accept) out[idx] = tagB
                }
                when (action.kind) {
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Color -> m.copy(paintFilamentIndex = out)
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Support -> m.copy(supportFlags = out)
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.Seam -> m.copy(seamFlags = out)
                    dev.orcaxr.app.mcp.WorkspaceAction.PaintKind.FuzzySkin -> m.copy(fuzzySkinFlags = out)
                }
            }
            paintHistoryVersion++
        },
        // D18j — replay a saved paint recipe in one applyPaintMutation
        // call, so a recipe load is one undo step instead of N
        // PaintTriangleSet emissions per kind/tag combination.
        onLoadPaintState = { action ->
            applyPaintMutation(action.modelId, paintHistory) { m ->
                m.copy(
                    paintFilamentIndex = action.paintFilamentIndex,
                    supportFlags = action.supportFlags,
                    seamFlags = action.seamFlags,
                    fuzzySkinFlags = action.fuzzySkinFlags,
                )
            }
            paintHistoryVersion++
        },
    )

    // C9 milestone 1 — register the AI-paint BVH provider so MCP tools
    // can fetch the same BVH the XR brush uses (built lazily by the
    // LaunchedEffect at LE_3166 on first paint-mode toggle). The
    // provider also handles cold starts: an LLM that calls
    // `paint_sphere` before the user has ever touched the brush
    // triggers a synchronous build off Dispatchers.Default, so no
    // separate "warm up paint" tool is needed. The provider closes
    // over the in-Compose `bvhCache` reference; that's fine because
    // MeshBvhCache is internally synchronized and its identity
    // doesn't change across recompositions (`remember { … }`).
    LaunchedEffect(Unit) {
        val ws = dev.orcaxr.app.mcp.WorkspaceModel.get()
        ws.setBvhProvider(
            dev.orcaxr.app.mcp.WorkspaceModel.BvhProvider { modelId ->
                bvhCache.get(modelId)?.let { return@BvhProvider it }
                val model = ws.placedModels.value.firstOrNull { it.id == modelId }
                    ?: return@BvhProvider null
                // The paint BVH MUST be the exact mesh the paint
                // pipeline authors onto / slices /
                // renders: model.objects[bakeIndex].volumes.front()
                // .mesh(). deriveStlFor() merges every object's
                // instanced mo->mesh() → for a multi-volume / instanced
                // 3MF that is a DIFFERENT (often 3-4×) tessellation than
                // the single volume apply_orcaxr_paint targets, so a
                // paintFilamentIndex sized to that BVH lands on the
                // wrong triangles and the model renders black (gotcha
                // #21 family). For 3MF/AMF build the BVH from
                // writeVolumeStl using the SAME source+object index the
                // colored-GLB / slice path uses; STL inputs already have
                // one consistent mesh so deriveStlFor is correct there.
                val resolved = run {
                    val paintSource = model.originalSource ?: model.source
                    val paintExt = paintSource.extension.lowercase()
                    if (paintExt == "3mf" || paintExt == "amf") {
                        val bakeIndex =
                            if (model.originalSource != null) model.groupOrdinal else -1
                        val volStl = File(ctx.cacheDir, "bvh_vol_${modelId}.stl")
                        runCatching {
                            if (SlicerEngine.writeVolumeStl(paintSource, volStl, bakeIndex)) {
                                volStl
                            } else {
                                null
                            }
                        }.getOrNull()
                            ?: runCatching { deriveStlFor(model.source) }.getOrNull()
                    } else {
                        runCatching { deriveStlFor(model.source) }.getOrNull()
                    }
                } ?: return@BvhProvider null
                withContext(Dispatchers.Default) {
                    val mesh = runCatching { StlReader.read(resolved) }
                        .getOrNull() ?: return@withContext null
                    val shiftX = -(mesh.bboxMin.x + mesh.bboxMax.x) / 2f
                    val shiftY = -(mesh.bboxMin.y + mesh.bboxMax.y) / 2f
                    val shiftZ = -mesh.bboxMin.z
                    val centered = mesh.translatedXyz(shiftX, shiftY, shiftZ)
                    val bvh = runCatching { MeshBvh.build(centered) }
                        .getOrNull() ?: return@withContext null
                    bvhCache.put(modelId, bvh)
                    bvh
                }
            },
        )
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
        selectedModelIds.firstOrNull(),
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
        // like. Unpainted generic STLs render single-color, so the
        // palette change doesn't affect them; extracted 3MF STL parts
        // carry previewFilamentIndex and must refresh when the
        // embedded/project palette changes.
        val ids = placedModels
            .filter {
                val ext = it.source.extension.lowercase()
                ext in setOf("3mf", "amf") ||
                    hasAnyPaint(it.paintFilamentIndex) ||
                    it.previewFilamentIndex > 0
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
    // bakes would be unusable.
    //
    // Keyed on `paintContentVersion` (a counter the stamp dispatcher
    // bumps on every in-place mutation) rather than on
    // `placedModels.map { it.paintFilamentIndex }` because, after
    // the 2026-05-02 in-place-stamp refactor, the paintFilamentIndex
    // ByteArray reference no longer changes between MOVE events.
    // Reference-equality keys would never re-key, the rebake would
    // never fire, and the user wouldn't see their paint until the
    // app restarted.
    LaunchedEffect(paintContentVersion) {
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
        listOf(it.source.absolutePath, it.paintFilamentIndex, it.supportFlags, it.seamFlags, it.fuzzySkinFlags)
    }) {
        kotlinx.coroutines.delay(300)
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            for (m in placedModels) {
                val anyPaint = hasAnyPaint(m.paintFilamentIndex) ||
                    hasAnyPaint(m.supportFlags) ||
                    hasAnyPaint(m.seamFlags) ||
                    hasAnyPaint(m.fuzzySkinFlags)
                // Tri count is recoverable from any of the four
                // arrays (they're all sized to mesh.triCount on
                // first stamp). When every array is null/empty
                // (anyPaint == false) we still call save so the
                // cache prunes the prior entry — matches the
                // "user cleared paint, persist that" expectation.
                val triCount = m.paintFilamentIndex?.size
                    ?: m.supportFlags?.size
                    ?: m.seamFlags?.size
                    ?: m.fuzzySkinFlags?.size
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
                            fuzzySkinFlags = m.fuzzySkinFlags,
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
    //
    // The STL-read + BVH-build runs on `Dispatchers.Default` because
    // for million-triangle meshes (e.g. 1.4M tris on the user's
    // dragon.3mf) it takes 30+ seconds and was blocking the
    // AndroidUiDispatcher. Symptom that triggered the off-thread move
    // (2026-05-02): user tapped Paint, headset froze, paint silently
    // didn't work for 36 s while the BVH built on the UI coroutine,
    // then started working with no indication that anything had
    // changed. A Toast announces the wait so the user knows the
    // headset isn't dead.
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
            // deriveStlFor handles the ASCII-STL fallback (probe-read
            // first, then libslic3r round-trip) so the BVH path
            // doesn't need to repeat that logic.
            val resolved = runCatching { deriveStlFor(src) }.getOrNull() ?: continue
            android.widget.Toast.makeText(
                ctx,
                "Building paint cache for ${m.label}…",
                android.widget.Toast.LENGTH_SHORT,
            ).show()
            android.util.Log.i("OrcaXR/paint",
                "BVH build start for ${m.label} (id=${m.id})")
            val t0 = android.os.SystemClock.uptimeMillis()
            val built = withContext(Dispatchers.Default) {
                val mesh = runCatching { StlReader.read(resolved) }.getOrNull()
                    ?: return@withContext null
                // Match `nativeWriteColoredGlb`'s centering shift so the
                // BVH lives in the SAME coordinate frame as the rendered
                // GLB. The JNI shifts every vertex by
                //   (-(min_x+max_x)/2, -(min_y+max_y)/2, -min_z)
                // (XY-center, Z-ground). Without this match the
                // derived STL keeps original printer-bed coordinates
                // (e.g. dragon at X≈109..161, Y≈106..165) while the
                // GLB renders at X(-25.9..25.9) Y(-29.2..29.2). Rays
                // computed via `hit.transform` are in GLB-coords, so
                // they miss every BVH triangle by ~135 mm. Fix
                // (2026-05-02): apply the same shift here.
                val shiftX = -(mesh.bboxMin.x + mesh.bboxMax.x) / 2f
                val shiftY = -(mesh.bboxMin.y + mesh.bboxMax.y) / 2f
                val shiftZ = -mesh.bboxMin.z
                val centered = mesh.translatedXyz(shiftX, shiftY, shiftZ)
                android.util.Log.i("OrcaXR/paint",
                    "BVH centered: shift=($shiftX,$shiftY,$shiftZ) " +
                        "newBbox=(${centered.bboxMin.x}..${centered.bboxMax.x}, " +
                        "${centered.bboxMin.y}..${centered.bboxMax.y}, " +
                        "${centered.bboxMin.z}..${centered.bboxMax.z})")
                val bvh = runCatching { MeshBvh.build(centered) }.getOrNull()
                    ?: return@withContext null
                centered.triCount to bvh
            }
            if (built == null) {
                android.util.Log.w("OrcaXR/paint",
                    "BVH build failed for ${m.label}")
                continue
            }
            val (triCount, bvh) = built
            bvhCache.put(m.id, bvh)
            bvhCacheVersion++
            val ms = android.os.SystemClock.uptimeMillis() - t0
            android.util.Log.i("OrcaXR/paint",
                "BVH built for ${m.label} ($triCount tris in ${ms}ms)")
            if (ms >= 1000L) {
                android.widget.Toast.makeText(
                    ctx,
                    "Paint ready for ${m.label}",
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
            }
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
        // Read bvhCacheVersion so this function recomposes when a
        // BVH lands. Without this read, the underlying Map mutation
        // is invisible to Compose and paintHooks stays null.
        @Suppress("UNUSED_VARIABLE")
        val cacheGen = bvhCacheVersion
        val bvh = bvhCache.get(model.id) ?: return null
        return PaintInputHooks(
            brush = paintBrushLive.value,
            bvh = bvh,
            onPaint = { hitTri, action ->
                val brush = paintBrushLive.value
                // Paint full-feature-parity (Smart Fill) — when
                // brush.smartFill is on, the next stamp walks
                // adjacency by normal-angle gate instead of by mm
                // radius. Used by every paint mode below so the user's
                // smart-fill toggle applies uniformly.
                fun pickTriangles(seed: Int): IntArray = when {
                    brush.smartFill -> bvh.smartFillBfs(seed, brush.smartFillAngleDeg)
                    brush.radiusMm <= 0f -> intArrayOf(seed)
                    else -> bvh.radiusBfs(seed, brush.radiusMm)
                }
                // Paint full-feature-parity (Undo) — snapshot the
                // BEFORE-state of the array(s) this stroke might touch
                // on DOWN. LayOnFace is excluded (it's a one-shot
                // rotation pick, not a paint mutation). The end of the
                // stroke is closed by an UP action, a brush mode
                // change, or selecting a different model — all routed
                // via the `endActiveStroke` helper below.
                if (action == androidx.xr.scenecore.InputEvent.Action.DOWN &&
                    brush.mode != PaintMode.LayOnFace &&
                    brush.mode != PaintMode.Off
                ) {
                    // PaintHistory keeps the BEFORE/AFTER snapshots
                    // BY REFERENCE (see PaintHistory.Snapshot). To
                    // let the active stroke mutate the model's array
                    // in place during MOVEs (avoiding the 1.4 MB
                    // clone per event that was OOMing the heap), we
                    // hand history an immutable CLONE of the current
                    // state — and only that clone — at stroke begin.
                    // The model's paintFilamentIndex is replaced by a
                    // separate stroke buffer below so the history
                    // snapshot stays untouched no matter how many
                    // MOVEs land.
                    paintHistory.beginStroke(
                        modelId = model.id,
                        currentState = PaintHistory.Snapshot(
                            paintFilamentIndex = model.paintFilamentIndex?.copyOf(),
                            supportFlags = model.supportFlags?.copyOf(),
                            seamFlags = model.seamFlags?.copyOf(),
                            fuzzySkinFlags = model.fuzzySkinFlags?.copyOf(),
                        ),
                    )
                    paintHistoryVersion++
                    lastStampedTri[0] = -1
                }
                // Allocation throttle: skip the stamp when the user is
                // holding still on the same triangle. Without this, a
                // 1.37M-tri mesh OOMs the JVM after ~1 minute of
                // held-pinch because each MOVE event clones a fresh
                // ByteArray (paintFilamentIndex) and BooleanArray
                // (radiusBfs.visited) — about 3 MB / event at ~60 Hz.
                // DOWN/UP always pass through (history begin/end
                // bookkeeping); only redundant MOVE stamps are
                // dropped. The triangle key isn't perfect for radius
                // paint (the user might shift slightly within the
                // brush), but for the common "hold still on a single
                // facet" case it's the cheapest bypass.
                if (action == androidx.xr.scenecore.InputEvent.Action.MOVE &&
                    hitTri == lastStampedTri[0]
                ) {
                    return@PaintInputHooks
                }
                // Time throttle: cap MOVE stamps at ~30 Hz so even
                // when the user is dragging across many triangles
                // (so the same-tri guard above doesn't fire) the
                // 1.4 MB ByteArray clones don't pile up faster than
                // GC can reclaim. DOWN/UP always pass through.
                if (action == androidx.xr.scenecore.InputEvent.Action.MOVE) {
                    val now = android.os.SystemClock.uptimeMillis()
                    if (now - lastStampMs[0] < 33L) return@PaintInputHooks
                    lastStampMs[0] = now
                }
                // UP sentinel from PaintInputHooks (hitTri = -1) closes
                // the open stroke. Read the model's current state from
                // the live placedModels list — by the time UP fires the
                // model state has been mutated by every MOVE in the
                // stroke, so re-look up the latest copy.
                if (action == androidx.xr.scenecore.InputEvent.Action.UP) {
                    val latest = placedModels.firstOrNull { it.id == model.id }
                    if (latest != null) {
                        paintHistory.endStroke(
                            modelId = model.id,
                            endState = PaintHistory.Snapshot(
                                paintFilamentIndex = latest.paintFilamentIndex,
                                supportFlags = latest.supportFlags,
                                seamFlags = latest.seamFlags,
                                fuzzySkinFlags = latest.fuzzySkinFlags,
                            ),
                        )
                        paintHistoryVersion++
                    }
                    return@PaintInputHooks
                }
                when (brush.mode) {
                    PaintMode.Color -> {
                        val triIndices = pickTriangles(hitTri)
                        // First stamp of the stroke (or model has no
                        // paint yet): allocate a stroke buffer once,
                        // copying any existing paint state. Subsequent
                        // stamps in the same stroke mutate this buffer
                        // in place — see `stampTrianglesInPlace`.
                        // The model's paintFilamentIndex now references
                        // this buffer directly; PaintHistory holds a
                        // separate clone (see DOWN handler above) so
                        // undo isn't corrupted.
                        val existing = model.paintFilamentIndex
                        val target = if (existing != null && existing.size == bvh.triCount) {
                            existing
                        } else {
                            ByteArray(bvh.triCount).also { fresh ->
                                existing?.let { System.arraycopy(it, 0, fresh, 0, minOf(it.size, fresh.size)) }
                            }
                        }
                        stampTrianglesInPlace(target, triIndices, brush.activeSlot)
                        // Only swap the placedModels list when the
                        // ByteArray reference changes (i.e. on the
                        // first stamp of the stroke or after a model
                        // re-load). For subsequent in-place stamps
                        // the reference is stable; bumping
                        // paintContentVersion is what tells the
                        // rebake LE that the contents changed.
                        if (target !== existing) {
                            placedModels = placedModels.map {
                                if (it.id == model.id) it.copy(paintFilamentIndex = target) else it
                            }
                        }
                        paintContentVersion++
                        lastStampedTri[0] = hitTri
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
                        val triIndices = pickTriangles(hitTri)
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
                        val triIndices = pickTriangles(hitTri)
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
                    PaintMode.BrimEars -> {
                        // Paint full-feature-parity (Brim Ears) — each
                        // DOWN drops one BrimEarPoint at the picked
                        // triangle's centroid in mesh-local mm.
                        // Centroid (vs ray-hit point) is enough because
                        // brim ears are 5 mm discs — triangle
                        // granularity is finer than the print feature.
                        // We intentionally ignore MOVE so a drag
                        // doesn't sprinkle dozens of overlapping
                        // points; one click = one ear.
                        if (action != androidx.xr.scenecore.InputEvent.Action.DOWN) return@PaintInputHooks
                        val c = bvh.triangleCentroid(hitTri)
                        // Round to 0.1 mm so two clicks at the same
                        // visual point coalesce in equality checks
                        // (the de-dup affordance below).
                        val rx = (kotlin.math.round(c.x * 10f) / 10f)
                        val ry = (kotlin.math.round(c.y * 10f) / 10f)
                        val rz = (kotlin.math.round(c.z * 10f) / 10f)
                        val newPoint = BrimEarPoint(rx, ry, rz, headRadiusMm = 5f)
                        // Avoid duplicate points within 1 mm of an
                        // existing one — finger-tap jitter shouldn't
                        // produce a stack.
                        val dedup = model.brimEars.none {
                            kotlin.math.abs(it.x - rx) < 1f &&
                            kotlin.math.abs(it.y - ry) < 1f &&
                            kotlin.math.abs(it.z - rz) < 1f
                        }
                        if (dedup) {
                            placedModels = placedModels.map {
                                if (it.id == model.id) it.copy(brimEars = it.brimEars + newPoint) else it
                            }
                            android.util.Log.i(
                                "OrcaXR/paint",
                                "brim ear added at ($rx, $ry, $rz)mm on ${model.label}",
                            )
                        }
                    }
                    PaintMode.FuzzySkin -> {
                        // Paint full-feature-parity — fuzzy-skin paint.
                        // Same flood-fill shape as support / seam, but
                        // stamps fuzzySkinFlags with state 1 (FUZZY_SKIN).
                        // Single-state painter — there's no "fuzzy
                        // blocker"; clearing requires an explicit reset
                        // affordance (handled by the slot=0 path the
                        // user can drive via the brush slot picker).
                        val triIndices = pickTriangles(hitTri)
                        // brush.activeSlot != 0 → paint state 1; activeSlot == 0
                        // → clear (state 0). That keeps the existing
                        // "Clear" affordance in the brush UI working
                        // for fuzzy paint without a separate blocker.
                        val state: Int = if (brush.activeSlot == 0) 0 else 1
                        val updated = stampTriangles(
                            previous = model.fuzzySkinFlags,
                            triCount = bvh.triCount,
                            triangleIndices = triIndices,
                            slot = state,
                        )
                        placedModels = placedModels.map {
                            if (it.id == model.id) it.copy(fuzzySkinFlags = updated) else it
                        }
                        android.util.Log.i(
                            "OrcaXR/paint",
                            "stamped ${triIndices.size} fuzzy-skin tris (seed=$hitTri) " +
                                "state=$state action=$action on ${model.label}",
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
    // C7 — digital-twin layer auto-follow. When the user is in Devices
    // mode AND the active printer has reported a live Z height AND
    // the current slice's parsed toolpath is the one being printed,
    // map the live Z onto the layer-index space and drive maxLayer
    // automatically. The result is the toolpath GLB "growing" in
    // lockstep with the physical print head.
    //
    // Keyed on workspaceMode + selectedPrinterId so the effect
    // cancels when the user leaves Devices mode (no point updating
    // maxLayer if the toolpath is hidden anyway). The inner polling
    // is light: just reads printerSnapshots[id] which is already
    // pumped by the existing 2s status loop. We don't initiate any
    // additional Moonraker requests.
    LaunchedEffect(workspaceMode, selectedPrinterId.value) {
        if (workspaceMode != WorkspaceMode.Devices) return@LaunchedEffect
        val printerId = selectedPrinterId.value ?: return@LaunchedEffect
        while (kotlin.coroutines.coroutineContext[kotlinx.coroutines.Job]?.isActive != false) {
            val snap = printerSnapshots[printerId]
            val parsed = (sliceState.value as? SliceUiState.Done)?.parsed
            val liveZ = snap?.liveZmm
            if (parsed != null && liveZ != null && parsed.layerZs.isNotEmpty()) {
                // binarySearch returns the matching index, or
                // -insertionPoint - 1 if the value falls between
                // layer Zs (which is the common case — the toolhead's
                // live Z is usually mid-layer-thickness above the
                // last completed layer's Z).
                val idx = parsed.layerZs.binarySearch(liveZ).let {
                    if (it >= 0) it else -(it + 1) - 1
                }.coerceIn(0, parsed.layerZs.lastIndex)
                if (maxLayer.value != idx) maxLayer.value = idx
            }
            kotlinx.coroutines.delay(500)
        }
    }

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
            val sel = selectedModelIds.firstOrNull()
            // Paint full-feature-parity (radius adjust) — when paint
            // mode is active, intercept stick Y to nudge brush radius
            // continuously instead of moving the model. Stick X still
            // cycles model rotation, just like Prepare's normal pump,
            // but Y becomes "shrink/grow brush" so the user can fine-
            // tune brush size without moving their hand to the chip.
            // The 0..50 mm clamp covers the practical range; smart-
            // fill mode adjusts the angle gate (1..90°) instead.
            val brushModeActive = paintBrushLive.value.mode != PaintMode.Off &&
                paintBrushLive.value.mode != PaintMode.LayOnFace
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
                if (brushModeActive) {
                    // Continuous nudge — apply a fractional delta per
                    // tick proportional to stick deflection above the
                    // 0.3 deadband. ~10 mm/sec at full deflection.
                    if (yMag > 0.3f) {
                        val curBrush = paintBrushLive.value
                        if (curBrush.smartFill) {
                            val newAngle = (curBrush.smartFillAngleDeg + yRaw * 1.5f)
                                .coerceIn(1f, 90f)
                            paintBrush = curBrush.copy(smartFillAngleDeg = newAngle)
                        } else {
                            val newR = (curBrush.radiusMm + yRaw * 0.2f).coerceIn(0f, 50f)
                            paintBrush = curBrush.copy(radiusMm = newR)
                        }
                    }
                } else {
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
                            extraOverrides = printSettingsOverrides.value + wipeTowerExtraOverrides(ctx) + fullSpectrumExtraOverrides(mixedFilamentDefinitions.isNotBlank()),
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
                        val fuzzyForSlice = testStatePlacedModels.firstOrNull()?.fuzzySkinFlags
                        val brimEarsForSlice = testStatePlacedModels.firstOrNull()
                            ?.brimEars?.toBrimEarsFloatArray()
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
                            fuzzySkinFlags = fuzzyForSlice,
                            brimEars = brimEarsForSlice,
                            objectConfigOverrides = testStatePlacedModels.firstOrNull()?.configOverrides ?: emptyMap(),
                            layerHeightProfile = testStatePlacedModels.firstOrNull()?.layerHeightProfile,
                            customGcodeTicks = customGcodeTicksByPlate[activePlateId] ?: emptyList(),
                            heightRanges = testStatePlacedModels.firstOrNull()?.heightRanges ?: emptyList(),
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
                    val target = testStatePlacedModels.firstOrNull { it.id == selectedModelIds.firstOrNull() }
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
                    val target = testStatePlacedModels.firstOrNull { it.id == selectedModelIds.firstOrNull() }
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
                    val target = placed.firstOrNull { it.id == selectedModelIds.firstOrNull() } ?: placed.firstOrNull()
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
                    val target = testStatePlacedModels.firstOrNull { it.id == selectedModelIds.firstOrNull() }
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
                    val targetId = selectedModelIds.firstOrNull() ?: testStatePlacedModels.firstOrNull()?.id
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
                    val sel = testStatePlacedModels.firstOrNull { it.id == selectedModelIds.firstOrNull() }
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
                                selectedModelIds = setOfNotNull(cubeId)
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
    LaunchedEffect(sliceState.value, maxLayer.value, showTravels.value, toolpathTubes.value, toolpathColorMode.value, paddedSlots) {
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
                    colorMode = ToolpathGlb.ColorMode.parse(toolpathColorMode.value),
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
            val root = Entity.create(session, "OrcaXR-root")
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
        if (rootEntity == null) {
            android.util.Log.w("OrcaXR", "workspaceEntity: rootEntity is null")
            return@remember null
        }
        val res = runCatching {
            val ws = Entity.create(session, "OrcaXR-workspace")
            ws.parent = rootEntity
            ws.setPose(
                androidx.xr.runtime.math.Pose(
                    androidx.xr.runtime.math.Vector3(0f, WORKSPACE_Y_OFFSET, 0.0f),
                    WORKSPACE_ROTATION,
                ),
            )
            ws
        }
        res.onFailure { android.util.Log.e("OrcaXR", "workspaceEntity creation failed", it) }
        res.getOrNull()
    }

    Subspace {
        rootEntity?.let { root ->
            // Plate-move mode. While `plateMovable` is true a single
            // MovableComponent on the workspace entity catches any
            // pinch over the bed footprint and translates the entire
            // workspace (bed + models) in world space. While false the
            // component is removed so model gizmos and selection get
            // unobstructed pinches. Toggled from PlateTabPanel.
            //
            // The bed is roughly square (256–270 mm typical), so a
            // cubical hit volume sized to the larger bed dimension in
            // world meters covers the footprint regardless of how
            // SceneCore interprets MovableComponent.size relative to
            // WORKSPACE_ROTATION (-90° X). The visible bed is rendered
            // by buildPlate.glb under this same workspace entity and
            // sits at workspaceTx in world space, so the AABB centers
            // on the bed.
            var workspaceMovable by remember {
                mutableStateOf<androidx.xr.scenecore.MovableComponent?>(null)
            }
            LaunchedEffect(workspaceEntity, plateMovable, bedW, bedH) {
                val ws = workspaceEntity ?: return@LaunchedEffect
                workspaceMovable?.let { existing ->
                    if (!ws.isDisposed) runCatching { ws.removeComponent(existing) }
                }
                workspaceMovable = null
                if (!plateMovable) return@LaunchedEffect

                val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
                val listener = object : androidx.xr.scenecore.EntityMoveListener {
                    override fun onMoveStart(
                        entity: androidx.xr.scenecore.Entity,
                        initialInputRay: androidx.xr.runtime.math.Ray,
                        initialPose: androidx.xr.runtime.math.Pose,
                        initialScale: Float,
                        initialParent: androidx.xr.scenecore.Entity,
                    ) {
                        isWorkspaceGrabbing = true
                    }

                    override fun onMoveUpdate(
                        entity: androidx.xr.scenecore.Entity,
                        currentInputRay: androidx.xr.runtime.math.Ray,
                        currentPose: androidx.xr.runtime.math.Pose,
                        currentScale: Float,
                    ) {
                        // Gotcha #13/#22 — drop pose updates while any
                        // model bake is mid-swap. The setPose below
                        // dispatches to the workspace GroupEntity whose
                        // GltfModelEntity children are being torn down
                        // and recreated; a queued pose op referencing a
                        // freed Filament material instance crashes the
                        // render thread with SIGABRT "unknown material
                        // instance id". Resumes the moment the bake
                        // completes (typically <500 ms).
                        if (bakeInFlight.isNotEmpty()) return
                        // Discard the system-proposed rotation; the
                        // workspace must stay upright (WORKSPACE_ROTATION
                        // maps printer-Z → world-Y so a "leaned"
                        // workspace would tip the bed and prints).
                        val newTx = currentPose.translation
                        workspaceTx = newTx
                        ws.setPose(androidx.xr.runtime.math.Pose(newTx, WORKSPACE_ROTATION))
                    }

                    override fun onMoveEnd(
                        entity: androidx.xr.scenecore.Entity,
                        finalInputRay: androidx.xr.runtime.math.Ray,
                        finalPose: androidx.xr.runtime.math.Pose,
                        finalScale: Float,
                        updatedParent: androidx.xr.scenecore.Entity?,
                    ) {
                        isWorkspaceGrabbing = false
                    }
                }
                val mc = androidx.xr.scenecore.MovableComponent.createCustomMovable(
                    session, false, executor, listener,
                )
                val bw = if (bedW > 0) bedW else 256f
                val bh = if (bedH > 0) bedH else 256f
                val side = maxOf(bw, bh) * WORLD_SCALE
                mc.size = androidx.xr.runtime.math.FloatSize3d(side, side, side)
                ws.addComponent(mc)
                workspaceMovable = mc
                android.util.Log.i("OrcaXR", "Workspace MovableComponent attached (size=$side m)")
            }

            DisposableEffect(Unit) {
                onDispose {
                    workspaceMovable?.let { mc ->
                        val ws = workspaceEntity
                        if (ws != null && !ws.isDisposed) {
                            runCatching { ws.removeComponent(mc) }
                        }
                    }
                }
            }

            SceneCoreEntity(
                factory = { root },
                modifier = SubspaceModifier,
            ) {
                // Top Navigation Pill
                MovablePanelWrapper(
                    id = "top-nav",
                    width = 800.dp,
                    height = 250.dp, // Increased height for two-tier layout
                    // Top-center; raised to +0.55 so it sits above the
                    // build plate area and frees y=0 for the side
                    // panels.
                    initialOffset = androidx.xr.runtime.math.Vector3(0f, 0.55f, -0.2f),
                    session = session,
                ) {
                    TopNavigationPill(
                        mode = workspaceMode,
                        onModeChange = { workspaceMode = it },
                        previewEnabled = glbPath != null,
                        onResetWorkspace = {
                            val newWsTx = androidx.xr.runtime.math.Vector3(0f, WORKSPACE_Y_OFFSET, 0.0f)
                            workspaceTx = newWsTx
                            // Reset model
                            workspaceEntity?.setPose(
                                androidx.xr.runtime.math.Pose(
                                    newWsTx,
                                    WORKSPACE_ROTATION,
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
                        onToggleDevices = {
                            // C7 — Devices is now a workspace mode, not
                            // just an overlay toggle. Entering Devices
                            // hides the slicing UI and brings up the
                            // PrinterPanel + PrintMonitorPanel; leaving
                            // returns to whichever non-Devices mode the
                            // user was last in (Prepare unless we still
                            // have a slice baked, in which case stay in
                            // Preview so the user doesn't lose their
                            // toolpath view).
                            val nowOpen = !devicesShown
                            devicesShown = nowOpen
                            workspaceMode = if (nowOpen) {
                                WorkspaceMode.Devices
                            } else if (glbPath != null) {
                                WorkspaceMode.Preview
                            } else {
                                WorkspaceMode.Prepare
                            }
                        },
                        helpShown = helpShown,
                        onToggleHelp = { helpShown = !helpShown },
                        settingsShown = settingsShown,
                        onToggleSettings = { settingsShown = !settingsShown },
                        addPrimitiveShown = addPrimitiveShown,
                        onToggleAddPrimitive = { addPrimitiveShown = !addPrimitiveShown },
                        customGcodeShown = customGcodeShown,
                        onToggleCustomGcode = { customGcodeShown = !customGcodeShown },
                        // Roadmap A10 — adaptive layer height authoring panel.
                        adaptiveLayerShown = adaptiveLayerShown,
                        onToggleAdaptiveLayer = { adaptiveLayerShown = !adaptiveLayerShown },
                        // Roadmap D17 — mesh simplify authoring panel.
                        simplifyShown = simplifyShown,
                        onToggleSimplify = { simplifyShown = !simplifyShown },
                        // Roadmap C8 — voice command panel.
                        voiceShown = voiceShown,
                        onToggleVoice = { voiceShown = !voiceShown },
                        gizmoTool = gizmoTool,
                        onGizmoToolChange = { gizmoTool = it },
                        transformToolsEnabled = selectedModel != null,
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
                        onPaintSmartFillToggle = {
                            paintBrush = paintBrush.copy(smartFill = !paintBrush.smartFill)
                        },
                        onPaintSmartFillAngleCycle = {
                            // 15° / 30° / 45° / 60° / 90° presets,
                            // mirroring upstream OrcaSlicer's smart-
                            // fill default ladder.
                            val presets = floatArrayOf(15f, 30f, 45f, 60f, 90f)
                            val idx = presets.indexOfFirst {
                                kotlin.math.abs(it - paintBrush.smartFillAngleDeg) < 0.5f
                            }
                            val next = presets[(idx + 1).coerceAtLeast(0) % presets.size]
                            paintBrush = paintBrush.copy(smartFillAngleDeg = next)
                        },
                        // Paint full-feature-parity (Undo/Redo) — read
                        // paintHistoryVersion to make Compose re-evaluate
                        // when the history mutates (PaintHistory itself
                        // is a mutable object the compiler can't observe).
                        onPaintUndo = run {
                            paintHistoryVersion  // observe
                            val sel = selectedModel
                            if (sel != null && paintHistory.canUndo(sel.id)) {
                                {
                                    val snap = paintHistory.undo(sel.id)
                                    if (snap != null) {
                                        placedModels = placedModels.map {
                                            if (it.id == sel.id) it.copy(
                                                paintFilamentIndex = snap.paintFilamentIndex
                                                    ?: it.paintFilamentIndex,
                                                supportFlags = snap.supportFlags
                                                    ?: it.supportFlags,
                                                seamFlags = snap.seamFlags
                                                    ?: it.seamFlags,
                                                fuzzySkinFlags = snap.fuzzySkinFlags
                                                    ?: it.fuzzySkinFlags,
                                            ) else it
                                        }
                                        paintHistoryVersion++
                                    }
                                }
                            } else null
                        },
                        onPaintRedo = run {
                            paintHistoryVersion  // observe
                            val sel = selectedModel
                            if (sel != null && paintHistory.canRedo(sel.id)) {
                                {
                                    val snap = paintHistory.redo(sel.id)
                                    if (snap != null) {
                                        placedModels = placedModels.map {
                                            if (it.id == sel.id) it.copy(
                                                paintFilamentIndex = snap.paintFilamentIndex
                                                    ?: it.paintFilamentIndex,
                                                supportFlags = snap.supportFlags
                                                    ?: it.supportFlags,
                                                seamFlags = snap.seamFlags
                                                    ?: it.seamFlags,
                                                fuzzySkinFlags = snap.fuzzySkinFlags
                                                    ?: it.fuzzySkinFlags,
                                            ) else it
                                        }
                                        paintHistoryVersion++
                                    }
                                }
                            } else null
                        },
                        // One-tap "remove all color paint". Mirrors the
                        // MCP `clear_paint kind=color` so an LLM saying
                        // "unpaint" / "paint white" lands the same state
                        // as the in-XR button. Routes through
                        // applyPaintMutation so PaintHistory captures it
                        // (paint_undo restores) and the colored-GLB
                        // rebake fires via paintContentVersion.
                        hasColorPaint = hasAnyPaint(selectedModel?.paintFilamentIndex),
                        onClearColorPaint = run {
                            paintHistoryVersion  // observe
                            val sel = selectedModel
                            if (sel != null && hasAnyPaint(sel.paintFilamentIndex)) {
                                {
                                    applyPaintMutation(sel.id, paintHistory) { m ->
                                        m.copy(paintFilamentIndex = null)
                                    }
                                    paintHistoryVersion++
                                }
                            } else null
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

                // Left Panel — hidden in Devices mode (no project /
                // slicing affordances when monitoring a live print).
                if (workspaceMode != WorkspaceMode.Devices) MovablePanelWrapper(
                    id = "left-project",
                    width = 400.dp,
                    height = 800.dp,
                    // Far left at the wide edge of the XR FOV — Galaxy
                    // XR's ~110° horizontal FOV easily covers ±1.05 m
                    // at panel-distance and the project panel was
                    // previously cramped against the build plate.
                    initialOffset = androidx.xr.runtime.math.Vector3(-1.05f, 0f, -0.1f),
                    session = session,
                ) {
                    LeftProjectPanel(
                        sliceState = sliceState.value,
                        bedFit = bedFit,
                        bedCollision = bedCollision,
                        printers = printers,
                        selectedPrinterId = selectedPrinterId.value,
                        onSelectPrinter = { selectedPrinterId.value = it },
                        onOpenDevices = {
                            devicesShown = true
                            workspaceMode = WorkspaceMode.Devices
                        },
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
                            // Phase E3: only clear models on the ACTIVE plate.
                            val removed = placedModels.filter { it.plateId == activePlateId }
                            placedModels = placedModels.filter { it.plateId != activePlateId }
                            if (selectedModelIds.firstOrNull() in removed.map { it.id }) {
                                selectedModelIds = setOfNotNull(placedModels.firstOrNull()?.id)
                            }
                            if (placedModelsOnActivePlate.isEmpty()) {
                                glbPath = null
                                stlPreviewPath = null
                                bedFit = null
                                bedCollision = null
                                sliceState.value = SliceUiState.Idle
                                workspaceMode = WorkspaceMode.Prepare
                            }
                            // Best-effort cleanup of removed models' preview cache
                            removed.forEach { m ->
                                runCatching {
                                    ctx.cacheDir.listFiles { f ->
                                        f.name.startsWith("stl_preview_${m.id}_v") &&
                                            f.name.endsWith(".glb")
                                    }?.forEach { it.delete() }
                                }
                            }
                        },
                        placedModels = placedModelsOnActivePlate,
                        selectedPlacedModelIds = selectedModelIds,
                        onSelectPlacedModels = { ids ->
                            selectedModelIds = ids
                        },
                        onDeletePlacedModels = { ids ->
                            // Drop these models from the bed. Sweep
                            // their preview GLBs from the cache and re-
                            // pick a selection if we removed the
                            // active one.
                            val removed = placedModels.filter { it.id in ids }
                            placedModels = placedModels.filter { it.id !in ids }
                            selectedModelIds = selectedModelIds - ids
                            
                            ids.forEach { id ->
                                sweepOldPreviews(File(""), id)
                            }

                            if (placedModelsOnActivePlate.isEmpty()) {
                                glbPath = null
                                stlPreviewPath = null
                                bedFit = null
                                bedCollision = null
                                sliceState.value = SliceUiState.Idle
                                workspaceMode = WorkspaceMode.Prepare
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
                        onRepairPlacedModel = ::runRepair,
                        onEmbossPlacedModel = { id -> embossTargetModelId = id },
                        onAddMagnetsPlacedModel = { id -> magnetTargetModelId = id },
                        allPlates = allPlates,
                        onMoveToPlate = { modelId, plateId ->
                            placedModels = placedModels.map {
                                if (it.id == modelId) it.copy(plateId = plateId) else it
                            }
                            // Follow the model to the destination plate
                            // so the user doesn't think it vanished.
                            activePlateId = plateId
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
                        onApplyGamutMatches = { matches ->
                            val pid = activePrinter?.id ?: return@LeftProjectPanel
                            // Apply against the FULL mixed-row list so the
                            // 1-based virtualSlot indices the matcher hands
                            // back line up with resolveAsWillPrintPalette /
                            // the slice path (both index the full list,
                            // deleted rows included — see PreviewPalette).
                            val result = GamutMatcher.applyGamutMatches(
                                filaments = filamentList,
                                virtualRows = mixedRows,
                                matches = matches,
                            )
                            scope.launch {
                                mixedFilamentsStore.set(pid, result.virtualRows)
                                filamentEntriesStore.set(pid, result.filaments)
                                val applied = matches.count {
                                    it.recipe !is GamutMatcher.GamutRecipe.Keep
                                }
                                val approx = matches.count {
                                    it.quality == GamutMatcher.MatchQuality.APPROXIMATE ||
                                        it.quality == GamutMatcher.MatchQuality.OUT_OF_GAMUT
                                }
                                android.widget.Toast.makeText(
                                    ctx,
                                    "Matched $applied color${if (applied == 1) "" else "s"} to loaded filaments" +
                                        if (approx > 0) " ($approx approximate)" else "",
                                    android.widget.Toast.LENGTH_LONG,
                                ).show()
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
                    // Transform panel only appears when a model is
                    // selected. Park it just to the right of the bed
                    // (x=+0.50) so it lands near the focused model
                    // rather than off-screen on the far left, and
                    // doesn't compete with the left-project panel.
                    initialOffset = androidx.xr.runtime.math.Vector3(0.50f, -0.05f, -0.1f),
                    session = session,
                ) {
                    TransformPanel(
                        model = selectedModel,
                        tool = gizmoTool,
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
                        onToggleFuzzySkin = selectedModel?.let { _ ->
                            {
                                paintBrush = paintBrush.copy(
                                    mode = if (paintBrush.mode == PaintMode.FuzzySkin)
                                        PaintMode.Off else PaintMode.FuzzySkin
                                )
                            }
                        },
                        onClearFuzzySkin = selectedModel?.let { _ ->
                            {
                                updateSelected { it.copy(fuzzySkinFlags = null) }
                            }
                        },
                        hasFuzzySkinPaint = hasAnyPaint(selectedModel?.fuzzySkinFlags),
                        onToggleBrimEars = selectedModel?.let { _ ->
                            {
                                paintBrush = paintBrush.copy(
                                    mode = if (paintBrush.mode == PaintMode.BrimEars)
                                        PaintMode.Off else PaintMode.BrimEars
                                )
                            }
                        },
                        onClearBrimEars = selectedModel?.let { _ ->
                            {
                                updateSelected { it.copy(brimEars = emptyList()) }
                            }
                        },
                        brimEarsCount = selectedModel?.brimEars?.size ?: 0,
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
                        allPlates = allPlates,
                        // Move the model to the target plate AND switch
                        // the active plate to follow it, so the user
                        // doesn't see "the model vanished" when the
                        // current plate filter excludes it post-move.
                        onMoveToPlate = { modelId, plateId ->
                            placedModels = placedModels.map {
                                if (it.id == modelId) it.copy(plateId = plateId) else it
                            }
                            activePlateId = plateId
                        },
                    )
                }

                // (Reverted 2026-05-04: an on-bed loading SpatialPanel
                // gated on `isLoadingModel` lived here briefly, but its
                // mount/unmount on the loading-flag flip created a
                // SceneCoreEntity that competed with Filament's
                // material-instance binder during the
                // model-preview rebake — gotcha #13. Three colored-GLB
                // bakes plus the loading panel's on/off cycle pushed
                // material-id allocations into races
                // (`split_engine_bridge.cc:100 NOT_FOUND: unknown
                // material instance id`). Loading feedback now ships
                // via the existing transient toast + the project-row
                // spinner ONLY; both are 2D Compose surfaces and don't
                // touch Filament's scene graph. If we want on-bed
                // feedback later, the safe path is a static
                // GltfModelEntity that's authored once and toggled
                // via setHidden, not a SpatialPanel that disposes.)

                // Plate switching panel
                MovablePanelWrapper(
                    // Plate-tabs is a vertical strip of plate
                    // selectors. Previously parked at (0.6, 0.4) where
                    // it sat directly on top of right-settings. Move
                    // to the LEFT of the bed at mid-height — clear of
                    // both right-settings AND left-project.
                    id = "plate-tabs",
                    width = 240.dp,
                    height = 400.dp,
                    initialOffset = androidx.xr.runtime.math.Vector3(-0.55f, -0.10f, -0.1f),
                    session = session,
                ) {
                    PlateTabPanel(
                        plates = allPlates,
                        activePlateId = activePlateId,
                        onSelectPlate = { activePlateId = it },
                        onAddPlate = {
                            val nextId = (allPlates.maxOfOrNull { it.id } ?: 0) + 1
                            scope.launch {
                                plateStore.upsert(PlateMetadata(nextId, "Plate $nextId"))
                                activePlateId = nextId
                            }
                        },
                        onRenamePlate = { id, name ->
                            allPlates.firstOrNull { it.id == id }?.let { plate ->
                                scope.launch { plateStore.upsert(plate.copy(label = name)) }
                            }
                        },
                        onDeletePlate = { id ->
                            scope.launch {
                                // Move any models on this plate to plate 1 before deleting
                                placedModels = placedModels.map {
                                    if (it.plateId == id) it.copy(plateId = 1) else it
                                }
                                plateStore.delete(id)
                                if (activePlateId == id) activePlateId = 1
                            }
                        },
                        plateMovable = plateMovable,
                        onTogglePlateMovable = { plateMovable = !plateMovable },
                    )
                }

                // Right Panel — hidden in Devices mode.
                if (workspaceMode != WorkspaceMode.Devices) MovablePanelWrapper(
                    id = "right-settings",
                    width = 400.dp,
                    height = 600.dp,
                    // Far right — was at x=0.6 colliding with both
                    // plate-tabs and print-monitor. Push out to 1.05 so
                    // each right-side panel gets its own column.
                    initialOffset = androidx.xr.runtime.math.Vector3(1.05f, 0.05f, -0.1f),
                    session = session,
                ) {
                    // Smart profile filter — narrow the dropdown to rows
                    // that make sense for the active printer's vendor
                    // and the project's shared material family. User-
                    // saved profiles (no machineName/filamentName)
                    // always pass through. If filtering would empty the
                    // list, falls back to the full catalog so the user
                    // never ends up with an empty dropdown. The
                    // selection-side LaunchedEffect at line ~359 keys on
                    // the unfiltered `allProfiles`, so a printer swap
                    // that hides the currently-selected profile leaves
                    // the selection alone — the dropdown just won't
                    // surface the row until the user changes filter
                    // context.
                    val printerBrand = OrcaProfileLoader.brandOfPrinter(activePrinter?.name)
                    val printerModel = OrcaProfileLoader.modelOfPrinter(activePrinter?.name)
                    val sharedMaterial = OrcaProfileLoader.sharedMaterialFamily(
                        filamentList.map { it.filamentType },
                    )
                    val displayedProfiles = remember(allProfiles, printerBrand, printerModel, sharedMaterial) {
                        OrcaProfileLoader.filterForContext(
                            all = allProfiles,
                            printerBrand = printerBrand,
                            sharedMaterial = sharedMaterial,
                            printerModel = printerModel,
                        )
                    }
                    RightSettingsPanel(
                        allProfiles = displayedProfiles,
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
                        loadedLayerHeightHintMm = loadedLayerHeightHintMm,
                        bambuImport = bambuImport,
                        onDismissBambuImport = { bambuImport = null },
                        onApplyBambuFilamentSuggestion = {
                            // The Bambu translator's per-slot
                            // filamentProfileSuggestion is keyed by
                            // slot index (0..slotCount-1). Map each
                            // suggestion onto the matching
                            // FilamentEntry.filamentType — that's the
                            // string the bundled-filament catalog
                            // keys off, so writing it in flips the
                            // slot to the suggested U1 profile on the
                            // next composition. Clear the banner
                            // afterwards so the suggestion doesn't
                            // re-apply on subsequent dismiss-then-
                            // reopen cycles.
                            val printerId = activePrinter?.id
                            val suggestion = bambuImport?.filamentProfileSuggestion.orEmpty()
                            if (printerId != null && suggestion.isNotEmpty()) {
                                val updated = filamentList.mapIndexed { i, entry ->
                                    val s = suggestion.getOrNull(i)
                                    if (s.isNullOrBlank()) entry else entry.copy(filamentType = s)
                                }
                                scope.launch { filamentEntriesStore.set(printerId, updated) }
                                bambuImport = null
                            }
                        },
                    )
                }


                // Bottom Center Panel (Layer Preview) — hidden in
                // Devices mode (the layer scrubber is auto-driven from
                // the printer's reported Z-height; manual override
                // would just re-trigger the auto-follow).
                val parsed = (sliceState.value as? SliceUiState.Done)?.parsed
                val maxIdx = parsed?.layerZs?.lastIndex ?: 0
                val currentLayer = maxLayer.value ?: maxIdx
                if (workspaceMode != WorkspaceMode.Devices) MovablePanelWrapper(
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
                        colorMode = toolpathColorMode.value,
                        onColorModeChange = { toolpathColorMode.value = it },
                        // A11 — render colored dots on the strip beneath
                        // the slider for every authored tick on the
                        // active plate. Tap to jump the scrubber to the
                        // tick's nearest layer; jumping into Preview is
                        // handled by the existing onLayerChange path.
                        customGcodeTicks = customGcodeTicksByPlate[activePlateId].orEmpty(),
                        onTickTapped = { layerIdx ->
                            maxLayer.value = if (layerIdx >= maxIdx) null else layerIdx
                        },
                    )
                }

                // Bottom Right Summary Panel — hidden in Devices mode
                // (slice / save buttons aren't relevant when
                // monitoring an active print).
                if (workspaceMode != WorkspaceMode.Devices) MovablePanelWrapper(
                    id = "bottom-summary",
                    width = 400.dp,
                    height = 250.dp,
                    initialOffset = androidx.xr.runtime.math.Vector3(0.6f, -0.475f, -0.05f),
                    session = session,
                ) {
                    val activePrinter = printers.firstOrNull { it.id == selectedPrinterId.value }
                    val sliceTargetLabel = when {
                        placedModelsOnActivePlate.size >= 2 -> "${placedModelsOnActivePlate.size} models"
                        else -> selectedModel?.label ?: "bundled 20 mm cube"
                    }
                    BottomRightSummaryPanel(
                        sliceState = sliceState.value,
                        sliceTarget = sliceTargetLabel,
                        activePrinterName = activePrinter?.name,
                        canSaveModel = selectedModel != null,
                        onSliceClick = {
                            // Phase E3: only slice models on the ACTIVE plate.
                            if (placedModelsOnActivePlate.size >= 2) {
                                runSliceMulti(placedModelsOnActivePlate)
                            } else {
                                val target = selectedModel
                                if (target != null) {
                                    runSlice(target.source, target.label)
                                } else {
                                    scope.launch {
                                        val label = "cube_20mm.stl (bundled)"
                                        val stl = copyBundledCube(ctx)
                                        val cubeId = "model_cube_${System.currentTimeMillis().toString(36)}"
                                        // Auto-assigned to activePlateId (default)
                                        val fresh = PlacedModel(id = cubeId, source = stl, label = label, plateId = activePlateId)
                                        placedModels = placedModels + fresh
                                        selectedModelIds = setOfNotNull(cubeId)
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
                                    extraOverrides = printSettingsOverrides.value + wipeTowerExtraOverrides(ctx) + fullSpectrumExtraOverrides(mixedFilamentDefinitions.isNotBlank()),
                                )
                                val dest = saveProjectAs3mfToDownloads(
                                    sourceFile = target.source,
                                    sourceLabel = target.label,
                                    config = cfg,
                                    paintFilamentIndex = target.paintFilamentIndex,
                                    supportFlags = target.supportFlags,
                                    seamFlags = target.seamFlags,
                                    fuzzySkinFlags = target.fuzzySkinFlags,
                                    brimEars = target.brimEars.toBrimEarsFloatArray(),
                                )
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
                            // Open the pre-print options sheet. The
                            // confirm callback (rendered further down)
                            // runs the actual upload+start with the
                            // picked PrintOptions.
                            sendOptionsRequest = SendOptionsRequest(
                                printer = cfg,
                                gcode = File(src.outputPath),
                            )
                            // Kick off the timelapse-component probe now
                            // so the sheet renders with the right
                            // enabled state on first frame (it falls
                            // back to false until the probe lands).
                            if (!timelapseSupportedByPrinter.containsKey(cfg.id)) {
                                scope.launch {
                                    val ok = runCatching { MoonrakerClient(cfg).timelapseSupported() }
                                        .getOrDefault(false)
                                    timelapseSupportedByPrinter =
                                        timelapseSupportedByPrinter + (cfg.id to ok)
                                }
                            }
                        },
                        filamentRuleResult = filamentRuleResult,
                        bedCollisionForbidden = bedCollision is BedCollision.Result.Off,
                    )
                }

                // Pre-print options sheet — shown when the user taps
                // Send & Print on BottomRightSummaryPanel. On confirm
                // the upload+start sequence runs with the picked
                // [PrintOptions]; on cancel the sheet just closes. Z=
                // +200 keeps it forward of the workspace panels.
                run {
                    val req = sendOptionsRequest
                    if (req != null) {
                        SpatialPanel(
                            modifier = SubspaceModifier
                                .subspaceWidth(520.dp)
                                .subspaceHeight(340.dp)
                                .offset(x = 0.dp, y = 80.dp, z = 200.dp),
                        ) {
                            SendAndPrintOptionsPanel(
                                printerName = req.printer.name,
                                initialOptions = PrintOptions.Default,
                                timelapseAvailable = timelapseSupportedByPrinter[req.printer.id] == true,
                                onCancel = { sendOptionsRequest = null },
                                onConfirm = { picked ->
                                    sendOptionsRequest = null
                                    devicesShown = true
                                    workspaceMode = WorkspaceMode.Devices
                                    runUploadAndStart(
                                        scope = scope,
                                        ctx = ctx,
                                        cfg = req.printer,
                                        gcode = req.gcode,
                                        options = picked,
                                        setStatus = ::setStatus,
                                    )
                                },
                            )
                        }
                    }
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
                            // Stack directly under right-settings on
                            // the far-right column. Was at (0.61,
                            // -0.235) which sat INSIDE right-settings'
                            // footprint when both were visible.
                            initialOffset = androidx.xr.runtime.math.Vector3(1.05f, -0.55f, -0.1f),
                            session = session,
                        ) {
                            PrintMonitorPanel(
                                printerName = cfg.name,
                                snapshot = snap,
                                webcam = webcamFrames[cfg.id],
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
                    // Bottom-left corner, outboard of left-project so
                    // the menu's hit-radius doesn't compete with the
                    // project panel's scrollable interior.
                    initialOffset = androidx.xr.runtime.math.Vector3(-1.05f, -0.55f, 0.05f),
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
                            selectedModelIds = setOfNotNull(newId)
                            scope.launch { previewStl(newId) }
                        },
                        onDelete = {
                            val id = selectedModelIds.firstOrNull() ?: return@RadialMenuPanel
                            val removed = placedModels.firstOrNull { it.id == id }
                            placedModels = placedModels.filter { it.id != id }
                            if (selectedModelIds.firstOrNull() == id) {
                                selectedModelIds = setOfNotNull(placedModels.firstOrNull()?.id)
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
                        deleteEnabled = selectedModelIds.firstOrNull() != null,
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
                                    selectedModelIds = setOfNotNull(cubeId)
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
                                // Same pre-print options flow as the
                                // BottomRightSummaryPanel's Send & Print
                                // button: open the sheet, run the upload
                                // on confirm.
                                sendOptionsRequest = SendOptionsRequest(p, gcode)
                                if (!timelapseSupportedByPrinter.containsKey(p.id)) {
                                    scope.launch {
                                        val ok = runCatching { MoonrakerClient(p).timelapseSupported() }
                                            .getOrDefault(false)
                                        timelapseSupportedByPrinter =
                                            timelapseSupportedByPrinter + (p.id to ok)
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
                            onClose = {
                                devicesShown = false
                                // Return to whichever non-Devices mode
                                // makes sense for current state.
                                workspaceMode = if (glbPath != null) {
                                    WorkspaceMode.Preview
                                } else {
                                    WorkspaceMode.Prepare
                                }
                            },
                        )
                    }
                }

                if (settingsShown) {
                    // App-wide preferences SpatialPanel. Hosts the
                    // in-app LLM assistant card (provider picker +
                    // API key + voice toggle + Open Assistant
                    // button); future cards drop in alongside. Sized
                    // to match PrinterPanel for visual consistency
                    // when the user toggles between them, but offset
                    // to the right so opening both at once doesn't
                    // overlap.
                    MovablePanelWrapper(
                        id = "settings",
                        width = 600.dp,
                        height = 600.dp,
                        initialOffset = androidx.xr.runtime.math.Vector3(0.7f, 0.1f, 0f),
                        session = session,
                    ) {
                        dev.orcaxr.app.ui.SettingsPanel(
                            onClose = { settingsShown = false },
                            onOpenAssistant = { assistantShown = true },
                            onRequestHomeSpaceMode = {
                                runCatching { session.scene.requestHomeSpaceMode() }
                            },
                        )
                    }
                }

                if (assistantShown) {
                    // Optional in-app LLM assistant — chat panel that
                    // routes through whichever provider the user
                    // configured in Settings → AI assistant. Mounted
                    // as its own SpatialPanel so it floats next to the
                    // workspace and can stay open while the user
                    // continues editing models.
                    MovablePanelWrapper(
                        id = "llm-assistant",
                        width = 540.dp,
                        height = 720.dp,
                        initialOffset = androidx.xr.runtime.math.Vector3(-0.85f, 0.05f, -0.05f),
                        session = session,
                    ) {
                        dev.orcaxr.app.llm.LlmAssistantPanel(
                            onClose = { assistantShown = false },
                            onRequestHomeSpaceMode = {
                                runCatching { session.scene.requestHomeSpaceMode() }
                            },
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

                if (addPrimitiveShown) {
                    // Roadmap D12 — primitive shape authoring SpatialPanel.
                    // Mirrors the `add_primitive` MCP tool: builds an STL
                    // via SlicerEngine.buildPrimitiveStl and emits either
                    // LoadModelFromPath (object mode) or AddVolumeToModel
                    // (the four volume kinds). The MCP tool's handler
                    // doubles as the spec — we re-use its WorkspaceModel
                    // emit path so the panel and the tool stay in lockstep.
                    MovablePanelWrapper(
                        id = "add-primitive",
                        width = 540.dp,
                        height = 760.dp,
                        initialOffset = androidx.xr.runtime.math.Vector3(0.6f, 0.2f, -0.15f),
                        session = session,
                    ) {
                        AddPrimitivePanel(
                            placedModels = placedModels,
                            selectedModelId = selectedModelIds.firstOrNull(),
                            onClose = { addPrimitiveShown = false },
                            onAdd = { req ->
                                scope.launch {
                                    val outDir = java.io.File(ctx.cacheDir, "primitives").apply {
                                        if (!exists()) mkdirs()
                                    }
                                    val outFile = java.io.File(
                                        outDir,
                                        "${req.kind.name.lowercase()}_${
                                            System.currentTimeMillis().toString(36)
                                        }.stl",
                                    )
                                    val built = SlicerEngine.buildPrimitiveStl(
                                        kind = req.kind,
                                        params = req.params,
                                        output = outFile,
                                    )
                                    if (built == null) {
                                        android.widget.Toast.makeText(
                                            ctx,
                                            "Failed to build ${req.kind.displayName}",
                                            android.widget.Toast.LENGTH_SHORT,
                                        ).show()
                                        return@launch
                                    }
                                    val ws = dev.orcaxr.app.mcp.WorkspaceModel.get()
                                    when (val m = req.mode) {
                                        PrimitivePanelData.Mode.AsObject -> {
                                            ws.emit(
                                                dev.orcaxr.app.mcp.WorkspaceAction.LoadModelFromPath(
                                                    built.absolutePath,
                                                    dev.orcaxr.app.mcp.WorkspaceAction.LoadMode.Add,
                                                ),
                                            )
                                        }
                                        is PrimitivePanelData.Mode.AsVolume -> {
                                            ws.emit(
                                                dev.orcaxr.app.mcp.WorkspaceAction.AddVolumeToModel(
                                                    modelId = m.targetModelId,
                                                    sourcePath = built.absolutePath,
                                                    type = m.type.name,
                                                ),
                                            )
                                        }
                                    }
                                    addPrimitiveShown = false
                                }
                            },
                        )
                    }
                }

                if (customGcodeShown) {
                    // Roadmap A11 — custom-G-code-per-print-Z SpatialPanel.
                    // Reads the active plate's ticks from the
                    // collectAsState'd `customGcodeTicksByPlate` map and
                    // dispatches add / remove / clear through the existing
                    // WorkspaceModel emit path so the persistence + 3MF
                    // round-trip + MCP listing all see the same state.
                    val activePlateLabel = allPlates.firstOrNull {
                        it.id == activePlateId
                    }?.label ?: "Plate $activePlateId"
                    val plateTicks = customGcodeTicksByPlate[activePlateId].orEmpty()
                    val maxZ = (sliceState.value as? SliceUiState.Done)
                        ?.parsed
                        ?.layerZs
                        ?.lastOrNull()
                    MovablePanelWrapper(
                        id = "custom-gcode",
                        width = 540.dp,
                        height = 760.dp,
                        initialOffset = androidx.xr.runtime.math.Vector3(0.6f, -0.05f, -0.15f),
                        session = session,
                    ) {
                        CustomGcodePanel(
                            activePlateId = activePlateId,
                            activePlateLabel = activePlateLabel,
                            ticks = plateTicks,
                            maxZmm = maxZ,
                            onClose = { customGcodeShown = false },
                            onAdd = { tick ->
                                scope.launch {
                                    dev.orcaxr.app.mcp.WorkspaceModel.get().emit(
                                        dev.orcaxr.app.mcp.WorkspaceAction.AddCustomGcodeTick(
                                            plateId = activePlateId,
                                            zMm = tick.printZmm,
                                            kind = tick.kind.name,
                                            extruder = tick.extruder,
                                            color = tick.color,
                                            extra = tick.extra,
                                        ),
                                    )
                                }
                            },
                            onRemove = { idx ->
                                scope.launch {
                                    dev.orcaxr.app.mcp.WorkspaceModel.get().emit(
                                        dev.orcaxr.app.mcp.WorkspaceAction.RemoveCustomGcodeTick(
                                            plateId = activePlateId,
                                            index = idx,
                                        ),
                                    )
                                }
                            },
                            onClear = {
                                scope.launch {
                                    dev.orcaxr.app.mcp.WorkspaceModel.get().emit(
                                        dev.orcaxr.app.mcp.WorkspaceAction.ClearCustomGcodeTicks(
                                            plateId = activePlateId,
                                        ),
                                    )
                                }
                            },
                        )
                    }
                }

                // Roadmap A10 — Adaptive layer height panel. Topnav
                // toggle drives `adaptiveLayerShown`. Acts on the
                // currently-selected PlacedModel; Compute disabled when
                // nothing is selected. Routes through the existing
                // ComputeAdaptiveLayerHeights / SetLayerHeightProfile
                // WorkspaceActions so the on-disk profile flows into
                // every subsequent slice via `nativeSliceMulti.layer
                // HeightProfilesPerInput` (see runComputeAdaptiveLayer
                // Heights for the JNI bridge).
                if (adaptiveLayerShown) {
                    val sel = placedModels.firstOrNull { it.id in selectedModelIds }
                    MovablePanelWrapper(
                        id = "adaptive-layer-panel",
                        width = 540.dp,
                        height = 760.dp,
                        initialOffset = androidx.xr.runtime.math.Vector3(0.6f, -0.05f, -0.15f),
                        session = session,
                    ) {
                        AdaptiveLayerPanel(
                            selected = sel,
                            onClose = { adaptiveLayerShown = false },
                            onCompute = { id, q, sr, km ->
                                scope.launch {
                                    dev.orcaxr.app.mcp.WorkspaceModel.get().emit(
                                        dev.orcaxr.app.mcp.WorkspaceAction.ComputeAdaptiveLayerHeights(
                                            modelId = id,
                                            quality = q,
                                            smoothingRadius = sr,
                                            smoothingKeepMin = km,
                                        ),
                                    )
                                }
                            },
                            onClear = { id ->
                                scope.launch {
                                    dev.orcaxr.app.mcp.WorkspaceModel.get().emit(
                                        dev.orcaxr.app.mcp.WorkspaceAction.SetLayerHeightProfile(
                                            modelId = id,
                                            profile = null,
                                        ),
                                    )
                                }
                            },
                        )
                    }
                }

                // Roadmap D17 — Mesh simplify panel. Topnav toggle
                // drives `simplifyShown`. Routes through the existing
                // SimplifyModel WorkspaceAction → runSimplify path so
                // the simplified mesh replaces the original on the bed
                // and paint state is dropped (gotcha #28-style sweep).
                if (simplifyShown) {
                    val sel = placedModels.firstOrNull { it.id in selectedModelIds }
                    MovablePanelWrapper(
                        id = "simplify-panel",
                        width = 480.dp,
                        height = 540.dp,
                        initialOffset = androidx.xr.runtime.math.Vector3(0.6f, -0.05f, -0.15f),
                        session = session,
                    ) {
                        SimplifyPanel(
                            selected = sel,
                            onClose = { simplifyShown = false },
                            onSimplify = { id, target, maxErr ->
                                scope.launch {
                                    dev.orcaxr.app.mcp.WorkspaceModel.get().emit(
                                        dev.orcaxr.app.mcp.WorkspaceAction.SimplifyModel(
                                            modelId = id,
                                            targetTriangleCount = target,
                                            maxError = maxErr,
                                        ),
                                    )
                                    // Auto-hide on apply — the user
                                    // wants to see the result on the
                                    // bed, not stay in the panel.
                                    simplifyShown = false
                                }
                            },
                        )
                    }
                }

                // Roadmap C8 — Voice command panel. Hosts a
                // SpeechRecognizer session, runs VoiceIntentMapper on
                // the recognized text, and dispatches the resulting
                // VoiceIntent into the same WorkspaceModel actions
                // every other path uses.
                if (voiceShown) {
                    VoiceCommandPanelMount(
                        onClose = { voiceShown = false },
                        helpToggle = { helpShown = !helpShown; voiceShown = false },
                        settingsToggle = { settingsShown = !settingsShown; voiceShown = false },
                        assistantToggle = { assistantShown = !assistantShown; voiceShown = false },
                        session = session,
                    )
                }

                // Roadmap D4 — Emboss / Engrave panel. Visible whenever
                // a target model has been picked via the per-row 𝐀
                // icon. Apply runs through MainActivity::runEmboss; on
                // both success and dismiss the target id resets so the
                // panel auto-hides.
                val embossTarget = embossTargetModelId
                    ?.let { id -> placedModels.firstOrNull { it.id == id } }
                if (embossTarget != null) {
                    MovablePanelWrapper(
                        id = "emboss-panel",
                        width = 480.dp,
                        height = 760.dp,
                        // Right column, slightly above the print monitor
                        // slot so it doesn't fight the help card or the
                        // monitor when both are open.
                        initialOffset = androidx.xr.runtime.math.Vector3(0.85f, 0.05f, -0.05f),
                        session = session,
                    ) {
                        EmbossPanel(
                            targetModel = embossTarget,
                            bundledFonts = EmbossAssets.BUNDLED_FONTS,
                            onStageFont = { f -> EmbossAssets.stageBundledFont(ctx, f) },
                            onStageSampleSvg = { EmbossAssets.stageBundledSampleSvg(ctx) },
                            onApply = { spec, mode, tx, ty, rotZ ->
                                runEmboss(
                                    modelId = embossTarget.id,
                                    spec = spec,
                                    mode = mode,
                                    translateXmm = tx,
                                    translateYmm = ty,
                                    rotZDeg = rotZ,
                                )
                                embossTargetModelId = null
                            },
                            onDismiss = { embossTargetModelId = null },
                        )
                    }
                }

                val magnetTarget = magnetTargetModelId
                    ?.let { id -> placedModels.firstOrNull { it.id == id } }
                if (magnetTarget != null) {
                    MovablePanelWrapper(
                        id = "magnet-panel",
                        width = 480.dp,
                        height = 760.dp,
                        initialOffset = androidx.xr.runtime.math.Vector3(0.85f, 0.05f, -0.05f),
                        session = session,
                    ) {
                        MagnetPanel(
                            targetModel = magnetTarget,
                            onApply = { spec ->
                                runMagnets(
                                    dev.orcaxr.app.mcp.WorkspaceAction.AddMagnets(
                                        modelId = magnetTarget.id,
                                        count = spec.count,
                                        shape = spec.shape.name.lowercase(),
                                        diameterMm = spec.diameterMm,
                                        heightMm = spec.discHeightMm,
                                        blockXmm = spec.blockXmm,
                                        blockYmm = spec.blockYmm,
                                        blockZmm = spec.blockZmm,
                                        clearanceMm = spec.clearanceMm,
                                        roofThicknessMm = spec.roofThicknessMm,
                                        edgeMarginMm = spec.edgeMarginMm,
                                    ),
                                )
                                magnetTargetModelId = null
                            },
                            onDismiss = { magnetTargetModelId = null },
                        )
                    }
                }
            }
        }

        // Build plate first so the toolpath/STL render on top of it.
        buildPlatePath?.let { path ->
            key(path) {
                BuildPlateSceneEntity(
                    session = session,
                    glbPath = path,
                    parentEntity = workspaceEntity,
                    onTap = { selectedModelIds = emptySet() }
                )
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
                for (m in placedModelsOnActivePlate) {
                    val path = m.previewPath ?: continue
                    val liveOv = liveDragOverride?.let { (ids, ov) ->
                        if (m.id in ids) ov else null
                    }
                    // Keyed on m.id only (NOT path) so the composable
                    // persists across previewPath changes. Re-keying on
                    // path tears down the GltfModelEntity synchronously
                    // and races split_engine_bridge with NOT_FOUND
                    // aborts during gotcha #22's two-bake load. The
                    // path-swap dispose is handled by GlbSceneEntity's
                    // load LaunchedEffect with a deferred dispose.
                    key(m.id) {
                        StlPreviewSceneEntity(
                            session = session,
                            glbPath = path,
                            parentEntity = workspaceEntity,
                            offsetXmm = m.translateXmm,
                            offsetYmm = m.translateYmm,
                            offsetZmm = m.translateZmm,
                            paintHooks = paintHooksFor(m),
                            liveOverride = liveOv,                            // Phase XR_OBJ_1: tap a model to select it.
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
                                    selectedModelIds = setOfNotNull(m.id)
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
                val selectedList = placedModels.filter { it.id in selectedModelIds }
                if (selectedList.isNotEmpty() && paintBrush.mode == PaintMode.Off) {
                    var minX = Float.POSITIVE_INFINITY
                    var maxX = Float.NEGATIVE_INFINITY
                    var minY = Float.POSITIVE_INFINITY
                    var maxY = Float.NEGATIVE_INFINITY
                    var minZ = Float.POSITIVE_INFINITY
                    var maxZ = Float.NEGATIVE_INFINITY
                    
                    for (m in selectedList) {
                        val (w, d) = m.footprintMm()
                        val h = m.baseBboxZmm * m.effectiveScaleZ
                        val cx = m.translateXmm
                        val cy = m.translateYmm
                        val cz = m.translateZmm
                        if (cx - w/2 < minX) minX = cx - w/2
                        if (cx + w/2 > maxX) maxX = cx + w/2
                        if (cy - d/2 < minY) minY = cy - d/2
                        if (cy + d/2 > maxY) maxY = cy + d/2
                        if (cz < minZ) minZ = cz
                        if (cz + h > maxZ) maxZ = cz + h
                    }
                    
                    // Pad the selection bbox slightly outside the model's
                    // own footprint so the wireframe doesn't z-fight with
                    // the model's surface and the user can clearly see
                    // it wrapping (vs hugging) the geometry. 4mm on each
                    // side feels right at typical model scales (~30-100mm).
                    val pad = SELECTION_BBOX_PADDING_MM
                    val fw = (maxX - minX) + pad * 2f
                    val fd = (maxY - minY) + pad * 2f
                    val fh = (maxZ - minZ) + pad * 2f

                    if (fw > 0f && fd > 0f && fh > 0f && !fw.isInfinite()) {
                        val cx = (minX + maxX) / 2f
                        val cy = (minY + maxY) / 2f
                        // Bottom of bbox sits `pad` BELOW the model's
                        // lowest point — for a model resting on the bed
                        // (minZ ≈ 0) this means the bbox just barely
                        // dips into the bed plane, which is the visual
                        // cue the user expects ("the box wraps the
                        // model with a hair of air").
                        val cz = minZ - pad

                        // Keyed only on the selection identity (NOT
                        // dims). Including fw/fd/fh would re-mount the
                        // composable on every dim tweak — and re-mount
                        // fires DisposableEffect(Unit).onDispose
                        // synchronously, racing split_engine_bridge with
                        // the same NOT_FOUND aborts as the path-keyed
                        // GlbSceneEntity bug. Dim changes are absorbed
                        // by SelectionBboxEntity's internal
                        // LaunchedEffect (which uses the deferred
                        // dispose helper).
                        key(selectedModelIds.hashCode()) {
                            SelectionBboxEntity(
                                session = session,
                                parentEntity = workspaceEntity,
                                modelId = "multi_select_bbox",
                                offsetXmm = cx,
                                offsetYmm = cy,
                                offsetZmm = cz,
                                sizeXmm = fw,
                                sizeYmm = fd,
                                sizeZmm = fh,
                            )
                        }
                    }
                    
                    if (!isWorkspaceGrabbing) {
                        if (selectedModelIds.size > 1) {
                            // B11 Multi-select Gizmo: Center on the bounding box of the group.
                            val groupModels = placedModels.filter { it.id in selectedModelIds }
                            if (groupModels.isNotEmpty()) {
                                var minX = Float.POSITIVE_INFINITY
                                var maxX = Float.NEGATIVE_INFINITY
                                var minY = Float.POSITIVE_INFINITY
                                var maxY = Float.NEGATIVE_INFINITY
                                var maxZ = Float.NEGATIVE_INFINITY // Base is 0
                                
                                for (m in groupModels) {
                                    val (w, d) = m.footprintMm()
                                    val h = m.baseBboxZmm * (m.scalePct / 100f)
                                    val cx = m.translateXmm
                                    val cy = m.translateYmm
                                    if (cx - w/2 < minX) minX = cx - w/2
                                    if (cx + w/2 > maxX) maxX = cx + w/2
                                    if (cy - d/2 < minY) minY = cy - d/2
                                    if (cy + d/2 > maxY) maxY = cy + d/2
                                    if (h > maxZ) maxZ = h
                                }
                                
                                val groupCenter = PlacedModel(
                                    id = "multi_select_gizmo",
                                    source = groupModels.first().source, // Dummy
                                    label = "Group",
                                    translateXmm = (minX + maxX) / 2f,
                                    translateYmm = (minY + maxY) / 2f,
                                    // Group bbox (so the gizmo sizes itself to the
                                    // whole selection, not a zero-extent point).
                                    baseBboxXmm = (maxX - minX).coerceAtLeast(0f),
                                    baseBboxYmm = (maxY - minY).coerceAtLeast(0f),
                                    baseBboxZmm = maxZ.coerceAtLeast(0f),
                                )

                                key(selectedModelIds.hashCode()) {
                                    TransformGizmo(
                                        session = session,
                                        parentEntity = workspaceEntity,
                                        selectedModel = groupCenter,
                                        workspaceTx = workspaceTx,
                                        tool = if (paintBrush.mode != PaintMode.Off) GizmoTool.Select else gizmoTool,
                                        liveOverride = liveDragOverride
                                            ?.takeIf { (ids, _) -> ids == selectedModelIds }
                                            ?.second,
                                        onLivePreview = { ov ->
                                            liveDragOverride =
                                                if (ov == null) null
                                                else selectedModelIds to ov
                                        },
                                        onCommit = { ov ->
                                            liveDragOverride = null
                                            placedModels = placedModels.map { m ->
                                                if (m.id in selectedModelIds) applyOverride(m, ov)
                                                else m
                                            }
                                        },
                                    )
                                }
                            }
                        } else if (selectedList.size == 1) {
                            val selected = selectedList.first()
                            // Defer composing the gizmo until the model has
                            // a preview GLB on disk. While a 3MF is loading,
                            // the StlPreview rebake (gotcha #22 fires it
                            // twice) + SelectionBbox attach already saturate
                            // Filament's material-instance binding queue
                            // (gotcha #11e). Three GizmoDragHandle entities
                            // racing in on top of that crashed
                            // `split_engine_bridge.cc:100 NOT_FOUND: unknown
                            // material instance id` even with the per-handle
                            // 3-awaitFrame gate. Withholding the gizmo
                            // composition until previewPath is non-null
                            // lets the heavier loads settle first; the user
                            // can't usefully drag a gizmo on an invisible
                            // model anyway.
                            if (selected.previewPath != null) {
                                key(selected.id) {
                                    TransformGizmo(
                                        session = session,
                                        parentEntity = workspaceEntity,
                                        selectedModel = selected,
                                        workspaceTx = workspaceTx,
                                        tool = if (paintBrush.mode != PaintMode.Off) GizmoTool.Select else gizmoTool,
                                        liveOverride = liveDragOverride
                                            ?.takeIf { (ids, _) -> selected.id in ids }
                                            ?.second,
                                        onLivePreview = { ov ->
                                            liveDragOverride =
                                                if (ov == null) null
                                                else setOf(selected.id) to ov
                                        },
                                        onCommit = { ov ->
                                            liveDragOverride = null
                                            placedModels = placedModels.map { m ->
                                                if (m.id == selected.id) applyOverride(m, ov) else m
                                            }
                                        },
                                    )
                                }
                            }
                        }
                    }
                }
            }
            WorkspaceMode.Preview, WorkspaceMode.Devices -> {
                // C7 — Devices mode renders the same toolpath GLB as
                // Preview, but the layer scrubber is auto-driven from
                // the active printer's reported Z-height (see the
                // digital-twin LaunchedEffect below). The result is a
                // virtual model that "grows" in lockstep with the
                // physical print head. When no toolpath is baked we
                // fall back to the placed-model previews so the bed
                // isn't blank during a fresh-print boot.
                val toolpath = glbPath
                if (toolpath != null) {
                    key(toolpath) {
                        ToolpathSceneEntity(session = session, glbPath = toolpath, parentEntity = workspaceEntity)
                    }
                } else {
                    for (m in placedModelsOnActivePlate) {
                        val path = m.previewPath ?: continue
                        // Keyed on m.id only — see Prepare branch above.
                        key(m.id) {
                            StlPreviewSceneEntity(
                                session = session,
                                glbPath = path,
                                parentEntity = workspaceEntity,
                                offsetXmm = m.translateXmm,
                                offsetYmm = m.translateYmm,
                                offsetZmm = m.translateZmm,
                            )                        }
                    }
                }
            }
        }
    }

    DisposableEffect(rootEntity, workspaceEntity) {
        onDispose {
            // Detach children first so SceneCore doesn't keep stale
            // parent refs when we re-create on a new session.
            // Entity.dispose() is deprecated in alpha15; parent = null
            // detaches from the scene graph and lets GC reclaim.
            workspaceEntity?.let { it.parent = null }
            rootEntity?.let { it.parent = null }
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
const val WORLD_SCALE = 0.0015f

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

private fun previewRgbForFilamentIndex(indexOneBased: Int, palette: List<String>): FloatArray? {
    if (indexOneBased <= 0) return null
    val hex = palette.getOrNull(indexOneBased - 1)
        ?.trimStart('#')
        ?.padStart(6, '0')
        ?.take(6)
        ?: return null
    val r = hex.substring(0, 2).toIntOrNull(16) ?: return null
    val g = hex.substring(2, 4).toIntOrNull(16) ?: return null
    val b = hex.substring(4, 6).toIntOrNull(16) ?: return null
    return floatArrayOf(r / 255f, g / 255f, b / 255f)
}

/** Margin (mm) added around the selection wireframe so it visibly wraps
 *  the model rather than z-fighting with its surface. ~4mm reads as a
 *  hair of breathing room at typical model scales (30-100 mm). */
internal const val SELECTION_BBOX_PADDING_MM = 4f

private fun applyWorkspacePose(ent: androidx.xr.scenecore.Entity, parent: androidx.xr.scenecore.Entity?) {
    // The workspace parent (a GroupEntity created in XrShell) already
    // carries WORKSPACE_Y_OFFSET + WORKSPACE_ROTATION, so child GLBs
    // only need the unit-conversion scale. Pose stays at identity.
    ent.parent = parent
    ent.setScale(WORLD_SCALE)
}

/** Dispose [ent] after a two-frame delay so the SceneCore render thread
 *  flushes any queued ops referencing its node id. Synchronous dispose
 *  on a freshly-swapped entity races split_engine_bridge.cc:100 with
 *  NOT_FOUND aborts ("unknown node id" / "unknown material instance
 *  id"); this helper holds the ref alive until the queue drains. Must
 *  be called from a coroutine — typically the LaunchedEffect doing the
 *  entity swap. No-op when [ent] is null or already disposed. */
private suspend fun disposeEntityDeferred(ent: androidx.xr.scenecore.Entity?) {
    if (ent == null || ent.isDisposed) return
    kotlinx.coroutines.android.awaitFrame()
    kotlinx.coroutines.android.awaitFrame()
    // Entity.dispose() is deprecated in alpha15; detach via parent = null
    // and let GC reclaim. The isDisposed guard stays for safety.
    if (!ent.isDisposed) runCatching { ent.parent = null }
}

/** Folds a gizmo drag's final delta into a [PlacedModel] on commit. */
internal fun applyOverride(m: PlacedModel, ov: GizmoDragOverride): PlacedModel {
    val newRotZ = (((m.rotZDeg.toFloat() + ov.deltaRotZDeg).toInt() % 360) + 360) % 360
    return m.copy(
        translateXmm = m.translateXmm + ov.deltaTxMm,
        translateYmm = m.translateYmm + ov.deltaTyMm,
        translateZmm = m.translateZmm + ov.deltaTzMm,
        rotXDeg = m.rotXDeg + ov.deltaRotXDeg,
        rotYDeg = m.rotYDeg + ov.deltaRotYDeg,
        rotZDeg = newRotZ,
        scaleXPct = (m.scaleXPct * ov.scaleMultX).coerceIn(10f, 1000f),
        scaleYPct = (m.scaleYPct * ov.scaleMultY).coerceIn(10f, 1000f),
        scaleZPct = (m.scaleZPct * ov.scaleMultZ).coerceIn(10f, 1000f),
    )
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
    offsetZmm: Float = 0f,
    /** Phase J: when non-null, attaches an `InteractableComponent`
     *  to the model's GltfModelEntity and forwards interactive
     *  events (CONTROLLER / HANDS / GAZE_AND_GESTURE) through the
     *  hooks. Null = no paint pipeline (the entity is purely visual;
     *  the workspace grab handle owns input). */
    paintHooks: PaintInputHooks? = null,
    /** Phase XR_OBJ_1: tap-to-select. Fires on `Action.DOWN`. Ignored
     *  when [paintHooks] is non-null — paint mode owns the laser. */
    onTap: (() -> Unit)? = null,
    /** Phase XR_OBJ_1: hover state. true on `HOVER_ENTER`, false on
     *  `HOVER_EXIT`. Same paint-mode caveat as [onTap]. */
    onHoverChange: ((Boolean) -> Unit)? = null,
    /** Live transform override applied to this model while a gizmo is
     *  being dragged. Null when no drag is active. */
    liveOverride: GizmoDragOverride? = null,
) {
    GlbSceneEntity(session, glbPath, parentEntity, offsetXmm, offsetYmm, offsetZmm, paintHooks, onTap, onHoverChange, liveOverride)
}

@Composable
private fun BuildPlateSceneEntity(
    session: Session,
    glbPath: String,
    parentEntity: androidx.xr.scenecore.Entity?,
    onTap: (() -> Unit)? = null,
) {
    GlbSceneEntity(session, glbPath, parentEntity, onTap = onTap)
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
@OptIn(androidx.xr.scenecore.ExperimentalCustomMeshApi::class)
@Composable
private fun SelectionBboxEntity(
    session: Session,
    parentEntity: androidx.xr.scenecore.Entity?,
    modelId: String,
    offsetXmm: Float,
    offsetYmm: Float,
    offsetZmm: Float,
    sizeXmm: Float,
    sizeYmm: Float,
    sizeZmm: Float,
) {
    var entity by remember { mutableStateOf<androidx.xr.scenecore.MeshEntity?>(null) }

    LaunchedEffect(modelId, sizeXmm, sizeYmm, sizeZmm, parentEntity) {
        val oldEntity = entity

        // Define vertex layout: position (buffer 0) and color (buffer 1).
        // COLOR requires UBYTE4_NORM in alpha15.
        val layout = androidx.xr.scenecore.VertexLayout(
            listOf(
                androidx.xr.scenecore.VertexAttributeDescriptor(
                    androidx.xr.scenecore.VertexAttribute.POSITION,
                    androidx.xr.scenecore.VertexAttributeType.FLOAT3,
                    0
                ),
                androidx.xr.scenecore.VertexAttributeDescriptor(
                    androidx.xr.scenecore.VertexAttribute.COLOR,
                    androidx.xr.scenecore.VertexAttributeType.UBYTE4_NORM,
                    1
                )
            )
        )

        // Selection bbox is a wireframe box composed of 12 edges, each rendered as
        // a small 2mm tube-like box (8 vertices, 36 indices per edge).
        // Total: 12 * 8 = 96 vertices, 12 * 36 = 432 indices.
        val h = 1.0f // 1mm half-thickness
        val xNeg = -sizeXmm / 2f; val xPos = sizeXmm / 2f
        val yNeg = -sizeYmm / 2f; val yPos = sizeYmm / 2f
        val zLo = 0f; val zHi = sizeZmm
        val selColor = floatArrayOf(1.0f, 0.65f, 0.0f, 1.0f) // Orca Orange, fully opaque

        val positions = FloatArray(96 * 3)
        val colors = ByteArray(96 * 4)  // RGBA per vertex (UBYTE4_NORM)
        val indices = IntArray(432)

        var pi = 0; var ci = 0; var ii = 0; var baseId = 0

        fun emitBox(xmin: Float, ymin: Float, zmin: Float, xmax: Float, ymax: Float, zmax: Float) {
            val pts = floatArrayOf(
                xmin, ymin, zmin, xmax, ymin, zmin, xmax, ymax, zmin, xmin, ymax, zmin,
                xmin, ymin, zmax, xmax, ymin, zmax, xmax, ymax, zmax, xmin, ymax, zmax
            )
            val rByte = (selColor[0] * 255f).toInt().toByte()
            val gByte = (selColor[1] * 255f).toInt().toByte()
            val bByte = (selColor[2] * 255f).toInt().toByte()
            val aByte = (selColor[3] * 255f).toInt().toByte()
            for (v in 0 until 8) {
                positions[pi++] = pts[v * 3]; positions[pi++] = pts[v * 3 + 1]; positions[pi++] = pts[v * 3 + 2]
                colors[ci++] = rByte; colors[ci++] = gByte; colors[ci++] = bByte; colors[ci++] = aByte
            }
            val faces = intArrayOf(
                0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
                3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5
            )
            for (idx in faces) indices[ii++] = baseId + idx
            baseId += 8
        }

        // 4 vertical edges
        for (xs in floatArrayOf(xNeg, xPos)) for (ys in floatArrayOf(yNeg, yPos)) {
            emitBox(xs - h, ys - h, zLo - h, xs + h, ys + h, zHi + h)
        }
        // 4 X-axis edges
        for (ys in floatArrayOf(yNeg, yPos)) for (zs in floatArrayOf(zLo, zHi)) {
            emitBox(xNeg - h, ys - h, zs - h, xPos + h, ys + h, zs + h)
        }
        // 4 Y-axis edges
        for (xs in floatArrayOf(xNeg, xPos)) for (zs in floatArrayOf(zLo, zHi)) {
            emitBox(xs - h, yNeg - h, zs - h, xs + h, yPos + h, zs + h)
        }

        val posBuf = java.nio.ByteBuffer.allocateDirect(positions.size * 4).order(java.nio.ByteOrder.nativeOrder())
        posBuf.asFloatBuffer().put(positions).flip()
        val colBuf = java.nio.ByteBuffer.allocateDirect(colors.size).order(java.nio.ByteOrder.nativeOrder())
        colBuf.put(colors).flip()
        val idxBuf = java.nio.ByteBuffer.allocateDirect(indices.size * 4).order(java.nio.ByteOrder.nativeOrder())
        idxBuf.asIntBuffer().put(indices).flip()

        val mesh = androidx.xr.scenecore.CustomMesh.FromMeshDataBuilder(session, layout)
            .addVertexData(androidx.xr.scenecore.ByteBufferRegion(posBuf, 0, posBuf.capacity()))
            .addVertexData(androidx.xr.scenecore.ByteBufferRegion(colBuf, 0, colBuf.capacity()))
            .setIndexData(androidx.xr.scenecore.ByteBufferRegion(idxBuf, 0, idxBuf.capacity()))
            .addSubset(androidx.xr.scenecore.MeshSubset(androidx.xr.scenecore.MeshSubsetTopology.TRIANGLES, 0, indices.size))
            .build()

        val material = androidx.xr.scenecore.KhronosUnlitMaterial.create(session, androidx.xr.scenecore.AlphaMode.OPAQUE)
        material.setBaseColorFactor(androidx.xr.runtime.math.Vector4(1f, 1f, 1f, 1f)) // Vertex colors already have orange

        val ent = androidx.xr.scenecore.MeshEntity.create(session, mesh, listOf(material))
        applyWorkspacePose(ent, parentEntity ?: session.scene.activitySpace)

        // Give Filament a few frames to settle as usual.
        kotlinx.coroutines.android.awaitFrame()
        kotlinx.coroutines.android.awaitFrame()
        kotlinx.coroutines.android.awaitFrame()

        if (ent.isDisposed) {
            disposeEntityDeferred(oldEntity)
            return@LaunchedEffect
        }
        entity = ent
        disposeEntityDeferred(oldEntity)
    }

    LaunchedEffect(entity, offsetXmm, offsetYmm, offsetZmm) {
        val ent = entity ?: return@LaunchedEffect
        if (ent.isDisposed) return@LaunchedEffect
        ent.setPose(
            androidx.xr.runtime.math.Pose(
                androidx.xr.runtime.math.Vector3(
                    offsetXmm * WORLD_SCALE,
                    offsetYmm * WORLD_SCALE,
                    offsetZmm * WORLD_SCALE,
                ),
                androidx.xr.runtime.math.Quaternion.Identity,
            ),
        )
    }

    // Composition-leave dispose only — keyed on Unit so it does NOT
    // fire on every modelId / size change. Those are handled by the
    // load LaunchedEffect above with a deferred dispose; firing this
    // onDispose synchronously on a swap would re-introduce the
    // split_engine_bridge "unknown node id" race.
    DisposableEffect(Unit) {
        onDispose {
            entity?.let { if (!it.isDisposed) runCatching { it.parent = null } }
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
    offsetZmm: Float = 0f,
    paintHooks: PaintInputHooks? = null,
    onTap: (() -> Unit)? = null,
    onHoverChange: ((Boolean) -> Unit)? = null,
    /** When non-null, the renderer applies these deltas as a live
     *  setPose+setScale on the existing GltfModelEntity instead of
     *  letting the gizmo trigger a full preview re-bake. Cleared on
     *  drag end; the parent then commits to PlacedModel and the
     *  re-bake LaunchedEffect runs once with the final values. */
    liveOverride: GizmoDragOverride? = null,
) {
    var entity by remember { mutableStateOf<GltfModelEntity?>(null) }
    // gotcha #13: signature (size<<32 | contentHash) of the GLB bytes
    // currently attached. When previewStl emits a redundant re-bake
    // whose bytes are identical (the v1→v2(→v3) churn, now byte-equal
    // via the synced-palette fix), we skip the SceneCore detach/
    // re-attach entirely — that attach/detach churn on a heavy mesh is
    // what trips the Impress "unknown material instance id" SIGABRT.
    var attachedGlbSig by remember { mutableStateOf<Long?>(null) }
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
    // Throttle hand HOVER_MOVE logs to one per 250 ms per entity so
    // the actionable lines (DOWN / MOVE / UP / ray miss) aren't
    // drowned out. Mutable Long so the listener closure can update it.
    var lastHoverLogMs = 0L

    LaunchedEffect(glbPath, parentEntity) {
        // Capture old entity for deferred dispose. Synchronous dispose
        // here races split_engine_bridge with NOT_FOUND aborts
        // ("unknown node" / "unknown material instance id") when the
        // render thread still has queued ops on the old node — common
        // during 3MF load because gotcha #22 fires two previewStl
        // bakes within milliseconds, and the GLB swap also recomposes
        // the SelectionBboxEntity / TransformGizmo whose own component
        // adds get queued to the same render thread. Holding the old
        // entity ref alive briefly past the swap lets that queue drain.
        val oldEntity = entity

        if (glbPath.isNullOrEmpty()) {
            entity = null
            attachedGlbSig = null
            disposeEntityDeferred(oldEntity)
            return@LaunchedEffect
        }

        android.util.Log.i("OrcaXR", "GlbSceneEntity loading $glbPath")
        val bytes = withContext(Dispatchers.IO) {
            runCatching { File(glbPath).readBytes() }.getOrNull()
        }
        if (bytes == null) {
            entity = null
            attachedGlbSig = null
            disposeEntityDeferred(oldEntity)
            return@LaunchedEffect
        }

        // gotcha #13: if the new GLB is byte-identical to the one
        // already attached, skip the entire SceneCore create/attach/
        // dispose cycle. previewStl re-bakes the colored GLB on several
        // recomposition triggers (palette/selection/paint effects); for
        // a freshly-loaded 3MF the v1 and echo v2 bakes are now
        // byte-identical (synced-palette fix), and selection re-fires
        // produce the same bytes too. Re-attaching a heavy (0.5M-tri)
        // GLB on every echo churns Impress material instances and
        // intermittently aborts with "unknown material instance id".
        // Collapsing identical re-bakes to a single stable attach
        // removes that churn. oldEntity === entity here, so there is
        // nothing to dispose.
        val newSig = (bytes.size.toLong() shl 32) or
            (bytes.contentHashCode().toLong() and 0xffffffffL)
        if (entity != null && !entity!!.isDisposed && newSig == attachedGlbSig) {
            android.util.Log.i(
                "OrcaXR",
                "GlbSceneEntity skip re-attach (byte-identical) $glbPath",
            )
            return@LaunchedEffect
        }

        // Use a unique name to avoid session conflicts
        val uniqueName = "m_${glbPath.hashCode().toString(36)}_${System.currentTimeMillis().toString(36)}.glb"
        val model = runCatching { GltfModel.create(session, bytes, uniqueName) }
            .onFailure { android.util.Log.e("OrcaXR", "GltfModel.create failed for $glbPath", it) }
            .getOrNull()
        if (model == null) {
            entity = null
            disposeEntityDeferred(oldEntity)
            return@LaunchedEffect
        }

        val ent = GltfModelEntity.create(session, model)
        applyWorkspacePose(ent, parentEntity ?: session.scene.activitySpace)

        // Let Filament's render thread bind the material instance for
        // this entity before downstream effects (notably the
        // InteractableComponent attach in the DisposableEffect keyed
        // on `entity`) queue collider ops that reference it. Without
        // this gap, a heavy 3MF load can race split_engine_bridge
        // with `unknown material instance id: N` on `addComponent`
        // because the IC attach lands on the render queue before the
        // entity's material is bound. Symptom (2026-05-02): app
        // aborted with SIGABRT on every dragon.3mf load. Three frames
        // is a heuristic — empirically 2 wasn't always enough on this
        // 1.4M-tri mesh.
        kotlinx.coroutines.android.awaitFrame()
        kotlinx.coroutines.android.awaitFrame()
        kotlinx.coroutines.android.awaitFrame()
        if (ent.isDisposed) {
            disposeEntityDeferred(oldEntity)
            return@LaunchedEffect
        }

        entity = ent
        attachedGlbSig = newSig
        android.util.Log.i("OrcaXR", "GlbSceneEntity attached $glbPath at ($offsetXmm, $offsetYmm, $offsetZmm)")
        disposeEntityDeferred(oldEntity)
    }

    // Steady-state pose update: position only (rotation/scale are baked
    // into the GLB by previewStl, so identity is correct here). Re-runs
    // when the user types a translate value or drags the bed under the
    // workspace.
    LaunchedEffect(entity, offsetXmm, offsetYmm, offsetZmm) {
        val ent = entity ?: return@LaunchedEffect
        if (ent.isDisposed) return@LaunchedEffect
        ent.setPose(androidx.xr.runtime.math.Pose(
            androidx.xr.runtime.math.Vector3(
                offsetXmm * WORLD_SCALE,
                offsetYmm * WORLD_SCALE,
                offsetZmm * WORLD_SCALE,
            ),
            androidx.xr.runtime.math.Quaternion.Identity,
        ))
    }

    // Live-drag override: only kicks in while a gizmo is being dragged.
    // Outside drags (liveOverride == null) we leave pose+scale untouched
    // so the steady-state effect above runs against an entity whose
    // material instance was bound exactly once at create time. An earlier
    // attempt re-issued setScale(Vector3, ...) on every recomposition and
    // tripped Impress's split_engine_bridge with "unknown material
    // instance id" — Filament rebinds materials when scale changes type
    // (scalar -> vector), which races the loader on a freshly created
    // GltfModelEntity.
    LaunchedEffect(entity, offsetXmm, offsetYmm, offsetZmm, liveOverride) {
        val ent = entity ?: return@LaunchedEffect
        if (ent.isDisposed) return@LaunchedEffect
        val ov = liveOverride ?: return@LaunchedEffect

        // Gotcha #10: setScale(Vector3) races material binding on freshly 
        // created entities. Wait one frame before applying non-uniform scale.
        kotlinx.coroutines.android.awaitFrame()
        if (ent.isDisposed) return@LaunchedEffect

        ent.setPose(androidx.xr.runtime.math.Pose(
            androidx.xr.runtime.math.Vector3(
                (offsetXmm + ov.deltaTxMm) * WORLD_SCALE,
                (offsetYmm + ov.deltaTyMm) * WORLD_SCALE,
                (offsetZmm + ov.deltaTzMm) * WORLD_SCALE,
            ),
            androidx.xr.runtime.math.Quaternion.fromEulerAngles(
                ov.deltaRotXDeg, ov.deltaRotYDeg, ov.deltaRotZDeg,
            ),
        ))
        ent.setScale(
            androidx.xr.runtime.math.Vector3(
                WORLD_SCALE * ov.scaleMultX,
                WORLD_SCALE * ov.scaleMultY,
                WORLD_SCALE * ov.scaleMultZ,
            ),
            androidx.xr.scenecore.Space.PARENT,
        )
    }


    // Persistent InteractableComponent — attached once per entity, kept
    // for the entity's lifetime. The listener routes each event to
    // paint hooks vs. selection callbacks at DISPATCH time by reading
    // the live `hooksLive` / `onTapLive` / `onHoverLive` references —
    // never swapped on mode change.
    //
    // Why persistent: the previous design re-keyed the DisposableEffect
    // on `(entity, paintHooksActive, selectionActive)` so flipping paint
    // mode tore down and recreated the IC. On Galaxy XR / SceneCore
    // alpha13 that swap is racy: events queued before
    // `removeComponent(oldIc)` lands kept dispatching to the OLD
    // listener (with its stale `paintHooksActive=false` capture), so
    // pinches arriving right after the user tapped Paint were silently
    // routed through the selection branch instead of the paint hooks.
    // Symptom in the bug logs (2026-05-02): `InteractableComponent
    // attached … (mode=paint)` followed 18 ms later by InputEvents
    // logging `mode=select` from the same entity, with no `handle:`
    // line ever firing — paint genuinely did nothing for the user.
    //
    // Hooking once and routing dynamically removes the swap entirely:
    // the IC is whatever the model needs as soon as the entity exists,
    // and a brush-mode flip just changes which `*Live.value` the
    // listener reads on the next event.
    DisposableEffect(entity) {
        val ent = entity
        if (ent == null) {
            onDispose { /* nothing attached */ }
        } else {
            val executor = androidx.core.content.ContextCompat.getMainExecutor(ctx)
            val listener = java.util.function.Consumer<androidx.xr.scenecore.InputEvent> { event ->
                val routedToPaint = hooksLive.value != null
                // Per-event log removed — string formatting at 60 Hz
                // produced ~30 KB/s of garbage that worsened the
                // stamp-pipeline OOM. The downstream `handle:` /
                // `stamped` lines tell us all we need.
                if (routedToPaint) {
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

            val attached = ic != null && !ent.isDisposed && runCatching { ent.addComponent(ic!!) }.getOrDefault(false)
            if (attached) {
                // Space.REAL_WORLD is deprecated in alpha15 (no direct
                // replacement yet); suppress for diagnostic logging only.
                @Suppress("DEPRECATION")
                val pose = runCatching { ent.getPose(androidx.xr.scenecore.Space.REAL_WORLD) }.getOrNull()
                @Suppress("DEPRECATION")
                val scale = runCatching { ent.getScale(androidx.xr.scenecore.Space.REAL_WORLD) }.getOrNull()
                val posStr = pose?.translation?.let {
                    "(%.3f,%.3f,%.3f)m".format(it.x, it.y, it.z)
                } ?: "?"
                val scaleStr = scale?.let { "%.4f".format(it) } ?: "?"
                android.util.Log.i(
                    "OrcaXR/paint",
                    "InteractableComponent attached to $glbPath (persistent) " +
                        "worldPos=$posStr worldScale=$scaleStr " +
                        "offsets=($offsetXmm,$offsetYmm,$offsetZmm)mm",
                )
            } else {
                android.util.Log.w(
                    "OrcaXR/paint",
                    "InteractableComponent NOT attached to $glbPath (ic=${ic != null} disposed=${ent.isDisposed})",
                )
            }
            onDispose {
                if (attached && !ent.isDisposed) {
                    runCatching { ent.removeComponent(ic!!) }
                    android.util.Log.i("OrcaXR/paint", "InteractableComponent detached from $glbPath")
                }
            }
        }
    }

    // Composition-leave dispose only — keyed on Unit so it does NOT
    // fire on every glbPath change. Path changes are handled by the
    // load LaunchedEffect above with a deferred dispose; firing this
    // onDispose synchronously on a path swap would re-introduce the
    // split_engine_bridge "unknown node id" race.
    DisposableEffect(Unit) {
        onDispose {
            android.util.Log.i("OrcaXR", "GlbSceneEntity onDispose $glbPath (composition leave)")
            entity?.let { if (!it.isDisposed) runCatching { it.parent = null } }
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

internal fun applyMapToPhysical(list: List<FilamentEntry>, slot: Int, physicalSlot: Int): List<FilamentEntry> {
    if (slot !in list.indices) return list
    return list.mapIndexed { i, f ->
        when {
            i == slot -> f.copy(physicalSlot = physicalSlot, virtualSlot = null)
            // Physical-slot uniqueness: any OTHER row that previously
            // held this physical slot is bumped back to identity
            // (physicalSlot = null). Without this, two project filaments
            // can share a physical extruder, and libslic3r's filament_map
            // collapses both painted regions onto the same Tn — the
            // dragon-3MF "purple body printed onto T0 alongside white"
            // regression. The FilamentEntriesStore.kt header documents
            // this as the intended UX contract.
            f.physicalSlot == physicalSlot -> f.copy(physicalSlot = null)
            else -> f
        }
    }
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

/**
 * Roadmap A13 — produce the `wipe_tower_x` / `wipe_tower_y` extras
 * map when the user has opted into auto-positioning. Empty map when
 * the toggle is off OR the persisted X/Y are NaN (set-once invariant
 * — the auto-position MCP tool writes both atomically).
 *
 * Call from every `mergedConfig(...)` site that drives a real slice;
 * the result is `+`'d onto the user's `extraOverrides` map so it wins
 * cleanly over the profile's bundled defaults.
 */
internal fun wipeTowerExtraOverrides(ctx: android.content.Context): Map<String, String> {
    val prefs = UserPreferences(ctx)
    if (!prefs.wipeTowerAutoPosition) return emptyMap()
    val x = prefs.wipeTowerXOverride
    val y = prefs.wipeTowerYOverride
    if (x.isNaN() || y.isNaN()) return emptyMap()
    return mapOf(
        "wipe_tower_x" to "%.3f".format(x),
        "wipe_tower_y" to "%.3f".format(y),
    )
}

/**
 * FullSpectrum auto-enabled config overrides. When the active printer
 * has at least one enabled virtual filament row, switch on the master
 * dithering toggle + sensible per-region defaults so the engine
 * emission patches (0027-0034) see coherent settings at slice time.
 * Empty for prints with no virtual filaments (zero-cost fallback to
 * vanilla libslic3r behavior).
 *
 * Mirrors how FullSpectrum-aware OrcaSlicer forks auto-set these when
 * the user populates the Mixed Filament panel — keeps OrcaXR's slice
 * output identical to a desktop FS slice for the same project.
 *
 * Extend with explicit per-printer UI later; for now we trust the
 * libslic3r defaults registered in patch 0016 for the rest of the
 * dithering knobs (z step, line height A/B, pointillism geometry).
 */
internal fun fullSpectrumExtraOverrides(virtualRowsEnabled: Boolean): Map<String, String> {
    if (!virtualRowsEnabled) return emptyMap()
    return mapOf(
        // Restrict cadence to painted zones by default; full-bed cadence
        // would force every layer to alternate even on background plates,
        // which is rarely what the user wants.
        //
        // `mixed_filament_advanced_dithering` is deliberately omitted here so
        // the 3MF's authored value (or the libslic3r default = false) wins.
        // Previously we hardcoded it to "1" which clobbered the 3MF's "0"
        // via the extraOverrides → projectOverrides precedence and forced
        // OrcaXR onto the use_component_b_advanced_dither resolver branch,
        // producing a T0↔T3 inversion vs the desktop FullSpectrum reference
        // for PeggyPalette38+Mini+BRYW.3mf. Users who want it on for
        // STL-loaded models can flip the toggle in the MixedAdvancedEditor
        // UI; 3MFs already carry the value they were authored with.
        "dithering_step_painted_zones_only" to "1",
    )
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
internal fun parseMixedDefinitionsForKotlin(serialized: String): List<MixedFilamentEntry> {
    if (serialized.isBlank()) return emptyList()
    val out = mutableListOf<MixedFilamentEntry>()
    val maxBiasMm = 0.4f.coerceIn(0.01f, 0.35f)  // matches max_component_surface_offset_mm default
    for (rawRow in serialized.split(';')) {
        val row = rawRow.trim()
        if (row.isEmpty()) continue
        val fields = row.split(',').map { it.trim() }
        if (fields.size < 5) continue
        val a = fields[0].toIntOrNull() ?: continue
        val b = fields[1].toIntOrNull() ?: continue
        val enabled = fields[2].toIntOrNull() != 0
        val custom = fields[3].toIntOrNull() != 0
        val mixB = fields[4].toIntOrNull()?.coerceIn(0, 100) ?: 50
        var pointillismAll = false
        var gradientIds = ""
        var gradientWeights = ""
        var distMode = 0
        var localZMax = 0
        var aOff = 0f
        var bOff = 0f
        var deleted = false
        var originAuto = false
        var stableId: String? = null
        var manualPattern: String? = null
        if (fields.size >= 6) pointillismAll = (fields[5].toIntOrNull() ?: 0) != 0
        for (f in fields.drop(6)) {
            when {
                f.startsWith("xa") -> aOff = f.removePrefix("xa").toFloatOrNull() ?: 0f
                f.startsWith("xb") -> bOff = f.removePrefix("xb").toFloatOrNull() ?: 0f
                f.startsWith("g") -> gradientIds = f.removePrefix("g")
                f.startsWith("w") -> gradientWeights = f.removePrefix("w")
                f.startsWith("m") -> distMode = (f.removePrefix("m").toIntOrNull() ?: 0).coerceIn(0, 2)
                f.startsWith("z") -> localZMax = (f.removePrefix("z").toIntOrNull() ?: 0).coerceAtLeast(0)
                f.startsWith("d") -> deleted = (f.removePrefix("d").toIntOrNull() ?: 0) != 0
                f.startsWith("o") -> originAuto = (f.removePrefix("o").toIntOrNull() ?: 0) != 0
                f.startsWith("u") -> stableId = f.removePrefix("u")
                // Trailing manual pattern: digits 1..9 only (libslic3r normalizes).
                f.isNotEmpty() && f.all { ch -> ch in '1'..'9' } -> manualPattern = f
            }
        }
        // PRESERVE deleted (d=1) rows. Skipping them here corrupts the row
        // index that libslic3r's MixedFilamentManager::resolve uses:
        // `mixed_index_from_filament_id` computes `filament_id - num_physical - 1`
        // as a direct index into `m_mixed`, so dropping the 6 auto-pair
        // rows that the desktop FullSpectrum app emits at the top of the
        // wire format (one per unordered physical pair, all marked d=1)
        // shifts every virtual filament ID by 6. The model's parts then
        // map to the wrong rows — observed as a T0↔T3 inversion vs the
        // desktop reference for PeggyPalette38+Mini+BRYW.3mf
        // (OrcaXR's extruder=21 → 1+4 27/73 row, desktop's extruder=21 →
        // 2+3 88/12 row). Round-tripped rows retain `deleted=true` and
        // the serializer re-emits them as `d1` so the libslic3r side
        // sees the same vector layout it would after running its own
        // auto_generate.
        // Reverse surface_offset_pair_from_signed_bias() to recover signed bias%.
        val signedBiasMm = bOff - aOff
        val biasPct = kotlin.math.round((signedBiasMm / maxBiasMm) * 100f).toInt().coerceIn(-100, 100)
        out += MixedFilamentEntry(
            id = stableId?.let { "fs_$it" } ?: "fs_${a}_${b}_${out.size}",
            componentA = a,
            componentB = b,
            mixBPercent = mixB,
            biasPercent = biasPct,
            manualPattern = manualPattern,
            gradientComponentIds = gradientIds,
            gradientComponentWeights = gradientWeights,
            distributionMode = distMode,
            localZMaxSublayers = localZMax,
            pointillismAllFilaments = pointillismAll,
            enabled = enabled,
            custom = custom,
            deleted = deleted,
            originAuto = originAuto,
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
            // Roadmap E8 — slice cancelled mid-flight via the
            // foreground notification or MCP cancel_slice. Show as
            // a neutral message rather than an error.
            SliceResult.Cancelled -> Text(
                "Slicing ${state.sourceLabel} was cancelled.",
                style = MaterialTheme.typography.bodyLarge,
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
    /**
     * Paint full-feature-parity (3MF round-trip) — when the user
     * authored paint in XR, those annotations should ride into the
     * exported 3MF so opening it in desktop OrcaSlicer or re-opening
     * here shows the same painted regions. Null arrays = pass-through
     * (preserves whatever paint the source already had).
     */
    paintFilamentIndex: ByteArray? = null,
    supportFlags: ByteArray? = null,
    seamFlags: ByteArray? = null,
    fuzzySkinFlags: ByteArray? = null,
    /** Paint full-feature-parity (Brim Ears) — flat float[4N] of
     *  (x, y, z, head_radius) quads. */
    brimEars: FloatArray? = null,
    /**
     * D9 — per-object config overrides applied to `mo->config()` so
     * libslic3r serializes them into model_settings.config.
     */
    objectConfigOverrides: Map<String, String> = emptyMap(),
    /**
     * D9 — per-volume config overrides keyed by 0-based volume index.
     */
    volumeConfigOverrides: Map<Int, Map<String, String>> = emptyMap(),
    /**
     * A11 — custom-gcode ticks for the active plate.
     */
    customGcodeTicks: List<SlicerEngine.CustomGcodeTick> = emptyList(),
    /**
     * A12 — per-Z-band config overrides written into the 3MF.
     */
    heightRanges: List<HeightRange> = emptyList(),
): File? {
    if (!sourceFile.exists()) return null
    val dest = downloadsPathFor(sourceLabel, "3mf")
    return if (SlicerEngine.saveAs3mf(
            input = sourceFile,
            outPath = dest,
            config = config,
            paintFilamentIndex = paintFilamentIndex,
            supportFlags = supportFlags,
            seamFlags = seamFlags,
            fuzzySkinFlags = fuzzySkinFlags,
            brimEars = brimEars,
            objectConfigOverrides = objectConfigOverrides,
            volumeConfigOverrides = volumeConfigOverrides,
            customGcodeTicks = customGcodeTicks,
            heightRanges = heightRanges,
        )) dest else null
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
     * Paint full-feature-parity — per-triangle fuzzy-skin paint state.
     * Flows into `mv->fuzzy_skin_facets`. State 1 = FUZZY_SKIN. Null
     * / all-zero = no fuzzy paint authored.
     */
    fuzzySkinFlags: ByteArray? = null,
    /**
     * Paint full-feature-parity (Brim Ears) — flat float[4N] of
     * (x, y, z, head_radius) quads. Null / empty = no ears.
     */
    brimEars: FloatArray? = null,
    /**
     * Phase XR_OBJ_4 (final) — per-object config overrides applied to
     * `mo->config()` after load. Default empty preserves existing
     * behavior.
     */
    objectConfigOverrides: Map<String, String> = emptyMap(),
    /**
     * A10 — per-object adaptive / variable layer-height profile.
     * Flat float[] of (z, h) pairs. Null / empty / odd-length = no
     * profile (libslic3r's global layer_height governs).
     */
    layerHeightProfile: FloatArray? = null,
    /**
     * A11 — custom G-code ticks for the active plate. Empty = no ticks.
     */
    customGcodeTicks: List<SlicerEngine.CustomGcodeTick> = emptyList(),
    /**
     * A12 — per-Z-band config overrides authored onto
     * `mo->layer_config_ranges`. Empty = no per-band overrides.
     */
    heightRanges: List<HeightRange> = emptyList(),
    onProgress: ((percent: Int, message: String) -> Unit)? = null,
): SliceResult {
    val gcode = File(stl.parentFile, "${stl.name}.gcode")
    val effectiveRemap = if (virtualRemap == null || virtualRemap.all { it == 0 }) null else virtualRemap
    val effectivePaint = if (paintFilamentIndex == null || !hasAnyPaint(paintFilamentIndex)) null else paintFilamentIndex
    val effectiveSupport = if (supportFlags == null || !hasAnyPaint(supportFlags)) null else supportFlags
    val effectiveSeam = if (seamFlags == null || !hasAnyPaint(seamFlags)) null else seamFlags
    val effectiveFuzzy = if (fuzzySkinFlags == null || !hasAnyPaint(fuzzySkinFlags)) null else fuzzySkinFlags
    val effectiveBrim = if (brimEars == null || brimEars.isEmpty()) null else brimEars
    val effectiveLhp = layerHeightProfile?.takeIf { it.size >= 4 && (it.size and 1) == 0 }
    return SlicerEngine.slice(
        stl = stl,
        outGcode = gcode,
        config = config,
        virtualRemap = effectiveRemap,
        paintFilamentIndex = effectivePaint,
        extraVolumes = extraVolumes,
        supportFlags = effectiveSupport,
        seamFlags = effectiveSeam,
        fuzzySkinFlags = effectiveFuzzy,
        brimEars = effectiveBrim,
        objectConfigOverrides = objectConfigOverrides,
        layerHeightProfile = effectiveLhp,
        customGcodeTicks = customGcodeTicks,
        heightRanges = heightRanges,
        onProgress = onProgress,
    )
}

/**
 * Paint full-feature-parity (Brim Ears) — flatten a list of
 * [BrimEarPoint]s into the JNI's flat float[4N] (x, y, z, head_radius)
 * format. Empty list returns null (which the JNI side reads as "no
 * ears authored").
 */
private fun List<BrimEarPoint>.toBrimEarsFloatArray(): FloatArray? {
    if (isEmpty()) return null
    val out = FloatArray(size * 4)
    for ((i, p) in withIndex()) {
        out[i * 4 + 0] = p.x
        out[i * 4 + 1] = p.y
        out[i * 4 + 2] = p.z
        out[i * 4 + 3] = p.headRadiusMm
    }
    return out
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
