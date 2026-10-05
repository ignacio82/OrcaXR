package dev.orcaxr.renderer

import dev.orcaxr.core.GcodePacket
import dev.orcaxr.core.GcodeViewPacket
import java.nio.ByteBuffer
import kotlin.math.*

data class ToolpathGeometry(val positions: ByteBuffer, val colors: ByteBuffer,
    val indices: ByteBuffer, val originalRecords: IntArray, val center: FloatArray, val halfExtent: FloatArray) {
    val segments get()=originalRecords.size
    val cpuBytes get()=positions.capacity().toLong()+colors.capacity()+indices.capacity()+originalRecords.size*4L
    companion object {
        /** Renderer-only projection. Uses Rust's selected records and colors;
         * never reclassifies extrusion roles or changes semantic arc identity. */
        fun from(model: GcodePacket, view: GcodeViewPacket, segmentBudget: Int=240_000): ToolpathGeometry {
            require(segmentBudget in 1..4_000_000 && view.kind==1)
            require(view.belongsTo(model)) { "Preview belongs to a different model capture" }
            require(view.metadata.getString("status")=="ready") { "Preview mode is unavailable" }
            require(view.metadata.getInt("sourceRecordCount")==model.recordCount)
            val selected=view.column("recordIndices").asIntBuffer()
            val colors=view.column("colorsRgba").asFloatBuffer()
            val kinds=model.column("columns","pathKind")
            val offsets=model.column("columns","pathPointOffset").asIntBuffer()
            val counts=model.column("columns","pathPointCount").asIntBuffer()
            val start=arrayOf("startX","startY","startZ").map {model.column("columns",it).asFloatBuffer()}
            val end=arrayOf("endX","endY","endZ").map {model.column("columns",it).asFloatBuffer()}
            val points=arrayOf("x","y","z").map {model.column("pathPoints",it).asFloatBuffer()}
            var prefix=0
            repeat(model.recordCount) { record ->
                val kind=kinds[record].toInt() and 255;require(kind == 0 || kind == 2 || kind == 3)
                require(offsets[record]==prefix && counts[record]>=0 && counts[record]<=model.pathPointCount-prefix)
                require(kind!=0 || counts[record]==0)
                prefix+=counts[record]
                repeat(3){axis-> require(start[axis][record].isFinite() && end[axis][record].isFinite())}
            }
            require(prefix==model.pathPointCount)
            repeat(model.pathPointCount){point->repeat(3){axis->require(points[axis][point].isFinite())}}
            var total=0L;var previous=-1
            repeat(view.recordCount) { index ->
                val record=selected[index];require(record in 0 until model.recordCount && record>previous);previous=record
                repeat(4){component->require(colors[index*4+component].isFinite() && colors[index*4+component] in 0f..1f)}
                total+=if(kinds[record].toInt()!=0) counts[record]+1L
                    else if((0..2).any {start[it][record]!=end[it][record]}) 1L else 0L
                require(total<=segmentBudget) { "Toolpath exceeds the renderer segment budget" }
            }
            val positions=MeshPacking.direct(total.toInt()*24);val packedColors=MeshPacking.direct(total.toInt()*32)
            val indices=MeshPacking.direct(total.toInt()*8);val ids=IntArray(total.toInt())
            val low=FloatArray(3){Float.POSITIVE_INFINITY};val high=FloatArray(3){Float.NEGATIVE_INFINITY}
            val recordOffset=(if (model.metadata.has("recordOffset")) model.metadata.getInt("recordOffset") else 0);require(recordOffset>=0 && recordOffset<=16_000_000-model.recordCount)
            var segment=0
            fun emit(a: Point3,b: Point3,record: Int,selection: Int) {
                for(p in arrayOf(RenderSpace.point(a),RenderSpace.point(b))) {
                    val coordinates=floatArrayOf(p.x.toFloat(),p.y.toFloat(),p.z.toFloat())
                    repeat(3){axis-> val v=coordinates[axis];positions.putFloat(v);low[axis]=min(low[axis],v);high[axis]=max(high[axis],v)}
                    repeat(4){packedColors.putFloat(colors[selection*4+it])}
                    indices.putInt(indices.position()/4)
                }
                ids[segment++]=recordOffset+record
            }
            repeat(view.recordCount) { selection ->
                val record=selected[selection]
                var prior=Point3(start[0][record].toDouble(),start[1][record].toDouble(),start[2][record].toDouble())
                val last=Point3(end[0][record].toDouble(),end[1][record].toDouble(),end[2][record].toDouble())
                if(kinds[record].toInt()!=0) {
                    repeat(counts[record]) { offset ->
                        val at=offsets[record]+offset
                        val next=Point3(points[0][at].toDouble(),points[1][at].toDouble(),points[2][at].toDouble())
                        emit(prior,next,record,selection);prior=next
                    }
                    // The reference includes the final arc edge, even if zero length.
                    emit(prior,last,record,selection)
                } else if(prior!=last) emit(prior,last,record,selection)
            }
            check(segment==ids.size);positions.flip();packedColors.flip();indices.flip()
            return ToolpathGeometry(positions,packedColors,indices,ids,
                FloatArray(3){if(total==0L) 0f else (low[it]+high[it])*.5f},
                FloatArray(3){if(total==0L) 1e-5f else max((high[it]-low[it])*.5f,1e-5f)})
        }
    }
}
