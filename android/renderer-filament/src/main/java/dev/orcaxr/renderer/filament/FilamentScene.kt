package dev.orcaxr.renderer.filament

import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.Surface
import android.view.SurfaceView
import com.google.android.filament.*
import com.google.android.filament.android.DisplayHelper
import com.google.android.filament.android.FilamentHelper
import com.google.android.filament.android.UiHelper
import dev.orcaxr.renderer.*
import java.nio.ByteBuffer
import java.util.Collections
import java.util.IdentityHashMap
import java.util.concurrent.Executors
import kotlin.math.*

/** A project's volumes drawn where its instances place them, for the flat
 * Workspace. All Filament access belongs to the UI thread. Each drawn volume
 * is uploaded once, in [MeshPacking] chunks of its mesh asset, and shared by
 * every draw that places it (its object's instances); a draw has its own
 * transform and its own material instance tinted with its colour. Picking
 * indexes are built once per mesh asset. The single worker owns chunk packing
 * and picking indexes, one job at a time, and the next chunk is admitted only
 * once all native buffer copies of the previous one completed. A replaced or
 * removed volume cancels its work; nothing it prepared reaches the GPU.
 *
 * A volume's vertex colours are its own, so paint ([setPaint]) uploads only
 * the colour bytes of the facets whose colour changed — never positions or
 * indices. Leaves of subdivided facets are a small mesh of their own, drawn
 * over the volume with a polygon offset as the browser draws its paint
 * overlay. */
class FilamentScene(private val surface: SurfaceView) : AutoCloseable {
    data class Metrics(
        val state: String, val meshes: Int, val facets: Int, val uploadedFacets: Int,
        val draws: Int, val drawEntities: Int, val gpuBufferBytes: Long, val pendingUploadBytes: Long,
        val peakUploadBytes: Long, val totalUploadBytes: Long, val bufferUploads: Long,
        val frames: Long, val maxFrameCpuMs: Double, val closed: Boolean,
        val toolpathSegments: Int = 0,
        /** Volumes uploaded, those painted, and the colour bytes paint changes uploaded. */
        val volumes: Int = 0,
        val paintedVolumes: Int = 0,
        val paintUploadBytes: Long = 0,
    )
    /**
     * The draw [key] a pick met: [facet] of volume [volumeId]'s mesh as placed
     * by instance [instanceId], with the hit and the ray's origin (the eye) in
     * the volume's own millimetres, as a paint brush takes them.
     */
    data class Pick(
        val key: String, val instanceId: String, val facet: Int, val distanceMetres: Double, val volumeId: String = "",
        val localPoint: Point3? = null, val localOrigin: Point3? = null,
    )

