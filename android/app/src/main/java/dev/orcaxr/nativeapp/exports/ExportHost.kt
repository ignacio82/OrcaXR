package dev.orcaxr.nativeapp.exports

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import dev.orcaxr.nativeapp.prepare.PrepareCommands
import dev.orcaxr.nativeapp.prepare.PrepareModel

/** "Create a document" with the export's own name and media type (the platform's contract fixes the type at construction). */
private class CreateExportDocument : ActivityResultContract<ExportRequest.Document, Uri?>() {
    override fun createIntent(context: Context, input: ExportRequest.Document): Intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(input.mediaType)
            .putExtra(Intent.EXTRA_TITLE, input.filename)

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? = intent?.data?.takeIf { resultCode == Activity.RESULT_OK }
}

/**
 * Where the exports meet the system, whichever area is shown: the picker an
 * export asks for (a document under the browser's name and type, or a folder
 * for every plate's G-code), Export All Plates' Slice All Plates handed to
 * the Prepare area ([run], as the menus run it), and each outcome shown once
 * through [show] — the browser's status line.
 */
@Composable
fun ExportHost(exports: ExportModel, prepare: PrepareModel, show: (String) -> Unit, run: (String) -> Unit) {
    val document = rememberLauncherForActivityResult(CreateExportDocument()) { uri -> exports.request?.let { exports.picked(it, uri) } }
    val folder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri -> exports.request?.let { exports.picked(it, uri) } }
    val request = exports.request
    LaunchedEffect(request) {
        if (request == null || exports.launched == request.serial) return@LaunchedEffect
        exports.launching(request)
        when (request) {
            is ExportRequest.Document -> document.launch(request)
            is ExportRequest.Folder -> folder.launch(null)
        }
    }
    val slice = exports.sliceRequest
    LaunchedEffect(slice) {
        if (slice == null) return@LaunchedEffect
        exports.sliceAsked()
        run(PrepareCommands.SLICE_ALL)
    }
    val ended = prepare.ended
    LaunchedEffect(ended) { exports.sliceEnded(ended) }
    val context = LocalContext.current
    val status = exports.status
    LaunchedEffect(status) {
        status ?: return@LaunchedEffect
        exports.statusShown(status)
        show(ExportCommands.text(status.words, context::getString))
    }
}
