package dev.orcaxr.nativeapp.workspace

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.ProjectEmbossing
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectMeasures
import dev.orcaxr.core.ProjectSvgParts
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.shell.ActionTooltip
import dev.orcaxr.nativeapp.shell.focusRing

/**
 * A number as the browser's `<input type=number>` hands it over
 * (`Number(input.value)` on `change`): a valid floating-point number is its
 * value, anything the input would sanitize to nothing is 0.
 */
object HtmlNumberInput {
    private val NUMBER = Regex("-?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?")

    fun value(text: String): Double = if (NUMBER.matches(text)) text.toDouble() else 0.0
}

/** Any document: providers often report a font or a drawing only as bytes; the core decides. */
private val ANY = arrayOf("*/*")

/** The panel's frame: a card at the Workspace's foot, a share of the window's height, scrolling. */
@Composable
private fun ToolCard(title: String, onDone: () -> Unit, modifier: Modifier, content: @Composable ColumnScope.() -> Unit) {
    val tall = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.height.toDp() }
    val bounded = if (tall > 0.dp) Modifier.heightIn(max = tall * PANEL_SHARE) else Modifier
    Card(modifier.padding(16.dp)) {
        Column(
            bounded.verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleSmall)
                TextButton(onClick = onDone, modifier = Modifier.focusRing(MaterialTheme.colorScheme.primary)) {
                    Text(stringResource(R.string.workspace_lay_flat_done))
                }
            }
            content()
        }
    }
}

/** A tool's hint (a status) and its last status, each read out as it changes. */
@Composable
private fun Said(hint: String, status: String?) {
    Text(hint, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodySmall)
    status?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodyMedium) }
}

/**
 * A panel's number field, showing [value] as the browser's does
 * (`Number(value.toFixed(3))`) and handing what was typed over on Done or
 * when the focus leaves a changed field, as an input's `change` does.
 */
@Composable
private fun NumberField(label: String, value: Double, edits: Int, enabled: Boolean, width: Int = 132, commit: (Double) -> Unit) {
    val shown = ProjectMeasures.format(value)
    var typed by remember(shown, edits) { mutableStateOf(shown) }
    val focus = LocalFocusManager.current
    fun submit() {
        if (typed != shown) commit(HtmlNumberInput.value(typed))
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
        modifier = Modifier.width(width.dp).onFocusChanged { if (!it.isFocused) submit() }.semantics { contentDescription = label },
    )
}

/** One of a few choices, as the browser's `<select>`: a chip each, the chosen one selected. */
@Composable
private fun <T> Choice(label: String, options: List<Pair<T, String>>, chosen: T, enabled: Boolean, choose: (T) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((option, words) in options) {
                FilterChip(
                    selected = option == chosen,
                    onClick = { choose(option) },
                    enabled = enabled,
                    label = { Text(words) },
                    modifier = Modifier.semantics {
                        contentDescription = "$label: $words"
                        selected = option == chosen
                    },
                )
            }
        }
    }
}

/**
 * The browser's Emboss panel (web/src/ui/dom/EmbossPanel.ts) while the tool
 * is on, at the Workspace's foot: its heading and the way out of the tool;
 * Load an emboss font (the system's document picker: an app reads the file
 * the operator picks, as the browser does) and Add text — Update text when
 * the selection is a text part, which it re-cuts — enabled with a font and
 * something to apply to; the font's name; the text; Size, Depth, Letter gap
 * and Line gap; the horizontal and vertical alignment; the hint and the
 * tool's last status.
 */
