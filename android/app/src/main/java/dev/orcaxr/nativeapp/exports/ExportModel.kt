package dev.orcaxr.nativeapp.exports

import android.app.Application
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import dev.orcaxr.core.ContentProjectDocument
import dev.orcaxr.core.ExportNameKind
import dev.orcaxr.core.ModelExports
import dev.orcaxr.core.ProjectDocumentException
import dev.orcaxr.core.ProjectArchiveExport
import dev.orcaxr.core.ProjectDocumentOutput
import dev.orcaxr.core.ProjectDocuments
import dev.orcaxr.core.StlExport
import dev.orcaxr.nativeapp.prepare.PrepareModel
import dev.orcaxr.nativeapp.project.ProjectModel
import java.io.File
import java.text.NumberFormat
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Future

/** What the shell asks the system's picker for on behalf of an export; [serial] tells two equal asks apart. */
sealed interface ExportRequest {
    val id: String
    val serial: Int

    /** One document, created as [filename] with [mediaType]. */
    data class Document(override val id: String, val filename: String, val mediaType: String, override val serial: Int) : ExportRequest

    /** A folder to create one document per sliced plate in. */
    data class Folder(override val id: String, override val serial: Int) : ExportRequest
}

/** A status the shell shows once (the browser's status line); [serial] tells equal words apart. */
data class ExportStatus(val words: ExportWords, val serial: Int)

/**
 * The browser's File menu exports and Download actions on Android: the
 * published G-code ([ExportCommands.DOWNLOAD], [ExportCommands.EXPORT_GCODE]),
 * every sliced plate's G-code into a folder ([ExportCommands.DOWNLOAD_ALL],
 * and [ExportCommands.EXPORT_ALL_PLATES], which first slices every plate when
 * their results are not the project's), the STLs
 * ([ExportCommands.EXPORT_STL], [ExportCommands.EXPORT_ALL_STLS]), the project
 * as a 3MF ([ExportCommands.EXPORT_3MF]) and the chosen profile's
 * configuration ([ExportCommands.EXPORT_CONFIG]) — each the same bytes the
 * browser downloads, under its name.
 *
 * What is written is fixed when the action is chosen, as the browser's
 * download is: a model export is written by the shared core, after every
 * queued edit has settled, into a private staging file before the system's
 * picker is asked for a place (a refusal asks for none), and the G-code is
 * the published file, whose currency is checked again before it is copied.
 * Copies run on one worker, never the main thread; a provider failure (a
 * full device, a revoked grant) is reported in words and the half-written
 * document removed. One export at a time.
 */
