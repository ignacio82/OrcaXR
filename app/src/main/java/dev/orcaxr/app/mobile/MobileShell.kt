package dev.orcaxr.app.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.outlined.Architecture
import androidx.compose.material.icons.outlined.LocalFireDepartment
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.mobile.screens.FilamentScreen
import dev.orcaxr.app.mobile.screens.FilesScreen
import dev.orcaxr.app.mobile.screens.HomeScreen
import dev.orcaxr.app.mobile.screens.MonitorScreen
import dev.orcaxr.app.mobile.screens.OnboardingScreen
import dev.orcaxr.app.mobile.screens.PreviewScreen as MobilePreviewScreen
import dev.orcaxr.app.mobile.screens.ProfileScreen
import dev.orcaxr.app.mobile.screens.SettingsScreen
import dev.orcaxr.app.mobile.screens.SlicerScreen

/** App-state CompositionLocal — every screen pulls stores out of here. */
val LocalMobileAppState = staticCompositionLocalOf<MobileAppState> {
    error("MobileAppState not provided")
}

/** Top-level mobile destinations. Tablet and phone share the same set;
 *  what differs is how they're surfaced (NavRail vs BottomNav). Preview
 *  is reachable only via the Slicer's "view G-code preview" CTA, not
 *  exposed in the nav itself. */
enum class MobileDestination(
    val label: String,
    val icon: ImageVector,
    val showInNav: Boolean = true,
) {
    Home("Home", Icons.Filled.Home),
    Slicer("Slicer", Icons.Outlined.Architecture),
    Files("Files", Icons.Filled.Folder),
    Monitor("Monitor", Icons.Outlined.Videocam),
    Filament("Filament", Icons.Outlined.LocalFireDepartment),
    Profiles("Profiles", Icons.Outlined.Tune),
    Settings("Settings", Icons.Filled.Settings),
    Preview("G-code preview", Icons.Filled.Folder, showInNav = false);
}

/**
 * Adaptive shell. Width < 600 dp ⇒ phone form factor (BottomNav);
 * Width >= 600 dp ⇒ tablet (NavRail + extra inspector pane room).
 *
 * The Onboarding screen takes over the whole surface (no nav chrome)
 * until the user has at least one printer configured — a printer-less
 * empty state on the Home screen would look broken on a fresh install.
 */
