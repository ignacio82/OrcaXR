package dev.orcaxr.app

import androidx.xr.runtime.math.Matrix4
import androidx.xr.runtime.math.Quaternion
import androidx.xr.runtime.math.Vector3
import androidx.xr.scenecore.InputEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * End-to-end tests for the paint hit-detection pipeline. These run as
 * pure JVM unit tests — no device, no Compose, no SceneCore runtime —
 * so the whole world→mesh-mm transform + BVH raycast can be iterated
 * on without round-tripping through `adb install`.
 *
 * Reference geometry empirically observed on the Galaxy XR retail
 * device (2026-05-02 DOWN frame dump):
 *   `transform.pose.translation = (0, 0, 66.66667)`  // mesh-mm
 *   `transform.pose.rotation    = (0.7071, ~0, ~0, 0.7071)`  // +90° X
 *   `transform.scale            = (666.66, 666.66, 666.66)`  // 1/WORLD_SCALE
 *
 * That is, `hit.transform = T(mesh_mm) · R(+90°X) · S(1/WORLD_SCALE)`
 * — a forward world→mesh-mm matrix where:
 *   - `S` converts world meters to mesh-mm (≈ 666.67),
 *   - `R` undoes the workspace's -90° X authoring rotation,
 *   - `T` carries the workspace Y offset pre-multiplied by S.
 */
class PaintInputMathTest {

    private val worldScale = 0.0015f
    private val invScale = 1f / worldScale  // ≈ 666.67

    /** Inverse of WORKSPACE_ROTATION (-90° X), i.e. +90° around X. */
    private val invWorkspaceRot = Quaternion(0.70710678f, 0f, 0f, 0.70710678f)

    /** Build the same Matrix4 the SDK reports for `hit.transform`,
     *  given a workspace world position [worldT] in METERS. The
     *  rotation matches the dragon-test observation on Galaxy XR. */
    private fun workspaceTransform(worldT: Vector3 = Vector3.Zero): Matrix4 {
        // T_w2l in mesh-mm = -R^-1 · T_l2w · S, where R is the
        // workspace's -90°X. Since the entity has identity local pose
        // under the workspace, the workspace's world position is the
        // entity's world position. Rotating (-worldT) by R^-1 (= +90°X)
        // and scaling by 1/WORLD_SCALE gives the matrix translation.
        val rotated = rotateXPositive90(Vector3(-worldT.x, -worldT.y, -worldT.z))
        val tInMm = Vector3(rotated.x * invScale, rotated.y * invScale, rotated.z * invScale)
        return Matrix4.fromTrs(
            tInMm,
            invWorkspaceRot,
            Vector3(invScale, invScale, invScale),
        )
    }

    private fun rotateXPositive90(v: Vector3): Vector3 {
        // +90° X: (X, Y, Z) -> (X, -Z, Y)
        return Vector3(v.x, -v.z, v.y)
    }

    /** A single 60×60 mm triangle on the bed (Z=0), centered at the
     *  origin in mesh-mm space. */
    private fun centeredTriangle(): StlMesh {
        val positions = floatArrayOf(
            -30f, -30f, 0f,
             30f, -30f, 0f,
              0f,  30f, 0f,
        )
        return StlMesh(
            positions = positions,
            triCount = 1,
            bboxMin = Vec3f(-30f, -30f, 0f),
            bboxMax = Vec3f(30f, 30f, 0f),
        )
    }

    /** A 60×60×60 cube (12 triangles) centered on (0,0,30) — same
     *  bbox shape as a typical model after the JNI's centering shift
     *  (centered XY, grounded Z). */
    private fun centeredCube(): StlMesh {
        val s = 30f  // half-extent
        val z0 = 0f
        val z1 = 60f
        val v = arrayOf(
            floatArrayOf(-s, -s, z0),  // 0
            floatArrayOf( s, -s, z0),  // 1
            floatArrayOf( s,  s, z0),  // 2
            floatArrayOf(-s,  s, z0),  // 3
            floatArrayOf(-s, -s, z1),  // 4
            floatArrayOf( s, -s, z1),  // 5
            floatArrayOf( s,  s, z1),  // 6
            floatArrayOf(-s,  s, z1),  // 7
        )
        // 12 triangles: 2 per face × 6 faces
        val faces = arrayOf(
            // bottom (-Z)
            intArrayOf(0, 2, 1), intArrayOf(0, 3, 2),
            // top (+Z)
            intArrayOf(4, 5, 6), intArrayOf(4, 6, 7),
            // -Y
            intArrayOf(0, 1, 5), intArrayOf(0, 5, 4),
            // +Y
            intArrayOf(3, 7, 6), intArrayOf(3, 6, 2),
            // -X
            intArrayOf(0, 4, 7), intArrayOf(0, 7, 3),
            // +X
            intArrayOf(1, 2, 6), intArrayOf(1, 6, 5),
        )
        val out = FloatArray(faces.size * 9)
        for ((fi, face) in faces.withIndex()) {
            for ((vi, idx) in face.withIndex()) {
                out[fi * 9 + vi * 3 + 0] = v[idx][0]
                out[fi * 9 + vi * 3 + 1] = v[idx][1]
                out[fi * 9 + vi * 3 + 2] = v[idx][2]
            }
        }
        return StlMesh(
            positions = out,
            triCount = faces.size,
            bboxMin = Vec3f(-s, -s, z0),
            bboxMax = Vec3f(s, s, z1),
        )
    }

