package dev.orcaxr.nativeapp.mcp

import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.AccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.text.AnnotatedString

/**
 * Headless Compose & Android View Inspector for OrcaXR MCP.
 * Directly reads Jetpack Compose's Semantics tree and the Android View hierarchy,
 * allowing AI agents to inspect the layout, controls, labels, and interactive states
 * and click or input text without needing any screenshots.
 */
object UiInspector {

    data class UiElement(
        val index: Int,
        val text: String?,
        val description: String?,
        val role: String,
        val clickable: Boolean,
        val enabled: Boolean,
        val checked: Boolean?,
        val bounds: List<Int>, // [left, top, right, bottom]
        val id: Int,
    ) {
        fun toMap(): Map<String, Any?> {
            val map = mutableMapOf<String, Any?>(
                "index" to index,
                "role" to role,
                "clickable" to clickable,
                "enabled" to enabled,
                "bounds" to bounds,
            )
            if (!text.isNullOrBlank()) map["text"] = text
            if (!description.isNullOrBlank()) map["description"] = description
            if (checked != null) map["checked"] = checked
            return map
        }
    }

    /**
     * Dumps the full semantic UI tree from the window's decor view.
     */
    fun dumpTree(rootView: View): Map<String, Any?> {
        val composeViews = findComposeViews(rootView)
        if (composeViews.isNotEmpty()) {
            val composeTrees = composeViews.mapNotNull { view ->
                val owner = getSemanticsOwner(view) ?: return@mapNotNull null
                dumpComposeNode(owner.rootSemanticsNode)
            }
            if (composeTrees.size == 1) return composeTrees.first()
            return mapOf("compose_roots" to composeTrees)
        }
        return dumpAndroidView(rootView)
    }

    /**
     * Extracts a flattened list of all visible interactive controls and labeled elements on screen.
     */
    fun getInteractiveElements(rootView: View): List<Map<String, Any?>> {
        val elements = mutableListOf<UiElement>()
        val composeViews = findComposeViews(rootView)
        for (view in composeViews) {
            val owner = getSemanticsOwner(view) ?: continue
            flattenComposeNode(owner.rootSemanticsNode, elements)
        }
        if (elements.isEmpty()) {
            flattenAndroidView(rootView, elements)
        }
        return elements.map { it.toMap() }
    }

    /**
     * Finds and clicks an element matching [target] (text or contentDescription) and optional [role].
     * Prefers Compose Semantics OnClick action; falls back to synthetic touch injection at the center of the bounds.
     */
    fun clickElement(rootView: View, target: String, role: String? = null): Boolean {
        val composeViews = findComposeViews(rootView)
        for (view in composeViews) {
            val owner = getSemanticsOwner(view) ?: continue
            val match = findMatchingComposeNode(owner.rootSemanticsNode, target, role)
            if (match != null) {
                // Try Compose OnClick action
                val action = match.config.getOrNull(SemanticsActions.OnClick)
                if (action?.action != null) {
                    val handled = action.action?.invoke() ?: true
                    return handled
                }

                // Fall back to synthetic touch injection at center
                val bounds = match.boundsInWindow
                val centerX = (bounds.left + bounds.right) / 2f
                val centerY = (bounds.top + bounds.bottom) / 2f
                return injectTouchAt(rootView, centerX, centerY)
            }
        }

        // Check traditional Android views
        val matchView = findMatchingAndroidView(rootView, target)
        if (matchView != null) {
            if (matchView.isClickable) {
                return matchView.performClick()
            }
            val location = IntArray(2)
            matchView.getLocationOnScreen(location)
            val cx = location[0] + matchView.width / 2f
            val cy = location[1] + matchView.height / 2f
            return injectTouchAt(rootView, cx, cy)
        }

        return false
    }

    /**
     * Sets text into an editable text field matching [target] (or currently focused field).
     */
    fun setTextInput(rootView: View, text: String, target: String? = null): Boolean {
        val composeViews = findComposeViews(rootView)
        for (view in composeViews) {
            val owner = getSemanticsOwner(view) ?: continue
            val match = findMatchingComposeNode(owner.rootSemanticsNode, target ?: "", role = "TextField")
                ?: if (target == null) findFirstEditableComposeNode(owner.rootSemanticsNode) else null

            if (match != null) {
                val setTextAction = match.config.getOrNull(SemanticsActions.SetText)
                if (setTextAction?.action != null) {
                    return setTextAction.action?.invoke(AnnotatedString(text)) ?: true
                }
            }
        }
        return false
    }