@Composable
fun MobileShell(
    appState: MobileAppState,
    forceDark: Boolean?,
    onSetForceDark: (Boolean?) -> Unit,
    pendingSlicerFile: kotlinx.coroutines.flow.MutableStateFlow<String?>? = null,
) {
    OrcaXrMobileTheme(forceDark = forceDark) {
        CompositionLocalProvider(LocalMobileAppState provides appState) {
            BoxWithConstraints(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                val isTablet = maxWidth >= 600.dp

                var dest by rememberSaveable { mutableStateOf(MobileDestination.Home) }
                var slicerFilePath by rememberSaveable { mutableStateOf<String?>(null) }
                var slicerOutputPath by rememberSaveable { mutableStateOf<String?>(null) }
                // Paint state — ByteArrays don't go through rememberSaveable
                // out of the box (Bundle.putByteArray works, but the
                // Compose Saver isn't auto-installed for them). They
                // live in MutableState across recompositions; on
                // process-death we lose the paint, which matches the
                // XR shell's behavior — paint is per-session unless
                // explicitly committed to a slice.
                var slicerPaintIndex by remember { mutableStateOf<ByteArray?>(null) }
                var paintModeFile by rememberSaveable { mutableStateOf<String?>(null) }
                var slicerTransform by remember { mutableStateOf(dev.orcaxr.app.SlicerEngine.ModelPlacement()) }

                // Onboarding gating: until at least one printer exists,
                // route to the Onboarding flow regardless of `dest`.
                val printersList by appState.printers.printers.collectAsState(
                    initial = emptyList<dev.orcaxr.app.PrinterConfig>(),
                )
                var onboardingComplete by rememberSaveable { mutableStateOf(false) }

                // When MobileActivity stages a shared file, route it
                // directly into the Slicer screen so a share-to-OrcaXR
                // from the browser / MakerWorld lands the user on the
                // file ready to slice — not on Files asking them to
                // pick which one. The flow drains a single value per
                // intent so subsequent recompositions don't re-route.
                if (pendingSlicerFile != null) {
                    androidx.compose.runtime.LaunchedEffect(Unit) {
                        pendingSlicerFile.collect { p ->
                            if (p != null) {
                                slicerFilePath = p
                                slicerOutputPath = null
                                slicerPaintIndex = null
                                onboardingComplete = true
                                dest = MobileDestination.Slicer
                                pendingSlicerFile.value = null
                            }
                        }
                    }
                }
                if (printersList.isEmpty() && !onboardingComplete) {
                    OnboardingScreen(
                        onSkip = { onboardingComplete = true },
                        onAdded = { onboardingComplete = true },
                    )
                    return@BoxWithConstraints
                }

                // Paint mode is a full-screen takeover (no nav chrome)
                // since the user's only meaningful interaction is the
                // canvas, brush size, and slot picker.
                val activePaintFile = paintModeFile
                if (activePaintFile != null) {
                    dev.orcaxr.app.mobile.screens.PaintScreen(
                        filePath = activePaintFile,
                        initialPaint = slicerPaintIndex,
                        onApply = { applied ->
                            slicerPaintIndex = applied
                            paintModeFile = null
                            dest = MobileDestination.Slicer
                        },
                        onCancel = {
                            paintModeFile = null
                            dest = MobileDestination.Slicer
                        },
                    )
                    return@BoxWithConstraints
                }

                val openPaintCallback: (String) -> Unit = { fp -> paintModeFile = fp }
                if (isTablet) {
                    Row(Modifier.fillMaxSize()) {
                        TabletNavRail(
                            selected = dest,
                            onSelect = { dest = it },
                        )
                        ScreenContent(
                            dest = dest,
                            isTablet = true,
                            slicerFilePath = slicerFilePath,
                            onSetSlicerFile = {
                                if (it != slicerFilePath) {
                                    // New file → discard stale paint + transform
                                    slicerPaintIndex = null
                                    slicerTransform = dev.orcaxr.app.SlicerEngine.ModelPlacement()
                                }
                                slicerFilePath = it
                            },
                            slicerOutputPath = slicerOutputPath,
                            onSetSlicerOutput = { slicerOutputPath = it },
                            slicerPaintIndex = slicerPaintIndex,
                            onOpenPaint = openPaintCallback,
                            transform = slicerTransform,
                            onSetTransform = { slicerTransform = it },
                            onNavigate = { dest = it },
                            forceDark = forceDark,
                            onSetForceDark = onSetForceDark,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                } else {
                    Column(Modifier.fillMaxSize()) {
                        ScreenContent(
                            dest = dest,
                            isTablet = false,
                            slicerFilePath = slicerFilePath,
                            onSetSlicerFile = {
                                if (it != slicerFilePath) {
                                    slicerPaintIndex = null
                                }
                                slicerFilePath = it
                            },
                            slicerOutputPath = slicerOutputPath,
                            onSetSlicerOutput = { slicerOutputPath = it },
                            slicerPaintIndex = slicerPaintIndex,
                            onOpenPaint = openPaintCallback,
                            transform = slicerTransform,
                            onSetTransform = { slicerTransform = it },
                            onNavigate = { dest = it },
                            forceDark = forceDark,
                            onSetForceDark = onSetForceDark,
                            modifier = Modifier.weight(1f).fillMaxWidth(),
                        )
                        PhoneBottomNav(
                            selected = dest,
                            onSelect = { dest = it },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ScreenContent(
    dest: MobileDestination,
    isTablet: Boolean,
    slicerFilePath: String?,
    onSetSlicerFile: (String?) -> Unit,
    slicerOutputPath: String?,
    onSetSlicerOutput: (String?) -> Unit,
    slicerPaintIndex: ByteArray?,
    onOpenPaint: (String) -> Unit,
    transform: dev.orcaxr.app.SlicerEngine.ModelPlacement,
    onSetTransform: (dev.orcaxr.app.SlicerEngine.ModelPlacement) -> Unit,
    onNavigate: (MobileDestination) -> Unit,
    forceDark: Boolean?,
    onSetForceDark: (Boolean?) -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier) {
        when (dest) {
            MobileDestination.Home -> HomeScreen(isTablet, onNavigate)
            MobileDestination.Slicer -> SlicerScreen(
                isTablet = isTablet,
                filePath = slicerFilePath,
                onSetFile = onSetSlicerFile,
                outputPath = slicerOutputPath,
                onSetOutput = onSetSlicerOutput,
                onNavigate = onNavigate,
                paintFilamentIndex = slicerPaintIndex,
                onOpenPaint = onOpenPaint,
                transform = transform,
                onSetTransform = onSetTransform,
            )
            MobileDestination.Files -> FilesScreen(
                isTablet = isTablet,
                onOpenInSlicer = { path ->
                    onSetSlicerFile(path)
                    onSetSlicerOutput(null)
                    onNavigate(MobileDestination.Slicer)
                },
            )
            MobileDestination.Monitor -> MonitorScreen(isTablet)
            MobileDestination.Filament -> FilamentScreen(isTablet)
            MobileDestination.Profiles -> ProfileScreen(isTablet)
            MobileDestination.Settings -> SettingsScreen(
                isTablet = isTablet,
                forceDark = forceDark,
                onSetForceDark = onSetForceDark,
            )
            MobileDestination.Preview -> MobilePreviewScreen(isTablet = isTablet)
        }
    }
}

@Composable
private fun PhoneBottomNav(
    selected: MobileDestination,
    onSelect: (MobileDestination) -> Unit,
) {
    var moreOpen by remember { mutableStateOf(false) }
    val primary = listOf(
        MobileDestination.Home,
        MobileDestination.Slicer,
        MobileDestination.Files,
        MobileDestination.Monitor,
    )
    val overflow = listOf(
        MobileDestination.Profiles,
        MobileDestination.Filament,
        MobileDestination.Settings,
    )
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.navigationBars),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(72.dp)
                .padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            for (d in primary) {
                NavCell(
                    label = d.label,
                    icon = d.icon,
                    selected = selected == d,
                    onClick = { onSelect(d) },
                    modifier = Modifier.weight(1f),
                )
            }
            // "More" entry surfaces Profiles / Filament / Settings via a
            // bottom sheet — keeps the bar at 5 visible cells while
            // every destination is reachable in one tap.
            NavCell(
                label = "More",
                icon = Icons.Filled.MoreHoriz,
                selected = selected in overflow,
                onClick = { moreOpen = true },
                modifier = Modifier.weight(1f),
            )
        }
    }
    if (moreOpen) {
        MoreSheet(
            destinations = overflow,
            selected = selected,
            onSelect = {
                moreOpen = false
                onSelect(it)
            },
            onDismiss = { moreOpen = false },
        )
    }
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun MoreSheet(
    destinations: List<MobileDestination>,
    selected: MobileDestination,
    onSelect: (MobileDestination) -> Unit,
    onDismiss: () -> Unit,
) {
    androidx.compose.material3.ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "More",
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(start = 8.dp, bottom = 8.dp),
            )
            for (d in destinations) {
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = if (selected == d) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
                    onClick = { onSelect(d) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            d.icon,
                            contentDescription = d.label,
                            tint = if (selected == d) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
                        )
                        Spacer(Modifier.width(16.dp))
                        Text(
                            d.label,
                            style = MaterialTheme.typography.titleMedium,
                            color = if (selected == d) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun NavCell(
    label: String,
    icon: ImageVector,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val pillColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent
    val iconColor = if (selected) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
    val labelColor = if (selected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        modifier = modifier
            .fillMaxHeight()
            .clickable(onClick = onClick)
            .padding(top = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            Modifier
                .height(32.dp)
                .background(pillColor, RoundedCornerShape(50))
                .padding(horizontal = 16.dp),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = label, tint = iconColor, modifier = Modifier.size(20.dp))
        }
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = labelColor,
        )
    }
}

@Composable
private fun TabletNavRail(
    selected: MobileDestination,
    onSelect: (MobileDestination) -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier
            .fillMaxHeight()
            .width(96.dp)
            .windowInsetsPadding(WindowInsets.systemBars),
    ) {
        Column(
            Modifier.fillMaxHeight().padding(vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Brand chip — Echo on a teal pill so the rail anchors visually.
            Box(
                Modifier
                    .size(56.dp)
                    .background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                EchoMark(size = 32.dp, color = MaterialTheme.colorScheme.primary)
            }
            Spacer(Modifier.height(8.dp))
            for (d in MobileDestination.values()) {
                if (!d.showInNav) continue
                RailCell(
                    label = d.label,
                    icon = d.icon,
                    selected = selected == d,
                    onClick = { onSelect(d) },
                )
            }
        }
    }
}

@Composable
private fun RailCell(
    label: String,
    icon: ImageVector,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val pillColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent
    val iconColor = if (selected) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
    val labelColor = if (selected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        Modifier
            .clickable(onClick = onClick)
            .width(80.dp)
            .padding(vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier
                .height(32.dp)
                .width(56.dp)
                .background(pillColor, RoundedCornerShape(50)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = label, tint = iconColor, modifier = Modifier.size(22.dp))
        }
        Text(label, style = MaterialTheme.typography.labelMedium, color = labelColor)
    }
}

/** Thin convenience wrapper used by every screen for its title bar. */
@Composable
fun MobileTopBar(
    title: String,
    subtitle: String? = null,
    actions: @Composable () -> Unit = {},
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.statusBars)
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            EchoMark(size = 28.dp, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.onSurface)
                if (subtitle != null) {
                    Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            actions()
        }
    }
}

/** Used inside ScreenContent to supply default content padding. */
val MobileScreenPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp)