    @Test
    fun `worldRayToMeshMm with identity-only-scale transform applies pure scale`() {
        val transform = Matrix4.fromTrs(
            Vector3.Zero,
            Quaternion.Identity,
            Vector3(invScale, invScale, invScale),
        )
        val (origin, dir) = PaintInputHooks.worldRayToMeshMm(
            worldOrigin = Vector3(0.045f, 0f, 0.06f),  // 45 mm × 0 × 60 mm in world meters / invScale
            worldDirection = Vector3(0f, 0f, -1f),
            transform = transform,
        )
        // 0.045 m × 666.67 ≈ 30 mm, 0.06 m × 666.67 ≈ 40 mm.
        assertEquals(30f, origin.x, 0.5f)
        assertEquals(0f, origin.y, 0.5f)
        assertEquals(40f, origin.z, 0.5f)
        // Direction scale-only (no rotation): -Z stays -Z.
        assertEquals(0f, dir.x, 0.001f)
        assertEquals(0f, dir.y, 0.001f)
        assertTrue("dir.z should be negative; got ${dir.z}", dir.z < 0f)
    }

    @Test
    fun `worldRayToMeshMm with workspace transform matches device dump`() {
        // Reproduces the 2026-05-02 device dump:
        //   event.origin=(0.099, -0.102, 1.376), worldDir≈ -Z
        //   transform.pose.t=(0, 0, 66.67), pose.r=+90°X, scale=666.67
        val transform = Matrix4.fromTrs(
            Vector3(0f, 0f, 66.66667f),
            invWorkspaceRot,
            Vector3(invScale, invScale, invScale),
        )
        val (origin, _) = PaintInputHooks.worldRayToMeshMm(
            worldOrigin = Vector3(0f, 0f, 0f),
            worldDirection = Vector3(0f, -1f, 0f),
            transform = transform,
        )
        // Ray origin at world (0,0,0): scaled (0,0,0), rotated +90°X
        // (0,0,0), translated +66.67 in z = (0, 0, 66.67). i.e. the
        // mesh-frame Z axis (= world Y after the +90° X) lands at
        // 66.67 mm.
        assertEquals(0f, origin.x, 0.001f)
        assertEquals(0f, origin.y, 0.001f)
        assertEquals(66.667f, origin.z, 0.01f)
    }

    @Test
    fun `locateTriangleByRay finds front-most triangle through the cube`() {
        val bvh = MeshBvh.build(centeredCube())
        // No-op transform: world meters == mesh mm (S=1). Ray from
        // above the cube's center pointing -Z should hit the top face.
        val transform = Matrix4.fromTrs(Vector3.Zero, Quaternion.Identity, Vector3.One)
        val hooks = PaintInputHooks(
            brush = PaintBrush(mode = PaintMode.Color, activeSlot = 1),
            bvh = bvh,
            onPaint = { _, _ -> },
        )
        val tri = hooks.locateTriangleByRay(
            worldOrigin = Vector3(0f, 0f, 100f),  // above the cube
            worldDirection = Vector3(0f, 0f, -1f),  // pointing down
            transform = transform,
        )
        assertNotNull("ray pointing straight down at cube center must hit a triangle", tri)
        // Top-face triangles are indices 2 and 3 in our cube layout.
        assertTrue("hit triangle should be on top face (got tri=$tri)", tri == 2 || tri == 3)
    }

    @Test
    fun `locateTriangleByRay misses when ray points away from mesh`() {
        val bvh = MeshBvh.build(centeredCube())
        val transform = Matrix4.fromTrs(Vector3.Zero, Quaternion.Identity, Vector3.One)
        val hooks = PaintInputHooks(
            brush = PaintBrush(mode = PaintMode.Color, activeSlot = 1),
            bvh = bvh,
            onPaint = { _, _ -> },
        )
        val tri = hooks.locateTriangleByRay(
            worldOrigin = Vector3(0f, 0f, 100f),
            worldDirection = Vector3(0f, 0f, +1f),  // pointing up, away from cube
            transform = transform,
        )
        assertNull("ray pointing away from mesh must miss; got tri=$tri", tri)
    }

