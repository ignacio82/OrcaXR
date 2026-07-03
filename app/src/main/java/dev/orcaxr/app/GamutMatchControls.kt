package dev.orcaxr.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoFixHigh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Shared review-before-apply control for remapping authored model colors
 * to the active printer's physical spool colors plus FullSpectrum blend
 * candidates. The caller owns persistence because XR and mobile use
 * different store plumbing.
 */
@Composable
internal fun GamutMatchButton(
    sourceModelColors: List<String>,
    physicalSlotColors: List<String>,
    onApply: (List<GamutMatcher.GamutMatch>) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (sourceModelColors.isEmpty() || physicalSlotColors.isEmpty()) return

    var gamutPreview by remember(sourceModelColors, physicalSlotColors) {
        mutableStateOf<List<GamutMatcher.GamutMatch>?>(null)
    }

    OutlinedButton(
        onClick = {
            gamutPreview = GamutMatcher.matchModelColors(
                sourceColors = sourceModelColors,
                physicalColors = physicalSlotColors,
            )
        },
        modifier = modifier,
    ) {
        Icon(Icons.Filled.AutoFixHigh, contentDescription = null)
        Spacer(Modifier.width(8.dp))
        Text("Match to filaments")
    }

    gamutPreview?.let { matches ->
        GamutMatchDialog(
            matches = matches,
            onApply = {
                onApply(matches)
                gamutPreview = null
            },
            onDismiss = { gamutPreview = null },
        )
    }
}

private fun parseUiColor(hex: String): Color = runCatching {
    Color(android.graphics.Color.parseColor(hex))
}.getOrDefault(Color(0xFF888888))

@Composable
private fun GamutMatchDialog(
    matches: List<GamutMatcher.GamutMatch>,
    onApply: () -> Unit,
    onDismiss: () -> Unit,
) {
    fun qualityLabel(q: GamutMatcher.MatchQuality): Pair<String, Color> = when (q) {
        GamutMatcher.MatchQuality.EXACT -> "Exact" to Color(0xFF4FC97A)
        GamutMatcher.MatchQuality.CLOSE -> "Close" to Color(0xFF7BC8FF)
        GamutMatcher.MatchQuality.APPROXIMATE -> "Approx" to Color(0xFFFFB04A)
        GamutMatcher.MatchQuality.OUT_OF_GAMUT -> "Best effort" to Color(0xFFFF8A8E)
    }

    fun recipeText(r: GamutMatcher.GamutRecipe): String = when (r) {
        is GamutMatcher.GamutRecipe.Physical -> "-> T${r.physicalSlot0} (loaded spool)"
        is GamutMatcher.GamutRecipe.Blend ->
            "-> FullSpectrum: T${r.componentA1 - 1} + T${r.componentB1 - 1} " +
                "(${100 - r.mixBPercent}/${r.mixBPercent})"
        GamutMatcher.GamutRecipe.Keep -> "-> kept (no usable match)"
    }

    val anyBlend = matches.any { it.recipe is GamutMatcher.GamutRecipe.Blend }

    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            Button(onClick = onApply) { Text("Apply matches") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
        title = { Text("Match to filaments") },
        text = {
            Column(
                modifier = Modifier
                    .heightIn(max = 460.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "Each model color is remapped to the closest color your " +
                        "loaded filaments can make. Delta E is the perceptual error.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color.LightGray,
                )
                matches.forEach { match ->
                    val (quality, qualityColor) = qualityLabel(match.quality)
                    Surface(
                        color = Color(0xFF1B1F23),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.padding(10.dp).fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            androidx.compose.foundation.layout.Box(
                                modifier = Modifier
                                    .size(22.dp)
                                    .background(parseUiColor(match.sourceHex), CircleShape),
                            )
                            Text(
                                "  ->  ",
                                color = Color.Gray,
                                style = MaterialTheme.typography.bodySmall,
                            )
                            androidx.compose.foundation.layout.Box(
                                modifier = Modifier
                                    .size(22.dp)
                                    .background(parseUiColor(match.targetHex), CircleShape),
                            )
                            Spacer(Modifier.width(10.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    recipeText(match.recipe),
                                    color = Color.White,
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                Text(
                                    if (match.deltaE >= Double.MAX_VALUE / 2) quality
                                    else "$quality - Delta E ${"%.1f".format(match.deltaE)}",
                                    color = qualityColor,
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                        }
                    }
                }
                if (anyBlend) {
                    Text(
                        "FullSpectrum blend rows will be saved for the selected " +
                            "printer and used by the slice path when mapped colors print.",
                        style = MaterialTheme.typography.labelSmall,
                        color = Color(0xFFFFB04A),
                    )
                }
                Text(
                    "A blended color reads as a third color at viewing distance " +
                        "and on flat top surfaces; vertical walls may show banding.",
                    style = MaterialTheme.typography.labelSmall,
                    color = Color.Gray,
                )
            }
        },
        containerColor = Color(0xFF15181B),
        titleContentColor = Color.White,
        textContentColor = Color.White,
    )
}
