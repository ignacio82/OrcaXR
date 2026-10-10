package dev.orcaxr.nativeapp.shell

/** The shell's areas, in the bar's order: the Workspace (the home), then the plan's Prepare, Preview, Device and Project. */
enum class ShellArea { Workspace, Prepare, Preview, Device, Project }

/** Material's window width classes: compact below 600 dp, medium below 840 dp, expanded from there. */
enum class WidthClass {
    Compact, Medium, Expanded;

    companion object {
        fun of(widthDp: Int): WidthClass = when {
            widthDp < MEDIUM_DP -> Compact
            widthDp < EXPANDED_DP -> Medium
            else -> Expanded
        }

        const val MEDIUM_DP = 600
        const val EXPANDED_DP = 840
    }
}

/** How the areas are reached: a bottom bar on a narrow window, a rail along the start edge otherwise. */
enum class Navigation { Bar, Rail }

/** What an expanded window shows beside the area's panel: the plate, or Preview's toolpath view. */
enum class Viewport { Workspace, Toolpath }

/**
 * The shell's arrangement for a window [widthDp] wide showing [area]. The
 * browser's flat shell (web/index.html, `WorkspaceViews`) docks the parameter
 * sidebar at the inline start beside the 3D viewport — 356 px wide, 312 px in
 * windows up to 1180 px, a sheet over the viewport on phones — and makes the
 * Device page take the whole work area. Here a compact window keeps the
 * bottom bar and one area at a time; medium and expanded ones put a rail at
 * the start; an expanded one shows the area's panel at the start beside the
 * [viewport] — the Workspace beside Prepare and Project (whose object tree is
 * the browser sidebar's Objects card), the toolpath view beside Preview's
 * controls — while the Workspace and Device fill the work area.
 */
data class ShellLayout(
    val width: WidthClass,
    val navigation: Navigation,
    /** Shown at the end beside the area's panel, or none when the area fills the work area. */
    val viewport: Viewport?,
    /** The panel's width beside the [viewport], as the browser's sidebar. */
    val panelWidthDp: Int,
) {
    companion object {
        /** The browser's sidebar widths and the window width below which it narrows (`@media (max-width: 1180px)`). */
        const val SIDEBAR_DP = 356
        const val NARROW_SIDEBAR_DP = 312
        const val NARROW_SIDEBAR_UP_TO_DP = 1180

        fun of(widthDp: Int, area: ShellArea): ShellLayout {
            val width = WidthClass.of(widthDp)
            val viewport = if (width != WidthClass.Expanded) {
                null
            } else {
                when (area) {
                    ShellArea.Prepare, ShellArea.Project -> Viewport.Workspace
                    ShellArea.Preview -> Viewport.Toolpath
                    ShellArea.Workspace, ShellArea.Device -> null
                }
            }
            return ShellLayout(
                width = width,
                navigation = if (width == WidthClass.Compact) Navigation.Bar else Navigation.Rail,
                viewport = viewport,
                panelWidthDp = if (widthDp > NARROW_SIDEBAR_UP_TO_DP) SIDEBAR_DP else NARROW_SIDEBAR_DP,
            )
        }
    }
}
