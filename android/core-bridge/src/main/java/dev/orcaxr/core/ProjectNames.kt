package dev.orcaxr.core

/**
 * Names as the browser's workspace takes them (web/src/workspace/
 * CanonicalWorkspaceController.ts, web/src/ui/dom/PlateManager.ts): trimmed
 * of ECMAScript white space (`String.prototype.trim`, not Kotlin's), counted
 * in UTF-16 units, refused when empty, too long or holding control
 * characters, with the browser's messages; and a new plate's "Plate n".
 */
object ProjectNames {
    /** ECMAScript `WhiteSpace` and `LineTerminator`: what `trim` removes. */
    fun isWhitespace(unit: Char): Boolean = when (unit) {
        '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', ' ', ' ', ' ', ' ', ' ',
        ' ', ' ', '　', '﻿' -> true
        in ' '..' ' -> true
        else -> false
    }

    /** `String.prototype.trim`. */
    fun trim(text: String): String {
        var start = 0
        var end = text.length
        while (start < end && isWhitespace(text[start])) start++
        while (end > start && isWhitespace(text[end - 1])) end--
        return text.substring(start, end)
    }

    /**
     * The browser's `requireBoundedText`: [value] trimmed, or a
     * [ProjectFailure] naming [label] when it is empty, longer than
     * [maxLength] units or holds a code point below U+0020.
     */
    fun bounded(value: String, label: String, maxLength: Int): String {
        val normalized = trim(value)
        if (normalized.isEmpty()) throw ProjectFailure("$label cannot be empty")
        if (normalized.length > maxLength) throw ProjectFailure("$label cannot exceed $maxLength characters")
        if (normalized.any { it.code < 0x20 }) throw ProjectFailure("$label cannot contain control characters")
        return normalized
    }

    /**
     * Why the plate bar refuses [value] as a plate's new name (the browser's
     * `PlateManager.validateName`, after its trim), or null when it takes it.
     */
    fun plateNameProblem(value: String): String? {
        val name = trim(value)
        return when {
            name.isEmpty() -> "Plate name cannot be empty."
            name.length > ProjectWorkspace.MAX_PLATE_NAME_LENGTH ->
                "Plate name cannot exceed ${ProjectWorkspace.MAX_PLATE_NAME_LENGTH} characters."
            // \p{Cc}: C0 controls, DEL and C1 controls.
            name.any { it.code < 0x20 || it.code in 0x7f..0x9f } -> "Plate name cannot contain control characters."
            else -> null
        }
    }

    /** The browser's `nextAvailableName`: "[prefix] n" for the least n ≥ 1 no name in [names] equals. */
    fun nextAvailable(prefix: String, names: Collection<String>): String {
        val occupied = names.toHashSet()
        var number = 1
        while ("$prefix $number" in occupied) number++
        return "$prefix $number"
    }
}
