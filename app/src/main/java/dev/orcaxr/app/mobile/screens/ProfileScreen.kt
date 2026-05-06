package dev.orcaxr.app.mobile.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.orcaxr.app.OrcaProfileLoader
import dev.orcaxr.app.Profiles
import dev.orcaxr.app.SlicerProfile
import dev.orcaxr.app.mobile.LocalMobileAppState
import dev.orcaxr.app.mobile.LocalMobileTextStyles
import dev.orcaxr.app.mobile.MobileCard
import dev.orcaxr.app.mobile.MobileTopBar
import dev.orcaxr.app.mobile.SectionKicker
import dev.orcaxr.app.mobile.StatusPill

/**
 * Profile picker — every printer × quality × filament combo bundled
 * with the app, plus user-saved profiles. Tapping a card sets it as
 * the active profile (used by the Slicer screen on next slice).
 *
 * Tablet: two-column grid. Phone: single column.
 */
@Composable
fun ProfileScreen(isTablet: Boolean) {
    val app = LocalMobileAppState.current
    val ctx = LocalContext.current
    val userProfiles by app.userProfiles.profiles.collectAsState(initial = emptyList())
    val bundled = remember { OrcaProfileLoader.loadCatalog(ctx) }
    val all = remember(userProfiles, bundled) { bundled + Profiles.all + userProfiles + listOf(Profiles.default) }

    var selectedId by remember { mutableStateOf(app.prefs.lastProfileId ?: Profiles.default.id) }

    // Group: User / by machineName / Other
    val grouped = remember(all) {
        val groups = linkedMapOf<String, MutableList<SlicerProfile>>()
        for (p in all) {
            val key = when {
                p.machineName == null -> "User-saved"
                else -> p.machineName
            }
            groups.getOrPut(key) { mutableListOf() }.add(p)
        }
        groups
    }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        MobileTopBar(
            title = "Profiles",
            subtitle = "${all.size} bundled & saved",
        )
        LazyColumn(
            contentPadding = androidx.compose.foundation.layout.PaddingValues(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            for ((groupName, items) in grouped) {
                item {
                    Spacer(Modifier.height(4.dp))
                    SectionKicker(groupName)
                }
                if (isTablet) {
                    items(items.chunked(2)) { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            for (p in row) Box(Modifier.weight(1f)) {
                                ProfileCardView(p, p.id == selectedId, onSelect = {
                                    selectedId = p.id
                                    app.prefs.lastProfileId = p.id
                                })
                            }
                            if (row.size == 1) Box(Modifier.weight(1f))
                        }
                    }
                } else {
                    items(items) { p ->
                        ProfileCardView(p, p.id == selectedId, onSelect = {
                            selectedId = p.id
                            app.prefs.lastProfileId = p.id
                        })
                    }
                }
            }
        }
    }
}

@Composable
private fun ProfileCardView(p: SlicerProfile, selected: Boolean, onSelect: () -> Unit) {
    MobileCard(onClick = onSelect) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(
                        p.displayName,
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        p.description,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (selected) StatusPill("Active", MaterialTheme.colorScheme.primary)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ProfileTag("Layer", p.config["layer_height"]?.let { "$it mm" } ?: "—")
                ProfileTag("Walls", p.config["wall_loops"] ?: "—")
                ProfileTag("Infill", p.config["sparse_infill_density"] ?: "—")
                ProfileTag("Material", p.filamentName?.take(14) ?: p.config["filament_type"] ?: "—")
            }
        }
    }
}

@Composable
private fun ProfileTag(label: String, value: String) {
    Column {
        Text(
            label.uppercase(),
            style = LocalMobileTextStyles.current.sectionLabel,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            value,
            style = LocalMobileTextStyles.current.numeric,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
