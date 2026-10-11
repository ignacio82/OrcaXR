package dev.orcaxr.nativeapp.workspace

import dev.orcaxr.renderer.filament.FilamentScene

/**
 * What a Workspace tool's pick met, as the browser's workspace judges it
 * (`previewsVolume`, `refusePreviewedPick`): nothing, a part a simplify
 * preview draws in its place — refused, since the preview's facets, normals
 * and surface are not the project's, so painting, measuring or laying flat
 * there would read another mesh — or a part of the project. The nearest part
 * is the one judged: a previewed part hides what lies behind it.
 */
internal sealed interface ToolPick {
    data object Missed : ToolPick
    data object Previewed : ToolPick
    data class Part(val pick: FilamentScene.Pick) : ToolPick

    companion object {
        /** What [pick] met while the volumes [previewed] show a simplify preview. */
        fun of(pick: FilamentScene.Pick?, previewed: Set<String>): ToolPick = when {
            pick == null -> Missed
            pick.volumeId in previewed -> Previewed
            else -> Part(pick)
        }
    }
}
