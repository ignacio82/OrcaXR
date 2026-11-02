package dev.orcaxr.nativeapp.ai

object ColorNames {
    /**
     * Parses a hex color (e.g. "#8BD5EE", "8BD5EE", "#FFF") and returns (r, g, b) in 0..255,
     * or null if invalid.
     */
    fun parseRgb(hexColor: String): Triple<Int, Int, Int>? {
        val clean = hexColor.trim().removePrefix("#")
        return when (clean.length) {
            3 -> {
                val r = clean.substring(0, 1).repeat(2).toIntOrNull(16) ?: return null
                val g = clean.substring(1, 2).repeat(2).toIntOrNull(16) ?: return null
                val b = clean.substring(2, 3).repeat(2).toIntOrNull(16) ?: return null
                Triple(r, g, b)
            }
            6 -> {
                val r = clean.substring(0, 2).toIntOrNull(16) ?: return null
                val g = clean.substring(2, 4).toIntOrNull(16) ?: return null
                val b = clean.substring(4, 6).toIntOrNull(16) ?: return null
                Triple(r, g, b)
            }
            8 -> {
                val r = clean.substring(0, 2).toIntOrNull(16) ?: return null
                val g = clean.substring(2, 4).toIntOrNull(16) ?: return null
                val b = clean.substring(4, 6).toIntOrNull(16) ?: return null
                Triple(r, g, b)
            }
            else -> null
        }
    }

    /**
     * Converts (r, g, b) in 0..255 to HSV:
     * hue: 0.0f..360.0f, sat: 0.0f..1.0f, value: 0.0f..1.0f
     */
    fun rgbToHsv(r: Int, g: Int, b: Int): Triple<Float, Float, Float> {
        val rf = r / 255.0f
        val gf = g / 255.0f
        val bf = b / 255.0f

        val max = maxOf(rf, gf, bf)
        val min = minOf(rf, gf, bf)
        val delta = max - min

        val hue = when {
            delta == 0.0f -> 0.0f
            max == rf -> ((gf - bf) / delta * 60.0f + 360.0f) % 360.0f
            max == gf -> ((bf - rf) / delta * 60.0f + 120.0f) % 360.0f
            else -> ((rf - gf) / delta * 60.0f + 240.0f) % 360.0f
        }

        val sat = if (max == 0.0f) 0.0f else delta / max
        val value = max

        return Triple(hue, sat, value)
    }

    /**
     * Maps hex color to a human-readable friendly color name.
     */
    fun nameOf(hexColor: String): String {
        val rgb = parseRgb(hexColor) ?: return "Unknown"
        val (hue, sat, value) = rgbToHsv(rgb.first, rgb.second, rgb.third)

        // Achromatic / Neutral colors
        if (value < 0.15f) return "Black"
        if (sat < 0.12f) {
            return when {
                value > 0.85f -> "White"
                value > 0.60f -> "Light Gray"
                value > 0.35f -> "Gray"
                else -> "Dark Gray"
            }
        }

        // Chromatic colors based on Hue, Saturation and Value
        return when (hue) {
            in 0.0f..14.0f, in 348.0f..360.0f -> {
                when {
                    sat < 0.5f && value > 0.7f -> "Pink"
                    value < 0.4f -> "Dark Red"
                    else -> "Red"
                }
            }
            in 14.0f..42.0f -> {
                when {
                    value < 0.45f && sat > 0.4f -> "Brown"
                    sat < 0.35f && value > 0.75f -> "Peach"
                    else -> "Orange"
                }
            }
            in 42.0f..68.0f -> {
                when {
                    value < 0.5f -> "Olive / Mustard"
                    sat < 0.4f -> "Pale Yellow"
                    else -> "Yellow"
                }
            }
            in 68.0f..158.0f -> {
                when {
                    hue < 88.0f -> "Lime Green"
                    value < 0.4f -> "Dark Green"
                    sat < 0.45f && value > 0.75f -> "Light Green"
                    else -> "Green"
                }
            }
            in 158.0f..182.0f -> "Teal"
            in 182.0f..205.0f -> {
                when {
                    value > 0.7f -> "Light Blue"
                    else -> "Cyan"
                }
            }
            in 205.0f..255.0f -> {
                when {
                    value < 0.4f -> "Dark Blue"
                    value > 0.8f && sat < 0.6f -> "Sky Blue"
                    else -> "Blue"
                }
            }
            in 255.0f..290.0f -> {
                when {
                    value < 0.4f -> "Dark Purple"
                    sat < 0.5f -> "Lavender"
                    else -> "Purple"
                }
            }
            in 290.0f..348.0f -> {
                when {
                    sat < 0.45f || value > 0.8f -> "Pink"
                    else -> "Magenta"
                }
            }
            else -> "Color"
        }
    }

