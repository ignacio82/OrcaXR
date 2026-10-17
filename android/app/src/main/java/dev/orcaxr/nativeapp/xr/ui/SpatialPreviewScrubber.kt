package dev.orcaxr.nativeapp.xr.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.GcodePreviewModes
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.preview.PreviewModel
import dev.orcaxr.nativeapp.preview.PreviewState

/**
 * Spatial Preview Scrubber for Android XR Full Space, matching the WebXR
 * XrPreviewScrubber design.
 *
 * Positioned low at the near edge of the build plate (-28° elevation, 0.9 m radius),
 * providing layer scrubbing, view mode selection, single-layer isolation, and move stepping.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SpatialPreviewScrubber(
    model: PreviewModel,
    modifier: Modifier = Modifier,
    isPinned: Boolean = false,
    onTogglePin: () -> Unit = {}
) {
    val state = model.state
    val bounds = state.layerBounds ?: return
    val (low, high) = state.layerRange ?: bounds

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .spatialPanel(),
        color = Color.Transparent,
        shape = RoundedCornerShape(XrSpatialTokens.CornerRadiusParent)
    ) {
        Column(
            modifier = Modifier
                .padding(XrSpatialTokens.PanelPadding),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            // Header: Title, Layer indicator, Z-height, and Pin toggle
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(
                        text = stringResource(R.string.xr_preview_scrubber_title),
                        style = MaterialTheme.typography.titleMedium,
                        color = XrSpatialTokens.ColorText,
                        modifier = Modifier.semantics { heading() }
                    )
                    Text(
                        text = stringResource(R.string.preview_layer_of, high, bounds.second),
                        style = MaterialTheme.typography.titleSmall,
                        color = XrSpatialTokens.ColorMintBright
                    )
                    state.topZMm?.let { z ->
                        Text(
                            text = "%.2f mm".format(z),
                            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                            color = XrSpatialTokens.ColorTextMuted
                        )
                    }
                }

                IconButton(
                    onClick = onTogglePin,
                    modifier = Modifier.size(40.dp)
                ) {
                    Icon(
                        painter = painterResource(
                            if (isPinned) R.drawable.ic_symbol_commit else R.drawable.ic_symbol_crop_free
                        ),
                        contentDescription = stringResource(
                            if (isPinned) R.string.xr_action_unpin else R.string.xr_action_pin
                        ),
                        tint = if (isPinned) XrSpatialTokens.ColorMint else XrSpatialTokens.ColorTextMuted
                    )
                }
            }

            // Layer scrubbing slider with minimum 58dp height touch target
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = XrSpatialTokens.MinTouchTarget),
                contentAlignment = Alignment.Center
            ) {
                Slider(
                    value = high.toFloat(),
                    onValueChange = { model.setTopLayer(it.toInt()) },
                    valueRange = bounds.first.toFloat()..bounds.second.toFloat(),
                    enabled = !state.loading,
                    colors = SliderDefaults.colors(
                        thumbColor = XrSpatialTokens.ColorMint,
                        activeTrackColor = XrSpatialTokens.ColorMintDeep,
                        inactiveTrackColor = XrSpatialTokens.ColorLineStrong
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { contentDescription = "Layer scrubber: layer $high of ${bounds.second}" }
                )
            }

            // Preview Modes (Feature type, Tool, Layer height, Feed rate, Fan speed, Temperature)
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                for (id in GcodePreviewModes.ids) {
                    val modeInfo = GcodePreviewModes.get(id)
                    val isSelected = id == state.mode
                    FilterChip(
                        selected = isSelected,
                        onClick = { if (!isSelected) model.setMode(id) },
                        label = { Text(modeInfo.label) },
                        enabled = !state.loading,
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = XrSpatialTokens.ColorMint.copy(alpha = 0.25f),
                            selectedLabelColor = XrSpatialTokens.ColorMintBright,
                            containerColor = XrSpatialTokens.ColorPanelSoft,
                            labelColor = XrSpatialTokens.ColorText
                        )
                    )
                }
            }

            // Controls row: Single layer toggle and windowed move stepping
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .toggleable(
                            value = state.singleLayer,
                            enabled = !state.loading,
                            role = Role.Checkbox,
                            onValueChange = model::setSingleLayer
                        )
                        .padding(4.dp)
                ) {
                    Checkbox(
                        checked = state.singleLayer,
                        onCheckedChange = null,
                        enabled = !state.loading,
                        colors = CheckboxDefaults.colors(
                            checkedColor = XrSpatialTokens.ColorMint,
                            checkmarkColor = XrSpatialTokens.ColorBgDeep
                        )
                    )
                    Text(
                        text = stringResource(R.string.preview_single_layer),
                        style = MaterialTheme.typography.bodyMedium,
                        color = XrSpatialTokens.ColorText,
                        modifier = Modifier.padding(start = 8.dp)
                    )
                }

                if (state.windowed) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = { model.step(-1) },
                            enabled = !state.loading && state.hasPrevious
                        ) {
                            Text(stringResource(R.string.preview_previous_moves))
                        }
                        OutlinedButton(
                            onClick = { model.step(1) },
                            enabled = !state.loading && state.hasNext
                        ) {
                            Text(stringResource(R.string.preview_next_moves))
                        }
                    }
                }
            }
        }
    }
}
