package dev.orcaxr.renderer

import dev.orcaxr.core.ProjectIntents
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.*

data class Point3(val x: Double, val y: Double, val z: Double) {
    operator fun plus(p: Point3) = Point3(x + p.x, y + p.y, z + p.z)
    operator fun minus(p: Point3) = Point3(x - p.x, y - p.y, z - p.z)
    operator fun times(s: Double) = Point3(x * s, y * s, z * s)
    fun dot(p: Point3) = x * p.x + y * p.y + z * p.z
    fun cross(p: Point3) = Point3(y * p.z - z * p.y, z * p.x - x * p.z, x * p.y - y * p.x)
    fun normalized(): Point3 { val n = sqrt(dot(this)); require(n > 1e-12 && n.isFinite()); return this * (1 / n) }
    fun finite() = x.isFinite() && y.isFinite() && z.isFinite()
}
data class PickRay(val origin: Point3, val direction: Point3) {
    init { require(origin.finite() && direction.finite() && direction.dot(direction) > 1e-20) }
}

/** Single right-handed basis conversion: millimetres Z-up to metres Y-up.
 * Determinant is positive; this conversion never reverses triangle winding. */
object RenderSpace {
    fun point(mm: Point3) = Point3(mm.x * .001, mm.z * .001, -mm.y * .001)
    fun millimetres(m: Point3) = Point3(m.x * 1000, -m.z * 1000, m.y * 1000)
    fun rayToMillimetres(ray: PickRay) = PickRay(millimetres(ray.origin), millimetres(ray.direction))
    fun normal(normal: Point3) = Point3(normal.x, normal.z, -normal.y).normalized()
}

