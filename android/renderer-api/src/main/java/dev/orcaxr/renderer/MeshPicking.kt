package dev.orcaxr.renderer

import kotlin.math.*

data class FacetHit(val facet: Int, val distance: Double, val positionMm: Point3)

/** Median-split immutable BVH. Original facet IDs survive sorting. Build on a
 * cancellable background owner; picking performs no mesh or buffer mutation. */
class MeshPicking(private val mesh: TriangleMesh, cancelled: () -> Boolean = {false}) {
    private val order=IntArray(mesh.facetCount){it}
    private val capacity: Int
    private val bounds: FloatArray
    private val nodes: IntArray
    private var used=0
    val cpuBytes get() = (order.size.toLong()+bounds.size+nodes.size)*4
    init {
        var leaves=1
        while(leaves<(mesh.facetCount+31)/32) leaves*=2
        capacity=leaves*2-1;bounds=FloatArray(capacity*6);nodes=IntArray(capacity*4)
        fun coordinate(facet: Int, corner: Int, axis: Int)=mesh.xyz[mesh.indices[facet*3+corner]*3+axis]
        fun centroid(facet: Int, axis: Int)=coordinate(facet,0,axis)+coordinate(facet,1,axis)+coordinate(facet,2,axis)
        fun build(start: Int, end: Int): Int {
            check(!cancelled()) { "Cancelled picking index" }
            val node=used++;check(node<capacity)
            val b=node*6
            repeat(3){ bounds[b+it]=Float.POSITIVE_INFINITY;bounds[b+3+it]=Float.NEGATIVE_INFINITY }
            for(at in start until end) {
                if(at%4096==0) check(!cancelled()) { "Cancelled picking index" }
                val facet=order[at]
                repeat(3){corner -> repeat(3){axis ->
                    val value=coordinate(facet,corner,axis)
                    bounds[b+axis]=min(bounds[b+axis],value);bounds[b+3+axis]=max(bounds[b+3+axis],value)
                }}
            }
            if(end-start<=32) { nodes[node*4+2]=start;nodes[node*4+3]=end-start;return node }
            var axis=0
            if(bounds[b+4]-bounds[b+1]>bounds[b+3]-bounds[b]) axis=1
            if(bounds[b+5]-bounds[b+2]>bounds[b+3+axis]-bounds[b+axis]) axis=2
            val middle=(start+end)/2
            // In-place quickselect; only facet ordinals move, never geometry.
            var low=start;var high=end-1
            while(low<high) {
                check(!cancelled()) { "Cancelled picking index" }
                val pivot=centroid(order[(low+high)/2],axis);var i=low;var j=high
                while(i<=j) {
                    while(centroid(order[i],axis)<pivot) i++
                    while(centroid(order[j],axis)>pivot) j--
                    if(i<=j) {val saved=order[i];order[i]=order[j];order[j]=saved;i++;j--}
                }
                if(middle<=j) high=j else if(middle>=i) low=i else break
            }
            nodes[node*4]=build(start,middle);nodes[node*4+1]=build(middle,end)
            return node
        }
        build(0,mesh.facetCount)
    }
    fun pick(ray: PickRay, maxDistance: Double=Double.POSITIVE_INFINITY,
        accepts: (Int, Point3) -> Boolean = {_,_->true}): FacetHit? {
        require(maxDistance>0 && !maxDistance.isNaN())
        var closest=maxDistance;var hit=-1
        fun intersects(node: Int): Boolean {
            var near=0.0;var far=closest
            val b=node*6
            repeat(3) { axis ->
                val origin=when(axis){0->ray.origin.x;1->ray.origin.y;else->ray.origin.z}
                val direction=when(axis){0->ray.direction.x;1->ray.direction.y;else->ray.direction.z}
                if(direction==0.0) {
                    if(origin<bounds[b+axis] || origin>bounds[b+3+axis]) return false
                } else {
                    val a=(bounds[b+axis]-origin)/direction;val z=(bounds[b+3+axis]-origin)/direction
                    // Conservatively include shared box boundaries after subtraction/division.
                    var exit=max(a,z)
                    repeat(4) { exit=Math.nextUp(exit) }
                    near=max(near,min(a,z));far=min(far,exit);if(near>far) return false
                }
            }
            return true
        }
        // Project along the dominant ray axis. Shared edges then use the same
        // operands in reverse order, avoiding cracks from independent barycentric
        // divisions. See PBRT 4e, Triangle Meshes, intersection tests.
        val direction=doubleArrayOf(ray.direction.x,ray.direction.y,ray.direction.z)
        val origin=doubleArrayOf(ray.origin.x,ray.origin.y,ray.origin.z)
        var depth=0
        if(abs(direction[1])>abs(direction[depth])) depth=1
        if(abs(direction[2])>abs(direction[depth])) depth=2
        val horizontal=(depth+1)%3;val vertical=(horizontal+1)%3
        val shearX=direction[horizontal]/direction[depth]
        val shearY=direction[vertical]/direction[depth]
        fun relative(vertex: Int,axis: Int)=mesh.xyz[vertex+axis].toDouble()-origin[axis]
        fun triangle(facet: Int): Double {
            val a=mesh.indices[facet*3]*3
            val b=mesh.indices[facet*3+1]*3
            val c=mesh.indices[facet*3+2]*3
            val az=relative(a,depth);val bz=relative(b,depth);val cz=relative(c,depth)
            val ax=relative(a,horizontal)-shearX*az;val ay=relative(a,vertical)-shearY*az
            val bx=relative(b,horizontal)-shearX*bz;val by=relative(b,vertical)-shearY*bz
            val cx=relative(c,horizontal)-shearX*cz;val cy=relative(c,vertical)-shearY*cz
            val ea=bx*cy-by*cx;val eb=cx*ay-cy*ax;val ec=ax*by-ay*bx
            if((ea<0 || eb<0 || ec<0) && (ea>0 || eb>0 || ec>0)) return Double.POSITIVE_INFINITY
            val determinant=ea+eb+ec
            if(determinant==0.0) return Double.POSITIVE_INFINITY
            val distance=(ea*az+eb*bz+ec*cz)/(determinant*direction[depth])
            return if(distance>=0 && distance.isFinite()) distance else Double.POSITIVE_INFINITY
        }
        fun visit(node: Int) {
            if(!intersects(node)) return
            val count=nodes[node*4+3]
            if(count==0) {visit(nodes[node*4]);visit(nodes[node*4+1]);return}
            val start=nodes[node*4+2]
            for(at in start until start+count) {
                val facet=order[at];val distance=triangle(facet)
                if(distance<closest && accepts(facet,ray.origin+ray.direction*distance)) {closest=distance;hit=facet}
            }
        }
        visit(0)
        return if(hit<0) null else FacetHit(hit,closest,ray.origin+ray.direction*closest)
    }
}

data class OrbitCamera(val yaw: Double=.65, val pitch: Double=.8, val distance: Double=.42,
    val target: Point3=Point3(0.0,.03,0.0)) {
    init {require(yaw.isFinite() && pitch in .05..1.5 && distance in .03..5.0 && target.finite())}
    val eye get()=target+Point3(sin(yaw)*cos(pitch),sin(pitch),cos(yaw)*cos(pitch))*distance
    fun ray(x: Double,y: Double,width: Int,height: Int): PickRay {
        require(width>0 && height>0 && x.isFinite() && y.isFinite())
        val forward=(target-eye).normalized();val right=forward.cross(Point3(0.0,1.0,0.0)).normalized()
        val up=right.cross(forward)
        val extent=tan(Math.toRadians(45.0)/2)
        return PickRay(eye,(forward+right*((2*x/width-1)*extent*width/height)+up*((1-2*y/height)*extent)).normalized())
    }
}
