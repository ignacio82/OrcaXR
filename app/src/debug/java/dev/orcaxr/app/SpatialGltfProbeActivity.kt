package dev.orcaxr.app

import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.xr.compose.spatial.Subspace
import androidx.xr.compose.subspace.SpatialGltfModel
import androidx.xr.compose.subspace.SpatialGltfModelSource
import androidx.xr.compose.subspace.SpatialGltfModelState
import androidx.xr.compose.subspace.SpatialGltfModelStatus
import androidx.xr.compose.subspace.layout.SubspaceModifier
import androidx.xr.compose.subspace.layout.offset
import androidx.xr.compose.subspace.layout.rotate
import androidx.xr.compose.subspace.layout.size
import androidx.xr.runtime.Session
import androidx.xr.runtime.SessionCreateSuccess
import androidx.xr.runtime.math.Vector4
import androidx.xr.scenecore.AlphaMode
import androidx.xr.scenecore.KhronosUnlitMaterial
import androidx.xr.scenecore.scene
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.android.awaitFrame

data class SpatialGltfProbeResult(
    val outcome: SpatialGltfProbeOutcome,
    val cyclesCompleted: Int,
    val loadsCompleted: Int,
    val materialOverrides: Int,
    val maxNodeCount: Int,
    val message: String,
)

enum class SpatialGltfProbeOutcome {
    Passed,
    Failed,
    Skipped,
}

object SpatialGltfProbeRegistry {
    @Volatile
    var latest: SpatialGltfProbeResult? = null
        private set

    @Volatile
    private var latch = CountDownLatch(1)

    @Synchronized
    fun reset() {
        latest = null
        latch = CountDownLatch(1)
    }

    @Synchronized
    fun publish(result: SpatialGltfProbeResult) {
        latest = result
        latch.countDown()
    }

    fun await(timeoutMs: Long): SpatialGltfProbeResult? {
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        return latest
    }
}

/**
 * Debug-only E12 probe. It exercises Compose XR's SpatialGltfModel lifecycle
 * with generated GLB bytes: mount, load, move, swap, GltfModelNode material
 * override, and teardown across 50 cycles.
 */
class SpatialGltfProbeActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        window.setBackgroundDrawable(ColorDrawable(android.graphics.Color.TRANSPARENT))

        val session = try {
            (Session.create(this) as? SessionCreateSuccess)?.session
        } catch (t: Throwable) {
            null
        }
        if (session == null) {
            SpatialGltfProbeRegistry.publish(
                SpatialGltfProbeResult(
                    outcome = SpatialGltfProbeOutcome.Skipped,
                    cyclesCompleted = 0,
                    loadsCompleted = 0,
                    materialOverrides = 0,
                    maxNodeCount = 0,
                    message = "XR Session unavailable on this device",
                ),
            )
            setContent { ProbeFlatStatus("Spatial GLB probe skipped: no XR session") }
            return
        }

        val modelBytes = runCatching { createProbeModels() }.getOrElse { t ->
            SpatialGltfProbeRegistry.publish(
                SpatialGltfProbeResult(
                    outcome = SpatialGltfProbeOutcome.Failed,
                    cyclesCompleted = 0,
                    loadsCompleted = 0,
                    materialOverrides = 0,
                    maxNodeCount = 0,
                    message = "probe GLB generation failed: ${t.message}",
                ),
            )
            setContent { ProbeFlatStatus("Spatial GLB probe failed: ${t.message}") }
            return
        }

        setContent {
            dev.orcaxr.app.ui.OrcaXrTheme {
                LaunchedEffect(session) {
                    runCatching { session.scene.requestFullSpaceMode() }
                }
                ProbeFlatStatus("Spatial GLB probe running")
                Subspace {
                    SpatialGltfLifecycleProbe(
                        session = session,
                        models = modelBytes,
                        cycles = 50,
                        onResult = SpatialGltfProbeRegistry::publish,
                    )
                }
            }
        }
    }

    private fun createProbeModels(): List<ByteArray> {
        val a = File(cacheDir, "e12_spatial_gltf_probe_a.glb")
        val b = File(cacheDir, "e12_spatial_gltf_probe_b.glb")
        GizmoGlb.writeCube(
            a,
            size = 24f,
            offset = floatArrayOf(0f, 0f, 0f),
            color = floatArrayOf(0.05f, 0.85f, 0.65f),
        )
        GizmoGlb.writeRing(
            b,
            axis = 2,
            radius = 18f,
            thickness = 3f,
            color = floatArrayOf(1.0f, 0.55f, 0.05f),
        )
        return listOf(a.readBytes(), b.readBytes())
    }
}

