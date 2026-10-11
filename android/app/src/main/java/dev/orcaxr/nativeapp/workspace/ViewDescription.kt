package dev.orcaxr.nativeapp.workspace

import android.view.View
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.core.view.ViewCompat
import dev.orcaxr.core.ProjectSceneSummary
import dev.orcaxr.nativeapp.R
import dev.orcaxr.renderer.CameraView

/**
 * What a 3D view says to an accessibility service. The browser names its
 * viewport "Build plate" (`#viewport`); here the Workspace also says what
 * stands on it — the active plate and its objects, and the selection by the
 * tree's names, in the browser's words where it has them (its XR objects
 * panel's "Selection", "Nothing selected", "Nothing on this plate yet.").
 */
object ViewDescription {
    /** The words, from resources, so the composition stays platform-free to test. */
    class Words(
        val plate: (String, Int) -> String,
        val empty: String,
        val selection: String,
        val nothingSelected: String,
    )

    /** The Workspace's state: the plate and its objects, then the selection — or that the plate is empty. */
    fun workspace(summary: ProjectSceneSummary, words: Words): String {
        val plate = summary.plate ?: return ""
        if (summary.objects == 0) return "$plate. ${words.empty}"
        val selection = when {
            summary.selected.isNotEmpty() -> "${words.selection}: ${summary.selected.joinToString(", ")}"
            summary.selection > 0 -> "${words.selection}: ${summary.selection}"
            else -> words.nothingSelected
        }
        return "${words.plate(plate, summary.objects)}. $selection"
    }

    /** The browser's View menu camera views as accessibility actions, by its labels (`action.view_camera_*.label`). */
    @Composable
    fun cameraActions(onView: (CameraView) -> Unit): List<CustomAccessibilityAction> {
        val labels = CameraView.entries.map { view ->
            view to stringResource(
                when (view) {
                    CameraView.DEFAULT -> R.string.view_camera_default
                    CameraView.TOP -> R.string.view_camera_top
                    CameraView.FRONT -> R.string.view_camera_front
                    CameraView.LEFT -> R.string.view_camera_left
                    CameraView.RIGHT -> R.string.view_camera_right
                    CameraView.REAR -> R.string.view_camera_rear
                    CameraView.BOTTOM -> R.string.view_camera_bottom
                },
            )
        }
        return remember(labels, onView) {
            labels.map { (view, label) -> CustomAccessibilityAction(label) { onView(view); true } }
        }
    }

    /**
     * Says [label], [state] and the [actions] on the 3D view's own [view]. The view is an interop
     * view (a SurfaceView inside Compose): semantics set on its `AndroidView` modifier never reach the
     * accessibility tree, so TalkBack would find an unnamed surface.
     */
    fun describe(view: View, label: String, state: String, actions: List<CustomAccessibilityAction>) {
        view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        view.contentDescription = label
        ViewCompat.setStateDescription(view, state)
        @Suppress("UNCHECKED_CAST")
        (view.getTag(R.id.view_description_actions) as? List<Int>)?.forEach { ViewCompat.removeAccessibilityAction(view, it) }
        view.setTag(
            R.id.view_description_actions,
            actions.map { action -> ViewCompat.addAccessibilityAction(view, action.label) { _, _ -> action.action() } },
        )
    }
}
