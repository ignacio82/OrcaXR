package dev.orcaxr.app.mobile.viewer

import android.content.Context
import android.util.Log
import android.view.Choreographer
import android.view.MotionEvent
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import com.google.android.filament.Camera
import com.google.android.filament.Colors
import com.google.android.filament.Engine
import com.google.android.filament.Entity
import com.google.android.filament.EntityManager
import com.google.android.filament.IndirectLight
import com.google.android.filament.LightManager
import com.google.android.filament.RenderableManager
import com.google.android.filament.Renderer
import com.google.android.filament.Scene
import com.google.android.filament.SwapChain
import com.google.android.filament.View
import com.google.android.filament.Viewport
import com.google.android.filament.android.UiHelper
import com.google.android.filament.gltfio.AssetLoader
import com.google.android.filament.gltfio.FilamentAsset
import com.google.android.filament.gltfio.ResourceLoader
import com.google.android.filament.gltfio.UbershaderProvider
import com.google.android.filament.utils.Manipulator
import com.google.android.filament.utils.Utils
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Filament-android SurfaceView that renders a toolpath GLB produced by
 * [dev.orcaxr.app.ToolpathGlb.write]. Used by the mobile shell's
 * [dev.orcaxr.app.mobile.MobileToolpath3DViewer] composable to give
 * users a true 3D preview of their slice on phones / tablets — the XR
 * shell already gets one for free via SceneCore (which is itself a
 * Filament wrapper, so this view's pixels match the headset's
 * pixels modulo the lighting model).
 *
 * Lifecycle contract:
 *   - Construct on the main thread.
 *   - Call [loadGlb] whenever the GLB on disk changes (layer scrub,
 *     color-mode toggle, new slice). Safe to call before the surface
 *     is ready; the load is deferred until [SurfaceHolder.Callback.surfaceCreated].
 *   - Call [destroy] from the hosting composable's `DisposableEffect`
 *     onDispose. Filament leaks GPU memory if you skip this.
 *
 * Camera: orbit mode via filament-utils [Manipulator], with target =
 * model bbox center and distance = 1.5 × longest bbox axis. Touch
 * gestures: single-finger drag → orbit, two-finger drag → pan,
 * two-finger pinch → zoom.
 *
 * The toolpath GLB uses `KHR_materials_unlit` (per
 * `app/src/main/cpp/slic3r_jni.cpp`'s nativeWriteColoredGlb), so it
 * renders correctly without an IBL — the gltfio UbershaderProvider's
 * default unlit ubershader is what we want here. We still wire a
 * single weak directional light so any future shaded helpers (e.g.
 * a build-plate quad) read sanely.
 */
class FilamentToolpathSurface(context: Context) : SurfaceView(context), SurfaceHolder.Callback, Choreographer.FrameCallback {

    private val choreographer: Choreographer = Choreographer.getInstance()
    private val uiHelper: UiHelper = UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK)

    private val engine: Engine = Engine.create()
    private val renderer: Renderer = engine.createRenderer()
    private val scene: Scene = engine.createScene()
    private val view: View = engine.createView().also { it.scene = scene }
    private val cameraEntity: Int = EntityManager.get().create()
    private val camera: Camera = engine.createCamera(cameraEntity)
    private var swapChain: SwapChain? = null

    private val materialProvider: UbershaderProvider = UbershaderProvider(engine)
    private val assetLoader: AssetLoader = AssetLoader(engine, materialProvider, EntityManager.get())
    private val resourceLoader: ResourceLoader = ResourceLoader(engine, /*normalizeSkinningWeights=*/true)

    private var asset: FilamentAsset? = null
    private var pendingGlb: File? = null
    private var lightEntity: Int = 0

    private var manipulator: Manipulator? = null
    private var viewportWidth = 1
    private var viewportHeight = 1

    /** Track in-flight pointer state for orbit / pan / pinch. */
    private var primaryPointerId = -1
    private var pinchStartDistance = 0f
    private var inPinch = false

    init {
        holder.addCallback(this)
        view.camera = camera
        view.viewport = Viewport(0, 0, 1, 1)

        // Soft background so the toolpath line/tube colors read on a
        // dark surface; matches the XR shell's plate backdrop tone.
        view.blendMode = View.BlendMode.OPAQUE
        renderer.clearOptions = renderer.clearOptions.apply {
            clear = true
            clearColor = floatArrayOf(0.04f, 0.05f, 0.07f, 1f)
        }

        // Single weak directional light. The toolpath GLB ignores it
        // (unlit), but anything we add later that uses the lit
        // ubershader needs SOMETHING.
        lightEntity = EntityManager.get().create()
        LightManager.Builder(LightManager.Type.DIRECTIONAL)
            .color(0.95f, 0.95f, 1.0f)
            .intensity(40_000.0f)
            .direction(0.5f, -1.0f, -0.4f)
            .castShadows(false)
            .build(engine, lightEntity)
        scene.addEntity(lightEntity)

        uiHelper.renderCallback = object : UiHelper.RendererCallback {
            override fun onNativeWindowChanged(surface: Surface) {
                swapChain?.let { engine.destroySwapChain(it) }
                swapChain = engine.createSwapChain(surface)
                pendingGlb?.let { loadGlbInternal(it) }
            }

            override fun onDetachedFromSurface() {
                swapChain?.let { engine.destroySwapChain(it) }
                swapChain = null
            }

            override fun onResized(width: Int, height: Int) {
                viewportWidth = max(1, width)
                viewportHeight = max(1, height)
                view.viewport = Viewport(0, 0, viewportWidth, viewportHeight)
                manipulator?.setViewport(viewportWidth, viewportHeight)
                applyCamera()
            }
        }
        uiHelper.attachTo(this)
    }

    /**
     * Schedule loading of a toolpath GLB on the next render-thread
     * tick. Replaces any previously-loaded asset. Safe to call before
     * the surface is ready — the load defers until [SurfaceHolder.Callback.surfaceCreated]
     * fires via [UiHelper].
     */
    fun loadGlb(file: File) {
        pendingGlb = file
        if (swapChain != null) loadGlbInternal(file)
    }

    private fun loadGlbInternal(file: File) {
        clearAsset()
        if (!file.exists() || file.length() <= 0L) {
            Log.w(TAG, "loadGlb: missing or empty $file")
            return
        }
        val bytes = file.readBytes()
        val bb = ByteBuffer.allocateDirect(bytes.size).also {
            it.put(bytes)
            it.flip()
        }
        val newAsset = assetLoader.createAsset(bb)
        if (newAsset == null) {
            Log.e(TAG, "loadGlb: AssetLoader returned null for $file (${bytes.size} bytes)")
            return
        }
        resourceLoader.loadResources(newAsset)
        // Toolpath GLB has no animations; release the source data so
        // the JVM heap doesn't carry a duplicate.
        newAsset.releaseSourceData()
        scene.addEntities(newAsset.entities)
        asset = newAsset

        val bbox = newAsset.boundingBox
        val cx = (bbox.center[0])
        val cy = (bbox.center[1])
        val cz = (bbox.center[2])
        val halfExtents = sqrt(
            bbox.halfExtent[0] * bbox.halfExtent[0] +
                bbox.halfExtent[1] * bbox.halfExtent[1] +
                bbox.halfExtent[2] * bbox.halfExtent[2]
        ).coerceAtLeast(0.05f)
        val distance = halfExtents * 2.6f

        manipulator = Manipulator.Builder()
            .targetPosition(cx, cy, cz)
            .viewport(viewportWidth, viewportHeight)
            .orbitHomePosition(cx + distance * 0.5f, cy + distance * 0.4f, cz + distance)
            .orbitSpeed(0.005f, 0.005f)
            .zoomSpeed(0.05f)
            .build(Manipulator.Mode.ORBIT)
        applyCamera()
    }

    private fun clearAsset() {
        asset?.let {
            scene.removeEntities(it.entities)
            assetLoader.destroyAsset(it)
        }
        asset = null
    }

    private fun applyCamera() {
        val m = manipulator ?: run {
            // Identity until we know a target.
            camera.lookAt(0.0, 0.6, 1.5, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0)
            return
        }
        val eye = FloatArray(3)
        val target = FloatArray(3)
        val up = FloatArray(3)
        m.getLookAt(eye, target, up)
        camera.lookAt(
            eye[0].toDouble(), eye[1].toDouble(), eye[2].toDouble(),
            target[0].toDouble(), target[1].toDouble(), target[2].toDouble(),
            up[0].toDouble(), up[1].toDouble(), up[2].toDouble(),
        )
        val aspect = viewportWidth.toDouble() / viewportHeight.toDouble().coerceAtLeast(1.0)
        camera.setProjection(45.0, aspect, 0.05, 1_000.0, Camera.Fov.VERTICAL)
    }

    /** Pause the choreographer-driven render loop. */
    fun pauseRendering() {
        choreographer.removeFrameCallback(this)
    }

    /** Resume the choreographer-driven render loop. */
    fun resumeRendering() {
        choreographer.removeFrameCallback(this)
        choreographer.postFrameCallback(this)
    }

    override fun doFrame(frameTimeNanos: Long) {
        choreographer.postFrameCallback(this)
        applyCamera()
        val sc = swapChain ?: return
        if (renderer.beginFrame(sc, frameTimeNanos)) {
            renderer.render(view)
            renderer.endFrame()
        }
    }

    override fun surfaceCreated(holder: SurfaceHolder) { /* uiHelper drives this */ }
    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) { /* uiHelper drives this */ }
    override fun surfaceDestroyed(holder: SurfaceHolder) { /* uiHelper drives this */ }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val m = manipulator ?: return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                primaryPointerId = event.getPointerId(0)
                m.grabBegin(event.x.toInt(), event.y.toInt(), /*strafe=*/false)
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.pointerCount == 2) {
                    m.grabEnd()
                    pinchStartDistance = pointerDistance(event)
                    inPinch = true
                    val (cx, cy) = pointerCenter(event)
                    m.grabBegin(cx.toInt(), cy.toInt(), /*strafe=*/true)
                }
            }
            MotionEvent.ACTION_MOVE -> {
                if (inPinch && event.pointerCount == 2) {
                    val (cx, cy) = pointerCenter(event)
                    m.grabUpdate(cx.toInt(), cy.toInt())
                    val newDist = pointerDistance(event)
                    val delta = newDist - pinchStartDistance
                    if (kotlin.math.abs(delta) > 4f) {
                        // Filament Manipulator zoom: positive scrolldelta
                        // = zoom out (camera moves away from target),
                        // negative = zoom in. Match the gesture sign.
                        m.scroll(cx.toInt(), cy.toInt(), -delta * 0.01f)
                        pinchStartDistance = newDist
                    }
                } else if (event.pointerCount >= 1) {
                    m.grabUpdate(event.x.toInt(), event.y.toInt())
                }
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (inPinch) {
                    m.grabEnd()
                    inPinch = false
                    // Re-anchor to the remaining finger for orbit.
                    val remaining = if (event.actionIndex == 0) 1 else 0
                    if (event.pointerCount > remaining) {
                        m.grabBegin(event.getX(remaining).toInt(), event.getY(remaining).toInt(), /*strafe=*/false)
                    }
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                m.grabEnd()
                primaryPointerId = -1
                inPinch = false
            }
        }
        return true
    }

    private fun pointerDistance(event: MotionEvent): Float {
        if (event.pointerCount < 2) return 0f
        val dx = event.getX(0) - event.getX(1)
        val dy = event.getY(0) - event.getY(1)
        return sqrt(dx * dx + dy * dy)
    }

    private fun pointerCenter(event: MotionEvent): Pair<Float, Float> {
        if (event.pointerCount < 2) return event.x to event.y
        return ((event.getX(0) + event.getX(1)) * 0.5f) to ((event.getY(0) + event.getY(1)) * 0.5f)
    }

    /**
     * Tear down all Filament state. Must be called from the hosting
     * composable's `DisposableEffect.onDispose` — Filament holds GPU
     * resources that the JVM GC won't reclaim.
     */
    fun destroy() {
        pauseRendering()
        uiHelper.detach()
        clearAsset()
        assetLoader.destroy()
        resourceLoader.destroy()
        materialProvider.destroyMaterials()
        materialProvider.destroy()

        scene.removeEntity(lightEntity)
        engine.destroyEntity(lightEntity)
        EntityManager.get().destroy(lightEntity)

        engine.destroyCameraComponent(cameraEntity)
        EntityManager.get().destroy(cameraEntity)

        engine.destroyView(view)
        engine.destroyScene(scene)
        engine.destroyRenderer(renderer)
        swapChain?.let { engine.destroySwapChain(it) }
        engine.destroy()
    }

    companion object {
        private const val TAG = "FilamentToolpath"

        init {
            // Filament's JNI loader has a one-shot guard internally, but
            // calling Utils.init() before any Engine.create() is the
            // documented bootstrap path for filament-utils.
            Utils.init()
        }
    }
}

/** Convenience: parse a `#RRGGBB` hex string to linear sRGB floats. */
internal fun hexColorToLinear(hex: String): FloatArray {
    val s = hex.removePrefix("#")
    if (s.length != 6) return floatArrayOf(0.6f, 0.6f, 0.6f)
    val r = s.substring(0, 2).toInt(16) / 255f
    val g = s.substring(2, 4).toInt(16) / 255f
    val b = s.substring(4, 6).toInt(16) / 255f
    return Colors.toLinear(Colors.RgbType.SRGB, floatArrayOf(r, g, b))
}
