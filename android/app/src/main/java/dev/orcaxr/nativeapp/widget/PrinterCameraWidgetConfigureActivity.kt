package dev.orcaxr.nativeapp.widget

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.orcaxr.core.AppCredentialVault
import dev.orcaxr.core.PrinterDirectory
import dev.orcaxr.nativeapp.MainActivity
import dev.orcaxr.nativeapp.R
import dev.orcaxr.nativeapp.device.PreferencesTextStore
import dev.orcaxr.nativeapp.theme.OrcaTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

class PrinterCameraWidgetConfigureActivity : ComponentActivity() {

    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID
    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)

        appWidgetId = intent?.extras?.getInt(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID,
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID

        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }

        val store = PreferencesTextStore(this, "orcaxr.printers", "directory")
        val directory = PrinterDirectory.load(store.read())
        val printers = directory.printers

        setContent {
            OrcaTheme(dark = true) {
                Scaffold(
                    containerColor = MaterialTheme.colorScheme.background,
                ) { innerPadding ->
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(innerPadding)
                            .padding(16.dp),
                    ) {
                        if (printers.isEmpty()) {
                            EmptyPrintersState()
                        } else {
                            ConfigureContent(
                                printers = printers.map { entry ->
                                    PrinterItem(
                                        id = text(entry.id),
                                        name = text(entry.name),
                                        host = text(entry.host),
                                        port = entry.port.toInt(),
                                    )
                                },
                            )
                        }
                    }
                }
            }
        }
    }

    private data class PrinterItem(
        val id: String,
        val name: String,
        val host: String,
        val port: Int,
    )

    @Composable
    private fun EmptyPrintersState() {
        Column(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = stringResource(R.string.widget_camera_no_printers),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(modifier = Modifier.height(16.dp))
            Button(
                onClick = {
                    startActivity(Intent(this@PrinterCameraWidgetConfigureActivity, MainActivity::class.java))
                    finish()
                },
            ) {
                Text("Open OrcaXR")
            }
        }
    }

    @Composable
    private fun ConfigureContent(printers: List<PrinterItem>) {
        var selectedPrinterIndex by remember { mutableIntStateOf(0) }
        val selectedPrinter = printers.getOrNull(selectedPrinterIndex) ?: printers.first()

        var webcams by remember { mutableStateOf<List<DiscoveredWebcam>>(emptyList()) }
        var loadingWebcams by remember { mutableStateOf(false) }
        var selectedWebcamUid by remember { mutableStateOf("") }
        var previewBitmap by remember { mutableStateOf<Bitmap?>(null) }
        var loadingPreview by remember { mutableStateOf(false) }

        // Query webcams when selected printer changes
        LaunchedEffect(selectedPrinter) {
            loadingWebcams = true
            webcams = emptyList()
            previewBitmap = null
            withContext(Dispatchers.IO) {
                try {
                    val apiKey = AppCredentialVault.shared(this@PrinterCameraWidgetConfigureActivity).current
                        .printerApiKeys.firstOrNull { text(it.key) == selectedPrinter.id }?.let { text(it.secret) }
                    val list = PrinterCameraDiscovery.queryWebcams(
                        http,
                        selectedPrinter.host,
                        selectedPrinter.port,
                        apiKey,
                    )
                    webcams = list
                    selectedWebcamUid = list.firstOrNull { it.enabled && it.snapshotUrl.isNotEmpty() }?.uid
                        ?: list.firstOrNull()?.uid ?: ""
                } catch (_: Exception) {
                    webcams = emptyList()
                } finally {
                    loadingWebcams = false
                }
            }
        }

        val selectedWebcam = webcams.firstOrNull { it.uid == selectedWebcamUid }

        // Fetch live preview when selected webcam changes
        LaunchedEffect(selectedWebcam, selectedPrinter) {
            if (selectedWebcam == null || selectedWebcam.snapshotUrl.isEmpty()) {
                previewBitmap = null
                return@LaunchedEffect
            }
            loadingPreview = true
            withContext(Dispatchers.IO) {
                try {
                    val apiKey = AppCredentialVault.shared(this@PrinterCameraWidgetConfigureActivity).current
                        .printerApiKeys.firstOrNull { text(it.key) == selectedPrinter.id }?.let { text(it.secret) }
                    val candidates = PrinterCameraDiscovery.resolveCandidateUrls(
                        selectedPrinter.host,
                        selectedPrinter.port,
                        selectedWebcam.snapshotUrl,
                    )
                    var foundBitmap: Bitmap? = null
                    for (candidate in candidates) {
                        try {
                            val url = if (candidate.contains("?")) {
                                "$candidate&orcaxr_preview=${System.currentTimeMillis()}"
                            } else {
                                "$candidate?orcaxr_preview=${System.currentTimeMillis()}"
                            }
                            val builder = Request.Builder().url(url)
                            if (!apiKey.isNullOrBlank()) {
                                builder.header("X-Api-Key", apiKey.trim())
                            }
                            val response = http.newCall(builder.build()).execute()
                            if (response.isSuccessful) {
                                val bytes = response.body?.bytes()
                                if (bytes != null && bytes.isNotEmpty()) {
                                    val opts = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.RGB_565 }
                                    foundBitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
                                    break
                                }
                            }
                        } catch (_: Exception) {
                        }
                    }
                    previewBitmap = foundBitmap
                } catch (_: Exception) {
                    previewBitmap = null
                } finally {
                    loadingPreview = false
                }
            }
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = stringResource(R.string.widget_camera_configure_title),
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onBackground,
            )

            // Printer selector Card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = stringResource(R.string.widget_camera_select_printer),
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    printers.forEachIndexed { index, printer ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { selectedPrinterIndex = index }
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = selectedPrinterIndex == index,
                                onClick = { selectedPrinterIndex = index },
                            )
                            Column(modifier = Modifier.padding(start = 8.dp)) {
                                Text(
                                    text = printer.name,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    text = "${printer.host}:${printer.port}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                                )
                            }
                        }
                    }
                }
            }

            // Camera selector Card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = stringResource(R.string.widget_camera_select_camera),
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (loadingWebcams) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
                            horizontalArrangement = Arrangement.Center,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            CircularProgressIndicator(modifier = Modifier.size(24.dp))
                            Spacer(modifier = Modifier.size(12.dp))
                            Text(
                                text = stringResource(R.string.widget_camera_loading),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else if (webcams.isEmpty()) {
                        Text(
                            text = stringResource(R.string.widget_camera_no_cameras),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.error,
                        )
                    } else {
                        webcams.forEach { webcam ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { selectedWebcamUid = webcam.uid }
                                    .padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(
                                    selected = selectedWebcamUid == webcam.uid,
                                    onClick = { selectedWebcamUid = webcam.uid },
                                )
                                Column(modifier = Modifier.padding(start = 8.dp)) {
                                    Text(
                                        text = "${webcam.name} (${webcam.service})",
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                    Text(
                                        text = "${webcam.aspectRatio} · ${webcam.targetFps} fps",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Live preview Card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = stringResource(R.string.widget_camera_preview_header),
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .aspectRatio(16f / 9f)
                            .clip(RoundedCornerShape(8.dp))
                            .background(MaterialTheme.colorScheme.surface),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (loadingPreview) {
                            CircularProgressIndicator(modifier = Modifier.size(32.dp))
                        } else if (previewBitmap != null) {
                            Image(
                                bitmap = previewBitmap!!.asImageBitmap(),
                                contentDescription = selectedWebcam?.name,
                                modifier = Modifier.fillMaxSize(),
                                contentScale = ContentScale.Fit,
                            )
                        } else {
                            Text(
                                text = stringResource(R.string.widget_camera_error),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                            )
                        }
                    }
                }
            }

            // Action button
            Button(
                onClick = {
                    val config = CameraWidgetConfig(
                        printerId = selectedPrinter.id,
                        printerName = selectedPrinter.name,
                        printerHost = selectedPrinter.host,
                        printerPort = selectedPrinter.port,
                        cameraUid = selectedWebcam?.uid ?: "default",
                        cameraName = selectedWebcam?.name.orEmpty(),
                        cameraSnapshotUrl = selectedWebcam?.snapshotUrl,
                    )
                    PrinterCameraWidgetPrefs.saveConfig(
                        this@PrinterCameraWidgetConfigureActivity,
                        appWidgetId,
                        config,
                    )
                    PrinterCameraWidgetFetcher.fetchAndUpdateAsync(
                        this@PrinterCameraWidgetConfigureActivity,
                        appWidgetId,
                    )
                    val resultValue = Intent().apply {
                        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                    }
                    setResult(RESULT_OK, resultValue)
                    finish()
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = selectedWebcam != null,
            ) {
                Text(stringResource(R.string.widget_camera_add_widget))
            }

            Spacer(modifier = Modifier.height(24.dp))
        }
    }
}