@Composable
private fun ProbeFlatStatus(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text = text, color = Color.White, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun SpatialGltfLifecycleProbe(
    session: Session,
    models: List<ByteArray>,
    cycles: Int,
    onResult: (SpatialGltfProbeResult) -> Unit,
) {
    var cycle by remember { mutableIntStateOf(0) }
    var variant by remember { mutableIntStateOf(0) }
    var mounted by remember { mutableStateOf(true) }
    var loads by remember { mutableIntStateOf(0) }
    var materialOverrides by remember { mutableIntStateOf(0) }
    var maxNodeCount by remember { mutableIntStateOf(0) }
    var completed by remember { mutableStateOf(false) }

    if (completed) return

    LaunchedEffect(cycle >= cycles) {
        if (cycle >= cycles) {
            completed = true
            onResult(
                SpatialGltfProbeResult(
                    outcome = SpatialGltfProbeOutcome.Passed,
                    cyclesCompleted = cycle,
                    loadsCompleted = loads,
                    materialOverrides = materialOverrides,
                    maxNodeCount = maxNodeCount,
                    message = "SpatialGltfModel loaded/swapped/tore down $cycle cycles",
                ),
            )
        }
    }

    LaunchedEffect(mounted, cycle) {
        if (!mounted && cycle < cycles) {
            awaitFrame()
            awaitFrame()
            variant = 0
            cycle += 1
            mounted = true
        }
    }

    if (cycle >= cycles) return
    if (!mounted) return

    val source = remember(cycle, variant) {
        ByteArraySpatialGltfModelSource(
            bytes = models[variant],
            modelName = "e12_probe_${cycle}_${variant}.glb",
        )
    }
    SpatialGltfProbeModel(
        session = session,
        source = source,
        cycle = cycle,
        variant = variant,
        onLoaded = { nodeCount, overrideOk ->
            loads += 1
            maxNodeCount = maxOf(maxNodeCount, nodeCount)
            if (overrideOk) materialOverrides += 1
            if (nodeCount <= 0) {
                completed = true
                onResult(
                    SpatialGltfProbeResult(
                        outcome = SpatialGltfProbeOutcome.Failed,
                        cyclesCompleted = cycle,
                        loadsCompleted = loads,
                        materialOverrides = materialOverrides,
                        maxNodeCount = maxNodeCount,
                        message = "SpatialGltfModel loaded without GltfModelNode entries",
                    ),
                )
            } else if (!overrideOk) {
                completed = true
                onResult(
                    SpatialGltfProbeResult(
                        outcome = SpatialGltfProbeOutcome.Failed,
                        cyclesCompleted = cycle,
                        loadsCompleted = loads,
                        materialOverrides = materialOverrides,
                        maxNodeCount = maxNodeCount,
                        message = "GltfModelNode material override failed",
                    ),
                )
            } else if (variant == 0) {
                variant = 1
            } else {
                mounted = false
            }
        },
        onFailed = { message ->
            completed = true
            onResult(
                SpatialGltfProbeResult(
                    outcome = SpatialGltfProbeOutcome.Failed,
                    cyclesCompleted = cycle,
                    loadsCompleted = loads,
                    materialOverrides = materialOverrides,
                    maxNodeCount = maxNodeCount,
                    message = message,
                ),
            )
        },
    )
}

@Composable
private fun SpatialGltfProbeModel(
    session: Session,
    source: SpatialGltfModelSource,
    cycle: Int,
    variant: Int,
    onLoaded: (nodeCount: Int, materialOverrideOk: Boolean) -> Unit,
    onFailed: (String) -> Unit,
) {
    val state = rememberSpatialGltfModelStateCompat(source)
    val materialRef = remember(source) { mutableStateOf<KhronosUnlitMaterial?>(null) }
    var reported by remember(source) { mutableStateOf(false) }

    LaunchedEffect(state.status) {
        when (val status = state.status) {
            is SpatialGltfModelStatus.Loaded -> {
                if (reported) return@LaunchedEffect
                reported = true
                val material = KhronosUnlitMaterial.create(session, AlphaMode.OPAQUE)
                val tint = if (variant == 0) {
                    Vector4(0.05f, 0.90f, 0.70f, 1f)
                } else {
                    Vector4(1.0f, 0.45f, 0.08f, 1f)
                }
                material.setBaseColorFactor(tint)
                materialRef.value = material
                val node = state.nodes.firstOrNull()
                val overrideOk = node != null && runCatching {
                    node.setMaterialOverride(material, 0)
                    awaitFrame()
                    node.clearMaterialOverride(0)
                    awaitFrame()
                    node.setMaterialOverride(material, 0)
                }.isSuccess
                awaitFrame()
                onLoaded(state.nodes.size, overrideOk)
            }
            is SpatialGltfModelStatus.Failed -> {
                if (!reported) {
                    reported = true
                    onFailed(status.exception.message ?: "SpatialGltfModel load failed")
                }
            }
            is SpatialGltfModelStatus.Loading -> Unit
        }
    }

    DisposableEffect(source) {
        onDispose {
            materialRef.value?.close()
            materialRef.value = null
        }
    }

    SpatialGltfModel(
        state = state,
        modifier = SubspaceModifier
            .size(140.dp)
            .offset(
                x = ((cycle % 5) * 35 - 70).dp,
                y = ((variant * 35) - 20).dp,
                z = 0.dp,
            )
            .rotate(yaw = cycle * 7f, pitch = variant * 12f, roll = 0f),
    )
}

@Composable
private fun rememberSpatialGltfModelStateCompat(
    source: SpatialGltfModelSource,
): SpatialGltfModelState =
    androidx.xr.compose.subspace.rememberSpatialGltfModelState(source)
