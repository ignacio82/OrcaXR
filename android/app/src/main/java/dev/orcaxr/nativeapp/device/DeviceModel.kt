package dev.orcaxr.nativeapp.device

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import dev.orcaxr.core.AndroidLocalNetwork
import dev.orcaxr.core.AppCredentialVault
import dev.orcaxr.core.DeviceRefusal
import dev.orcaxr.core.DeviceTextStore
import dev.orcaxr.core.DeviceWorkspace
import dev.orcaxr.core.PrintJobCommandException
import dev.orcaxr.core.ProjectIntents
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors

/** The printer directory's stored text, in a private preferences file. */
class PreferencesTextStore(context: Context, file: String, private val key: String) : DeviceTextStore {
    private val preferences = context.getSharedPreferences(file, Context.MODE_PRIVATE)
    override fun read(): String? = preferences.getString(key, null)
    override fun write(text: String) {
        check(preferences.edit().putString(key, text).commit()) { "storage_failed" }
    }
}

/** One printer as the list shows it. */
data class PrinterRow(val id: String, val name: String, val address: String)

/** A command the operator must confirm, and how to answer. */
class PendingConfirmation(val intent: ProjectIntents.PrintJobCommandIntent, val answer: CompletableFuture<Boolean>)

/** What the Device screen shows: a projection of the workspace, never a second copy of it. */
data class DeviceState(
    val printers: List<PrinterRow> = emptyList(),
    val activeId: String? = null,
    val apiKey: String = "",
    val remember: Boolean = true,
    val localNetworkBlocked: Boolean = false,
    val connected: Boolean = false,
    val connecting: Boolean = false,
    /** The connection in a few words, with the transport's own code when it failed. */
    val connection: String = "",
    val summary: ProjectIntents.PrinterStatusSummary? = null,
    val commands: List<ProjectIntents.PrintJobCommandDescriptor> = emptyList(),
)

/**
 * The Device area's host adapter: it owns the [DeviceWorkspace], runs every
 * call that may block (storage, the Keystore, name resolution, the session)
 * on one worker thread, and publishes a [DeviceState] projection to Compose on
 * the main thread.
 */
class DeviceModel(application: Application) : AndroidViewModel(application) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "device-model") }
    private lateinit var workspace: DeviceWorkspace
    private var subscription: AutoCloseable? = null

    var state by mutableStateOf(DeviceState())
        private set
    var message by mutableStateOf<String?>(null)
        private set
    var confirmation by mutableStateOf<PendingConfirmation?>(null)
        private set

    init {
        work {
            workspace = DeviceWorkspace(
                PreferencesTextStore(application, "orcaxr.printers", "directory"),
                AppCredentialVault.open(application),
                AndroidLocalNetwork.permission(application),
                // The transport's diagnostics (redacted by the core) reach logcat in debuggable builds only.
                logger = if (application.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
                    { log -> android.util.Log.d("OrcaXRPrinter", log.toString()) }
                } else {
                    null
                },
            )
            subscription = workspace.subscribe { work { publish() } }
            publish()
        }
    }

    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    private fun work(task: () -> Unit) {
        worker.execute {
            try {
                task()
            } catch (refused: DeviceRefusal) {
                main.post { message = refused.message }
            } catch (refused: PrintJobCommandException) {
                main.post { message = refused.message }
            } catch (failure: ExecutionException) {
                main.post { message = failure.cause?.message ?: failure.message }
            } catch (failure: Exception) {
                main.post { message = failure.message }
            }
        }
    }

    /** Recomputes the projection on the worker and publishes it. */
    private fun publish() {
        val directory = workspace.directory
        val active = workspace.active
        val activeId = active?.let { text(it.id) }
        val connection = workspace.session.state
        val next = DeviceState(
            printers = directory.printers.map { entry ->
                val port = entry.port.toLong()
                PrinterRow(text(entry.id), text(entry.name), "${text(entry.host)} · port $port")
            },
            activeId = activeId,
            apiKey = activeId?.let(workspace::apiKey) ?: "",
            remember = workspace.credentials.remember,
            localNetworkBlocked = workspace.localNetworkBlocked(),
            connected = connection is ProjectIntents.MoonrakerConnectionState.Connected,
            connecting = connection is ProjectIntents.MoonrakerConnectionState.Connecting ||
                connection is ProjectIntents.MoonrakerConnectionState.Reconnecting,
            connection = when (connection) {
                null -> "Not connected"
                is ProjectIntents.MoonrakerConnectionState.Disconnected -> "Disconnected"
                is ProjectIntents.MoonrakerConnectionState.Connecting -> "Connecting…"
                is ProjectIntents.MoonrakerConnectionState.Connected -> "Connected"
                is ProjectIntents.MoonrakerConnectionState.Reconnecting ->
                    "Reconnecting (attempt ${connection.value.attempt}) after ${connection.value.lastError.code.name}"
                is ProjectIntents.MoonrakerConnectionState.Error -> "Connection failed: ${connection.value.error.code.name}"
            },
            summary = if (active != null) workspace.summary() else null,
            commands = workspace.session.view.availability,
        )
        main.post { state = next }
    }

    /** Re-reads what may have changed outside the app, such as a permission granted in settings. */
    fun refresh() = work { publish() }

    fun dismissMessage() {
        message = null
    }

    fun addPrinter(name: String, address: String, port: Int?) = work {
        workspace.addPrinter(name, address, port)
        main.post { message = "Saved ${name.trim()}." }
    }

    fun activate(id: String) = work { workspace.activate(id) }

    fun removeActive() = work {
        val id = workspace.active?.let { text(it.id) } ?: return@work
        workspace.removePrinter(id)
    }

    fun setApiKey(key: String) = work {
        val id = workspace.active?.let { text(it.id) } ?: return@work
        workspace.setApiKey(id, key)
    }

    fun setRemember(remember: Boolean) = work {
        workspace.setRemember(remember)
        main.post {
            message = if (remember) {
                "Printer keys will be remembered on this device."
            } else {
                "Stopped remembering printer keys; the saved copies were erased."
            }
        }
    }

    fun forgetCredentials() = work {
        workspace.forgetCredentials()
        main.post { message = "Every saved printer key was forgotten on this device." }
    }

    /** Reports how [future] failed, without holding the worker while it runs. */
    private fun report(future: CompletableFuture<*>) {
        future.whenComplete { _, failure ->
            val cause = (failure as? java.util.concurrent.CompletionException)?.cause ?: failure
            if (cause != null) main.post { message = cause.message }
        }
    }

    fun connect() = work {
        main.post { message = null }
        report(workspace.connect())
    }

    fun disconnect() = work { workspace.disconnect() }

    /** Sends a job command; one that needs confirming asks the operator first. */
    fun command(command: ProjectIntents.PrintJobCommand) = work {
        val intent = workspace.session.captureIntent(command)
        report(
            workspace.session.execute(intent, dialog = { asked, ended ->
                val answer = CompletableFuture<Boolean>()
                // A session that ends while the dialog is open answers no.
                ended.whenComplete { _, _ -> answer.complete(false) }
                main.post { confirmation = PendingConfirmation(asked, answer) }
                answer.whenComplete { _, _ -> main.post { confirmation = null } }
            }),
        )
    }

    fun answer(confirmed: Boolean) {
        confirmation?.answer?.complete(confirmed)
    }

    override fun onCleared() {
        worker.execute {
            subscription?.close()
            if (::workspace.isInitialized) workspace.close()
        }
        worker.shutdown()
    }
}
