package dev.orcaxr.app

/**
 * Roadmap B6 — human-readable descriptions for libslic3r config keys
 * surfaced in the right-side print-settings panel. Pure-data layer
 * exposed so a unit test can assert that every key wired into the
 * Quality / Speed / Support tabs has a non-blank description (so a
 * future setting addition can't ship without a hover tooltip).
 *
 * Source of truth: OrcaSlicer's `PrintConfig.cpp` `tooltip()` strings
 * (translated, where applicable from the original BambuStudio prose).
 * Kept short — the laser-hover plate has ~3 lines of vertical room
 * before it eats the field below it.
 */
object SettingDescriptions {

    /** All descriptions, keyed by the libslic3r config key. */
    val byKey: Map<String, String> = mapOf(
        // Quality tab
        "layer_height" to
            "Print resolution along Z. 0.4-mm nozzle defaults: 0.12 fine, 0.20 standard, 0.28 draft.",

        // Speed tab
        "initial_layer_speed" to
            "First-layer print speed. Slower than the rest so the model adheres to the bed.",
        "outer_wall_speed" to
            "Speed for the outer-most perimeter — drives surface finish quality.",
        "inner_wall_speed" to
            "Speed for inner perimeters. Can run faster than outer walls without affecting the surface.",
        "sparse_infill_speed" to
            "Speed for low-density interior infill.",
        "internal_solid_infill_speed" to
            "Speed for fully-solid infill on top/bottom layers.",
        "support_speed" to
            "Speed for support material extrusion.",
        "travel_speed" to
            "Speed for non-printing moves between extrusions. Affects overall print time more than print quality.",

        // Support tab
        "support_threshold_angle" to
            "Maximum overhang angle (from vertical) that prints without support. Higher = fewer supports.",
        "support_top_z_distance" to
            "Vertical gap between the model's bottom and the support's top. Bigger = easier removal but worse surface.",
        "support_interface_top_layers" to
            "Solid layers between the support and the model's bottom face. More = smoother, harder to remove.",

        // Strength tab (read-only summary today; descriptions for the future)
        "sparse_infill_density" to
            "Percent of the model's interior filled with infill. 15% is typical; 100% is solid.",
        "wall_loops" to
            "Number of perimeter loops. More loops = stronger walls, longer print time.",
        "top_shell_layers" to
            "Number of solid top layers. Higher = better top surface, less translucent.",
        "bottom_shell_layers" to
            "Number of solid bottom layers. First-layer adhesion + base appearance.",

        // Filament / temperature
        "nozzle_temperature" to
            "Hot-end temperature during the print. Material-specific.",
        "bed_temperature" to
            "Heat-bed temperature during the print. Material- and surface-specific.",
        "filament_flow_ratio" to
            "Multiplier on the nominal extrusion volume — fine-tunes how much plastic comes out per move.",
    )

    /** Convenience lookup that returns null for unknown keys so the
     *  caller can hide the `?` chip when no description is available
     *  (avoids a misleading hover affordance). */
    fun forKey(key: String): String? = byKey[key]?.takeIf { it.isNotBlank() }
}
