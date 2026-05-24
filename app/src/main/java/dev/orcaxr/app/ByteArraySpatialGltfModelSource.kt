package dev.orcaxr.app

import androidx.xr.compose.subspace.SpatialGltfModelSource
import androidx.xr.runtime.Session
import androidx.xr.scenecore.GltfModel

/**
 * Raw-byte source for generated GLBs used with Compose XR's [SpatialGltfModelSource].
 *
 * The built-in fromPath source routes through SceneCore's Path loader, which is
 * asset-oriented and does not cover OrcaXR's cache-generated absolute paths.
 */
internal class ByteArraySpatialGltfModelSource(
    private val bytes: ByteArray,
    private val modelName: String,
) : SpatialGltfModelSource {
    private val signature = (bytes.size.toLong() shl 32) or
        (bytes.contentHashCode().toLong() and 0xffffffffL)

    override suspend fun createModel(session: Session): GltfModel =
        GltfModel.create(session, bytes, modelName)

    override fun equals(other: Any?): Boolean =
        other is ByteArraySpatialGltfModelSource &&
            modelName == other.modelName &&
            signature == other.signature

    override fun hashCode(): Int =
        31 * modelName.hashCode() + signature.hashCode()

    override fun toString(): String =
        "ByteArraySpatialGltfModelSource(name=$modelName, signature=$signature)"
}
