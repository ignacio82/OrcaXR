package dev.orcaxr.nativeapp.shell

import androidx.compose.material.ripple.RippleAlpha
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RippleConfiguration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusEventModifierNode
import androidx.compose.ui.focus.FocusState
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.KeyInputModifierNode
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.node.CompositionLocalConsumerModifierNode
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.currentValueOf
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.unit.dp

/**
 * The app's theme with keyboard focus that shows. Material draws a focused
 * control's state layer at 10% of its content colour, which a keyboard user
 * barely sees; the browser outlines its focused control (`:focus-visible`,
 * web/index.html). Every button, navigation item, tab, menu item, switch
 * and clickable row here takes its focus from the ripple, so the state layer
 * is raised to Material 2's high-contrast 24% for focus alone — pressing,
 * hovering and dragging keep Material 3's values. Touch never shows it: a
 * control is focusable only once a key was pressed.
 */
@Composable
fun FocusVisibleTheme(content: @Composable () -> Unit) {
    MaterialTheme {
        CompositionLocalProvider(LocalRippleConfiguration provides RippleConfiguration(rippleAlpha = FOCUS_VISIBLE_ALPHA), content = content)
    }
}

private val FOCUS_VISIBLE_ALPHA = RippleAlpha(draggedAlpha = 0.16f, focusedAlpha = 0.24f, hoveredAlpha = 0.08f, pressedAlpha = 0.1f)

/**
 * A ring in [color] around a control while it (or a control inside it) has
 * the focus, as the browser's 2 px focus outline: for a control Material
 * draws no focus state on, such as a slider's thumb.
 */
fun Modifier.focusRing(color: Color): Modifier = this then FocusRingElement(color)

private data class FocusRingElement(val color: Color) : ModifierNodeElement<FocusRingNode>() {
    override fun create() = FocusRingNode(color)

    override fun update(node: FocusRingNode) {
        node.color = color
        node.invalidateDraw()
    }

    override fun InspectorInfo.inspectableProperties() {
        name = "focusRing"
        properties["color"] = color
    }
}

private class FocusRingNode(var color: Color) : Modifier.Node(), FocusEventModifierNode, DrawModifierNode {
    private var focused = false

    override fun onFocusEvent(focusState: FocusState) {
        if (focusState.hasFocus == focused) return
        focused = focusState.hasFocus
        invalidateDraw()
    }

    override fun ContentDrawScope.draw() {
        drawContent()
        if (!focused) return
        val width = RING_WIDTH.toPx()
        drawRoundRect(
            color,
            topLeft = Offset(width / 2, width / 2),
            size = Size(size.width - width, size.height - width),
            cornerRadius = CornerRadius(RING_RADIUS.toPx()),
            style = Stroke(width),
        )
    }
}

private val RING_WIDTH = 2.dp
private val RING_RADIUS = 4.dp

/**
 * Tab and Shift+Tab move the focus on from a multi-line text field instead
 * of typing a tab, so the keyboard is never trapped in it — as a browser
 * textarea leaves Tab to the page. A single-line field already does this.
 */
fun Modifier.tabMovesFocus(): Modifier = this then TabMovesFocusElement

private data object TabMovesFocusElement : ModifierNodeElement<TabMovesFocusNode>() {
    override fun create() = TabMovesFocusNode()

    override fun update(node: TabMovesFocusNode) = Unit

    override fun InspectorInfo.inspectableProperties() {
        name = "tabMovesFocus"
    }
}

private class TabMovesFocusNode : Modifier.Node(), KeyInputModifierNode, CompositionLocalConsumerModifierNode {
    override fun onPreKeyEvent(event: KeyEvent): Boolean {
        if (event.key != Key.Tab || event.isCtrlPressed || event.isAltPressed || event.isMetaPressed) return false
        if (event.type == KeyEventType.KeyDown) {
            currentValueOf(LocalFocusManager).moveFocus(if (event.isShiftPressed) FocusDirection.Previous else FocusDirection.Next)
        }
        return true
    }

    override fun onKeyEvent(event: KeyEvent) = false
}
