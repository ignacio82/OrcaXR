package dev.orcaxr.nativeapp.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.BrimEarPoint
import dev.orcaxr.core.BrimEarState
import dev.orcaxr.core.JsText
import dev.orcaxr.core.ProjectBrimEars
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.shell.ActionTooltip
import dev.orcaxr.nativeapp.shell.focusRing
import dev.orcaxr.renderer.MarkerShape
import dev.orcaxr.renderer.ModelTransform
import dev.orcaxr.renderer.Point3
import dev.orcaxr.renderer.ProjectScene
import dev.orcaxr.renderer.SceneMarker
import dev.orcaxr.renderer.decomposedScale

/**
 * The brim-ear discs as the browser's workspace draws them while its tool is
 * on (`refreshBrimEarPreview`): each placed ear as the pinned flat disc on
 * every instance of its object — grey where it will work, translucent red
 * where it reaches nothing — its printed size whatever the instance's scale.
 */
internal object BrimEarDiscs {
    /** The pinned render colours (`BRIM_EAR_COLORS`, `GLGizmoBrimEars.cpp:13-16`). */
    const val DEFAULT_ARGB = 0xffb3b3b3.toInt()
    const val ERROR_ARGB = 0xffff4d4d.toInt()
    const val ERROR_OPACITY = .5f
    /** The disc: three's `CylinderGeometry(radius, radius, 0.2, 32)` (`BRIM_EAR_DISC_HEIGHT_MM`), here of unit radius, scaled to each ear's. */
    val SHAPE = MarkerShape.cylinder("brim-ear-disc", 0.2, 32)

    /**
     * The discs of [state]'s ears on every instance of its object among
     * [draws] (the active plate's), instance by instance — each moved with
     * its instance in an exploded view ([offsets], mm), as the browser's
     * discs ride on the instance's group.
     */
    fun markers(state: BrimEarState, draws: List<ProjectScene.Draw>, offsets: Map<String, Point3> = emptyMap()): List<SceneMarker> {
        val objectId = state.objectId ?: return emptyList()
        if (state.ears.isEmpty()) return emptyList()
        val stranded = state.stranded.toSet()
        val instances = draws.filter { it.objectId == objectId }.distinctBy { it.instanceId }.map { draw ->
            val instance = draw.placement.instance
            val offset = offsets[draw.instanceId] ?: return@map ModelTransform.fromCanonical(instance)
            val (x, y, z) = instance.translationMm
            ModelTransform.fromCanonical(instance.copy(translationMm = listOf(x + offset.x, y + offset.y, z + offset.z)))
        }
        return instances.flatMap { instance -> state.ears.mapIndexed { index, ear -> disc(instance, ear, index in stranded) } }
    }

    /**
     * One ear's disc under [instance]: at the ear's object-local position,
     * its radius the ear's, with the instance's own scale undone (the pinned
     * `instance_scaling_matrix_inverse`, as three's `decompose` reads it), so
     * a disc is the ear's printed size on any instance.
     */
    fun disc(instance: ModelTransform, ear: BrimEarPoint, stranded: Boolean): SceneMarker {
        val scale = decomposedScale(instance)
        fun inverse(value: Double) = if (value == 0.0) 1.0 else 1 / value
        val radius = ear.headFrontRadiusMm
        val (x, y, z) = ear.positionMm
        val placed = instance * ModelTransform.scaledTranslated(radius * inverse(scale.x), radius * inverse(scale.y), inverse(scale.z), x, y, z)
        return SceneMarker(SHAPE, placed, if (stranded) ERROR_ARGB else DEFAULT_ARGB, if (stranded) ERROR_OPACITY else 1f)
    }
}

/**
 * The Ear radius field as the browser's `<input type=number>` hands it over
 * (`Number(input.value)` on `change`): a valid floating-point number is its
 * value, anything the input would sanitize to nothing is 0 — which the
 * workspace refuses, as it refuses an infinite one.
 */
object BrimEarFields {
    fun radius(text: String): Double = HtmlNumberInput.value(text)
}

