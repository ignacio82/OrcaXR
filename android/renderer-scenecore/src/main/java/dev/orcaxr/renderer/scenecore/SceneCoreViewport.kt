package dev.orcaxr.renderer.scenecore

import android.os.Looper
import androidx.annotation.MainThread
import androidx.xr.runtime.Session
import androidx.xr.runtime.math.BoundingBox
import androidx.xr.runtime.math.Pose
import androidx.xr.runtime.math.Quaternion
import androidx.xr.runtime.math.Vector3
import androidx.xr.runtime.math.Vector4
import androidx.xr.scenecore.*
import dev.orcaxr.renderer.MeshChunk
import dev.orcaxr.renderer.MeshPacking
import dev.orcaxr.renderer.TriangleMesh
import kotlinx.coroutines.*
import kotlin.math.max
import kotlin.math.min

/** Measured SceneCore candidate, not the production editing or toolpath renderer.
 * Uses only rc01 public APIs. Each immutable buffer is shared by two entities.
 * No GLB conversion and no canonical geometry mutation occurs here. */
@MainThread
class SceneCoreViewport private constructor(
    private val session: Session,
    private val opaque: KhronosUnlitMaterial,
    private val transparent: KhronosUnlitMaterial,
    private val publish: (Metrics) -> Unit,
) : AutoCloseable {
    data class Metrics(
        val state: String = "Idle", val facets: Int = 0, val entities: Int = 0,
        val sourceBytes: Long = 0, val bufferPayloadBytes: Long = 0,
        val largestChunkBytes: Long = 0, val uploadCalls: Int = 0,
        val uploadedBytes: Long = 0, val paintReplacementBytes: Long = 0,
        val maxSubmissionMs: Double = 0.0,
    )
    private class OwnedChunk(val first: Int, val facets: Int, val bytes: Long,
        val buffer: MeshBuffer, val mesh: CustomMesh, val entities: List<MeshEntity>) : AutoCloseable {
        override fun close() {
            // In SceneCore rc01, imp::Mesh OwnedPtr aborts in owned_ptr.h if CustomMesh.close()
            // is called while MeshEntity borrowers still exist. Entity.dispose is library-restricted
            // in rc01, so detach and disable entities to remove them from the scene graph.
            entities.forEach {
                it.setEnabled(false)
                it.parent = null
            }
        }
    }
    private val root = Entity.create(session, "OrcaXR fixture", parent = session.scene.activitySpace,
        pose = Pose(Vector3(0f, -.15f, -.7f), Quaternion.fromAxisAngle(Vector3(1f, 0f, 0f), 35f)))
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var work: Job? = null
    private val chunks = linkedMapOf<Int, OwnedChunk>()
    private val tombstonedChunks = mutableListOf<OwnedChunk>()
    private var source: TriangleMesh? = null
    private var closed = false
    private var translucent = false
    private var instances = false
    private var angle = 35f
    var metrics = Metrics(); private set

    private fun assertOwner() { check(Looper.myLooper() == Looper.getMainLooper()); check(!closed) }
    private fun report(next: Metrics) { metrics = next; publish(next) }
    private fun releaseChunks() {
        chunks.values.forEach {
            it.close()
            tombstonedChunks.add(it)
        }
        chunks.clear()
        source = null
    }
    fun loadGrid(cells: Int) {
        assertOwner(); require(cells in 1..1000)
        work?.cancel(); releaseChunks()
        report(Metrics(state = "Building fixture"))
        work = scope.launch {
            try {
                val owner = currentCoroutineContext()
                val mesh = withContext(Dispatchers.Default) { TriangleMesh.grid(cells) { !owner.isActive } }
                ensureActive(); source = mesh
                report(metrics.copy(sourceBytes = mesh.cpuBytes, state = "Uploading"))
                for (first in 0 until mesh.facetCount step MeshPacking.FACETS_PER_CHUNK) {
                    val packed = withContext(Dispatchers.Default) { MeshPacking.chunk(mesh, first) }
                    ensureActive()
                    val chunk = upload(packed, paint = false)
                    chunks[first] = chunk
                    report(metrics.copy(facets = metrics.facets + chunk.facets,
                        entities = chunks.size * if (instances) 2 else 1,
                        bufferPayloadBytes = metrics.bufferPayloadBytes + chunk.bytes))
                    // Yield between synchronous copies; giving CPM time to settle subspaces.
                    delay(16)
                }
                report(metrics.copy(state = "Ready"))
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                android.util.Log.e("SceneCoreViewport", "loadGrid failed for $cells cells", failure)
                if (isActive) { releaseChunks(); report(metrics.copy(state = "Unavailable", facets = 0,
                entities = 0, sourceBytes = 0, bufferPayloadBytes = 0)) } }
        }
    }
    private fun upload(packed: MeshChunk, paint: Boolean): OwnedChunk {
        val started = System.nanoTime()
        var buffer: MeshBuffer? = null
        var mesh: CustomMesh? = null
        val entities = mutableListOf<MeshEntity>()
        try {
            buffer = MeshBuffer.create(session, layout(), listOf(
                region(packed.positions), region(packed.colors)), region(packed.indices))
            fun corner(sign: Float) = Vector3(packed.center[0] + sign * packed.halfExtent[0],
                packed.center[1] + sign * packed.halfExtent[1], packed.center[2] + sign * packed.halfExtent[2])
            mesh = CustomMesh.BuilderFromMeshBuffer(session, buffer)
                .addSubset(MeshSubsetTopology.TRIANGLES, 0, packed.facetCount * 3)
                .setBounds(BoundingBox.fromMinMax(corner(-1f), corner(1f))).build()
            val material = if (translucent) transparent else opaque
            entities += MeshEntity.create(session, mesh, listOf(material))
            entities += MeshEntity.create(session, mesh, listOf(material), pose = Pose(Vector3(.22f, 0f, 0f)))
            entities[1].setScale(.65f) // Public scale is uniform and nonnegative.
            entities[1].setEnabled(instances)
            // Attach after both creations succeed. Native mesh data was copied by create().
            entities.forEach { it.parent = root }
            report(metrics.copy(uploadCalls = metrics.uploadCalls + 1,
                uploadedBytes = metrics.uploadedBytes + packed.bytes,
                paintReplacementBytes = metrics.paintReplacementBytes + if (paint) packed.bytes else 0,
                largestChunkBytes = max(metrics.largestChunkBytes, packed.bytes),
                maxSubmissionMs = max(metrics.maxSubmissionMs, (System.nanoTime() - started) / 1e6)))
            return OwnedChunk(packed.firstFacet, packed.facetCount, packed.bytes, buffer, mesh, entities)
        } catch (failure: Exception) {
            try { entities.forEach { it.setEnabled(false); it.parent = null } }
            finally {
                if (entities.isEmpty()) {
                    try { mesh?.close() } finally { buffer?.close() }
                }
            }
            throw failure
        }
    }
    /** Fixed synthetic stroke spanning two chunks. Repeated calls replace the same
     * display projection. Does not pretend to be a canonical painting command. */
    fun paintSample() {
        assertOwner(); if (work?.isActive == true || metrics.state != "Ready") return
        val mesh = source ?: return
        val start = min(14_336, mesh.facetCount - 1)
        val end = min(start + 4096, mesh.facetCount)
        report(metrics.copy(state = "Replacing paint chunks"))
        work = scope.launch {
            try {
                for (first in chunks.keys.toList().filter { it < end && it + MeshPacking.FACETS_PER_CHUNK > start }) {
                    val packed = withContext(Dispatchers.Default) { samplePaintChunk(mesh, first) }
                    val replacement = upload(packed, paint = true)
                    chunks.put(first, replacement)?.let { old ->
                        old.close()
                        tombstonedChunks.add(old)
                    }
                    delay(16)
                }
                report(metrics.copy(state = "Ready"))
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                android.util.Log.e("SceneCoreViewport", "paintSample failed", failure)
                if (isActive) report(metrics.copy(state = "Paint unavailable"))
            }
        }
    }
    fun setInstances(value: Boolean) {
        assertOwner(); instances = value
        chunks.values.forEach { it.entities[1].setEnabled(value) }
        report(metrics.copy(entities = chunks.size * if (value) 2 else 1))
    }
    fun setTransparent(value: Boolean) {
        assertOwner(); translucent = value
        chunks.values.forEach { chunk -> chunk.entities.forEach { it.setMaterial(if (value) transparent else opaque) } }
    }
    fun setSelected(value: Boolean) {
        assertOwner()
        val green = if (value) .5f else 1f
        opaque.setBaseColorFactor(Vector4(1f, green, 1f, 1f))
        transparent.setBaseColorFactor(Vector4(1f, green, 1f, .35f))
    }
    fun rotate() {
        assertOwner(); angle = (angle + 15f) % 360f
        root.setPose(Pose(Vector3(0f, -.15f, -.7f), Quaternion.fromAxisAngle(Vector3(1f, 0f, 0f), angle)))
    }
    override fun close() {
        if (closed) return
        assertOwner(); closed = true; scope.cancel()
        try { root.parent = null; releaseChunks() }
        finally { try { transparent.close() } finally { opaque.close() } }
        report(metrics.copy(state = "Closed", facets = 0, entities = 0, sourceBytes = 0, bufferPayloadBytes = 0))
    }
    companion object {
        internal fun samplePaintChunk(mesh: TriangleMesh, first: Int): MeshChunk {
            val start = min(14_336, mesh.facetCount - 1)
            val end = min(start + 4096, mesh.facetCount)
            return MeshPacking.chunk(mesh, first).also { chunk ->
                val colors = chunk.colors.duplicate()
                for (facet in max(start, first) until min(end, first + chunk.facetCount)) {
                    colors.position((facet - first) * 12)
                    repeat(3) { MeshPacking.rgba(colors, 0xffe74f98.toInt()) }
                }
            }
        }
        fun layout(): VertexLayout = VertexLayout.Builder()
            .addAttribute(VertexAttribute.POSITION, VertexAttributeType.FLOAT3)
            .startNextBuffer().addAttribute(VertexAttribute.COLOR, VertexAttributeType.UBYTE4_NORM).build()
        private fun region(buffer: java.nio.ByteBuffer) = ByteBufferRegion(buffer, buffer.position(), buffer.remaining())
        suspend fun create(session: Session, publish: (Metrics) -> Unit): SceneCoreViewport {
            val opaque = KhronosUnlitMaterial.create(session, AlphaMode.OPAQUE)
            var transparent: KhronosUnlitMaterial? = null
            try {
                transparent = KhronosUnlitMaterial.create(session, AlphaMode.BLEND)
                transparent.setBaseColorFactor(Vector4(1f, 1f, 1f, .35f))
                return SceneCoreViewport(session, opaque, transparent, publish)
            } catch (failure: Exception) { try { transparent?.close() } finally { opaque.close() }; throw failure }
        }
    }
}
