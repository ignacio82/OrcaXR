package dev.orcaxr.nativeapp.shell

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.ActionSection
import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.nativeapp.theme.OrcaActionGlyphs

/**
 * Runs a catalogue action the way the app's menus run it (`ProjectModel.perform`),
 * showing the area it needs first: the Project area for a document action, the
 * Workspace for a camera view or a tool. The shell provides it.
 */
val LocalActionRunner = staticCompositionLocalOf<(String) -> Unit> { {} }

/**
 * What a control says when a pointer rests on it, as the browser's `title`
 * does: a plain tooltip on mouse hover (and on a long press by touch or pen,
 * Material's way), kept while the pointer stays.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActionTooltip(text: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Below),
        tooltip = { PlainTooltip { Text(text) } },
        state = rememberTooltipState(isPersistent = true),
        modifier = modifier,
        content = content,
    )
}

/** [id]'s glyph, the browser's Material symbol for it; nothing for an action without one. */
@Composable
fun ActionIcon(id: String, modifier: Modifier = Modifier) {
    val glyph = OrcaActionGlyphs.actions[id] ?: return
    Icon(painterResource(glyph.icon), contentDescription = null, modifier = modifier.size(20.dp))
}

/**
 * One toolbar button, as the browser's `tool-btn`: the action's symbol, named
 * by its label, its tooltip the hint (or why the core does not enable it), a
 * hand pointer over it; a tool shows whether it is the Workspace's tool now
 * ([active], the browser's `.active`) and is pressed again to end it.
 */
@Composable
fun ActionIconButton(action: ProjectActionState, tool: Boolean, active: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val label = ActionTexts.label(action)
    ActionTooltip(ActionTexts.tooltip(action)) {
        val modifier = Modifier.pointerHoverIcon(PointerIcon.Hand).semantics { contentDescription = label }
        if (tool) {
            IconToggleButton(
                checked = active,
                onCheckedChange = { onClick() },
                enabled = enabled || active,
                colors = IconButtonDefaults.iconToggleButtonColors(
                    checkedContainerColor = MaterialTheme.colorScheme.primary,
                    checkedContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
                modifier = modifier,
            ) { ActionIcon(action.id) }
        } else {
            IconButton(onClick = onClick, enabled = enabled, modifier = modifier) { ActionIcon(action.id) }
        }
    }
}

/**
 * A grouped action menu's entries, as the browser's context menu draws them
 * (`ContextMenu.ts`): each section's heading (the catalogue group's label in
 * the app's language, [ActionTexts.heading], small and muted), then its actions — the
 * symbol, the label and the shortcut the browser's menus print, the hint as
 * the tooltip (or, for an entry the core does not enable, why: on mouse hover
 * or a long press) and a hand pointer over an enabled one.
 */
@Composable
fun ColumnScope.ActionSections(
    sections: List<Pair<ActionSection, List<ProjectActionState>>>,
    enabled: (ProjectActionState) -> Boolean = { it.enabled },
    run: (ProjectActionState) -> Unit,
) {
    sections.forEachIndexed { index, (section, actions) ->
        val heading = ActionTexts.heading(section)
        if (heading.isNotEmpty()) {
            Text(
                heading.uppercase(),
                Modifier.padding(start = 12.dp, end = 12.dp, top = if (index == 0) 2.dp else 8.dp, bottom = 2.dp)
                    .alpha(.6f).semantics { heading() },
                style = MaterialTheme.typography.labelSmall,
            )
        }
        for (action in actions) ActionMenuItem(action, enabled(action)) { run(action) }
    }
}

/** One catalogue action in a menu: see [ActionSections]. */
@Composable
fun ActionMenuItem(action: ProjectActionState, enabled: Boolean = action.enabled, trailing: String? = null, onClick: () -> Unit) {
    ActionTooltip(ActionTexts.tooltip(action)) {
        DropdownMenuItem(
            text = { Text(ActionTexts.label(action)) },
            onClick = onClick,
            enabled = enabled,
            leadingIcon = OrcaActionGlyphs.actions[action.id]?.let { { ActionIcon(action.id) } },
            trailingIcon = (trailing ?: OrcaActionGlyphs.actions[action.id]?.shortcut)?.let { text ->
                { Text(text, style = MaterialTheme.typography.labelSmall, modifier = Modifier.alpha(.7f)) }
            },
            modifier = if (enabled) Modifier.pointerHoverIcon(PointerIcon.Hand) else Modifier,
        )
    }
}