/** Column-major affine model transform. No mutable matrix escapes. */
class ModelTransform private constructor(private val m: DoubleArray) {
    fun point(p: Point3) = vector(p) + Point3(m[12], m[13], m[14])
    fun vector(p: Point3) = Point3(m[0]*p.x+m[4]*p.y+m[8]*p.z,
        m[1]*p.x+m[5]*p.y+m[9]*p.z, m[2]*p.x+m[6]*p.y+m[10]*p.z)
    fun inverse(): ModelTransform {
        val a=m[0]; val b=m[4]; val c=m[8]; val d=m[1]; val e=m[5]; val f=m[9]
        val g=m[2]; val h=m[6]; val i=m[10]
        val determinant=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g)
        require(abs(determinant)>1e-12 && determinant.isFinite()) { "Singular model transform" }
        val result=doubleArrayOf(e*i-f*h, f*g-d*i, d*h-e*g, 0.0,
            c*h-b*i, a*i-c*g, b*g-a*h, 0.0, b*f-c*e, c*d-a*f, a*e-b*d, 0.0,
            0.0, 0.0, 0.0, determinant)
        for (n in result.indices) result[n] /= determinant
        val inverse=ModelTransform(result)
        val translation=inverse.vector(Point3(-m[12],-m[13],-m[14]))
        result[12]=translation.x; result[13]=translation.y; result[14]=translation.z
        return inverse
    }
    fun normal(n: Point3): Point3 {
        val inv=inverse().m
        return Point3(inv[0]*n.x+inv[1]*n.y+inv[2]*n.z,
            inv[4]*n.x+inv[5]*n.y+inv[6]*n.z, inv[8]*n.x+inv[9]*n.y+inv[10]*n.z).normalized()
    }
    fun localRay(worldMm: PickRay) = inverse().let { PickRay(it.point(worldMm.origin),it.vector(worldMm.direction)) }
    /** This transform after [other]: `(a * b).point(p) == a.point(b.point(p))`. */
    operator fun times(other: ModelTransform): ModelTransform {
        val b=other.m; val result=DoubleArray(16)
        for (column in 0..3) for (row in 0..3) {
            var sum=0.0
            for (k in 0..3) sum+=m[k*4+row]*b[column*4+k]
            result[column*4+row]=sum
        }
        return of(result)
    }
    fun renderMatrix(): FloatArray {
        // B M B^-1, including the one mm -> metre translation conversion.
        val columns = listOf(Point3(1.0,0.0,0.0),Point3(0.0,0.0,1.0),Point3(0.0,-1.0,0.0))
        val output=FloatArray(16)
        columns.forEachIndexed { index, axis ->
            val v=vector(axis); output[index*4]=v.x.toFloat(); output[index*4+1]=v.z.toFloat(); output[index*4+2]=-v.y.toFloat()
        }
        val t=RenderSpace.point(Point3(m[12],m[13],m[14]))
        output[12]=t.x.toFloat();output[13]=t.y.toFloat();output[14]=t.z.toFloat();output[15]=1f
        return output
    }
    companion object {
        fun of(values: DoubleArray): ModelTransform {
            require(values.size==16 && values.all { it.isFinite() && abs(it)<=1e9 })
            require(values[3]==0.0 && values[7]==0.0 && values[11]==0.0 && values[15]==1.0)
            return ModelTransform(values.copyOf()).also { it.inverse() }
        }
        /**
         * The project's canonical transform in millimetres, `T * R * S`, as the
         * browser applies it (`applyCanonicalTransform`: position, the unit
         * quaternion `[x, y, z, w]` normalized — a zero one is the identity, as
         * three.js normalizes it — then scale).
         */
        fun fromCanonical(t: ProjectIntents.Transform): ModelTransform {
            require(t.translationMm.size==3 && t.rotation.size==4 && t.scale.size==3) { "Invalid canonical transform" }
            var (x,y,z,w)=t.rotation
            val length=sqrt(x*x+y*y+z*z+w*w)
            require(length.isFinite()) { "Invalid canonical rotation" }
            if (length==0.0) { x=0.0; y=0.0; z=0.0; w=1.0 } else { x/=length; y/=length; z/=length; w/=length }
            val (sx,sy,sz)=t.scale; val (tx,ty,tz)=t.translationMm
            return of(doubleArrayOf(
                (1-2*(y*y+z*z))*sx, 2*(x*y+z*w)*sx, 2*(x*z-y*w)*sx, 0.0,
                2*(x*y-z*w)*sy, (1-2*(x*x+z*z))*sy, 2*(y*z+x*w)*sy, 0.0,
                2*(x*z+y*w)*sz, 2*(y*z-x*w)*sz, (1-2*(x*x+y*y))*sz, 0.0,
                tx, ty, tz, 1.0))
        }
        fun scaledTranslated(x: Double=1.0,y: Double=1.0,z: Double=1.0,tx: Double=0.0,ty: Double=0.0,tz: Double=0.0) =
            of(doubleArrayOf(x,0.0,0.0,0.0,0.0,y,0.0,0.0,0.0,0.0,z,0.0,tx,ty,tz,1.0))
    }
}

/** Immutable geometry, with facet IDs equal to input index triples. Color is a
 * display projection and never a topology ID or an authored project mutation. */