    /** One mesh asset: its source and the picking index its volumes share. */
    private class Mesh(val assetId: String, val source: TriangleMesh) {
        var picking: MeshPicking? = null
        var failed = false
        /** Read by the worker: a replaced, removed or closed mesh stops its job. */
        @Volatile var cancelled = false
    }
    private class Chunk(val vertices: VertexBuffer, val indices: IndexBuffer, val count: Int, val firstFacet: Int,
        val facetCount: Int, val center: FloatArray, val extent: FloatArray, val bytes: Long)
    /** One drawn volume on the GPU: its mesh's chunks with colour bytes of its own, shared by its draws. */
    private class Geometry(val volumeId: String, val mesh: Mesh) {
        val chunks = mutableListOf<Chunk>()
        var uploadedFacets = 0
        /** Every facet's vertex colour once the volume is painted; null while it shows its mesh's own shades. */
        var colors: IntArray? = null
        var leaves: Leaves? = null
        var failed = false
        /** Read by the worker: a replaced, removed or closed volume stops its job. */
        @Volatile var cancelled = false
        val uploaded get() = uploadedFacets == mesh.source.facetCount
    }
    private class Leaves(val vertices: VertexBuffer, val indices: IndexBuffer, val count: Int,
        val center: FloatArray, val extent: FloatArray, val bytes: Long)
    private class Placed(var draw: ProjectScene.Draw, var material: MaterialInstance) {
        val entities = IdentityHashMap<Chunk, Int>()
        /** The leaves drawn over this draw, with their own offset material. */
        var leafMaterial: MaterialInstance? = null
        var leafEntity: Int? = null
    }
    private class Lines(val vertices: VertexBuffer, val indices: IndexBuffer, val entity: Int, val bytes: Long)
    /** A marker shape on the GPU, shared by the markers drawing it. */
    private class Shape(val vertices: VertexBuffer, val indices: IndexBuffer, val count: Int, val center: FloatArray, val extent: FloatArray)
    /** One marker drawn: its entity and its own material. */
    private class Marked(val entity: Int, val material: MaterialInstance)
    /** The viewport's vertical wash: a quad at the far end of the view, carried with the camera. */
    private class Backdrop(val vertices: VertexBuffer, val indices: IndexBuffer, val entity: Int, val material: MaterialInstance)

    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "OrcaXR scene geometry") }
    private val engine: Engine
    private val renderer: Renderer
    private val scene: Scene
    private val view: View
    private val camera: Camera
    private val opaque: Material
    private val transparent: Material
    private val bedMaterial: MaterialInstance
    private val toolpathMaterial: MaterialInstance
    private val helper = UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK)
    private val display = DisplayHelper(surface.context)
    private val scheduler = Choreographer.getInstance()
    private var swapChain: SwapChain? = null
    private val meshes = LinkedHashMap<String, Mesh>()
    /** Uploaded volumes, by volume. */
    private val geometries = LinkedHashMap<String, Geometry>()
    private val placed = LinkedHashMap<String, Placed>()
    private var bed: Lines? = null
    private var bedSize: Pair<Double, Double>? = null
    /** The bed's outline and grid colours (RGB, 0..1): the plate skin's major and minor lines once themed. */
    private var bedOutline = BED_TINT.copyOf()
    private var bedGrid = FloatArray(3) { BED_TINT[it] * BED_GRID_SHADE }
    /** The viewport's wash, top and bottom (RGB, 0..1). */
    private var washTop = CLEAR.copyOf()
    private var washBottom = CLEAR.copyOf()
    private var backdrop: Backdrop? = null
    /** Buffers Filament still copies for the backdrop: kept alive until each copy completes. */
    private val backdropBuffers = Collections.newSetFromMap(IdentityHashMap<ByteBuffer, Boolean>())
    private var toolpath: Lines? = null
    private var toolpathSegments = 0
    /** Marker shapes uploaded, by key, and the markers drawn now. */
    private val shapes = HashMap<String, Shape>()
    private val marked = ArrayList<Marked>()
    /** Buffers Filament still copies for marker shapes: kept alive until each copy completes. */
    private val shapeBuffers = Collections.newSetFromMap(IdentityHashMap<ByteBuffer, Boolean>())
    private var selected: Set<String> = emptySet()
    private var busy = false
    private var pending = 0L
    private var peakPending = 0L
    private var uploaded = 0L
    private var uploads = 0L
    private var paintUploaded = 0L
    private var state = "Empty"
    private var active = false
    private var scheduled = false
    private var dirtyFrames = 0
    private var frames = 0L
    private var maxFrameCpuMs = 0.0
    private var closed = false
    private var clipHeight = 10000f
    private var orbit = OrbitCamera()
    private val pendingBuffers = Collections.newSetFromMap(IdentityHashMap<ByteBuffer, Boolean>())

    init {
        requireUi()
        Filament.init()
        engine = Engine.create(Engine.Backend.OPENGL)
        try {
            renderer = engine.createRenderer()
            scene = engine.createScene()
            view = engine.createView()
            camera = engine.createCamera(engine.entityManager.create())
            opaque = material("opaque")
            transparent = material("transparent")
            bedMaterial = opaque.createInstance()
            bedMaterial.setParameter("clipHeight", clipHeight)
            bedMaterial.setParameter("opacity", 1f)
            // The bed's lines carry their own colours.
            bedMaterial.setParameter("tint", 1f, 1f, 1f, 1f)
            bedMaterial.setParameter("highlight", 0f, 0f, 0f, 0f)
            toolpathMaterial = opaque.createInstance()
            toolpathMaterial.setParameter("clipHeight", clipHeight)
            toolpathMaterial.setParameter("opacity", 1f)
            toolpathMaterial.setParameter("tint", 1f, 1f, 1f, 1f)
            toolpathMaterial.setParameter("highlight", 0f, 0f, 0f, 0f)
            view.scene = scene
            view.camera = camera
            view.isPostProcessingEnabled = false
            renderer.clearOptions = Renderer.ClearOptions().apply {
                clear = true
                clearColor = doubleArrayOf(CLEAR[0].toDouble(), CLEAR[1].toDouble(), CLEAR[2].toDouble(), 1.0)
            }
            backdrop = createBackdrop()
            helper.renderCallback = object : UiHelper.RendererCallback {
                override fun onNativeWindowChanged(window: Surface) {
                    swapChain?.let { engine.destroySwapChain(it) }
                    swapChain = engine.createSwapChain(window)
                    surface.display?.let { display.attach(renderer, it) }
                    invalidate()
                }
                override fun onDetachedFromSurface() {
                    display.detach()
                    swapChain?.let {
                        engine.destroySwapChain(it)
                        engine.flushAndWait() // Android must not release a still-used Surface.
                    }
                    swapChain = null
                    unschedule()
                }
                override fun onResized(width: Int, height: Int) {
                    if (width <= 0 || height <= 0) return
                    view.viewport = Viewport(0, 0, width, height)
                    camera.setProjection(FIELD_OF_VIEW, width.toDouble() / height, .001, 10.0, Camera.Fov.VERTICAL)
                    FilamentHelper.synchronizePendingFrames(engine)
                    updateCamera()
                }
            }
            updateCamera()
            helper.attachTo(surface)
        } catch (failure: Throwable) {
            helper.detach()
            worker.shutdownNow()
            engine.destroy()
            throw failure
        }
    }

    private fun requireUi() = check(Looper.myLooper() == Looper.getMainLooper())
    private fun checkOpen() { requireUi(); check(!closed) { "Scene is closed" } }
    private fun material(name: String): Material {
        val bytes = surface.context.assets.open("materials/$name.filamat").use { it.readBytes() }
        return Material.Builder().payload(ByteBuffer.wrap(bytes), bytes.size).build(engine)
    }

    fun metrics(): Metrics {
        requireUi()
        return Metrics(state, meshes.size, geometries.values.sumOf { it.mesh.source.facetCount },
            geometries.values.sumOf { it.uploadedFacets }, placed.size,
            placed.values.sumOf { it.entities.size + (if (it.leafEntity == null) 0 else 1) } + (if (bed == null) 0 else 1) + (if (toolpath == null) 0 else 1),
            geometries.values.sumOf { geometry -> geometry.chunks.sumOf { it.bytes } + (geometry.leaves?.bytes ?: 0) } + (bed?.bytes ?: 0) + (toolpath?.bytes ?: 0),
            pending, peakPending, uploaded, uploads, frames, maxFrameCpuMs, closed, toolpathSegments,
            geometries.size, geometries.values.count { it.colors != null }, paintUploaded)
    }

    fun setActive(value: Boolean) {
        checkOpen(); active = value
        if (value) invalidate() else unschedule()
    }

    /** Takes [mesh] for [assetId], replacing the mesh it had (and every volume uploaded from it): draws placing it show each chunk as it lands. */
    fun setMesh(assetId: String, mesh: TriangleMesh) {
        checkOpen(); require(assetId.isNotEmpty())
        meshes.remove(assetId)?.let(::discard)
        meshes[assetId] = Mesh(assetId, mesh)
        // Volumes already drawn from this asset upload from the new mesh.
        for (draw in placed.values.map { it.draw }) if (draw.assetId == assetId) geometryFor(draw)
        for (each in placed.values) if (each.draw.assetId == assetId) geometries[each.draw.volumeId]?.chunks?.forEach { attach(each, it) }
        pump()
        invalidate()
    }

    fun removeMesh(assetId: String) {
        checkOpen()
        meshes.remove(assetId)?.let(::discard)
        refreshState()
        invalidate()
    }

    /** Drops [mesh] and every volume uploaded from it; a job in flight is dropped when it answers. */
    private fun discard(mesh: Mesh) {
        mesh.cancelled = true
        mesh.picking = null
        for ((volumeId, geometry) in geometries.entries.toList()) if (geometry.mesh === mesh) dropGeometry(volumeId)
    }

    /** [draw]'s volume uploaded from its asset's mesh, made once; null while the mesh is unknown. */
    private fun geometryFor(draw: ProjectScene.Draw): Geometry? {
        val mesh = meshes[draw.assetId] ?: return null
        val existing = geometries[draw.volumeId]
        if (existing != null && existing.mesh === mesh) return existing
        if (existing != null) dropGeometry(draw.volumeId)
        return Geometry(draw.volumeId, mesh).also { geometries[draw.volumeId] = it }
    }

    /** Detaches every draw from volume [volumeId]'s chunks and leaves and frees them. */
    private fun dropGeometry(volumeId: String) {
        val geometry = geometries.remove(volumeId) ?: return
        geometry.cancelled = true
        for (each in placed.values) {
            for (chunk in geometry.chunks) each.entities.remove(chunk)?.let(::destroyEntity)
            if (each.draw.volumeId == volumeId) detachLeaves(each)
        }
        geometry.chunks.forEach { engine.destroyVertexBuffer(it.vertices); engine.destroyIndexBuffer(it.indices) }
        geometry.chunks.clear()
        geometry.leaves?.let(::destroyLeaves)
        geometry.leaves = null
    }

    /** The draws to show, keyed by [ProjectScene.Draw.key]: new ones placed, changed ones moved or retinted, the rest removed. */
    fun setDraws(draws: List<ProjectScene.Draw>) {
        checkOpen()
        val wanted = LinkedHashMap<String, ProjectScene.Draw>()
        for (draw in draws) require(wanted.put(draw.key, draw) == null) { "Repeated draw ${draw.key}" }
        for (key in placed.keys.toList()) if (key !in wanted) placed.remove(key)?.let(::destroyPlaced)
        // A volume no draw shows is not kept on the GPU; one whose asset changed uploads again.
        val shown = wanted.values.associateBy { it.volumeId }
        for ((volumeId, geometry) in geometries.entries.toList()) {
            val draw = shown[volumeId]
            if (draw == null || geometry.mesh !== meshes[draw.assetId]) dropGeometry(volumeId)
        }
        for ((key, draw) in wanted) {
            val geometry = geometryFor(draw)
            val current = placed[key]
            if (current == null) {
                val created = Placed(draw, materialFor(draw))
                placed[key] = created
                geometry?.chunks?.forEach { attach(created, it) }
                attachLeaves(created)
                continue
            }
            val before = current.draw
            current.draw = draw
            val reshaped = before.assetId != draw.assetId || before.volumeId != draw.volumeId
            if (reshaped) {
                current.entities.values.forEach(::destroyEntity)
                current.entities.clear()
                detachLeaves(current)
            }
            if (before.printable != draw.printable) {
                val replaced = current.material
                current.material = materialFor(draw)
                for (entity in current.entities.values) {
                    engine.renderableManager.setMaterialInstanceAt(engine.renderableManager.getInstance(entity), 0, current.material)
                }
                engine.destroyMaterialInstance(replaced)
                if (!reshaped) { detachLeaves(current); attachLeaves(current) }
            } else if (before.argb != draw.argb || before.instanceId != draw.instanceId) {
                tint(current.material, draw)
                current.leafMaterial?.let { tint(it, draw) }
            }
            val matrix = draw.transform.renderMatrix()
            if (!before.transform.renderMatrix().contentEquals(matrix)) {
                for (entity in current.entities.values) place(entity, matrix)
                current.leafEntity?.let { place(it, matrix) }
            }
            if (reshaped) {
                geometry?.chunks?.forEach { attach(current, it) }
                attachLeaves(current)
            }
        }
        pump()
        invalidate()
    }

    private fun materialFor(draw: ProjectScene.Draw): MaterialInstance {
        val instance = (if (draw.printable) opaque else transparent).createInstance()
        instance.setParameter("clipHeight", clipHeight)
        instance.setParameter("opacity", if (draw.printable) 1f else NOT_PRINTABLE_OPACITY)
        tint(instance, draw)
        return instance
    }

    /** The draw's colour as its tint; a selected instance's draws move toward the selection accent. */
    private fun tint(instance: MaterialInstance, draw: ProjectScene.Draw) {
        instance.setParameter("tint", ((draw.argb ushr 16) and 255) / 255f, ((draw.argb ushr 8) and 255) / 255f, (draw.argb and 255) / 255f, 1f)
        val mix = if (draw.instanceId in selected) SELECTED_MIX else 0f
        instance.setParameter("highlight", SELECTED_ACCENT[0], SELECTED_ACCENT[1], SELECTED_ACCENT[2], mix)
    }

    private fun place(entity: Int, matrix: FloatArray) {
        val transforms = engine.transformManager
        if (!transforms.hasComponent(entity)) transforms.create(entity)
        transforms.setTransform(transforms.getInstance(entity), matrix)
    }

    private fun attach(target: Placed, chunk: Chunk) {
        if (target.entities.containsKey(chunk)) return
        val entity = engine.entityManager.create()
        try {
            RenderableManager.Builder(1)
                .boundingBox(Box(chunk.center[0], chunk.center[1], chunk.center[2], chunk.extent[0], chunk.extent[1], chunk.extent[2]))
                .geometry(0, RenderableManager.PrimitiveType.TRIANGLES, chunk.vertices, chunk.indices, 0, chunk.count)
                .material(0, target.material)
                .culling(false).castShadows(false).receiveShadows(false)
                .build(engine, entity)
            place(entity, target.draw.transform.renderMatrix())
            scene.addEntity(entity)
            target.entities[chunk] = entity
        } catch (failure: Throwable) {
            destroyEntity(entity)
            throw failure
        }
    }

    private fun destroyEntity(entity: Int) {
        scene.removeEntity(entity); engine.destroyEntity(entity); engine.entityManager.destroy(entity)
    }

    private fun destroyPlaced(value: Placed) {
        value.entities.values.forEach(::destroyEntity)
        value.entities.clear()
        detachLeaves(value)
        engine.destroyMaterialInstance(value.material)
    }

    private fun refreshState() {
        if (busy) return
        state = when {
            geometries.isEmpty() -> "Empty"
            meshes.values.any { it.failed } || geometries.values.any { it.failed } -> "Geometry upload failed"
            geometries.values.all { it.uploaded && it.mesh.picking != null } -> "Ready"
            else -> state
        }
    }

    /** Admits one job at a time: a volume's next chunk, then a drawn mesh's picking index once
     * its volumes have landed. Nothing starts while an upload is still being copied. */
    private fun pump() {
        if (closed || busy || pending != 0L) return
        val geometry = geometries.values.firstOrNull { !it.failed && !it.mesh.failed && !it.uploaded }
        val mesh = if (geometry != null) null else geometries.values.map { it.mesh }.firstOrNull { !it.failed && it.picking == null }
        if (geometry == null && mesh == null) { refreshState(); return }
        val source = geometry?.mesh?.source ?: mesh!!.source
        val first = geometry?.uploadedFacets ?: 0
        busy = true
        state = if (geometry != null) "Uploading ${source.facetCount} facets" else "Indexing ${source.facetCount} facets"
        worker.execute {
            var chunk: MeshChunk? = null
            var index: MeshPicking? = null
            var failed = false
            try {
                val cancelled = { (geometry?.cancelled ?: false) || (mesh?.cancelled ?: false) || Thread.currentThread().isInterrupted }
                check(!cancelled())
                if (geometry != null) chunk = MeshPacking.chunk(source, first) else index = MeshPicking(source, cancelled)
                check(!cancelled())
            } catch (_: Exception) { failed = true }
            handler.post {
                busy = false
                if (closed) return@post
                if (geometry != null) landChunk(geometry, chunk, failed)
                if (mesh != null && !mesh.cancelled && meshes[mesh.assetId] === mesh) {
                    if (failed) mesh.failed = true else mesh.picking = index
                }
                pump()
                refreshState()
                invalidate()
            }
        }
    }

    /** A packed chunk of [geometry] reaching the UI thread: uploaded in the volume's paint colours, then drawn. */
    private fun landChunk(geometry: Geometry, packed: MeshChunk?, failed: Boolean) {
        if (geometry.cancelled || geometries[geometry.volumeId] !== geometry) return
        if (failed || packed == null) { geometry.failed = true; return }
        geometry.colors?.let { colors ->
            // Painted already: the chunk's colours are the volume's, not the mesh's shades.
            packed.colors.clear()
            for (facet in packed.firstFacet until packed.firstFacet + packed.facetCount) repeat(3) { MeshPacking.rgba(packed.colors, colors[facet]) }
            packed.colors.flip()
        }
        try {
            val gpu = createChunk(packed)
            geometry.chunks.add(gpu)
            geometry.uploadedFacets += packed.facetCount
            for (each in placed.values) if (each.draw.volumeId == geometry.volumeId) attach(each, gpu)
        } catch (_: RuntimeException) {
            geometry.failed = true
        }
    }

    private fun submit(buffer: ByteBuffer, upload: (Runnable) -> Unit) {
        // Identity collection: ByteBuffer equality changes with its contents/position.
        val retained = buffer.duplicate()
        pendingBuffers.add(retained)
        val count = retained.remaining().toLong()
        pending += count; peakPending = maxOf(peakPending, pending)
        uploaded += count; uploads++
        try {
            upload(Runnable {
                if (closed) return@Runnable
                pendingBuffers.remove(retained)
                pending -= count
                check(pending >= 0)
                pump()
            })
        } catch (failure: Throwable) {
            pendingBuffers.remove(retained)
            pending -= count; uploaded -= count; uploads--
            throw failure
        }
    }

    private fun createChunk(chunk: MeshChunk): Chunk {
        val count = chunk.indices.remaining() / 4
        val vertices = VertexBuffer.Builder().bufferCount(2).vertexCount(count)
            .attribute(VertexBuffer.VertexAttribute.POSITION, 0, VertexBuffer.AttributeType.FLOAT3, 0, 12)
            .attribute(VertexBuffer.VertexAttribute.COLOR, 1, VertexBuffer.AttributeType.UBYTE4, 0, 4)
            .normalized(VertexBuffer.VertexAttribute.COLOR)
            .build(engine)
        val indices = try {
            IndexBuffer.Builder().indexCount(count).bufferType(IndexBuffer.Builder.IndexType.UINT).build(engine)
        } catch (failure: Throwable) {
            engine.destroyVertexBuffer(vertices)
            throw failure
        }
        try {
            submit(chunk.positions) { callback -> vertices.setBufferAt(engine, 0, chunk.positions, 0, chunk.positions.remaining(), handler, callback) }
            submit(chunk.colors) { callback -> vertices.setBufferAt(engine, 1, chunk.colors, 0, chunk.colors.remaining(), handler, callback) }
            submit(chunk.indices) { callback -> indices.setBuffer(engine, chunk.indices, 0, chunk.indices.remaining(), handler, callback) }
            engine.flush()
        } catch (failure: Throwable) {
            engine.destroyVertexBuffer(vertices); engine.destroyIndexBuffer(indices)
            throw failure
        }
        return Chunk(vertices, indices, count, chunk.firstFacet, chunk.facetCount, chunk.center, chunk.halfExtent,
            chunk.positions.remaining().toLong() + chunk.colors.remaining() + chunk.indices.remaining())
    }

    // --- Paint ---------------------------------------------------------------------------

    /**
     * Applies one volume's paint change: the colour bytes of the facets whose
     * colour changed, one partial upload per chunk a range crosses (chunks
     * still to come are packed in the new colours), and its leaves when they
     * changed. Positions and indices are never uploaded again.
     */
    fun setPaint(update: PaintUpdate) {
        checkOpen()
        val geometry = geometries[update.volumeId] ?: return
        if (geometry.mesh.assetId != update.assetId) return
        require(update.facetCount == geometry.mesh.source.facetCount) { "Paint for another mesh" }
        val colors = geometry.colors ?: IntArray(geometry.mesh.source.facetCount, geometry.mesh.source::facetColor).also {
            if (update.ranges.isEmpty()) return@also
            geometry.colors = it
        }
        val chunks = geometry.chunks.associateBy { it.firstFacet }
        for (range in update.ranges) {
            val end = range.first + range.colors.size
            require(range.first >= 0 && end <= colors.size) { "Paint range outside the mesh" }
            range.colors.copyInto(colors, range.first)
            // Each chunk the range crosses: a partial upload of its colour bytes alone.
            var facet = range.first
            while (facet < end) {
                val first = facet / MeshPacking.FACETS_PER_CHUNK * MeshPacking.FACETS_PER_CHUNK
                val stop = min(end, first + MeshPacking.FACETS_PER_CHUNK)
                chunks[first]?.let { chunk ->
                    val from = facet
                    val bytes = MeshPacking.direct((stop - from) * 12)
                    for (painted in from until stop) repeat(3) { MeshPacking.rgba(bytes, colors[painted]) }
                    bytes.flip()
                    val size = bytes.remaining()
                    submit(bytes) { callback -> chunk.vertices.setBufferAt(engine, 1, bytes, (from - first) * 12, size, handler, callback) }
                    paintUploaded += size
                }
                facet = stop
            }
        }
        if (update.ranges.isNotEmpty()) engine.flush()
        if (update.leavesChanged) {
            for (each in placed.values) if (each.draw.volumeId == update.volumeId) detachLeaves(each)
            geometry.leaves?.let(::destroyLeaves)
            geometry.leaves = update.leaves?.let(::createLeaves)
            for (each in placed.values) if (each.draw.volumeId == update.volumeId) attachLeaves(each)
        }
        invalidate()
    }

    private fun createLeaves(leaves: PaintLeaves): Leaves {
        val count = leaves.count * 3
        val positions = MeshPacking.direct(count * 12)
        val colors = MeshPacking.direct(count * 4)
        val indices = MeshPacking.direct(count * 4)
        val low = FloatArray(3) { Float.POSITIVE_INFINITY }; val high = FloatArray(3) { Float.NEGATIVE_INFINITY }
        for (leaf in 0 until leaves.count) repeat(3) { corner ->
            val at = leaf * 9 + corner * 3
            val point = RenderSpace.point(Point3(leaves.corners[at].toDouble(), leaves.corners[at + 1].toDouble(), leaves.corners[at + 2].toDouble()))
            val coordinates = floatArrayOf(point.x.toFloat(), point.y.toFloat(), point.z.toFloat())
            for (axis in 0..2) {
                positions.putFloat(coordinates[axis])
                low[axis] = min(low[axis], coordinates[axis]); high[axis] = max(high[axis], coordinates[axis])
            }
            MeshPacking.rgba(colors, leaves.colors[leaf])
            indices.putInt(indices.position() / 4)
        }
        positions.flip(); colors.flip(); indices.flip()
        val vertices = VertexBuffer.Builder().bufferCount(2).vertexCount(count)
            .attribute(VertexBuffer.VertexAttribute.POSITION, 0, VertexBuffer.AttributeType.FLOAT3, 0, 12)
            .attribute(VertexBuffer.VertexAttribute.COLOR, 1, VertexBuffer.AttributeType.UBYTE4, 0, 4)
            .normalized(VertexBuffer.VertexAttribute.COLOR)
            .build(engine)
        val index = try {
            IndexBuffer.Builder().indexCount(count).bufferType(IndexBuffer.Builder.IndexType.UINT).build(engine)
        } catch (failure: Throwable) {
            engine.destroyVertexBuffer(vertices)
            throw failure
        }
        val size = positions.remaining().toLong() + colors.remaining() + indices.remaining()
        try {
            submit(positions) { callback -> vertices.setBufferAt(engine, 0, positions, 0, positions.remaining(), handler, callback) }
            submit(colors) { callback -> vertices.setBufferAt(engine, 1, colors, 0, colors.remaining(), handler, callback) }
            submit(indices) { callback -> index.setBuffer(engine, indices, 0, indices.remaining(), handler, callback) }
            engine.flush()
        } catch (failure: Throwable) {
            engine.destroyVertexBuffer(vertices); engine.destroyIndexBuffer(index)
            throw failure
        }
        paintUploaded += size
        return Leaves(vertices, index, count, FloatArray(3) { (low[it] + high[it]) * .5f }, FloatArray(3) { max((high[it] - low[it]) * .5f, 1e-5f) }, size)
    }

    private fun destroyLeaves(leaves: Leaves) {
        engine.destroyVertexBuffer(leaves.vertices); engine.destroyIndexBuffer(leaves.indices)
    }

    /** Draws its volume's leaves over [target], with an offset copy of its material. */
    private fun attachLeaves(target: Placed) {
        if (target.leafEntity != null) return
        val leaves = geometries[target.draw.volumeId]?.leaves ?: return
        val material = materialFor(target.draw)
        material.setPolygonOffset(LEAF_OFFSET, LEAF_OFFSET)
        val entity = engine.entityManager.create()
        try {
            RenderableManager.Builder(1)
                .boundingBox(Box(leaves.center[0], leaves.center[1], leaves.center[2], leaves.extent[0], leaves.extent[1], leaves.extent[2]))
                .geometry(0, RenderableManager.PrimitiveType.TRIANGLES, leaves.vertices, leaves.indices, 0, leaves.count)
                .material(0, material)
                .culling(false).castShadows(false).receiveShadows(false)
                .build(engine, entity)
            place(entity, target.draw.transform.renderMatrix())
            scene.addEntity(entity)
        } catch (failure: Throwable) {
            destroyEntity(entity)
            engine.destroyMaterialInstance(material)
            throw failure
        }
        target.leafEntity = entity
        target.leafMaterial = material
    }

    private fun detachLeaves(target: Placed) {
        target.leafEntity?.let(::destroyEntity)
        target.leafMaterial?.let { engine.destroyMaterialInstance(it) }
        target.leafEntity = null
        target.leafMaterial = null
    }

    /**
     * The view's background, as the browser's window shows its viewport: a
     * vertical wash from [topArgb] at the top edge to [bottomArgb] at the
     * bottom, whatever the camera does. Colours are drawn as given (sRGB, no
     * tone mapping), as the browser's CSS gradient is.
     */
    fun setBackdrop(topArgb: Int, bottomArgb: Int) {
        checkOpen()
        val top = rgb(topArgb); val bottom = rgb(bottomArgb)
        if (top.contentEquals(washTop) && bottom.contentEquals(washBottom)) return
        washTop = top; washBottom = bottom
        renderer.clearOptions = Renderer.ClearOptions().apply {
            clear = true
            clearColor = doubleArrayOf(bottom[0].toDouble(), bottom[1].toDouble(), bottom[2].toDouble(), 1.0)
        }
        backdrop?.let { uploadBackdrop(it.vertices, 1, washColours()) }
        invalidate()
    }

    /** The bed's colours: its outline in [outlineArgb], its grid in [gridArgb] (the plate skin's major and minor lines). */
    fun setBedColors(outlineArgb: Int, gridArgb: Int) {
        checkOpen()
        val outline = rgb(outlineArgb); val grid = rgb(gridArgb)
        if (outline.contentEquals(bedOutline) && grid.contentEquals(bedGrid)) return
        bedOutline = outline; bedGrid = grid
        bedSize?.let { (width, depth) -> setBed(width, depth) }
    }

    private fun rgb(argb: Int) = floatArrayOf(((argb ushr 16) and 255) / 255f, ((argb ushr 8) and 255) / 255f, (argb and 255) / 255f)

    /** The backdrop's vertex colours: top-left, top-right, bottom-left, bottom-right. */
    private fun washColours(): ByteBuffer {
        val colours = MeshPacking.direct(4 * 16)
        for (colour in arrayOf(washTop, washTop, washBottom, washBottom)) colours.putFloat(colour[0]).putFloat(colour[1]).putFloat(colour[2]).putFloat(1f)
        colours.flip()
        return colours
    }

    /** Copies [buffer] into [vertices]' buffer [index], keeping it alive until Filament has it. Not counted as mesh upload. */
    private fun uploadBackdrop(vertices: VertexBuffer, index: Int, buffer: ByteBuffer) {
        backdropBuffers.add(buffer)
        vertices.setBufferAt(engine, index, buffer, 0, buffer.remaining(), handler) { backdropBuffers.remove(buffer) }
    }

    /**
     * A quad filling the view at [BACKDROP_DEPTH] metres, in the camera's own
     * space (so it moves with it): exactly the vertical field of view high, far
     * wider than any window. Drawn after everything else, at the far end of the
     * depth range, it shows only where nothing else is drawn. Its colours are
     * its vertices' own (alpha 1 under a white tint), never highlighted.
     */
    private fun createBackdrop(): Backdrop {
        val half = (BACKDROP_DEPTH * tan(Math.toRadians(FIELD_OF_VIEW / 2))).toFloat()
        val wide = half * BACKDROP_ASPECT
        val positions = MeshPacking.direct(4 * 12)
        for ((x, y) in listOf(-wide to half, wide to half, -wide to -half, wide to -half)) {
            positions.putFloat(x).putFloat(y).putFloat(-BACKDROP_DEPTH.toFloat())
        }
        positions.flip()
        val indices = MeshPacking.direct(6 * 4)
        for (index in intArrayOf(0, 2, 1, 1, 2, 3)) indices.putInt(index)
        indices.flip()
        val material = opaque.createInstance()
        material.setParameter("clipHeight", Float.MAX_VALUE)
        material.setParameter("opacity", 1f)
        material.setParameter("tint", 1f, 1f, 1f, 1f)
        material.setParameter("highlight", 0f, 0f, 0f, 0f)
        val vertices = VertexBuffer.Builder().bufferCount(2).vertexCount(4)
            .attribute(VertexBuffer.VertexAttribute.POSITION, 0, VertexBuffer.AttributeType.FLOAT3, 0, 12)
            .attribute(VertexBuffer.VertexAttribute.COLOR, 1, VertexBuffer.AttributeType.FLOAT4, 0, 16)
            .build(engine)
        val index = IndexBuffer.Builder().indexCount(6).bufferType(IndexBuffer.Builder.IndexType.UINT).build(engine)
        val entity = engine.entityManager.create()
        RenderableManager.Builder(1)
            .boundingBox(Box(0f, 0f, -BACKDROP_DEPTH.toFloat(), wide, half, 1f))
            .geometry(0, RenderableManager.PrimitiveType.TRIANGLES, vertices, index, 0, 6)
            .material(0, material)
            .priority(7)
            .culling(false).castShadows(false).receiveShadows(false)
            .build(engine, entity)
        scene.addEntity(entity)
        uploadBackdrop(vertices, 0, positions)
        uploadBackdrop(vertices, 1, washColours())
        backdropBuffers.add(indices)
        index.setBuffer(engine, indices, 0, indices.remaining(), handler) { backdropBuffers.remove(indices) }
        return Backdrop(vertices, index, entity, material)
    }

    /**
     * Draws [markers] in place of the ones drawn before: each its shape
     * placed by its transform, unlit in its colour and opacity, with depth
     * test but without depth writes, after the models (three.js's
     * `MeshBasicMaterial` with `depthWrite: false` at a later render order).
     * Markers are never picked and never highlighted.
     */
    fun setMarkers(markers: List<SceneMarker>) {
        checkOpen()
        marked.forEach { destroyEntity(it.entity); engine.destroyMaterialInstance(it.material) }
        marked.clear()
        for (marker in markers) {
            val shape = shapes.getOrPut(marker.shape.key) { createShape(marker.shape) }
            val material = transparent.createInstance()
            material.setParameter("clipHeight", clipHeight)
            material.setParameter("opacity", marker.opacity)
            material.setParameter("tint", ((marker.argb ushr 16) and 255) / 255f, ((marker.argb ushr 8) and 255) / 255f, (marker.argb and 255) / 255f, 1f)
            material.setParameter("highlight", 0f, 0f, 0f, 0f)
            val entity = engine.entityManager.create()
            try {
                RenderableManager.Builder(1)
                    .boundingBox(Box(shape.center[0], shape.center[1], shape.center[2], shape.extent[0], shape.extent[1], shape.extent[2]))
                    .geometry(0, RenderableManager.PrimitiveType.TRIANGLES, shape.vertices, shape.indices, 0, shape.count)
                    .material(0, material)
                    .priority(MARKER_PRIORITY)
                    .culling(false).castShadows(false).receiveShadows(false)
                    .build(engine, entity)
                place(entity, marker.transform.renderMatrix())
                scene.addEntity(entity)
            } catch (failure: Throwable) {
                destroyEntity(entity)
                engine.destroyMaterialInstance(material)
                throw failure
            }
            marked += Marked(entity, material)
        }
        invalidate()
    }

    /** [shape]'s facets on the GPU, in render space, every corner white so the marker's tint is its colour. */
    private fun createShape(shape: MarkerShape): Shape {
        val count = shape.facetCount * 3
        val positions = MeshPacking.direct(count * 12)
        val colors = MeshPacking.direct(count * 4)
        val indices = MeshPacking.direct(count * 4)
        val low = FloatArray(3) { Float.POSITIVE_INFINITY }; val high = FloatArray(3) { Float.NEGATIVE_INFINITY }
        for (facet in 0 until shape.facetCount) repeat(3) { corner ->
            val point = RenderSpace.point(shape.corner(facet, corner))
            val coordinates = floatArrayOf(point.x.toFloat(), point.y.toFloat(), point.z.toFloat())
            for (axis in 0..2) {
                positions.putFloat(coordinates[axis])
                low[axis] = min(low[axis], coordinates[axis]); high[axis] = max(high[axis], coordinates[axis])
            }
            colors.put(255.toByte()).put(255.toByte()).put(255.toByte()).put(255.toByte())
            indices.putInt(indices.position() / 4)
        }
        positions.flip(); colors.flip(); indices.flip()
        val vertices = VertexBuffer.Builder().bufferCount(2).vertexCount(count)
            .attribute(VertexBuffer.VertexAttribute.POSITION, 0, VertexBuffer.AttributeType.FLOAT3, 0, 12)
            .attribute(VertexBuffer.VertexAttribute.COLOR, 1, VertexBuffer.AttributeType.UBYTE4, 0, 4)
            .normalized(VertexBuffer.VertexAttribute.COLOR)
            .build(engine)
        val index = try {
            IndexBuffer.Builder().indexCount(count).bufferType(IndexBuffer.Builder.IndexType.UINT).build(engine)
        } catch (failure: Throwable) {
            engine.destroyVertexBuffer(vertices)
            throw failure
        }
        for ((buffer, upload) in listOf<Pair<ByteBuffer, (ByteBuffer, Runnable) -> Unit>>(
            positions to { b, done -> vertices.setBufferAt(engine, 0, b, 0, b.remaining(), handler, done) },
            colors to { b, done -> vertices.setBufferAt(engine, 1, b, 0, b.remaining(), handler, done) },
            indices to { b, done -> index.setBuffer(engine, b, 0, b.remaining(), handler, done) },
        )) {
            shapeBuffers.add(buffer)
            upload(buffer, Runnable { shapeBuffers.remove(buffer) })
        }
        return Shape(vertices, index, count, FloatArray(3) { (low[it] + high[it]) * .5f }, FloatArray(3) { max((high[it] - low[it]) * .5f, 1e-5f) })
    }

    /** The print bed: its outline and a grid every 10 mm (coarser on a large bed), on z = 0 from the origin. */
    fun setBed(widthMm: Double, depthMm: Double) {
        checkOpen(); require(widthMm.isFinite() && depthMm.isFinite() && widthMm in 1.0..5000.0 && depthMm in 1.0..5000.0)
        bed?.let(::destroyLines); bed = null
        bedSize = widthMm to depthMm
        var spacing = 10.0
        while ((widthMm + depthMm) / spacing > MAX_BED_LINES) spacing *= 5
        val segments = ArrayList<Pair<Point3, Point3>>()
        val outline = ArrayList<Boolean>()
        fun line(a: Point3, b: Point3, edge: Boolean) { segments.add(a to b); outline.add(edge) }
        var x = spacing
        while (x < widthMm - 1e-6) { line(Point3(x, 0.0, 0.0), Point3(x, depthMm, 0.0), false); x += spacing }
        var y = spacing
        while (y < depthMm - 1e-6) { line(Point3(0.0, y, 0.0), Point3(widthMm, y, 0.0), false); y += spacing }
        val corners = listOf(Point3(0.0, 0.0, 0.0), Point3(widthMm, 0.0, 0.0), Point3(widthMm, depthMm, 0.0), Point3(0.0, depthMm, 0.0))
        for (n in 0..3) line(corners[n], corners[(n + 1) % 4], true)
        val positions = MeshPacking.direct(segments.size * 24)
        val colors = MeshPacking.direct(segments.size * 32)
        val indices = MeshPacking.direct(segments.size * 8)
        val low = FloatArray(3) { Float.POSITIVE_INFINITY }; val high = FloatArray(3) { Float.NEGATIVE_INFINITY }
        segments.forEachIndexed { n, (a, b) ->
            val colour = if (outline[n]) bedOutline else bedGrid
            for (point in arrayOf(RenderSpace.point(a), RenderSpace.point(b))) {
                val coordinates = floatArrayOf(point.x.toFloat(), point.y.toFloat(), point.z.toFloat())
                for (axis in 0..2) {
                    positions.putFloat(coordinates[axis])
                    low[axis] = min(low[axis], coordinates[axis]); high[axis] = max(high[axis], coordinates[axis])
                }
                colors.putFloat(colour[0]).putFloat(colour[1]).putFloat(colour[2]).putFloat(1f)
                indices.putInt(indices.position() / 4)
            }
        }
        positions.flip(); colors.flip(); indices.flip()
        bed = createLines(positions, colors, indices,
            FloatArray(3) { (low[it] + high[it]) * .5f }, FloatArray(3) { max((high[it] - low[it]) * .5f, 1e-5f) }, bedMaterial)
        invalidate()
    }

    /**
     * Shows a G-code toolpath (replacing the one shown before), drawn as lines
     * in the colours Rust chose for each record; none clears it. Its buffers are
     * copied to the GPU in the background; the geometry stays the caller's.
     */
    fun setToolpath(value: ToolpathGeometry?) {
        checkOpen()
        require(value == null || value.segments <= MAX_TOOLPATH_SEGMENTS) { "Toolpath exceeds the renderer segment budget" }
        toolpath?.let(::destroyLines); toolpath = null; toolpathSegments = 0
        if (value != null && value.segments > 0) {
            // Duplicates: the caller may show the same geometry again in a scene made afresh.
            toolpath = createLines(value.positions.duplicate(), value.colors.duplicate(), value.indices.duplicate(),
                value.center, value.halfExtent, toolpathMaterial)
            toolpathSegments = value.segments
        }
        invalidate()
    }

    /** LINES geometry: float3 render-space positions, float4 RGBA colours, uint indices; one entity. */
    private fun createLines(positions: ByteBuffer, colors: ByteBuffer, indices: ByteBuffer, center: FloatArray,
        halfExtent: FloatArray, material: MaterialInstance): Lines {
        val count = indices.remaining() / 4
        val vertices = VertexBuffer.Builder().bufferCount(2).vertexCount(count)
            .attribute(VertexBuffer.VertexAttribute.POSITION, 0, VertexBuffer.AttributeType.FLOAT3, 0, 12)
            .attribute(VertexBuffer.VertexAttribute.COLOR, 1, VertexBuffer.AttributeType.FLOAT4, 0, 16)
            .build(engine)
        val index = try {
            IndexBuffer.Builder().indexCount(count).bufferType(IndexBuffer.Builder.IndexType.UINT).build(engine)
        } catch (failure: Throwable) {
            engine.destroyVertexBuffer(vertices)
            throw failure
        }
        val entity = engine.entityManager.create()
        try {
            RenderableManager.Builder(1)
                .boundingBox(Box(center[0], center[1], center[2], halfExtent[0], halfExtent[1], halfExtent[2]))
                .geometry(0, RenderableManager.PrimitiveType.LINES, vertices, index, 0, count)
                .material(0, material)
                .culling(false).castShadows(false).receiveShadows(false)
                .build(engine, entity)
            scene.addEntity(entity)
            submit(positions) { callback -> vertices.setBufferAt(engine, 0, positions, 0, positions.remaining(), handler, callback) }
            submit(colors) { callback -> vertices.setBufferAt(engine, 1, colors, 0, colors.remaining(), handler, callback) }
            submit(indices) { callback -> index.setBuffer(engine, indices, 0, indices.remaining(), handler, callback) }
            engine.flush()
        } catch (failure: Throwable) {
            destroyEntity(entity)
            engine.destroyVertexBuffer(vertices); engine.destroyIndexBuffer(index)
            throw failure
        }
        return Lines(vertices, index, entity, positions.remaining().toLong() + colors.remaining() + indices.remaining())
    }

    private fun destroyLines(value: Lines) {
        destroyEntity(value.entity)
        engine.destroyVertexBuffer(value.vertices); engine.destroyIndexBuffer(value.indices)
    }

    /** Highlights every draw of the [instances] selected (the project's canonical selection); none when empty. */
    fun select(instances: Set<String>) {
        checkOpen()
        if (instances == selected) return
        selected = instances.toSet()
        for (each in placed.values) {
            tint(each.material, each.draw)
            each.leafMaterial?.let { tint(it, each.draw) }
        }
        invalidate()
    }

    fun clipAboveMm(height: Float?) {
        checkOpen(); require(height == null || height.isFinite() && height in -1_000_000f..1_000_000f)
        clipHeight = height?.times(.001f) ?: 10000f
        bedMaterial.setParameter("clipHeight", clipHeight)
        toolpathMaterial.setParameter("clipHeight", clipHeight)
        for (each in placed.values) {
            each.material.setParameter("clipHeight", clipHeight)
            each.leafMaterial?.setParameter("clipHeight", clipHeight)
        }
        marked.forEach { it.material.setParameter("clipHeight", clipHeight) }
        invalidate()
    }

    fun setCamera(value: OrbitCamera) { checkOpen(); orbit = value; updateCamera() }
    fun cameraState() = orbit

    /** Aims the camera at the middle of a [widthMm] by [depthMm] bed, far enough to show all of it. */
    fun frame(widthMm: Double, depthMm: Double) = frameArea(0.0, 0.0, widthMm, depthMm)

    /** Aims the camera at the middle of the area from ([minXMm], [minYMm]) to ([maxXMm], [maxYMm]) on z = 0, far enough to show all of it. */
    fun frameArea(minXMm: Double, minYMm: Double, maxXMm: Double, maxYMm: Double) {
        checkOpen()
        require(listOf(minXMm, minYMm, maxXMm, maxYMm).all { it.isFinite() } && maxXMm > minXMm && maxYMm > minYMm)
        val widthMm = maxXMm - minXMm
        val depthMm = maxYMm - minYMm
        val target = RenderSpace.point(Point3((minXMm + maxXMm) / 2, (minYMm + maxYMm) / 2, 0.0))
        val radius = .5 * sqrt(widthMm * widthMm + depthMm * depthMm) * .001
        val width = view.viewport.width.takeIf { it > 0 } ?: surface.width
        val height = view.viewport.height.takeIf { it > 0 } ?: surface.height
        val aspect = if (width > 0 && height > 0) width.toDouble() / height else 1.0
        val vertical = Math.toRadians(45.0) / 2
        val half = min(vertical, atan(tan(vertical) * aspect))
        val distance = (radius / sin(half) * 1.05).coerceIn(.03, 5.0)
        orbit = OrbitCamera(orbit.yaw, orbit.pitch, distance, target)
        updateCamera()
    }

    private fun updateCamera() {
        val eye = orbit.eye; val target = orbit.target
        camera.lookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, 0.0, 1.0, 0.0)
        // The backdrop rides with the camera, so the wash stays put on the screen.
        backdrop?.let { place(it.entity, FloatArray(16).also(camera::getModelMatrix)) }
        invalidate()
    }

    /**
     * The nearest uploaded facet under view position ([x], [y]), over every
     * draw (or only the draw keyed [only], as a stroke in flight samples its
     * own part), below the clip height.
     */
    fun pick(x: Double, y: Double, only: String? = null): Pick? {
        checkOpen()
        if (view.viewport.width <= 0 || view.viewport.height <= 0) return null
        val world = RenderSpace.rayToMillimetres(orbit.ray(x, y, view.viewport.width, view.viewport.height))
        var closest: Pick? = null
        for ((key, each) in placed) {
            if (only != null && key != only) continue
            val geometry = geometries[each.draw.volumeId] ?: continue
            val index = geometry.mesh.picking ?: continue
            val transform = each.draw.transform
            val local = runCatching { transform.localRay(world) }.getOrNull() ?: continue
            // An affine map keeps the ray parameter, so distances compare across draws.
            val hit = index.pick(local, closest?.distanceMetres ?: Double.POSITIVE_INFINITY) { facet, point ->
                facet < geometry.uploadedFacets && transform.point(point).z * .001 <= clipHeight
            }
            if (hit != null) closest = Pick(key, each.draw.instanceId, hit.facet, hit.distance, each.draw.volumeId, hit.positionMm, local.origin)
        }
        return closest
    }

    private val frame = Choreographer.FrameCallback { time ->
        scheduled = false
        if (!closed && active && helper.isReadyToRender && swapChain != null) {
            val start = System.nanoTime()
            if (renderer.beginFrame(swapChain!!, time)) {
                renderer.render(view); renderer.endFrame()
                frames++; dirtyFrames--
                maxFrameCpuMs = maxOf(maxFrameCpuMs, (System.nanoTime() - start) / 1_000_000.0)
            }
            schedule()
        }
    }
    private fun invalidate() { dirtyFrames = 3; schedule() }
    private fun schedule() {
        if (!closed && active && !scheduled && dirtyFrames > 0 && swapChain != null && helper.isReadyToRender) {
            scheduled = true; scheduler.postFrameCallback(frame)
        }
    }
    private fun unschedule() { scheduler.removeFrameCallback(frame); scheduled = false }

    override fun close() {
        requireUi(); if (closed) return
        closed = true; active = false
        unschedule(); worker.shutdownNow(); helper.detach()
        placed.values.forEach(::destroyPlaced); placed.clear()
        meshes.values.forEach(::discard); meshes.clear()
        for (volumeId in geometries.keys.toList()) dropGeometry(volumeId)
        bed?.let(::destroyLines); bed = null
        toolpath?.let(::destroyLines); toolpath = null; toolpathSegments = 0
        marked.forEach { destroyEntity(it.entity); engine.destroyMaterialInstance(it.material) }; marked.clear()
        shapes.values.forEach { engine.destroyVertexBuffer(it.vertices); engine.destroyIndexBuffer(it.indices) }; shapes.clear()
        backdrop?.let {
            destroyEntity(it.entity)
            engine.destroyVertexBuffer(it.vertices); engine.destroyIndexBuffer(it.indices)
            engine.destroyMaterialInstance(it.material)
        }
        backdrop = null
        engine.destroyMaterialInstance(bedMaterial)
        engine.destroyMaterialInstance(toolpathMaterial)
        engine.destroyMaterial(opaque); engine.destroyMaterial(transparent)
        engine.destroyView(view); engine.destroyScene(scene); engine.destroyRenderer(renderer)
        val cameraEntity = camera.entity
        engine.destroyCameraComponent(cameraEntity); engine.entityManager.destroy(cameraEntity)
        engine.flushAndWait(); engine.destroy()
        pendingBuffers.clear(); backdropBuffers.clear(); pending = 0; state = "Closed"
    }

    private companion object {
        /** The background until a theme gives one: the experiment's near-black. */
        val CLEAR = floatArrayOf(.035f, .045f, .06f)
        /** The camera's vertical field of view in degrees, the browser's flat 45° (`FLAT_FOV`). */
        const val FIELD_OF_VIEW = 45.0
        /** How far the backdrop sits (the view reaches 10 m) and how much wider than high it is. */
        const val BACKDROP_DEPTH = 9.5
        const val BACKDROP_ASPECT = 16f
        /** A non-printable instance is drawn see-through, so it reads as left out of the print. */
        const val NOT_PRINTABLE_OPACITY = .4f
        /** A selected instance's colour is moved this far toward [SELECTED_ACCENT]. */
        const val SELECTED_MIX = .45f
        val SELECTED_ACCENT = floatArrayOf(1f, .62f, .18f)
        val BED_TINT = floatArrayOf(.42f, .47f, .55f)
        const val BED_GRID_SHADE = .55f
        const val MAX_BED_LINES = 1000.0
        /** The viewport experiment's toolpath bound and `ToolpathGeometry`'s default budget. */
        const val MAX_TOOLPATH_SEGMENTS = 240_000
        /** Leaves are pulled toward the eye, as the browser offsets its paint overlay (`polygonOffsetFactor/Units -2`). */
        const val LEAF_OFFSET = -2f
        /** Markers draw after the models (three's render order 2 for the brim-ear discs), before the backdrop. */
        const val MARKER_PRIORITY = 5
    }
}
