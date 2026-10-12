package dev.orcaxr.nativeapp.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreInterceptKeyBeforeSoftKeyboard
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.orcaxr.core.ActionPresentation
import dev.orcaxr.core.PaletteSearchable
import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.project.ProjectModel
import dev.orcaxr.nativeapp.theme.LocalOrcaTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Opens the command palette; the shell provides it (Ctrl/⌘ K, and the search buttons that show the browser's). */
val LocalCommandPalette = staticCompositionLocalOf<() -> Unit> { {} }

/** One palette row: an action the app performs, with its label and hint in the app's language. */
private class PaletteRow(val action: ProjectActionState, val label: String, val hint: String?)

/**
 * The browser's command palette (`CommandPalette.ts`): every catalogue action
 * the app performs, by name, one search away. The list is the core's
 * `command-palette` surface in catalogue order with its enablement
 * ([ProjectModel.surfaceActions]), limited to the actions the app performs
 * ([AppActions.PERFORMED]) — Slice, Slice All Plates, Cancel Slice and Send
 * to Printer enabled as the Prepare area's buttons are ([LocalActionStates]),
 * as the browser's palette asks its slicing controller for them; the search is the browser's, in the shared core
 * ([ActionPresentation.palette]: label, id or hint containing the trimmed
 * query, case ignored). A row shows the action's symbol, its label and its
 * hint — or, when the core does not enable it, why. ArrowDown and ArrowUp
 * move the highlight (a new search starts at the first row, the pointer
 * highlights the row it rests on), Enter or a click runs the highlighted
 * action through [run] — the same call the menus make — and closes the
 * palette; one the core does not enable leaves it open with the browser's
 * status ("label: reason"). Escape, Ctrl/⌘ K, Back or a press outside close it
 * — Escape and Ctrl/⌘ K before an on-screen keyboard can take them. Opened
 * with Ctrl/⌘ K ([fromKeys]) it brings up no on-screen keyboard.
 */
@Composable
fun CommandPalette(model: ProjectModel, fromKeys: Boolean, onDismiss: () -> Unit, run: (String) -> Unit) {
    var actions by remember { mutableStateOf<List<ProjectActionState>>(emptyList()) }
    val view = model.view
    // The core's list, read again whenever the project, its selection or its enablement changes.
    LaunchedEffect(view) {
        actions = runCatching {
            withContext(Dispatchers.IO) { AppActions.performed(model.surfaceActions(ProjectIntents.ActionSurface.CommandPalette).get()) }
        }.getOrDefault(actions)
    }
    var query by remember { mutableStateOf("") }
    var selected by remember { mutableIntStateOf(0) }
    var status by remember { mutableStateOf<String?>(null) }
    // Slice, Slice All Plates, Cancel Slice and Send to Printer as the Prepare area enables them, the rest as the core does.
    val enable = LocalActionStates.current
    val rows = actions.map(enable).map { PaletteRow(it, ActionTexts.label(it), ActionTexts.hint(it.id)) }
    val matches = remember(actions, rows.map { it.label to it.hint }, query) {
        ActionPresentation.palette(query, rows) { PaletteSearchable(it.action.id, it.label, it.hint) }
    }
    val list = rememberLazyListState()
    LaunchedEffect(selected, matches.size) {
        if (selected in matches.indices) {
            val visible = list.layoutInfo.visibleItemsInfo.map { it.index }
            if (selected !in visible.drop(1).dropLast(1)) list.scrollToItem(maxOf(0, selected - 1))
        }
    }
    fun runRow(row: PaletteRow?) {
        row ?: return
        if (row.action.enabled) {
            onDismiss()
            run(row.action.id)
        } else {
            status = AppActions.unavailable(row.label, row.action.reason)
        }
    }
    val field = remember { FocusRequester() }
    LaunchedEffect(Unit) { field.requestFocus() }
    val tokens = LocalOrcaTheme.current.tokens.color
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        BoxWithConstraints(
            Modifier.fillMaxSize()
                // The dimmed backdrop: a press outside the box closes, as the browser's overlay does.
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDismiss)
                // Before the on-screen keyboard sees them (it would take Escape to hide itself and leave the palette open).
                .onPreInterceptKeyBeforeSoftKeyboard { event ->
                    if (event.type != KeyEventType.KeyDown) return@onPreInterceptKeyBeforeSoftKeyboard false
                    when {
                        (event.isCtrlPressed || event.isMetaPressed) && event.key == Key.K -> onDismiss()
                        event.key == Key.Escape -> onDismiss()
                        else -> return@onPreInterceptKeyBeforeSoftKeyboard false
                    }
                    true
                },
            contentAlignment = Alignment.TopCenter,
        ) {
            val listHeight = maxHeight * .48f
            Surface(
                modifier = Modifier.padding(top = maxHeight * .11f).width(min(600.dp, maxWidth * .92f))
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
                shape = RoundedCornerShape(6.dp),
                color = Color(tokens.bgElevated),
                shadowElevation = 8.dp,
            ) {
                Column {
                    val search = stringResource(R.string.palette_search)
                    TextField(
                        value = query,
                        onValueChange = {
                            query = it
                            selected = 0
                            status = null
                        },
                        placeholder = { Text(search) },
                        singleLine = true,
                        // Opened from the keyboard, the typing is the keyboard's: no on-screen keyboard over the list; opened by a
                        // touch, the on-screen keyboard comes up.
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go, showKeyboardOnFocus = !fromKeys),
                        keyboardActions = KeyboardActions(onGo = { runRow(matches.getOrNull(selected)) }),
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent,
                            unfocusedContainerColor = Color.Transparent,
                        ),
                        modifier = Modifier.fillMaxWidth().focusRequester(field)
                            .semantics { contentDescription = search }
                            .onPreviewKeyEvent { event ->
                                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                                when (event.key) {
                                    Key.DirectionDown -> selected = AppActions.Selection.down(selected, matches.size)
                                    Key.DirectionUp -> selected = AppActions.Selection.up(selected)
                                    Key.Enter, Key.NumPadEnter -> runRow(matches.getOrNull(selected))
                                    else -> return@onPreviewKeyEvent false
                                }
                                true
                            },
                    )
                    HorizontalDivider()
                    if (matches.isEmpty()) {
                        Text(
                            stringResource(R.string.palette_empty),
                            Modifier.fillMaxWidth().padding(18.dp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    } else {
                        LazyColumn(Modifier.heightIn(max = listHeight).padding(5.dp), state = list) {
                            itemsIndexed(matches, key = { _, row -> row.action.id }) { index, row ->
                                PaletteItem(row, index == selected, tokens.surfaceHover, onHover = { selected = index }) {
                                    selected = index
                                    runRow(row)
                                }
                            }
                        }
                    }
                    status?.let {
                        Text(
                            it,
                            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }
    }
}

/** One palette row: the symbol, the label, and the hint (or why it cannot run), dimmed when it cannot. */
@Composable
private fun PaletteItem(row: PaletteRow, highlighted: Boolean, hover: Long, onHover: () -> Unit, onClick: () -> Unit) {
    val note = if (!row.action.enabled) row.action.reason else row.hint
    val hovered by rememberUpdatedState(onHover)
    Row(
        Modifier.fillMaxWidth()
            .background(if (highlighted) Color(hover) else Color.Transparent, RoundedCornerShape(3.dp))
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent()
                        if (event.type == PointerEventType.Enter || event.type == PointerEventType.Move) hovered()
                    }
                }
            }
            .pointerHoverIcon(PointerIcon.Hand)
            .clickable(onClick = onClick)
            .semantics { selected = highlighted }
            .padding(horizontal = 11.dp, vertical = 8.dp)
            .alpha(if (row.action.enabled) 1f else .45f),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) { ActionIcon(row.action.id, Modifier.size(18.dp)) }
        Text(row.label, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodyMedium)
        if (note != null) {
            Text(
                note,
                Modifier.weight(1f).widthIn(max = 280.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
            )
        }
    }
}