    // --- Compose Semantics Tree Traversal ---

    private fun dumpComposeNode(node: SemanticsNode): Map<String, Any?> {
        val text = extractText(node.config)
        val desc = extractDescription(node.config)
        val role = extractRole(node.config)
        val isClickable = node.config.getOrNull(SemanticsActions.OnClick) != null
        val bounds = node.boundsInWindow

        val children = node.children.map { dumpComposeNode(it) }

        val map = mutableMapOf<String, Any?>(
            "id" to node.id,
            "role" to role,
            "clickable" to isClickable,
            "bounds" to listOf(bounds.left.toInt(), bounds.top.toInt(), bounds.right.toInt(), bounds.bottom.toInt()),
        )
        if (!text.isNullOrBlank()) map["text"] = text
        if (!desc.isNullOrBlank()) map["description"] = desc
        extractChecked(node.config)?.let { map["checked"] = it }
        if (children.isNotEmpty()) map["children"] = children
        return map
    }

    private fun flattenComposeNode(node: SemanticsNode, out: MutableList<UiElement>) {
        val text = extractText(node.config)
        val desc = extractDescription(node.config)
        val role = extractRole(node.config)
        val isClickable = node.config.getOrNull(SemanticsActions.OnClick) != null
        val isEditable = node.config.getOrNull(SemanticsActions.SetText) != null
        val checked = extractChecked(node.config)
        val bounds = node.boundsInWindow

        if (isClickable || isEditable || checked != null || !text.isNullOrBlank() || !desc.isNullOrBlank()) {
            if (bounds.width > 0 && bounds.height > 0) {
                out.add(
                    UiElement(
                        index = out.size,
                        text = text,
                        description = desc,
                        role = role,
                        clickable = isClickable,
                        enabled = !node.config.contains(SemanticsProperties.Disabled),
                        checked = checked,
                        bounds = listOf(bounds.left.toInt(), bounds.top.toInt(), bounds.right.toInt(), bounds.bottom.toInt()),
                        id = node.id,
                    )
                )
            }
        }

        for (child in node.children) {
            flattenComposeNode(child, out)
        }
    }

    private fun findMatchingComposeNode(node: SemanticsNode, target: String, role: String?): SemanticsNode? {
        val text = extractText(node.config).orEmpty()
        val desc = extractDescription(node.config).orEmpty()
        val nodeRole = extractRole(node.config)

        val roleMatches = role == null || nodeRole.equals(role, ignoreCase = true)
        val textMatches = text.contains(target, ignoreCase = true) || desc.contains(target, ignoreCase = true)

        if (roleMatches && textMatches) {
            return node
        }

        for (child in node.children) {
            val match = findMatchingComposeNode(child, target, role)
            if (match != null) return match
        }
        return null
    }

    private fun findFirstEditableComposeNode(node: SemanticsNode): SemanticsNode? {
        if (node.config.getOrNull(SemanticsActions.SetText) != null) return node
        for (child in node.children) {
            val match = findFirstEditableComposeNode(child)
            if (match != null) return match
        }
        return null
    }

    private fun extractText(config: SemanticsConfiguration): String? {
        val list = config.getOrNull(SemanticsProperties.Text)
        if (!list.isNullOrEmpty()) {
            return list.joinToString(" ") { it.text }
        }
        val editable = config.getOrNull(SemanticsProperties.EditableText)
        if (editable != null) {
            return editable.text
        }
        return null
    }

    private fun extractDescription(config: SemanticsConfiguration): String? {
        val list = config.getOrNull(SemanticsProperties.ContentDescription)
        if (!list.isNullOrEmpty()) {
            return list.joinToString(" ")
        }
        return null
    }

