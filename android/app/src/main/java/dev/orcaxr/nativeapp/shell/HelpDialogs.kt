package dev.orcaxr.nativeapp.shell

import android.os.Build
import android.os.LocaleList
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.orcaxr.nativeapp.R

/** Dialog showing keyboard shortcuts available in the desktop / keyboard experience. */
@Composable
fun ShortcutsDialog(onDismiss: () -> Unit) {
    val shortcuts = listOf(
        "Ctrl+Z" to R.string.project_undo,
        "Ctrl+Shift+Z" to R.string.project_redo,
        "Ctrl+X" to R.string.project_edit_cut,
        "Ctrl+C" to R.string.project_edit_copy,
        "Ctrl+V" to R.string.project_edit_paste,
        "Delete" to R.string.project_edit_delete_selected,
        "Ctrl+A" to R.string.project_edit_select_all,
        "Escape" to R.string.project_edit_deselect_all,
        "G" to R.string.workspace_tool_move,
        "R" to R.string.workspace_tool_rotate,
        "S" to R.string.workspace_tool_scale,
        "Ctrl+K" to R.string.palette_open,
    )
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.shortcuts_title)) },
        text = {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for ((keys, labelRes) in shortcuts) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(stringResource(labelRes), style = MaterialTheme.typography.bodyMedium)
                        Text(
                            keys,
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.shortcuts_close))
            }
        },
    )
}

/** Dialog showing version, engine provenance and commit information. */
@Composable
fun AboutDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.about_title)) },
        text = {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    stringResource(R.string.about_version, "0.1.0-dev"),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    stringResource(R.string.about_engine),
                    style = MaterialTheme.typography.bodyMedium,
                )
                HorizontalDivider()
                Text(
                    "Snapmaker OrcaSlicer commit 9fd12ffb2b1b80c9fb4c14564754d2ec1573a626",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.about_close))
            }
        },
    )
}

data class SupportedLanguage(val tag: String, val displayName: String, val englishName: String)

val SUPPORTED_LANGUAGES = listOf(
    SupportedLanguage("", "System default", "System default"),
    SupportedLanguage("en", "English", "English"),
    SupportedLanguage("zh-Hans", "简体中文", "Simplified Chinese"),
    SupportedLanguage("zh-Hant", "繁體中文", "Traditional Chinese"),
    SupportedLanguage("de", "Deutsch", "German"),
    SupportedLanguage("es", "Español", "Spanish"),
    SupportedLanguage("fr", "Français", "French"),
    SupportedLanguage("it", "Italiano", "Italian"),
    SupportedLanguage("ja", "日本語", "Japanese"),
    SupportedLanguage("ko", "한국어", "Korean"),
    SupportedLanguage("pt-BR", "Português (Brasil)", "Portuguese (Brazil)"),
    SupportedLanguage("ru", "Русский", "Russian"),
    SupportedLanguage("ca", "Català", "Catalan"),
    SupportedLanguage("cs", "Čeština", "Czech"),
    SupportedLanguage("hu", "Magyar", "Hungarian"),
    SupportedLanguage("lt", "Lietuvių", "Lithuanian"),
    SupportedLanguage("nl", "Nederlands", "Dutch"),
    SupportedLanguage("pl", "Polski", "Polish"),
    SupportedLanguage("sv", "Svenska", "Swedish"),
    SupportedLanguage("tr", "Türkçe", "Turkish"),
    SupportedLanguage("uk", "Українська", "Ukrainian"),
)

/** Language selector dialog for in-app language switching across all 19 supported locales. */
@Composable
fun LanguageDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val currentTag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.getSystemService(android.app.LocaleManager::class.java)?.applicationLocales?.toLanguageTags().orEmpty()
    } else {
        ""
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.help_language)) },
        text = {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                for (lang in SUPPORTED_LANGUAGES) {
                    val isSelected = (lang.tag.isEmpty() && currentTag.isEmpty()) || (lang.tag.isNotEmpty() && currentTag.startsWith(lang.tag))
                    Row(
                        Modifier.fillMaxWidth()
                            .clickable {
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                    val lm = context.getSystemService(android.app.LocaleManager::class.java)
                                    lm?.applicationLocales = if (lang.tag.isEmpty()) LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(lang.tag)
                                }
                                onDismiss()
                            }
                            .padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = isSelected, onClick = null)
                        Column(Modifier.padding(start = 12.dp)) {
                            Text(lang.displayName, style = MaterialTheme.typography.bodyLarge)
                            if (lang.displayName != lang.englishName) {
                                Text(lang.englishName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.device_dismiss))
            }
        },
    )
}