class ExportModel(application: Application) : AndroidViewModel(application) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "export-model") }
    private val resolver = application.contentResolver
    private val staging = File(application.cacheDir, "exports")
    private lateinit var project: ProjectModel
    private lateinit var prepare: PrepareModel

    /** Whether an export is being prepared or written. */
    var busy by mutableStateOf(false)
        private set

    /** The picker the shell is to show now. */
    var request by mutableStateOf<ExportRequest?>(null)
        private set

    /** The last outcome, for the shell to show once. */
    var status by mutableStateOf<ExportStatus?>(null)
        private set

    /** Export All Plates' Slice All Plates for the shell to run in the Prepare area (its serial), once. */
    var sliceRequest by mutableStateOf<Int?>(null)
        private set

    /** The [request] whose picker the shell has shown: a window recreated while it is up does not show it again. */
    var launched: Int? = null
        private set

    /** What the next picker answer is for. Main thread. */
    private var pending: Pending? = null
    /** The Prepare area's [PrepareModel.ended] when Export All Plates asked it to slice; null when not waiting. */
    private var awaiting: Int? = null
    @Volatile private var cancelled = false
    private var task: Future<*>? = null
    private var serial = 0

    private sealed interface Pending {
        val id: String

        /** The published G-code, while [current]. */
        class Gcode(override val id: String, val file: File, val current: () -> Boolean) : Pending

        /** Every sliced plate's G-code ([files], with the names they are written under), while [current]. */
        class Plates(override val id: String, val files: List<Pair<String, File>>, val current: () -> Boolean) : Pending

        /** A model export written to [file] by the core; [done] says what the status line says once it is saved. */
        class Staged(override val id: String, val file: File, val done: ExportWords) : Pending
    }

    fun bind(project: ProjectModel, prepare: PrepareModel) {
        this.project = project
        this.prepare = prepare
        worker.execute { staging.listFiles()?.forEach { it.delete() } }
    }

    private fun show(words: ExportWords) {
        status = ExportStatus(words, ++serial)
    }

    /** Runs export [id] (one of [ExportCommands.IDS]) as the browser's menu does. Main thread. */
    fun perform(id: String) {
        require(id in ExportCommands.IDS) { "$id is not one of the exports" }
        if (busy || request != null) return show(ExportWords(text = ExportCommands.BUSY))
        when {
            ExportCommands.isGcode(id) -> {
                val slice = prepare.sendable() ?: return show(ExportCommands.STALE)
                ask(Pending.Gcode(id, slice.file, slice.isCurrent), document(id, ModelExports.GCODE_FILENAME))
            }
            id == ExportCommands.DOWNLOAD_ALL -> downloadAll(id)
            id == ExportCommands.EXPORT_ALL_PLATES -> when {
                project.view.plateList.sumOf { it.objects } == 0 -> show(ExportCommands.NOTHING_TO_SLICE)
                prepare.publishedPlates().isNotEmpty() -> downloadAll(id)
                else -> {
                    // As the browser's exportAllPlates: slice every plate first, then download them.
                    awaiting = prepare.ended
                    busy = true
                    sliceRequest = ++serial
                }
            }
            else -> stage(id)
        }
    }

    /** The shell asked the Prepare area for Export All Plates' Slice All Plates. */
    fun sliceAsked() {
        sliceRequest = null
    }

    /** The shell showed [request]'s picker. */
    fun launching(request: ExportRequest) {
        launched = request.serial
    }

    /** The shell showed [shown]; it is not shown again. */
    fun statusShown(shown: ExportStatus) {
        if (status == shown) status = null
    }

    /** A slice request ended in the Prepare area ([PrepareModel.ended]): Export All Plates goes on with what it published, or stops. */
    fun sliceEnded(ended: Int) {
        val before = awaiting ?: return
        if (ended == before) return
        awaiting = null
        busy = false
        // A failed or declined slice says why in the Prepare area, as the browser's status does.
        if (prepare.publishedPlates().isNotEmpty()) downloadAll(ExportCommands.EXPORT_ALL_PLATES)
    }

    /** Download All Plates: every plate's result of the last Slice All Plates, still the project's, one file each. */
    private fun downloadAll(id: String) {
        val plates = prepare.state.plates
        if (plates.isEmpty()) return show(ExportCommands.SLICE_ALL_FIRST)
        if (prepare.publishedPlates().isEmpty()) return show(ExportCommands.STALE)
        val files = plates.map { ModelExports.filename(ExportNameKind.PLATE_GCODE, it.plateName) to it.file }
        ask(Pending.Plates(id, files) { prepare.publishedPlates() == plates }, ExportRequest.Folder(id, ++serial))
    }

    /** A document to create for [id] as [filename], with the type that keeps its name ([ExportCommands.documentType]). */
    private fun document(id: String, filename: String) = ExportRequest.Document(id, filename, type(filename), ++serial)

    private fun type(filename: String) = ExportCommands.documentType(filename) { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }

    private fun ask(what: Pending, picker: ExportRequest) {
        pending = what
        request = picker
    }

    /** What a model export staged: the name to offer and what to say once saved, or the browser's refusal. */
    private class Staging(val filename: String?, val words: ExportWords)

    /** A model export: written by the core into a staging file first, then offered under the browser's name. */
    private fun stage(id: String) {
        busy = true
        val file = File(staging, "staged-${++serial}")
        val output = object : ProjectDocumentOutput {
            override fun openOutput() = file.outputStream()
        }
        val refused = { message: String ->
            when (id) {
                ExportCommands.EXPORT_3MF -> ExportCommands.failed3mf(message)
                ExportCommands.EXPORT_CONFIG -> ExportWords(text = message)
                else -> ExportCommands.stlRefused(id, message)
            }
        }
        task = worker.submit {
            val staged = try {
                staging.mkdirs()
                if (id == ExportCommands.EXPORT_CONFIG) {
                    // The chosen profile's file as the project worker holds it, after every choice asked before.
                    when (val json = project.exportConfig().get()) {
                        null -> Staging(null, ExportCommands.NO_PROFILE)
                        else -> {
                            file.writeText(json, Charsets.UTF_8)
                            Staging(ExportCommands.CONFIG_FILENAME, ExportCommands.EXPORTED_CONFIG)
                        }
                    }
                } else if (id == ExportCommands.EXPORT_3MF) {
                    when (val answer = project.export3mf(output).get()) {
                        is ProjectArchiveExport.Written -> Staging(answer.filename, ExportCommands.EXPORTED_3MF)
                        is ProjectArchiveExport.Refused -> Staging(null, ExportCommands.failed3mf(answer.code))
                    }
                } else {
                    when (val answer = project.exportStl(id == ExportCommands.EXPORT_ALL_STLS, output).get()) {
                        is StlExport.Written -> Staging(answer.filename, ExportCommands.stlWritten(id, answer) { NumberFormat.getIntegerInstance().format(it) })
                        is StlExport.Refused -> Staging(null, ExportCommands.stlRefused(id, answer.message))
                    }
                }
            } catch (failure: Throwable) {
                val cause = unwrap(failure)
                Staging(null, refused(cause.message ?: cause.javaClass.simpleName))
            }
            if (staged.filename == null) file.delete()
            main.post {
                busy = false
                if (staged.filename == null) show(staged.words) else ask(Pending.Staged(id, file, staged.words), document(id, staged.filename))
            }
        }
    }

    /** The picker's answer for [asked]: where to write it, or nothing (dismissed). Main thread. */
    fun picked(asked: ExportRequest, uri: Uri?) {
        if (request != asked) return
        request = null
        val what = pending ?: return
        pending = null
        if (uri == null) {
            if (what is Pending.Staged) worker.execute { what.file.delete() }
            return
        }
        busy = true
        cancelled = false
        task = worker.submit {
            val words = try {
                when (what) {
                    is Pending.Gcode -> {
                        if (!what.current()) {
                            delete(uri)
                            ExportCommands.STALE
                        } else {
                            write(uri, what.file)
                            ExportCommands.saved(displayName(uri))
                        }
                    }
                    is Pending.Staged -> try {
                        write(uri, what.file)
                        what.done
                    } finally {
                        what.file.delete()
                    }
                    is Pending.Plates -> if (!what.current()) ExportCommands.STALE else writePlates(uri, what.files)
                }
            } catch (failure: Failed) {
                failure.words
            }
            main.post {
                busy = false
                show(words)
            }
        }
    }

    /** A write that failed, in the words to show. */
    private class Failed(val words: ExportWords) : Exception(words.text)

    /** [source] copied into the document [uri]; a failure removes the document and is reported by its name. */
    private fun write(uri: Uri, source: File) {
        try {
            ProjectDocuments.copy(source, ContentProjectDocument(resolver, uri)) { cancelled }
        } catch (failure: Throwable) {
            val name = displayName(uri)
            delete(uri)
            throw Failed(ExportCommands.failed(name, (unwrap(failure) as? ProjectDocumentException)?.code))
        }
    }

    /** One document per plate in the folder [tree], as the browser downloads one file per plate; answers the status. */
    private fun writePlates(tree: Uri, files: List<Pair<String, File>>): ExportWords {
        val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        var written = 0
        for ((name, file) in files) {
            val document = try {
                DocumentsContract.createDocument(resolver, parent, type(name), name)
            } catch (failure: Exception) {
                throw Failed(ExportCommands.failed(name, if (failure is SecurityException) "document_permission" else null))
            } ?: throw Failed(ExportCommands.failed(name, "document_unavailable"))
            write(document, file)
            written++
        }
        return ExportCommands.downloaded(written)
    }

    private fun delete(uri: Uri) {
        runCatching { DocumentsContract.deleteDocument(resolver, uri) }
    }

    private fun displayName(uri: Uri): String = try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
        }
    } catch (_: RuntimeException) {
        null
    } ?: uri.lastPathSegment ?: "document"

    private fun unwrap(failure: Throwable): Throwable =
        if ((failure is ExecutionException || failure is CompletionException) && failure.cause != null) unwrap(failure.cause!!) else failure

    override fun onCleared() {
        cancelled = true
        task?.cancel(true)
        worker.execute { staging.listFiles()?.forEach { it.delete() } }
        worker.shutdown()
    }
}