/**
 * The browser's Brim ears panel (web/src/ui/dom/BrimEarsPanel.ts) while the
 * tool is on, at the Workspace's foot: its heading and the way out of the
 * tool; Place on corners (enabled with an object in scope) and Clear all
 * (with ears placed); the Ear radius field; the hint (a status), the tool's
 * last status and the warning about ears that reach nothing (an alert); and
 * the placed ears, each with its Remove, a stranded one in the error colour
 * of its red disc.
 */
@Composable
internal fun BrimEarsCard(model: ProjectModel, modifier: Modifier = Modifier) {
    val state = model.brimEarState
    val inScope = state.objectId != null
    val ring = MaterialTheme.colorScheme.primary
    // A share of the window's height, as the paint and Measure panels bound themselves.
    val tall = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.height.toDp() }
    val bounded = if (tall > 0.dp) Modifier.heightIn(max = tall * PANEL_SHARE) else Modifier
    Card(modifier.padding(16.dp)) {
        Column(
            bounded.verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.brim_ears_title), Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleSmall)
                TextButton(onClick = { model.brimEars(false) }, modifier = Modifier.focusRing(ring)) { Text(stringResource(R.string.workspace_lay_flat_done)) }
            }
            // The panel's controls in one run, wrapping only where the window is narrow, so the view above stays in sight.
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                ActionTooltip(stringResource(R.string.brim_ears_corners_hint)) {
                    TextButton(onClick = model::autoPlaceBrimEars, enabled = inScope && !model.busy, modifier = Modifier.focusRing(ring)) {
                        Text(stringResource(R.string.brim_ears_place_corners))
                    }
                }
                TextButton(onClick = model::clearBrimEars, enabled = state.ears.isNotEmpty() && !model.busy, modifier = Modifier.focusRing(ring)) {
                    Text(stringResource(R.string.brim_ears_clear_all))
                }
                RadiusField(model, inScope)
            }
            Text(ProjectBrimEars.hint(inScope), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodySmall)
            model.brimEarStatus?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodyMedium) }
            // An alert rather than a status, as the browser's: a stranded ear slices clean and prints an island, so this is
            // the only place the operator learns it before the print does.
            ProjectBrimEars.warning(state.stranded.size)?.let {
                Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Assertive }, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            if (state.ears.isNotEmpty()) PlacedEars(model, state)
        }
    }
}

/** The Ear radius field: the radius the next ear takes, handed over on Done or when the focus leaves a changed field. */
@Composable
private fun RadiusField(model: ProjectModel, enabled: Boolean) {
    val label = stringResource(R.string.brim_ears_radius)
    val shown = JsText.number(model.brimEarRadiusMm)
    var typed by remember(shown, model.brimEarRadiusEdits) { mutableStateOf(shown) }
    val focus = LocalFocusManager.current
    fun submit() {
        if (typed != shown) model.setBrimEarRadius(BrimEarFields.radius(typed))
    }
    OutlinedTextField(
        value = typed,
        onValueChange = { typed = it },
        label = { Text(label) },
        singleLine = true,
        enabled = enabled,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = {
            submit()
            focus.clearFocus()
        }),
        modifier = Modifier.width(132.dp).onFocusChanged { if (!it.isFocused) submit() }.semantics { contentDescription = label },
    )
}

/** The placed ears, in order: each one's position and diameter (a stranded one in the error colour, saying so) and its Remove. */
@Composable
private fun PlacedEars(model: ProjectModel, state: BrimEarState) {
    val placed = stringResource(R.string.brim_ears_placed_list)
    val remove = stringResource(R.string.brim_ears_remove)
    val stranded = state.stranded.toSet()
    Column(Modifier.semantics { contentDescription = placed }) {
        state.ears.forEachIndexed { index, ear ->
            val reaches = index !in stranded
            val row = ProjectBrimEars.row(ear, !reaches)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "${index + 1}. $row",
                    Modifier.weight(1f),
                    color = if (reaches) Color.Unspecified else MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(
                    onClick = { model.removeBrimEar(index) },
                    enabled = !model.busy,
                    modifier = Modifier.focusRing(MaterialTheme.colorScheme.primary).semantics { contentDescription = "$remove: $row" },
                ) { Text(remove) }
            }
        }
    }
}
