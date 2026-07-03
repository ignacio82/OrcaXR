package dev.orcaxr.app.mobile

import dev.orcaxr.app.NumericValidation
import kotlin.math.abs
import kotlin.math.roundToInt

internal enum class MobileSupportMode(val label: String) {
    Inherit("Inherit"),
    Generate("Generate"),
    Disable("Disable"),
}

internal enum class MobileSupportStyle(val value: String, val label: String) {
    NormalAuto("normal(auto)", "Normal auto"),
    TreeAuto("tree(auto)", "Tree auto"),
    NormalManual("normal(manual)", "Normal manual"),
    TreeManual("tree(manual)", "Tree manual"),
}

internal data class MobilePrintOverrideDraft(
    val infillDensity: String = "",
    val wallLoops: String = "",
    val supportMode: MobileSupportMode = MobileSupportMode.Inherit,
    val supportStyle: MobileSupportStyle = MobileSupportStyle.NormalAuto,
    val supportThresholdAngle: String = "",
    val supportTopZDistance: String = "",
    val supportBottomZDistance: String = "",
    val supportXyDistance: String = "",
    val supportInterfaceTopLayers: String = "",
    val supportInterfaceBottomLayers: String = "",
    val supportSpeed: String = "",
    val supportInterfaceSpeed: String = "",
) {
    companion object {
        fun from(overrides: Map<String, String>): MobilePrintOverrideDraft =
            MobilePrintOverrideDraft(
                infillDensity = overrides["sparse_infill_density"]?.removeSuffix("%") ?: "",
                wallLoops = overrides["wall_loops"] ?: "",
                supportMode = when (overrides["enable_support"]?.trim()?.lowercase()) {
                    "1", "true" -> MobileSupportMode.Generate
                    "0", "false" -> MobileSupportMode.Disable
                    else -> MobileSupportMode.Inherit
                },
                supportStyle = MobilePrintOverrideMapper.supportStyleOf(
                    overrides["support_type"],
                ),
                supportThresholdAngle = overrides["support_threshold_angle"] ?: "",
                supportTopZDistance = overrides["support_top_z_distance"] ?: "",
                supportBottomZDistance = overrides["support_bottom_z_distance"] ?: "",
                supportXyDistance = overrides["support_object_xy_distance"] ?: "",
                supportInterfaceTopLayers = overrides["support_interface_top_layers"] ?: "",
                supportInterfaceBottomLayers = overrides["support_interface_bottom_layers"] ?: "",
                supportSpeed = overrides["support_speed"] ?: "",
                supportInterfaceSpeed = overrides["support_interface_speed"] ?: "",
            )
    }
}

internal object MobilePrintOverrideMapper {
    private val supportDetailKeys = setOf(
        "support_type",
        "support_threshold_angle",
        "support_top_z_distance",
        "support_bottom_z_distance",
        "support_object_xy_distance",
        "support_interface_top_layers",
        "support_interface_bottom_layers",
        "support_interface_spacing",
        "support_speed",
        "support_interface_speed",
    )

    private val integerKeys = setOf(
        "wall_loops",
        "support_threshold_angle",
        "support_interface_top_layers",
        "support_interface_bottom_layers",
    )

    fun supportStyleOf(raw: String?): MobileSupportStyle =
        MobileSupportStyle.values().firstOrNull { it.value == raw }
            ?: MobileSupportStyle.NormalAuto

    fun apply(
        existing: Map<String, String>,
        draft: MobilePrintOverrideDraft,
    ): Map<String, String> {
        val out = existing.toMutableMap()
        applyNumeric(out, "sparse_infill_density", draft.infillDensity, suffix = "%")
        applyNumeric(out, "wall_loops", draft.wallLoops)

        when (draft.supportMode) {
            MobileSupportMode.Inherit -> {
                out.remove("enable_support")
                supportDetailKeys.forEach(out::remove)
            }
            MobileSupportMode.Disable -> {
                out["enable_support"] = "0"
                supportDetailKeys.forEach(out::remove)
            }
            MobileSupportMode.Generate -> {
                out["enable_support"] = "1"
                out["support_type"] = draft.supportStyle.value
                applyNumeric(out, "support_threshold_angle", draft.supportThresholdAngle)
                applyNumeric(out, "support_top_z_distance", draft.supportTopZDistance)
                applyNumeric(out, "support_bottom_z_distance", draft.supportBottomZDistance)
                applyNumeric(out, "support_object_xy_distance", draft.supportXyDistance)
                applyNumeric(out, "support_interface_top_layers", draft.supportInterfaceTopLayers)
                applyNumeric(out, "support_interface_bottom_layers", draft.supportInterfaceBottomLayers)
                applyNumeric(out, "support_speed", draft.supportSpeed)
                applyNumeric(out, "support_interface_speed", draft.supportInterfaceSpeed)
            }
        }
        return out
    }

    fun isNumericTextValidOrBlank(key: String, text: String): Boolean {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return true
        val parsed = parse(trimmed) ?: return false
        if (key in integerKeys && abs(parsed - parsed.roundToInt()) > 0.0001f) return false
        val range = NumericValidation.printSettingRanges[key]
        return range == null || parsed in range
    }

    private fun applyNumeric(
        out: MutableMap<String, String>,
        key: String,
        text: String,
        suffix: String = "",
    ) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) {
            out.remove(key)
            return
        }
        val parsed = parse(trimmed) ?: return
        if (key in integerKeys && abs(parsed - parsed.roundToInt()) > 0.0001f) return
        val range = NumericValidation.printSettingRanges[key]
        if (range != null && parsed !in range) return
        out[key] = format(parsed, key) + suffix
    }

    private fun parse(text: String): Float? =
        text.removeSuffix("%").replace(',', '.').toFloatOrNull()
            ?.takeIf { it.isFinite() }

    private fun format(value: Float, key: String): String =
        if (key in integerKeys || abs(value - value.roundToInt()) < 0.0001f) {
            value.roundToInt().toString()
        } else {
            "%.4f".format(java.util.Locale.US, value)
                .trimEnd('0')
                .trimEnd('.')
        }
}
