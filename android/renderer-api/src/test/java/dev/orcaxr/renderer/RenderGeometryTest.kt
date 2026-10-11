package dev.orcaxr.renderer

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.abs

class RenderGeometryTest {
    private fun near(a: Point3,b: Point3) {
        assertEquals(a.x,b.x,1e-8);assertEquals(a.y,b.y,1e-8);assertEquals(a.z,b.z,1e-8)
    }
    @Test fun basisPreservesUnitsWindingNormalsAndInverse() {
        near(Point3(.01,.03,-.02),RenderSpace.point(Point3(10.0,20.0,30.0)))
        val a=Point3(1.0,0.0,0.0);val b=Point3(0.0,1.0,0.0)
        near(RenderSpace.normal(a.cross(b)),RenderSpace.normal(a).cross(RenderSpace.normal(b)))
        val transform=ModelTransform.of(doubleArrayOf(0.0,-2.0,0.0,0.0,-3.0,0.0,0.0,0.0,
            0.0,0.0,.5,0.0,100.0,50.0,20.0,1.0))
        val p=Point3(5.0,6.0,7.0)
        near(p,transform.inverse().point(transform.point(p)))
        val normal=Point3(1.0,1.0,1.0).normalized();val tangent=Point3(1.0,-1.0,0.0)
        assertEquals(0.0,transform.normal(normal).dot(transform.vector(tangent)),1e-8)
        val matrix=transform.renderMatrix();val converted=RenderSpace.point(p)
        val actual=Point3(matrix[0]*converted.x+matrix[4]*converted.y+matrix[8]*converted.z+matrix[12],
            matrix[1]*converted.x+matrix[5]*converted.y+matrix[9]*converted.z+matrix[13],
            matrix[2]*converted.x+matrix[6]*converted.y+matrix[10]*converted.z+matrix[14])
        near(RenderSpace.point(transform.point(p)),actual)
        assertThrows(IllegalArgumentException::class.java) { ModelTransform.scaledTranslated(x=0.0) }
    }
    @Test fun packedChunksPreserveFacetIdentityAndDoNotMutateSource() {
        val positions=floatArrayOf(0f,0f,0f,100f,0f,0f,0f,100f,0f)
        val mesh=TriangleMesh.copyOf("fixture",positions,intArrayOf(0,1,2),intArrayOf(0xff123456.toInt()))
        positions.fill(999f)
        val chunk=MeshPacking.chunk(mesh,0)
        assertEquals(1,chunk.facetCount);assertEquals(60L,chunk.bytes)
        near(Point3(0.0,0.0,0.0),mesh.vertex(0,0))
        assertEquals(.1f,chunk.positions.getFloat(12),1e-8f)
        assertEquals(-.1f,chunk.positions.getFloat(32),1e-8f)
        assertEquals(listOf(0x12,0x34,0x56,0xff), (0..3).map {chunk.colors[it].toInt() and 255})
    }
    @Test fun picksOriginalFacetsThroughMirrorsNonuniformScaleAndClip() {
        val mesh=TriangleMesh.copyOf("two-depths",floatArrayOf(0f,0f,0f,100f,0f,0f,0f,100f,0f,
            0f,0f,10f,100f,0f,10f,0f,100f,10f),intArrayOf(0,1,2,3,4,5),intArrayOf(-1,-1))
        val index=MeshPicking(mesh)
        val transform=ModelTransform.scaledTranslated(-2.0,3.0,.5,50.0,20.0,10.0)
        val origin=transform.point(Point3(10.0,10.0,100.0))
        val direction=transform.vector(Point3(0.0,0.0,-1000.0))
        val ray=transform.localRay(PickRay(origin,direction))
        assertEquals(1,index.pick(ray)!!.facet)
        assertEquals(0,index.pick(ray,accepts={_, p ->p.z<5})!!.facet)
        assertEquals(.09,index.pick(ray)!!.distance,1e-8)
        assertNull(index.pick(PickRay(Point3(200.0,200.0,100.0),Point3(0.0,0.0,-1.0))))
    }
    @Test fun bvhMatchesIndependentExhaustiveFixtureRaysAndCancels() {
        val mesh=TriangleMesh.grid(64);val index=MeshPicking(mesh)
        // Vertical rays hit exactly the analytic grid cell; verify the original
        // two facet IDs without using the BVH's triangle intersection code.
        for(y in 0 until 64 step 3) for(x in 0 until 64 step 3) {
            for((u,v,half) in listOf(Triple(.2,.3,0),Triple(.8,.7,1))) {
                val ray=PickRay(Point3((x+u)*200/64-100,(y+v)*200/64-100,100.0),Point3(0.0,0.0,-1000.0))
                assertEquals((y*64+x)*2+half,index.pick(ray)!!.facet)
            }
        }
        assertThrows(IllegalStateException::class.java) { MeshPicking(mesh){true} }
        assertThrows(IllegalStateException::class.java) { TriangleMesh.grid(1000){true} }
    }
    @Test fun projectingAPointAlongAPickRayGivesBackItsPixel() {
        for (camera in listOf(OrbitCamera(), OrbitCamera(yaw=-2.4,pitch=.3,distance=1.2,target=Point3(.1,0.0,-.05)))) {
            for ((x, y) in listOf(400.0 to 300.0, 12.5 to 590.0, 799.0 to 1.0)) {
                val ray = camera.ray(x, y, 800, 600)
                val (px, py) = camera.project(ray.origin + ray.direction * .37, 800, 600)!!
                assertEquals(x, px, 1e-6); assertEquals(y, py, 1e-6)
            }
            // Behind the camera nothing shows.
            assertNull(camera.project(camera.eye + (camera.eye - camera.target), 800, 600))
        }
    }
    @Test fun cameraCenterRayHitsItsTargetAndCornerRaysDiverge() {
        val camera=OrbitCamera();val center=camera.ray(400.0,300.0,800,600)
        near(camera.target,center.origin+center.direction*camera.distance)
        assertTrue(abs(center.direction.dot(camera.ray(0.0,0.0,800,600).direction))<.99)
    }
    @Test fun obliqueRayDoesNotFallThroughASharedVertex() {
        val index = MeshPicking(TriangleMesh.grid(128))
        for (yaw in -30..30) for (pitch in 1..14) {
            val camera = OrbitCamera(yaw=yaw*.1,pitch=pitch*.1)
            val ray = RenderSpace.rayToMillimetres(camera.ray(360.0, 250.0, 720, 500))
            val hit = index.pick(ray)
            assertNotNull("Exact center targets a shared vertex: $yaw/$pitch", hit)
            // Shallow rays may hit another part of the wavy surface first.
            assertTrue(hit!!.distance<=camera.distance+1e-8)
            if (abs(hit.distance-camera.distance)<1e-8) near(Point3(0.0, 0.0, 30.0), hit.positionMm)
        }
    }
}
