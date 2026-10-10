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

/** A project's meshes drawn where its instances place them, for the flat
 * Workspace. All Filament access belongs to the UI thread. Each mesh asset is
 * uploaded once, in [MeshPacking] chunks, and shared by every draw that places
 * it; a draw has its own transform and its own material instance tinted with
 * its colour. The single worker owns chunk packing and picking indexes, one job
 * at a time, and the next chunk is admitted only once all three native buffer
 * copies of the previous one completed. A replaced or removed mesh cancels its
 * work; nothing it prepared reaches the GPU. */
class FilamentScene(private val surface: SurfaceView) : AutoCloseable {
    data class Metrics(
        val state: String, val meshes: Int, val facets: Int, val uploadedFacets: Int,
        val draws: Int, val drawEntities: Int, val gpuBufferBytes: Long, val pendingUploadBytes: Long,
        val peakUploadBytes: Long, val totalUploadBytes: Long, val bufferUploads: Long,
        val frames: Long, val maxFrameCpuMs: Double, val closed: Boolean,
        val toolpathSegments: Int = 0,
    )
    data class Pick(val key: String, val instanceId: String, val facet: Int, val distanceMetres: Double)

    private class Chunk(val vertices: VertexBuffer, val indices: IndexBuffer, val count: Int,
        val facetCount: Int, val center: FloatArray, val extent: FloatArray, val bytes: Long)
    private class Mesh(val assetId: String, val source: TriangleMesh) {
        val chunks = mutableListOf<Chunk>()
        var uploadedFacets = 0
        var picking: MeshPicking? = null
        var failed = false
        /** Read by the worker: a replaced, removed or closed mesh stops its job. */
        @Volatile var cancelled = false
        val complete get() = uploadedFacets == source.facetCount && picking != null
    }
    private class Placed(var draw: ProjectScene.Draw, var material: MaterialInstance) {
        val entities = IdentityHashMap<Chunk, Int>()
    }
    private class Lines(val vertices: VertexBuffer, val indices: IndexBuffer, val entity: Int, val bytes: Long)

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
    private val placed = LinkedHashMap<String, Placed>()
    private var bed: Lines? = null
    private var toolpath: Lines? = null
    private var toolpathSegments = 0
    private var selected: Set<String> = emptySet()
    private var busy = false
    private var pending = 0L
    private var peakPending = 0L
    private var uploaded = 0L
    private var uploads = 0L
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
            bedMaterial.setParameter("tint", BED_TINT[0], BED_TINT[1], BED_TINT[2], 1f)
            toolpathMaterial = opaque.createInstance()
            toolpathMaterial.setParameter("clipHeight", clipHeight)
            toolpathMaterial.setParameter("opacity", 1f)
            toolpathMaterial.setParameter("tint", 1f, 1f, 1f, 1f)
            view.scene = scene
            view.camera = camera
            view.isPostProcessingEnabled = false
            renderer.clearOptions = Renderer.ClearOptions().apply {
                clear = true
                clearColor = doubleArrayOf(.035, .045, .06, 1.0)
            }
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
                    camera.setProjection(45.0, width.toDouble() / height, .001, 10.0, Camera.Fov.VERTICAL)
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
        return Metrics(state, meshes.size, meshes.values.sumOf { it.source.facetCount },
            meshes.values.sumOf { it.uploadedFacets }, placed.size,
            placed.values.sumOf { it.entities.size } + (if (bed == null) 0 else 1) + (if (toolpath == null) 0 else 1),
            meshes.values.sumOf { mesh -> mesh.chunks.sumOf { it.bytes } } + (bed?.bytes ?: 0) + (toolpath?.bytes ?: 0),
            pending, peakPending, uploaded, uploads, frames, maxFrameCpuMs, closed, toolpathSegments)
    }

    fun setActive(value: Boolean) {
        checkOpen(); active = value
        if (value) invalidate() else unschedule()
    }

    /** Uploads [mesh] for [assetId], replacing the mesh it had: draws placing it show each chunk as it lands. */
    fun setMesh(assetId: String, mesh: TriangleMesh) {
        checkOpen(); require(assetId.isNotEmpty())
        meshes.remove(assetId)?.let(::discard)
        meshes[assetId] = Mesh(assetId, mesh)
        pump()
        invalidate()
    }

    fun removeMesh(assetId: String) {
        checkOpen()
        meshes.remove(assetId)?.let(::discard)
        refreshState()
        invalidate()
    }

    /** Detaches every draw from [mesh]'s chunks and frees them; its job in flight is dropped when it answers. */
    private fun discard(mesh: Mesh) {
        mesh.cancelled = true
        for (each in placed.values) for (chunk in mesh.chunks) each.entities.remove(chunk)?.let(::destroyEntity)
        mesh.chunks.forEach { engine.destroyVertexBuffer(it.vertices); engine.destroyIndexBuffer(it.indices) }
        mesh.chunks.clear()
        mesh.picking = null
    }

    /** The draws to show, keyed by [ProjectScene.Draw.key]: new ones placed, changed ones moved or retinted, the rest removed. */
    fun setDraws(draws: List<ProjectScene.Draw>) {
        checkOpen()
        val wanted = LinkedHashMap<String, ProjectScene.Draw>()
        for (draw in draws) require(wanted.put(draw.key, draw) == null) { "Repeated draw ${draw.key}" }
        for (key in placed.keys.toList()) if (key !in wanted) placed.remove(key)?.let(::destroyPlaced)
        for ((key, draw) in wanted) {
            val current = placed[key]
            if (current == null) {
                val created = Placed(draw, materialFor(draw))
                placed[key] = created
                meshes[draw.assetId]?.chunks?.forEach { attach(created, it) }
                continue
            }
            val before = current.draw
            current.draw = draw
            if (before.assetId != draw.assetId) {
                current.entities.values.forEach(::destroyEntity)
                current.entities.clear()
            }
            if (before.printable != draw.printable) {
                val replaced = current.material
                current.material = materialFor(draw)
                for (entity in current.entities.values) {
                    engine.renderableManager.setMaterialInstanceAt(engine.renderableManager.getInstance(entity), 0, current.material)
                }
                engine.destroyMaterialInstance(replaced)
            } else if (before.argb != draw.argb || before.instanceId != draw.instanceId) {
                tint(current.material, draw)
            }
            val matrix = draw.transform.renderMatrix()
            if (!before.transform.renderMatrix().contentEquals(matrix)) {
                for (entity in current.entities.values) place(entity, matrix)
            }
            if (before.assetId != draw.assetId) meshes[draw.assetId]?.chunks?.forEach { attach(current, it) }
        }
        invalidate()
    }

    private fun materialFor(draw: ProjectScene.Draw): MaterialInstance {
        val instance = (if (draw.printable) opaque else transparent).createInstance()
        instance.setParameter("clipHeight", clipHeight)
        instance.setParameter("opacity", if (draw.printable) 1f else NOT_PRINTABLE_OPACITY)
        tint(instance, draw)
        return instance
    }

    /** The draw's colour; a selected instance's draws shift toward the selection accent. */
    private fun tint(instance: MaterialInstance, draw: ProjectScene.Draw) {
        val colour = floatArrayOf(((draw.argb ushr 16) and 255) / 255f, ((draw.argb ushr 8) and 255) / 255f, (draw.argb and 255) / 255f)
        if (draw.instanceId in selected) for (n in 0..2) colour[n] = colour[n] * (1 - SELECTED_MIX) + SELECTED_ACCENT[n] * SELECTED_MIX
        // The transparent material blends premultiplied colour.
        val alpha = if (draw.printable) 1f else NOT_PRINTABLE_OPACITY
        instance.setParameter("tint", colour[0] * alpha, colour[1] * alpha, colour[2] * alpha, 1f)
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
        engine.destroyMaterialInstance(value.material)
    }

    private fun refreshState() {
        if (busy) return
        state = when {
            meshes.isEmpty() -> "Empty"
            meshes.values.any { it.failed } -> "Geometry upload failed"
            meshes.values.all { it.complete } -> "Ready"
            else -> state
        }
    }

    /** Admits one job at a time: a mesh's next chunk, then its picking index once
     * every chunk has landed. Nothing starts while an upload is still being copied. */
    private fun pump() {
        if (closed || busy || pending != 0L) return
        val target = meshes.values.firstOrNull { !it.failed && !it.complete }
        if (target == null) { refreshState(); return }
        val upload = target.uploadedFacets < target.source.facetCount
        val first = target.uploadedFacets
        busy = true
        state = if (upload) "Uploading ${target.source.facetCount} facets" else "Indexing ${target.source.facetCount} facets"
        worker.execute {
            var chunk: MeshChunk? = null
            var index: MeshPicking? = null
            var failed = false
            try {
                val cancelled = { target.cancelled || Thread.currentThread().isInterrupted }
                check(!cancelled())
                if (upload) chunk = MeshPacking.chunk(target.source, first) else index = MeshPicking(target.source, cancelled)
                check(!cancelled())
            } catch (_: Exception) { failed = true }
            handler.post {
                busy = false
                if (closed) return@post
                if (target.cancelled || meshes[target.assetId] !== target) { pump(); refreshState(); return@post }
                if (failed) {
                    target.failed = true
                } else {
                    index?.let { target.picking = it }
                    chunk?.let {
                        try {
                            val gpu = createChunk(it)
                            target.chunks.add(gpu)
                            target.uploadedFacets += it.facetCount
                            for (each in placed.values) if (each.draw.assetId == target.assetId) attach(each, gpu)
                        } catch (_: RuntimeException) {
                            target.failed = true
                        }
                    }
                }
                pump()
                refreshState()
                invalidate()
            }
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
        return Chunk(vertices, indices, count, chunk.facetCount, chunk.center, chunk.halfExtent,
            chunk.positions.remaining().toLong() + chunk.colors.remaining() + chunk.indices.remaining())
    }

    /** The print bed: its outline and a grid every 10 mm (coarser on a large bed), on z = 0 from the origin. */
    fun setBed(widthMm: Double, depthMm: Double) {
        checkOpen(); require(widthMm.isFinite() && depthMm.isFinite() && widthMm in 1.0..5000.0 && depthMm in 1.0..5000.0)
        bed?.let(::destroyLines); bed = null
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
            val shade = if (outline[n]) 1f else BED_GRID_SHADE
            for (point in arrayOf(RenderSpace.point(a), RenderSpace.point(b))) {
                val coordinates = floatArrayOf(point.x.toFloat(), point.y.toFloat(), point.z.toFloat())
                for (axis in 0..2) {
                    positions.putFloat(coordinates[axis])
                    low[axis] = min(low[axis], coordinates[axis]); high[axis] = max(high[axis], coordinates[axis])
                }
                colors.putFloat(shade).putFloat(shade).putFloat(shade).putFloat(1f)
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
        for (each in placed.values) tint(each.material, each.draw)
        invalidate()
    }

    fun clipAboveMm(height: Float?) {
        checkOpen(); require(height == null || height.isFinite() && height in -1_000_000f..1_000_000f)
        clipHeight = height?.times(.001f) ?: 10000f
        bedMaterial.setParameter("clipHeight", clipHeight)
        toolpathMaterial.setParameter("clipHeight", clipHeight)
        for (each in placed.values) each.material.setParameter("clipHeight", clipHeight)
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
        invalidate()
    }

    /** The nearest uploaded facet under view position ([x], [y]), over every draw, below the clip height. */
    fun pick(x: Double, y: Double): Pick? {
        checkOpen()
        if (view.viewport.width <= 0 || view.viewport.height <= 0) return null
        val world = RenderSpace.rayToMillimetres(orbit.ray(x, y, view.viewport.width, view.viewport.height))
        var closest: Pick? = null
        for ((key, each) in placed) {
            val mesh = meshes[each.draw.assetId] ?: continue
            val index = mesh.picking ?: continue
            val transform = each.draw.transform
            val local = runCatching { transform.localRay(world) }.getOrNull() ?: continue
            // An affine map keeps the ray parameter, so distances compare across draws.
            val hit = index.pick(local, closest?.distanceMetres ?: Double.POSITIVE_INFINITY) { facet, point ->
                facet < mesh.uploadedFacets && transform.point(point).z * .001 <= clipHeight
            }
            if (hit != null) closest = Pick(key, each.draw.instanceId, hit.facet, hit.distance)
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
        bed?.let(::destroyLines); bed = null
        toolpath?.let(::destroyLines); toolpath = null; toolpathSegments = 0
        engine.destroyMaterialInstance(bedMaterial)
        engine.destroyMaterialInstance(toolpathMaterial)
        engine.destroyMaterial(opaque); engine.destroyMaterial(transparent)
        engine.destroyView(view); engine.destroyScene(scene); engine.destroyRenderer(renderer)
        val cameraEntity = camera.entity
        engine.destroyCameraComponent(cameraEntity); engine.entityManager.destroy(cameraEntity)
        engine.flushAndWait(); engine.destroy()
        pendingBuffers.clear(); pending = 0; state = "Closed"
    }

    private companion object {
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
    }
}