@Composable
internal fun EmbossCard(model: ProjectModel, modifier: Modifier = Modifier) {
    val tools = model.drawn
    val target = tools.target
    val recipe = tools.recipe
    val focus = LocalFocusManager.current
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(tools::loadFont) }
    // "Load an emboss font" from the palette opens this panel and its picker.
    LaunchedEffect(tools.fontPickPending) {
        if (tools.fontPickPending) {
            tools.fontPickShown()
            pick.launch(ANY)
        }
    }
    val ring = MaterialTheme.colorScheme.primary
    val enabled = !model.busy
    ToolCard(stringResource(R.string.emboss_title), { tools.emboss(false) }, modifier) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            ActionTooltip(stringResource(R.string.action_hint_emboss_load_font)) {
                OutlinedButton(onClick = { pick.launch(ANY) }, enabled = enabled, modifier = Modifier.focusRing(ring)) {
                    Text(stringResource(R.string.emboss_load_font))
                }
            }
            ActionTooltip(stringResource(R.string.action_hint_emboss_apply)) {
                Button(
                    onClick = {
                        // As a click blurs the browser's fields first: an edit still typed is handed over before the cut.
                        focus.clearFocus()
                        tools.applyEmboss()
                    },
                    enabled = enabled && tools.fontName != null && (target.objectId != null || target.textVolumeId != null),
                    modifier = Modifier.focusRing(ring),
                ) { Text(stringResource(if (target.textVolumeId != null) R.string.emboss_update else R.string.emboss_add)) }
            }
        }
        Text(
            tools.fontName?.let { stringResource(R.string.emboss_font_named, it) } ?: stringResource(R.string.emboss_font),
            style = MaterialTheme.typography.bodySmall,
        )
        val textLabel = stringResource(R.string.emboss_text)
        OutlinedTextField(
            value = ProjectEmbossing.text(recipe),
            onValueChange = tools::setText,
            label = { Text(textLabel) },
            minLines = 2,
            enabled = enabled,
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = textLabel },
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((field, words) in listOf(
                ProjectEmbossing.Field.SIZE to R.string.emboss_size,
                ProjectEmbossing.Field.DEPTH to R.string.drawn_depth,
                ProjectEmbossing.Field.CHAR_GAP to R.string.emboss_char_gap,
                ProjectEmbossing.Field.LINE_GAP to R.string.emboss_line_gap,
            )) {
                NumberField(stringResource(words), ProjectEmbossing.number(recipe, field), tools.fieldEdits, enabled) { tools.setNumber(field, it) }
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Choice(
                stringResource(R.string.emboss_horizontal),
                listOf(
                    ProjectIntents.EmbossHorizontalAlign.Left to stringResource(R.string.emboss_left),
                    ProjectIntents.EmbossHorizontalAlign.Center to stringResource(R.string.emboss_center),
                    ProjectIntents.EmbossHorizontalAlign.Right to stringResource(R.string.emboss_right),
                ),
                recipe.font.horizontal,
                enabled,
                tools::setHorizontal,
            )
            Choice(
                stringResource(R.string.emboss_vertical),
                listOf(
                    ProjectIntents.EmbossVerticalAlign.Top to stringResource(R.string.emboss_top),
                    ProjectIntents.EmbossVerticalAlign.Center to stringResource(R.string.emboss_center),
                    ProjectIntents.EmbossVerticalAlign.Bottom to stringResource(R.string.emboss_bottom),
                ),
                recipe.font.vertical,
                enabled,
                tools::setVertical,
            )
        }
        Said(ProjectEmbossing.hint(tools.fontName != null, target), tools.embossStatus)
    }
}

/**
 * The browser's SVG part panel (web/src/ui/dom/SvgPanel.ts) while the tool
 * is on, at the Workspace's foot: its heading and the way out of the tool;
 * Load an SVG drawing (the system's document picker) and Add part — Update
 * part when the selection is an SVG part, which it re-cuts — enabled with a
 * drawing and something to apply to; the drawing's name; Depth and Width
 * (0 keeps the drawing's size); the hint, the tool's last status, and what
 * the drawing holds that cannot be cut, named rather than quietly missing.
 */
@Composable
internal fun SvgPartCard(model: ProjectModel, modifier: Modifier = Modifier) {
    val tools = model.drawn
    val target = tools.target
    val focus = LocalFocusManager.current
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(tools::loadDrawing) }
    // "Load an SVG drawing" from the palette opens this panel and its picker.
    LaunchedEffect(tools.drawingPickPending) {
        if (tools.drawingPickPending) {
            tools.drawingPickShown()
            pick.launch(ANY)
        }
    }
    val ring = MaterialTheme.colorScheme.primary
    val enabled = !model.busy
    ToolCard(stringResource(R.string.svg_title), { tools.svg(false) }, modifier) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            ActionTooltip(stringResource(R.string.action_hint_svg_load_drawing)) {
                OutlinedButton(onClick = { pick.launch(ANY) }, enabled = enabled, modifier = Modifier.focusRing(ring)) {
                    Text(stringResource(R.string.svg_load_drawing))
                }
            }
            ActionTooltip(stringResource(R.string.action_hint_svg_apply)) {
                Button(
                    onClick = {
                        focus.clearFocus()
                        tools.applySvg()
                    },
                    enabled = enabled && tools.drawingName != null && (target.objectId != null || target.svgVolumeId != null),
                    modifier = Modifier.focusRing(ring),
                ) { Text(stringResource(if (target.svgVolumeId != null) R.string.svg_update else R.string.svg_add)) }
            }
        }
        Text(
            tools.drawingName?.let { stringResource(R.string.svg_drawing_named, it) } ?: stringResource(R.string.svg_drawing),
            style = MaterialTheme.typography.bodySmall,
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            NumberField(stringResource(R.string.drawn_depth), tools.svgDepthMm, tools.fieldEdits, enabled, commit = tools::setSvgDepth)
            NumberField(stringResource(R.string.svg_width), tools.svgWidthMm ?: 0.0, tools.fieldEdits, enabled, width = 180, commit = tools::setSvgWidth)
        }
        Said(ProjectSvgParts.hint(tools.drawingName != null, target) ?: stringResource(R.string.svg_select_part), tools.svgStatus)
        val notes = tools.drawing?.let(ProjectSvgParts::unsupported).orEmpty()
        if (notes.isNotEmpty()) {
            // Named, not silently dropped: the part will not look like the drawing.
            val heading = stringResource(R.string.svg_unsupported)
            Column(Modifier.semantics { contentDescription = heading }) {
                for (note in notes) Text("• $note", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
