package dev.orcaxr.nativeapp.shell

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import dev.orcaxr.nativeapp.theme.LocalOrcaTheme
import dev.orcaxr.nativeapp.theme.OrcaThemes
import dev.orcaxr.nativeapp.theme.OrcaTokens

/** One area of the shell's navigation: its name and its icon. */
class ShellDestination(@StringRes val label: Int, @DrawableRes val icon: Int)

/**
 * The bottom bar of a compact window: the areas in order, each its icon and
 * its whole name, the shown one marked as the browser marks its active tab (the
 * accent with on-accent ink). Names are never cut: when they do not fit one row
 * at the text size in force — enlarged text, a long language — the bar takes a
 * second row ([NavigationRows]). It sits on the window chrome above the system
 * navigation bar.
 */
@Composable
fun ShellBar(destinations: List<ShellDestination>, selected: Int, onSelect: (Int) -> Unit) {
    Surface(color = LocalOrcaTheme.current.chrome, contentColor = MaterialTheme.colorScheme.onSurface) {
        Column {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Layout(
                content = { for (destination in destinations) ShellItem(destination, destination.label == selected, onSelect) },
                // Clear of the system's navigation bar and, in landscape, of a camera cutout at its side.
                modifier = Modifier.windowInsetsPadding(
                    WindowInsets.navigationBars.union(WindowInsets.displayCutout).only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom),
                ).selectableGroup(),
            ) { items, constraints ->
                val available = constraints.maxWidth
                val natural = items.map { it.maxIntrinsicWidth(Constraints.Infinity) }
                var next = 0
                val rows = NavigationRows.arrange(natural, available).map { widths ->
                    val row = items.subList(next, next + widths.size).also { next += widths.size }
                    val height = row.indices.maxOf { row[it].maxIntrinsicHeight(widths[it]) }
                    row.indices.map { row[it].measure(Constraints.fixed(widths[it], height)) }
                }
                layout(available, rows.sumOf { row -> row.maxOf { it.height } }) {
                    var y = 0
                    for (row in rows) {
                        var x = 0
                        for (item in row) {
                            item.placeRelative(x, y)
                            x += item.width
                        }
                        y += row.maxOf { it.height }
                    }
                }
            }
        }
    }
}

/**
 * The navigation rail of a medium or expanded window: the areas down the start
 * edge, as wide as the widest name needs (at least Material's 80 dp, at most a
 * third of the window, where a name wraps), scrolling when enlarged text makes
 * them taller than the window.
 */
@Composable
fun ShellRail(destinations: List<ShellDestination>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val widest = (LocalWindowInfo.current.containerDpSize.width.value / 3).coerceAtLeast(RAIL_MIN_DP.toFloat())
    Surface(modifier.fillMaxHeight(), color = LocalOrcaTheme.current.chrome, contentColor = MaterialTheme.colorScheme.onSurface) {
        Row {
            Column(
                Modifier.width(IntrinsicSize.Max).widthIn(min = RAIL_MIN_DP.dp, max = widest.dp).fillMaxHeight()
                    .verticalScroll(rememberScrollState()).selectableGroup().padding(vertical = OrcaTokens.SPACE_SM.dp),
                verticalArrangement = Arrangement.spacedBy(OrcaTokens.SPACE_XS.dp),
            ) {
                for (destination in destinations) ShellItem(destination, destination.label == selected, onSelect, Modifier.fillMaxWidth())
            }
            VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

/** One area: its icon in the indicator (filled with the accent when shown) over its name, a tab in its group. */
@Composable
private fun ShellItem(destination: ShellDestination, selected: Boolean, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Column(
        modifier.widthIn(min = MIN_TOUCH_DP.dp)
            .selectable(selected = selected, onClick = { onSelect(destination.label) }, role = Role.Tab)
            .padding(horizontal = ITEM_PADDING_DP.dp, vertical = OrcaTokens.SPACE_SM.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(OrcaTokens.SPACE_XS.dp),
    ) {
        Box(
            Modifier.widthIn(max = INDICATOR_DP.dp).fillMaxWidth().height(32.dp)
                .background(if (selected) colors.primary else Color.Transparent, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(painterResource(destination.icon), contentDescription = null, tint = if (selected) colors.onPrimary else colors.onSurfaceVariant)
        }
        Text(
            stringResource(destination.label),
            style = OrcaThemes.style(OrcaTokens.type.tab),
            color = if (selected) colors.onSurface else colors.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

private const val RAIL_MIN_DP = 80
private const val MIN_TOUCH_DP = 48
private const val INDICATOR_DP = 64
/** Room either side of a name: small, so five names fit a phone's width at the usual size. */
private const val ITEM_PADDING_DP = 2