    @Test
    fun `locateTriangleByRay finds correct face under the +90 X workspace transform`() {
        val bvh = MeshBvh.build(centeredCube())
        // Workspace transform: world Y is up, mesh Z is up. With the
        // +90° X rotation in the inverse-pose, world (0, 1, 0) -> mesh (0, 0, 1).
        // So a ray from world (0, 0.1, 0) pointing -Y in world (= -mesh-Z)
        // should hit the cube's top face.
        val transform = workspaceTransform()  // entity at world origin
        val hooks = PaintInputHooks(
            brush = PaintBrush(mode = PaintMode.Color, activeSlot = 1),
            bvh = bvh,
            onPaint = { _, _ -> },
        )
        val tri = hooks.locateTriangleByRay(
            worldOrigin = Vector3(0f, 0.1f, 0f),  // 100 mm above bed in world
            worldDirection = Vector3(0f, -1f, 0f),  // toward the bed
            transform = transform,
        )
        assertNotNull("ray from above bed pointing down must hit top face", tri)
        // Top face = triangles 2 and 3 of our cube layout.
        assertTrue("expected top-face triangle, got tri=$tri", tri == 2 || tri == 3)
    }

    @Test
    fun `locateTriangleByRay handles workspace Y offset`() {
        val bvh = MeshBvh.build(centeredCube())
        // Workspace at world Y = -0.10 (matches WORKSPACE_Y_OFFSET).
        val transform = workspaceTransform(Vector3(0f, -0.10f, 0f))
        val hooks = PaintInputHooks(
            brush = PaintBrush(mode = PaintMode.Color, activeSlot = 1),
            bvh = bvh,
            onPaint = { _, _ -> },
        )
        // The bed is at world Y = -0.10. The cube top is at world Y =
        // -0.10 + 60 mm × WORLD_SCALE = -0.10 + 0.09 = -0.01 m.
        // Ray from world (0, +0.10, 0) pointing -Y must hit the top.
        val tri = hooks.locateTriangleByRay(
            worldOrigin = Vector3(0f, 0.10f, 0f),
            worldDirection = Vector3(0f, -1f, 0f),
            transform = transform,
        )
        assertNotNull("ray from above offset bed must hit cube top", tri)
        assertTrue("expected top-face triangle, got tri=$tri", tri == 2 || tri == 3)
    }

    @Test
    fun `BVH centering shift puts an off-center mesh under the world origin`() {
        // Mirrors the MainActivity BVH builder: an STL whose source
        // bbox is X(100..160) Y(100..160) Z(0..60) gets shifted by
        // (-130, -130, 0) so the BVH ends up centered at world origin.
        val s = 30f
        val rawPositions = floatArrayOf(
            // single triangle on the +Z top face with center at (130, 130, 60)
            100f, 100f, 60f,
            160f, 100f, 60f,
            130f, 160f, 60f,
        )
        val raw = StlMesh(
            positions = rawPositions,
            triCount = 1,
            bboxMin = Vec3f(100f, 100f, 0f),
            bboxMax = Vec3f(160f, 160f, 60f),
        )

        val shiftX = -(raw.bboxMin.x + raw.bboxMax.x) / 2f
        val shiftY = -(raw.bboxMin.y + raw.bboxMax.y) / 2f
        val shiftZ = -raw.bboxMin.z
        val centered = raw.translatedXyz(shiftX, shiftY, shiftZ)

        // Centered bbox should be (-30..30, -30..30, 0..60)
        assertEquals(-30f, centered.bboxMin.x, 0.001f)
        assertEquals(30f, centered.bboxMax.x, 0.001f)
        assertEquals(-30f, centered.bboxMin.y, 0.001f)
        assertEquals(30f, centered.bboxMax.y, 0.001f)
        assertEquals(0f, centered.bboxMin.z, 0.001f)
        assertEquals(60f, centered.bboxMax.z, 0.001f)

        val bvh = MeshBvh.build(centered)
        val hooks = PaintInputHooks(
            brush = PaintBrush(mode = PaintMode.Color, activeSlot = 1),
            bvh = bvh,
            onPaint = { _, _ -> },
        )
        // No-op transform — feed mesh-mm coords directly.
        val noop = Matrix4.fromTrs(Vector3.Zero, Quaternion.Identity, Vector3.One)
        // Ray from (0, 0, 100mm) pointing -Z should hit the (now
        // centered) triangle.
        val tri = hooks.locateTriangleByRay(
            worldOrigin = Vector3(0f, 0f, 100f),
            worldDirection = Vector3(0f, 0f, -1f),
            transform = noop,
        )
        assertNotNull("centered triangle should be hit by axis-aligned ray; got tri=$tri", tri)
        assertEquals(0, tri)
    }
}
