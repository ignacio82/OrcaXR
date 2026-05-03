package dev.orcaxr.app

import android.content.Context
import java.io.File

/**
 * D13 — bundled "Add handy model" registry. Mirrors upstream
 * OrcaSlicer's resources/handy_models/ folder so well-known
 * calibration prints are one tap (or one MCP call) away.
 *
 * The asset files ship in `app/src/main/assets/handy_models/` and are
 * staged into `cacheDir/handy/` on first use — libslic3r's loaders
 * (`load_drc`, `load_3mf`) require a real on-disk path. Staging is
 * idempotent so repeat calls return the same file.
 *
 * AGPL attribution for the vendored meshes lives in `NOTICE.md`.
 */
data class HandyModel(
    /** Stable identifier the MCP tool / UI passes around. */
    val id: String,
    /** Human-readable label shown in the picker. */
    val displayName: String,
    /** Short "what does this print test" hint. */
    val hint: String,
    /** Path inside `app/src/main/assets/`. */
    val assetPath: String,
) {
    /** Filename component (with extension) used when staging to cacheDir. */
    val fileName: String get() = assetPath.substringAfterLast('/')
}

object HandyModelCatalog {

    /**
     * Order matters: the picker shows entries in the order below.
     * Benchy goes first — it's the default "is my printer working at
     * all" reference. The Orca calibration models follow because
     * they're the most actionable: one print per visible defect class.
     */
    val ENTRIES: List<HandyModel> = listOf(
        HandyModel(
            id = "benchy",
            displayName = "3DBenchy",
            hint = "The canonical jolly torture test boat — overhangs, bridges, fine details.",
            assetPath = "handy_models/3DBenchy.drc",
        ),
        HandyModel(
            id = "orca_cube",
            displayName = "Orca Cube v2",
            hint = "20 mm calibration cube with embedded XYZ markers.",
            assetPath = "handy_models/OrcaCube_v2.3mf",
        ),
        HandyModel(
            id = "voron_cube",
            displayName = "Voron Design Cube v7",
            hint = "Voron's standard XYZ cube — quick dimensional accuracy check.",
            assetPath = "handy_models/Voron_Design_Cube_v7.drc",
        ),
        HandyModel(
            id = "orca_tolerance",
            displayName = "Orca Tolerance Test",
            hint = "Step-pin tolerance gauge for clearance / fit calibration.",
            assetPath = "handy_models/OrcaToleranceTest.drc",
        ),
        HandyModel(
            id = "orca_string_hell",
            displayName = "Orca String Hell",
            hint = "Stringing / retraction torture test — many travel moves between towers.",
            assetPath = "handy_models/Orca_stringhell.drc",
        ),
        HandyModel(
            id = "fdm_test",
            displayName = "Autodesk FDM Test (Kickstarter)",
            hint = "Comprehensive printer benchmark covering many failure modes at once.",
            assetPath = "handy_models/ksr_fdmtest_v4.drc",
        ),
        HandyModel(
            id = "stanford_bunny",
            displayName = "Stanford Bunny",
            hint = "Classic CG reference mesh — organic surfaces, gentle overhangs.",
            assetPath = "handy_models/Stanford_Bunny.drc",
        ),
        HandyModel(
            id = "cali_cat",
            displayName = "Cali Cat",
            hint = "Cute speed-printing reference cat.",
            assetPath = "handy_models/calicat.drc",
        ),
    )

    /** Resolve a handy model by [id] (case-insensitive), or null if unknown. */
    fun byId(id: String): HandyModel? = ENTRIES.firstOrNull { it.id.equals(id, ignoreCase = true) }

    /**
     * Stage [model] from `assets/` into `cacheDir/handy/<filename>`.
     * Idempotent — subsequent calls return the already-staged file.
     */
    fun stage(ctx: Context, model: HandyModel): File {
        val dir = File(ctx.cacheDir, "handy").apply { mkdirs() }
        val dst = File(dir, model.fileName)
        if (dst.exists() && dst.length() > 0L) return dst
        ctx.assets.open(model.assetPath).use { input ->
            dst.outputStream().use { output -> input.copyTo(output) }
        }
        return dst
    }
}