class TriangleMesh private constructor(val topologyId: String, internal val xyz: FloatArray,
    internal val indices: IntArray, internal val colors: IntArray) {
    val facetCount get() = indices.size / 3
    val cpuBytes get() = (xyz.size.toLong()+indices.size+colors.size)*4
    fun point(vertex: Int) = Point3(xyz[vertex*3].toDouble(),xyz[vertex*3+1].toDouble(),xyz[vertex*3+2].toDouble())
    fun vertex(facet: Int, corner: Int) = point(indices[facet*3+corner])
    companion object {
        const val MAX_FACETS = 2_100_000
        fun copyOf(id: String, xyz: FloatArray, indices: IntArray, colors: IntArray): TriangleMesh {
            validate(id,xyz,indices,colors); return TriangleMesh(id,xyz.copyOf(),indices.copyOf(),colors.copyOf())
        }
        /** Takes arrays this module built and never shares, without a second copy. */
        internal fun owning(id: String, xyz: FloatArray, indices: IntArray, colors: IntArray): TriangleMesh {
            validate(id,xyz,indices,colors); return TriangleMesh(id,xyz,indices,colors)
        }
        private fun validate(id: String, xyz: FloatArray, indices: IntArray, colors: IntArray) {
            require(id.isNotBlank() && id.length<=128 && xyz.size%3==0 && xyz.size in 9..(MAX_FACETS*9))
            require(indices.size%3==0 && indices.size/3 in 1..MAX_FACETS && colors.size==indices.size/3)
            require(xyz.all { it.isFinite() && abs(it)<=10_000_000f })
            require(indices.all { it>=0 && it<xyz.size/3 })
        }
        fun grid(cells: Int, cancelled: () -> Boolean = {false}): TriangleMesh {
            require(cells in 1..1000)
            val side=cells+1; val xyz=FloatArray(side*side*3)
            for(y in 0..cells) {
                check(!cancelled()) { "Cancelled mesh generation" }
                for(x in 0..cells) {
                    val px=x*200f/cells-100f;val py=y*200f/cells-100f;val at=(y*side+x)*3
                    xyz[at]=px;xyz[at+1]=py;xyz[at+2]=(30+12*sin(px*.045)*cos(py*.052)).toFloat()
                }
            }
            val indices=IntArray(cells*cells*6); val colors=IntArray(cells*cells*2)
            for(y in 0 until cells) {
                check(!cancelled()) { "Cancelled mesh generation" }
                for(x in 0 until cells) {
                    val p=y*side+x;val f=(y*cells+x)*2;val at=f*3
                    indices[at]=p;indices[at+1]=p+1;indices[at+2]=p+side
                    indices[at+3]=p+1;indices[at+4]=p+side+1;indices[at+5]=p+side
                    colors[f]=if((x/8+y/8)%2==0) 0xff45bfa3.toInt() else 0xffeebd56.toInt()
                    colors[f+1]=if((x/8+y/8)%2==0) 0xff23846d.toInt() else 0xffab792e.toInt()
                }
            }
            return TriangleMesh("grid-$cells-v1",xyz,indices,colors)
        }
    }
}

data class MeshChunk(val firstFacet: Int, val facetCount: Int, val positions: ByteBuffer,
    val colors: ByteBuffer, val indices: ByteBuffer, val center: FloatArray, val halfExtent: FloatArray) {
    val bytes get() = positions.capacity().toLong()+colors.capacity()+indices.capacity()
}
object MeshPacking {
    const val FACETS_PER_CHUNK = 16_384
    fun direct(bytes: Int): ByteBuffer = ByteBuffer.allocateDirect(bytes).order(ByteOrder.nativeOrder())
    fun rgba(buffer: ByteBuffer, argb: Int) {
        buffer.put((argb ushr 16).toByte()).put((argb ushr 8).toByte()).put(argb.toByte()).put((argb ushr 24).toByte())
    }
    fun chunk(mesh: TriangleMesh, firstFacet: Int): MeshChunk {
        require(firstFacet in 0 until mesh.facetCount)
        val count=min(FACETS_PER_CHUNK,mesh.facetCount-firstFacet);val vertices=count*3
        val positions=direct(vertices*12);val colors=direct(vertices*4);val indices=direct(vertices*4)
        val low=FloatArray(3){Float.POSITIVE_INFINITY};val high=FloatArray(3){Float.NEGATIVE_INFINITY}
        repeat(vertices) { n ->
            // Same Double basis conversion as RenderSpace, without allocating
            // two Point3 objects for each of the six million expanded vertices.
            val at=mesh.indices[firstFacet*3+n]*3
            val x=(mesh.xyz[at].toDouble()*.001).toFloat()
            val y=(mesh.xyz[at+2].toDouble()*.001).toFloat()
            val z=(-mesh.xyz[at+1].toDouble()*.001).toFloat()
            positions.putFloat(x).putFloat(y).putFloat(z)
            low[0]=min(low[0],x);low[1]=min(low[1],y);low[2]=min(low[2],z)
            high[0]=max(high[0],x);high[1]=max(high[1],y);high[2]=max(high[2],z)
            rgba(colors,mesh.colors[firstFacet+n/3]);indices.putInt(n)
        }
        positions.flip();colors.flip();indices.flip()
        return MeshChunk(firstFacet,count,positions,colors,indices,
            FloatArray(3){(low[it]+high[it])*.5f},FloatArray(3){max((high[it]-low[it])*.5f,1e-5f)})
    }
}