    /**
     * Resolves a slot number (1..N) or human color name (e.g. "blue", "white", "orange")
     * against the active printer filaments, returning the 1-based slot string (e.g. "1", "2").
     */
    fun findSlotByColorOrNumber(
        input: Any?,
        filaments: List<dev.orcaxr.core.FilamentOption>,
    ): String? {
        if (input == null) return null
        val str = input.toString().trim()
        val num = str.toIntOrNull()
        if (num != null && num in 1..filaments.size) {
            return num.toString()
        }
        val lower = str.lowercase()
        // Try exact filament ID match
        filaments.forEachIndexed { index, fil ->
            if (fil.id == str || fil.id.equals(str, ignoreCase = true)) {
                return (index + 1).toString()
            }
        }
        // Try exact color match first
        filaments.forEachIndexed { index, fil ->
            val colorName = nameOf(fil.color).lowercase()
            if (colorName == lower || lower.contains(colorName) || colorName.contains(lower)) {
                return (index + 1).toString()
            }
        }
        // Try filament name match
        filaments.forEachIndexed { index, fil ->
            val filName = fil.name.lowercase()
            if (filName.isNotBlank() && (filName.contains(lower) || lower.contains(filName))) {
                return (index + 1).toString()
            }
        }
        return null
    }

    /**
     * Resolves a slot number (1..N), human color name, or filament ID
     * to the concrete filament ID (fil.id) required by facet paint strokes.
     */
    fun findFilamentIdByColorOrNumber(
        input: Any?,
        filaments: List<dev.orcaxr.core.FilamentOption>,
    ): String? {
        if (input == null) return null
        val str = input.toString().trim()
        // Check if already an exact filament ID
        filaments.firstOrNull { it.id == str || it.id.equals(str, ignoreCase = true) }?.let {
            return it.id
        }
        // Slot number 1..N
        val num = str.toIntOrNull()
        if (num != null && num in 1..filaments.size) {
            return filaments[num - 1].id
        }
        val lower = str.lowercase()
        // Try color name match
        filaments.firstOrNull { fil ->
            val colorName = nameOf(fil.color).lowercase()
            colorName == lower || lower.contains(colorName) || colorName.contains(lower)
        }?.let { return it.id }

        // Try filament name match
        filaments.firstOrNull { fil ->
            val filName = fil.name.lowercase()
            filName.isNotBlank() && (filName == lower || filName.contains(lower) || lower.contains(filName))
        }?.let { return it.id }

        return null
    }

    /** Well-known color-name → hex mapping for auto-adding filaments. */
    private val NAMED_HEX = mapOf(
        "white" to "#FFFFFF",
        "black" to "#000000",
        "red" to "#FF0000",
        "green" to "#00FF00",
        "blue" to "#0000FF",
        "yellow" to "#FFFF00",
        "orange" to "#FF6A13",
        "purple" to "#800080",
        "pink" to "#FFC0CB",
        "cyan" to "#00FFFF",
        "magenta" to "#FF00FF",
        "brown" to "#8B4513",
        "gray" to "#808080",
        "grey" to "#808080",
        "light blue" to "#8BD5EE",
        "light green" to "#90EE90",
        "dark blue" to "#00008B",
        "dark green" to "#006400",
        "dark red" to "#8B0000",
        "gold" to "#FFD700",
        "silver" to "#C0C0C0",
        "teal" to "#008080",
        "navy" to "#000080",
        "maroon" to "#800000",
        "olive" to "#808000",
        "lime" to "#00FF00",
        "coral" to "#FF7F50",
        "salmon" to "#FA8072",
        "turquoise" to "#40E0D0",
        "lavender" to "#E6E6FA",
        "beige" to "#F5F5DC",
        "ivory" to "#FFFFF0",
        "tan" to "#D2B48C",
        "peach" to "#FFDAB9",
        "sky blue" to "#87CEEB",
    )

    /**
     * Resolves a human color name (e.g. "white", "sky blue") to a hex code like "#FFFFFF".
     * Returns null when the name is not recognized.
     */
    fun hexForColorName(name: String): String? = NAMED_HEX[name.trim().lowercase()]
}