    private fun extractRole(config: SemanticsConfiguration): String {
        val role = config.getOrNull(SemanticsProperties.Role)
        if (role != null) {
            return when (role) {
                Role.Button -> "Button"
                Role.Checkbox -> "Checkbox"
                Role.Switch -> "Switch"
                Role.RadioButton -> "RadioButton"
                Role.Tab -> "Tab"
                Role.Image -> "Image"
                Role.DropdownList -> "DropdownList"
                else -> role.toString()
            }
        }
        if (config.getOrNull(SemanticsActions.SetText) != null) return "TextField"
        if (config.getOrNull(SemanticsProperties.Heading) != null) return "Heading"
        if (config.getOrNull(SemanticsProperties.Selected) != null) return "TabSelected"
        if (config.getOrNull(SemanticsActions.OnClick) != null) return "Clickable"
        if (config.getOrNull(SemanticsProperties.Text) != null) return "Text"
        return "Node"
    }

    private fun extractChecked(config: SemanticsConfiguration): Boolean? {
        val toggle = config.getOrNull(SemanticsProperties.ToggleableState)
        if (toggle != null) {
            return toggle == androidx.compose.ui.state.ToggleableState.On
        }
        return config.getOrNull(SemanticsProperties.Selected)
    }

    // --- Android Compose View Finder via Reflection ---

    private fun findComposeViews(view: View): List<View> {
        val result = mutableListOf<View>()
        if (view.javaClass.name.contains("AndroidComposeView")) {
            result.add(view)
        }
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                result.addAll(findComposeViews(view.getChildAt(i)))
            }
        }
        return result
    }

    private fun getSemanticsOwner(view: View): SemanticsOwner? {
        return try {
            val method = view.javaClass.getMethod("getSemanticsOwner")
            method.invoke(view) as? SemanticsOwner
        } catch (_: Exception) {
            null
        }
    }

    // --- Traditional Android View Helpers (Fallback) ---

    private fun dumpAndroidView(view: View): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>(
            "class" to view.javaClass.simpleName,
            "clickable" to view.isClickable,
            "enabled" to view.isEnabled,
        )
        val text = (view as? TextView)?.text?.toString()?.trim()
        val desc = view.contentDescription?.toString()?.trim()
        if (!text.isNullOrBlank()) map["text"] = text
        if (!desc.isNullOrBlank()) map["description"] = desc

        if (view is ViewGroup && view.childCount > 0) {
            val children = (0 until view.childCount).map { dumpAndroidView(view.getChildAt(it)) }
            map["children"] = children
        }
        return map
    }

    private fun flattenAndroidView(view: View, out: MutableList<UiElement>) {
        val text = (view as? TextView)?.text?.toString()?.trim()
        val desc = view.contentDescription?.toString()?.trim()
        val isClickable = view.isClickable

        if (isClickable || !text.isNullOrBlank() || !desc.isNullOrBlank()) {
            val location = IntArray(2)
            view.getLocationOnScreen(location)
            out.add(
                UiElement(
                    index = out.size,
                    text = text,
                    description = desc,
                    role = if (isClickable) "Button" else "Text",
                    clickable = isClickable,
                    enabled = view.isEnabled,
                    checked = null,
                    bounds = listOf(location[0], location[1], location[0] + view.width, location[1] + view.height),
                    id = view.id,
                )
            )
        }

        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                flattenAndroidView(view.getChildAt(i), out)
            }
        }
    }

    private fun findMatchingAndroidView(view: View, target: String): View? {
        val text = (view as? TextView)?.text?.toString()?.trim().orEmpty()
        val desc = view.contentDescription?.toString()?.trim().orEmpty()
        if (text.contains(target, ignoreCase = true) || desc.contains(target, ignoreCase = true)) {
            return view
        }
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                val match = findMatchingAndroidView(view.getChildAt(i), target)
                if (match != null) return match
            }
        }
        return null
    }

    private fun injectTouchAt(rootView: View, screenX: Float, screenY: Float): Boolean {
        val location = IntArray(2)
        rootView.getLocationOnScreen(location)
        val localX = screenX - location[0]
        val localY = screenY - location[1]

        val downTime = SystemClock.uptimeMillis()
        val down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, localX, localY, 0)
        rootView.dispatchTouchEvent(down)
        down.recycle()

        val up = MotionEvent.obtain(downTime, downTime + 50, MotionEvent.ACTION_UP, localX, localY, 0)
        val handled = rootView.dispatchTouchEvent(up)
        up.recycle()
        return handled
    }
}
