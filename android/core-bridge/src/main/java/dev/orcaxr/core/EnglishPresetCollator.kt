package dev.orcaxr.core

import android.icu.text.Collator
import android.icu.util.ULocale

/** The browser's `localeCompare(…, 'en')` on Android: ICU's English collator
 * at its defaults (tertiary strength, punctuation not ignored), as Chrome's
 * ICU compares. Frozen, so the building thread may use it freely. */
class EnglishPresetCollator : PresetCollator {
    private val collator: Collator = Collator.getInstance(ULocale.ENGLISH).freeze()

    override fun compare(left: CharArray, right: CharArray): Int = collator.compare(String(left), String(right))
}
