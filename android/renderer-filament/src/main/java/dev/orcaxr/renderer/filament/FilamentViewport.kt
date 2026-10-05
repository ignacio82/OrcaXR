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
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min

/** Flat, debug-only feasibility adapter. All Filament access belongs to the UI
 * thread. Its single worker owns generation/indexing and at most one upload
 * chunk. Only completion of all three native buffer copies admits the next chunk.
 * No project state, engine, network transport or XR session is created here. */
class FilamentViewport(private val surface: SurfaceView) : AutoCloseable {
    data class Metrics(
        val state: String, val facets: Int, val uploadedFacets: Int, val drawEntities: Int,
        val sourceAndIndexBytes: Long, val gpuBufferBytes: Long, val pendingUploadBytes: Long,
        val peakUploadBytes: Long, val totalUploadBytes: Long, val bufferUploads: Long,
        val paintUploadBytes: Long, val frames: Long, val maxFrameCpuMs: Double,
        val closed: Boolean,
    )
    data class Hit(val instance: Int, val facet: Int, val distanceMetres: Double)
    private data class Geometry(val vertices: VertexBuffer, val indices: IndexBuffer,
        val entities: IntArray, val firstFacet: Int, val facetCount: Int, val bytes: Long)

    private val handler = Handler(Looper.getMainLooper())
    private val generation = AtomicInteger()
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "OrcaXR geometry") }
    private val engine: Engine
    private val renderer: Renderer
    private val scene: Scene
    private val view: View
    private val camera: Camera
    private val opaque: Material
    private val transparent: Material
    private val solid: MaterialInstance
    private val translucent: MaterialInstance
    private val duplicate: MaterialInstance
    private val lines: MaterialInstance
    private val helper = UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK)
    private val display = DisplayHelper(surface.context)
    private val scheduler = Choreographer.getInstance()
    private var swapChain: SwapChain? = null
    private val geometry = mutableListOf<Geometry>()
    private var toolpath: Geometry? = null
    private var toolpathIds: IntArray? = null
    private var mesh: TriangleMesh? = null
    private var picking: MeshPicking? = null
    private var requestedCells: Int? = null
    private var busy = false
    private var pending = 0L
    private var peakPending = 0L
    private var uploaded = 0L
    private var uploads = 0L
    private var paintBytes = 0L
    private var uploadedFacets = 0
    private var state = "Empty"
    private var active = false
    private var scheduled = false
    private var dirtyFrames = 0
    private var frames = 0L
    private var maxFrameCpuMs = 0.0
    private var closed = false
    private var secondVisible = false
    private var transparentVisible = false
    private var clipHeight = 10000f
    private var orbit = OrbitCamera()
    private val transforms = arrayOf(ModelTransform.scaledTranslated(),
        ModelTransform.scaledTranslated(x = -.65, y = .8, z = 1.3, tx = 90.0, ty = 65.0, tz = 8.0))
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
            solid = opaque.createInstance()
            translucent = transparent.createInstance()
            duplicate = transparent.createInstance()
            lines = opaque.createInstance()
            for (instance in listOf(solid, translucent, duplicate, lines)) {
                instance.setParameter("clipHeight", clipHeight)
                instance.setParameter("opacity", if (instance === duplicate) .5f else 1f)
                instance.setParameter("tint", 1f, 1f, 1f, 1f)
            }
            translucent.setParameter("opacity", .45f)
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
    private fun checkOpen() { requireUi(); check(!closed) { "Viewport is closed" } }
    private fun material(name: String): Material {
        val bytes = surface.context.assets.open("materials/$name.filamat").use { it.readBytes() }
        return Material.Builder().payload(ByteBuffer.wrap(bytes), bytes.size).build(engine)
    }

    fun metrics(): Metrics {
        requireUi()
        return Metrics(state, mesh?.facetCount ?: 0, uploadedFacets,
            geometry.size * (if (secondVisible) 2 else 1) + (if (toolpath == null) 0 else 1),
            (mesh?.cpuBytes ?: 0) + (picking?.cpuBytes ?: 0) + (toolpathIds?.size ?: 0) * 4L,
            geometry.sumOf { it.bytes } + (toolpath?.bytes ?: 0), pending, peakPending,
            uploaded, uploads, paintBytes, frames, maxFrameCpuMs, closed)
    }

    fun setActive(value: Boolean) {
        checkOpen(); active = value
        if (value) invalidate() else unschedule()
    }

    fun loadGrid(cells: Int) {
        checkOpen(); require(cells in 1..1000)
        generation.incrementAndGet()
        requestedCells = cells
        clearMesh()
        state = "Preparing ${cells * cells * 2} facets"
        pump()
        invalidate()
    }

    /** Global admission prevents replacement/cancellation from stacking chunks
     * or allocating another source while the previous worker still owns one. */
    private fun pump() {
        if (closed || busy || pending != 0L) return
        val cells = requestedCells ?: return
        val token = generation.get()
        val source = mesh
        if (source != null && uploadedFacets == source.facetCount) {
            state = "Ready"; return
        }
        busy = true
        val first = uploadedFacets
        worker.execute {
            var prepared: TriangleMesh? = null
            var index: MeshPicking? = null
            var chunk: MeshChunk? = null
            var failed = false
            try {
                val cancelled = { generation.get() != token || Thread.currentThread().isInterrupted }
                if (source == null) {
                    prepared = TriangleMesh.grid(cells, cancelled)
                    index = MeshPicking(prepared, cancelled)
                } else {
                    check(!cancelled())
                    chunk = MeshPacking.chunk(source, first)
                    check(!cancelled())
                }
            } catch (_: Exception) { failed = true }
            handler.post {
                busy = false
                if (closed) return@post
                if (generation.get() != token) { pump(); return@post }
                if (failed) {
                    state = "Geometry preparation failed"
                    requestedCells = null
                    return@post
                }
                if (prepared != null) {
                    mesh = prepared; picking = index
                    state = "Uploading ${prepared.facetCount} facets"
                }
                chunk?.let {
                    try {
                        val gpu = createGeometry(it.positions, it.colors, it.indices, it.center,
                            it.halfExtent, false, it.firstFacet, it.facetCount)
                        geometry.add(gpu)
                        uploadedFacets += it.facetCount
                    } catch (_: RuntimeException) {
                        requestedCells = null
                        clearMesh()
                        state = "Geometry upload failed"
                    }
                }
                pump()
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

    private fun createGeometry(positions: ByteBuffer, colors: ByteBuffer, indices: ByteBuffer,
        center: FloatArray, extent: FloatArray, isLines: Boolean, first: Int = 0, facets: Int = 0): Geometry {
        val count = indices.remaining() / 4
        val builder = VertexBuffer.Builder().bufferCount(2).vertexCount(count)
            .attribute(VertexBuffer.VertexAttribute.POSITION, 0, VertexBuffer.AttributeType.FLOAT3, 0, 12)
            .attribute(VertexBuffer.VertexAttribute.COLOR, 1,
                if (isLines) VertexBuffer.AttributeType.FLOAT4 else VertexBuffer.AttributeType.UBYTE4,
                0, if (isLines) 16 else 4)
        if (!isLines) builder.normalized(VertexBuffer.VertexAttribute.COLOR)
        val vertices = builder.build(engine)
        val index = try {
            IndexBuffer.Builder().indexCount(count)
                .bufferType(IndexBuffer.Builder.IndexType.UINT).build(engine)
        } catch (failure: Throwable) {
            engine.destroyVertexBuffer(vertices)
            throw failure
        }
        val entities = IntArray(if (isLines) 1 else 2)
        try {
            for (n in entities.indices) {
                val entity = engine.entityManager.create()
                entities[n] = entity
                RenderableManager.Builder(1)
                    .boundingBox(Box(center[0], center[1], center[2], extent[0], extent[1], extent[2]))
                    .geometry(0, if (isLines) RenderableManager.PrimitiveType.LINES else RenderableManager.PrimitiveType.TRIANGLES,
                        vertices, index, 0, count)
                    .material(0, if (isLines) lines else if (n == 1) duplicate else primaryMaterial())
                    .culling(false).castShadows(false).receiveShadows(false)
                    .build(engine, entity)
                if (!isLines) engine.transformManager.setTransform(engine.transformManager.getInstance(entity), transforms[n].renderMatrix())
                if (n == 0 || secondVisible) scene.addEntity(entity)
            }
            submit(positions) { callback -> vertices.setBufferAt(engine, 0, positions, 0, positions.remaining(), handler, callback) }
            submit(colors) { callback -> vertices.setBufferAt(engine, 1, colors, 0, colors.remaining(), handler, callback) }
            submit(indices) { callback -> index.setBuffer(engine, indices, 0, indices.remaining(), handler, callback) }
            engine.flush()
            return Geometry(vertices, index, entities, first, facets,
                positions.remaining().toLong() + colors.remaining() + indices.remaining())
        } catch (failure: Throwable) {
            entities.filter { it != 0 }.forEach { scene.removeEntity(it); engine.destroyEntity(it); engine.entityManager.destroy(it) }
            engine.destroyVertexBuffer(vertices); engine.destroyIndexBuffer(index)
            throw failure
        }
    }

    fun setToolpath(value: ToolpathGeometry) {
        checkOpen()
        check(pending == 0L && !busy && state == "Ready") { "Wait for mesh upload to finish" }
        require(value.segments <= 240_000)
        toolpath?.let(::destroyGeometry); toolpath = null; toolpathIds = null
        if (value.segments > 0) {
            toolpath = createGeometry(value.positions, value.colors, value.indices, value.center, value.halfExtent, true)
            toolpathIds = value.originalRecords.copyOf()
        }
        invalidate()
    }

    fun setTransform(instance: Int, transform: ModelTransform) {
        checkOpen(); require(instance in 0..1)
        transforms[instance] = transform
        geometry.forEach { engine.transformManager.setTransform(engine.transformManager.getInstance(it.entities[instance]), transform.renderMatrix()) }
        invalidate()
    }
    fun showSecondInstance(value: Boolean) {
        checkOpen(); secondVisible = value
        geometry.forEach { if (value) scene.addEntity(it.entities[1]) else scene.removeEntity(it.entities[1]) }
        invalidate()
    }
    fun setTransparent(value: Boolean) {
        checkOpen(); transparentVisible = value
        geometry.forEach { engine.renderableManager.setMaterialInstanceAt(engine.renderableManager.getInstance(it.entities[0]), 0, primaryMaterial()) }
        invalidate()
    }
    private fun primaryMaterial() = if (transparentVisible) translucent else solid
    fun select(instance: Int?) {
        checkOpen(); require(instance == null || instance in 0..1)
        for ((n, material) in listOf(0 to solid, 0 to translucent, 1 to duplicate)) {
            material.setParameter("tint", if (instance == n) 1f else .85f, if (instance == n) .65f else 1f, 1f, 1f)
        }
        invalidate()
    }
    fun clipAboveMm(height: Float?) {
        checkOpen(); require(height == null || height.isFinite() && height in -1_000_000f..1_000_000f)
        clipHeight = height?.times(.001f) ?: 10000f
        for (material in listOf(solid, translucent, duplicate, lines)) material.setParameter("clipHeight", clipHeight)
        invalidate()
    }
    fun setCamera(value: OrbitCamera) { checkOpen(); orbit = value; updateCamera() }
    fun cameraState() = orbit
    private fun updateCamera() {
        val eye = orbit.eye; val target = orbit.target
        camera.lookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, 0.0, 1.0, 0.0)
        invalidate()
    }
    fun pick(x: Double, y: Double): Hit? {
        checkOpen()
        if (view.viewport.width <= 0 || view.viewport.height <= 0) return null
        val index = picking ?: return null
        val world = RenderSpace.rayToMillimetres(orbit.ray(x, y, view.viewport.width, view.viewport.height))
        var closest: Hit? = null
        for (instance in 0..(if (secondVisible) 1 else 0)) {
            val transform = transforms[instance]
            val hit = index.pick(transform.localRay(world), closest?.distanceMetres ?: Double.POSITIVE_INFINITY) { facet, point ->
                facet < uploadedFacets && transform.point(point).z * .001 <= clipHeight
            }
            if (hit != null) closest = Hit(instance, hit.facet, hit.distance)
        }
        return closest
    }

    /** Bounded color-only display overlay. Source mesh and facet IDs stay immutable. */
    fun paint(firstFacet: Int, facetCount: Int, argb: Int): Boolean {
        checkOpen(); require(facetCount in 1..4096)
        require(firstFacet >= 0 && firstFacet.toLong() + facetCount <= uploadedFacets)
        if (pending != 0L || busy || state != "Ready") return false
        for (chunk in geometry) {
            val start = maxOf(firstFacet, chunk.firstFacet)
            val end = min(firstFacet + facetCount, chunk.firstFacet + chunk.facetCount)
            if (end <= start) continue
            val data = MeshPacking.direct((end - start) * 12)
            repeat((end - start) * 3) { MeshPacking.rgba(data, argb) }
            data.flip(); paintBytes += data.remaining()
            submit(data) { callback -> chunk.vertices.setBufferAt(engine, 1, data,
                (start - chunk.firstFacet) * 12, data.remaining(), handler, callback) }
        }
        engine.flush(); invalidate(); return true
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
    private fun destroyGeometry(value: Geometry) {
        value.entities.forEach { scene.removeEntity(it); engine.destroyEntity(it); engine.entityManager.destroy(it) }
        engine.destroyVertexBuffer(value.vertices); engine.destroyIndexBuffer(value.indices)
    }
    private fun clearMesh() {
        geometry.forEach(::destroyGeometry); geometry.clear()
        mesh = null; picking = null; uploadedFacets = 0
    }
    override fun close() {
        requireUi(); if (closed) return
        closed = true; active = false; generation.incrementAndGet(); requestedCells = null
        unschedule(); worker.shutdownNow(); helper.detach()
        clearMesh(); toolpath?.let(::destroyGeometry); toolpath = null; toolpathIds = null
        for (instance in listOf(solid, translucent, duplicate, lines)) engine.destroyMaterialInstance(instance)
        engine.destroyMaterial(opaque); engine.destroyMaterial(transparent)
        engine.destroyView(view); engine.destroyScene(scene); engine.destroyRenderer(renderer)
        val cameraEntity = camera.entity
        engine.destroyCameraComponent(cameraEntity); engine.entityManager.destroy(cameraEntity)
        engine.flushAndWait(); engine.destroy()
        pendingBuffers.clear(); pending = 0; state = "Closed"
    }
}
