package dev.orcaxr.nativeapp

import android.icu.number.NumberFormatter
import android.icu.number.Precision
import androidx.annotation.PluralsRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.pluralStringResource
import java.math.RoundingMode
import java.util.Locale

/**
 * The arguments of resources carried from the browser's message catalogues
 * (`contracts/android-strings.json`). Every argument of such a resource is
 * text (`%1$s`) that the caller formats as the browser's `icu.ts` would: a
 * plain `{name}` is the value's own text, and a number — a plural's `#`, a
 * `{n, number}` — is the locale's `Intl.NumberFormat` with at most two
 * fraction digits, rounding half away from zero, which ICU's
 * `NumberFormatter` reproduces from the same CLDR data. A plural's form is
 * chosen by the integer quantity, by the same CLDR rules as the browser's
 * `Intl.PluralRules`. For display only: nothing formatted here is canonical.
 */
object MessageArguments {
    /** A number as the browser's messages write it in [locale]. */
    fun number(value: Long, locale: Locale): String =
        NumberFormatter.withLocale(locale)
            .precision(Precision.maxFraction(2))
            .roundingMode(RoundingMode.HALF_UP)
            .format(value)
            .toString()
}

/** A carried plural message whose only argument is its [count] (`{count, plural, … # …}`). */
@Composable
fun pluralMessage(@PluralsRes id: Int, count: Int): String =
    pluralStringResource(id, count, MessageArguments.number(count.toLong(), LocalConfiguration.current.locales[0]))
