package dev.orcaxr.nativeapp.workspace

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.ActionArrangement
import dev.orcaxr.core.ActionPresentation
import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.shell.ActionIcon
import dev.orcaxr.nativeapp.shell.ActionIconButton
import dev.orcaxr.nativeapp.shell.ActionSections
import dev.orcaxr.nativeapp.shell.ActionTexts
import dev.orcaxr.nativeapp.shell.ActionTooltip
import dev.orcaxr.nativeapp.shell.AppActions
import dev.orcaxr.nativeapp.shell.LocalActionRunner
import dev.orcaxr.nativeapp.shell.LocalActionStates
import dev.orcaxr.nativeapp.shell.LocalCommandPalette
import dev.orcaxr.nativeapp.theme.LocalOrcaTheme
import dev.orcaxr.nativeapp.theme.OrcaActionGlyphs

/**
 * The browser's menu strip actions beside the Workspace's title: its quick
 * actions (Save, Undo, Redo — bare symbols, as the browser's `strip-btn`s,
 * enabled as the core enables them on `dom-menu`) and the command palette's
 * search button (`#cmd-search-btn`: the search symbol, "Search actions &
 * settings" on a window wider than the browser's 1180 px, and ⌘K; its title
 * a tooltip).
 */
@Composable
internal fun StripActions(model: ProjectModel, wide: Boolean, compact: Boolean) {
    val run = LocalActionRunner.current
    for (action in model.quickActions) {
        val label = ActionTexts.label(action)
        ActionTooltip(ActionTexts.tooltip(action)) {
            IconButton(
                onClick = { run(action.id) },
                enabled = action.enabled && !model.busy,
                modifier = Modifier.pointerHoverIcon(PointerIcon.Hand).semantics { contentDescription = label },
            ) { ActionIcon(action.id) }
        }
    }
    val open = LocalCommandPalette.current
    val name = stringResource(R.string.palette_open)
    ActionTooltip(stringResource(R.string.palette_open_hint)) {
        if (compact) {
            IconButton(onClick = open, modifier = Modifier.pointerHoverIcon(PointerIcon.Hand).semantics { contentDescription = name }) {
                Icon(painterResource(OrcaActionGlyphs.search), contentDescription = null, modifier = Modifier.size(20.dp))
            }
        } else {
            OutlinedButton(
                onClick = open,
                modifier = Modifier.pointerHoverIcon(PointerIcon.Hand).semantics { contentDescription = name },
                contentPadding = PaddingValues(horizontal = 8.dp),
            ) {
                Icon(painterResource(OrcaActionGlyphs.search), contentDescription = null, modifier = Modifier.size(16.dp))
                if (wide) Text(name, Modifier.padding(start = 6.dp), style = MaterialTheme.typography.labelMedium)
                Text(
                    stringResource(R.string.palette_keys),
                    Modifier.padding(start = 6.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                )
            }
        }
    }
}

/**
 * The browser's model toolbar (`#model-toolbar`, DomShell's `dom-toolbar`):
 * the toolbar actions the app performs, in the catalogue's order and runs, a
 * hairline wherever the group changes; each its symbol, named and tipped by
 * its words, enabled as the core enables it, a tool showing whether it is the
 * Workspace's tool now. A card that scrolls sideways when the window is
 * narrower than its tools.
 */
@Composable
internal fun ModelToolbar(model: ProjectModel, modifier: Modifier = Modifier) {
    val runs = model.toolbar
    if (runs.isEmpty()) return
    val run = LocalActionRunner.current
    val tokens = LocalOrcaTheme.current.tokens.color
    val name = stringResource(R.string.workspace_toolbar)
    Surface(
        modifier = modifier.padding(horizontal = 8.dp),
        shape = RoundedCornerShape(6.dp),
        color = Color(tokens.bgCard),
        border = BorderStroke(1.dp, Color(tokens.stroke)),
        shadowElevation = 3.dp,
    ) {
        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(2.dp).semantics { contentDescription = name },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(1.dp),
        ) {
            runs.forEachIndexed { index, tools ->
                if (index > 0) Box(Modifier.padding(horizontal = 3.dp).width(1.dp).height(20.dp).background(Color(tokens.stroke)))
                for (action in tools) {
                    val tool = action.id in AppActions.TOOLS
                    val active = tool && model.toolActive(action.id)
                    ActionIconButton(action, tool = tool, active = active, enabled = action.enabled && !model.busy) { run(action.id) }
                }
            }
        }
    }
}

/** What a secondary press or a long press on the Workspace opened a menu on: a model ([instanceId]), or the plate. */
internal data class SceneMenuRequest(val x: Float, val y: Float, val instanceId: String?)

/**
 * The browser's scene context menu (main.ts's `sceneContextMenu`): the
 * catalogue's context menu for what was pressed — a model's (the object
 * menu) or, on nothing, the plate's — limited to what the app performs, in
 * the catalogue's sections ([ActionPresentation.arrange]), each entry enabled
 * as the core enables it; it opens where the press was and runs the menus'
 * call.
 */
@Composable
internal fun SceneMenu(model: ProjectModel, request: SceneMenuRequest, close: () -> Unit) {
    val view = model.view
    val run = LocalActionRunner.current
    val objectMenu = request.instanceId != null
    // The plate's Slice as the Prepare area enables it, the rest as the core does.
    val actions = AppActions.performed(if (objectMenu) view.objectMenu else view.plateMenu).map(LocalActionStates.current)
    val sections = remember(actions) { ActionPresentation.arrange(actions, ActionArrangement.CONTEXT) { it.id } }
    val name = stringResource(if (objectMenu) R.string.menu_scene_object else R.string.menu_scene_plate)
    Box(Modifier.offset { IntOffset(request.x.toInt(), request.y.toInt()) }) {
        DropdownMenu(
            expanded = true,
            onDismissRequest = close,
            offset = DpOffset.Zero,
            modifier = Modifier.semantics { contentDescription = name },
        ) {
            ActionSections(sections, enabled = { action: ProjectActionState -> !model.busy && (action.enabled || model.toolActive(action.id)) }) { action ->
                close()
                run(action.id)
            }
        }
    }
}
