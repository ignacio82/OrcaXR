package dev.orcaxr.app.mobile

import dev.orcaxr.app.HeightRange
import dev.orcaxr.app.mcp.WorkspaceAction

/**
 * Pure (no Compose, no Android) per-model state the mobile workspace
 * binding maintains in response to MCP `WorkspaceAction`s — the spine
 * of the MobileWorkspaceBinding re-architecture.
 *
 * Before this, the binding only kept the four paint arrays
 * ([MobilePaintState]) and dropped every other mutator on the floor
 * (the `else ->` branch), so `add_height_range`, `set_object_overrides`,
 * `set_layer_height_profile`, `set_volume_overrides` succeeded at the
 * tool layer but never took effect on phone. This holder carries the
 * same per-`PlacedModel` fields the XR side stores
 * (`PlacedModel.heightRanges` / `configOverrides` / `volumeOverrides`
 * via volumes / `layerHeightProfile`) so those actions round-trip and
 * can be threaded into the phone slice.
 *
 * Scope of THIS increment: the plain, capability-free, pure-data
 * mutators only. Shell-level mutators (drop-to-bed, switch-profile,
 * delete-models), the Tier-B-gated ops (compute-adaptive,
 * custom-gcode), the geometry ops (cut/simplify/boolean/emboss/
 * magnets — they need a JNI run + source-file replace), and the
 * slice-path consumption are subsequent increments built on this.
 *
 * Not thread-safe; the binding's collector consumes actions on a
 * single coroutine so mutations arrive serialized.
 */
data class MobileModelState(
    val paint: MobilePaintState = MobilePaintState(),
    val heightRanges: List<HeightRange> = emptyList(),
    val configOverrides: Map<String, String> = emptyMap(),
    /** volumeId → its replacement override map. */
    val volumeOverrides: Map<String, Map<String, String>> = emptyMap(),
    val layerHeightProfile: FloatArray? = null,
) {

    fun applySetHeightRanges(a: WorkspaceAction.SetHeightRanges): MobileModelState =
        copy(heightRanges = a.ranges)

    fun applySetObjectOverrides(a: WorkspaceAction.SetObjectOverrides): MobileModelState =
        copy(configOverrides = a.overrides)

    fun applySetVolumeOverrides(a: WorkspaceAction.SetVolumeOverrides): MobileModelState =
        copy(volumeOverrides = volumeOverrides + (a.volumeId to a.overrides))

    /**
     * Mirrors MainActivity's `SetLayerHeightProfile` validation so the
     * phone produces the same result for the same call: null / empty
     * clears; otherwise the profile must be an even count ≥ 4 with
     * strictly increasing Z (even indices), else it's rejected as
     * malformed (cleared) rather than corrupting the slice.
     */
    fun applySetLayerHeightProfile(a: WorkspaceAction.SetLayerHeightProfile): MobileModelState {
        val p = a.profile
        if (p == null || p.isEmpty()) return copy(layerHeightProfile = null)
        if (p.size < 4 || p.size % 2 != 0) return copy(layerHeightProfile = null)
        var i = 0
        var lastZ = Float.NEGATIVE_INFINITY
        while (i < p.size) {
            if (p[i] <= lastZ) return copy(layerHeightProfile = null)
            lastZ = p[i]
            i += 2
        }
        return copy(layerHeightProfile = p.copyOf())
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is MobileModelState) return false
        return paint == other.paint &&
            heightRanges == other.heightRanges &&
            configOverrides == other.configOverrides &&
            volumeOverrides == other.volumeOverrides &&
            (layerHeightProfile?.contentEquals(other.layerHeightProfile)
                ?: (other.layerHeightProfile == null))
    }

    override fun hashCode(): Int {
        var h = paint.hashCode()
        h = 31 * h + heightRanges.hashCode()
        h = 31 * h + configOverrides.hashCode()
        h = 31 * h + volumeOverrides.hashCode()
        h = 31 * h + (layerHeightProfile?.contentHashCode() ?: 0)
        return h
    }
}
