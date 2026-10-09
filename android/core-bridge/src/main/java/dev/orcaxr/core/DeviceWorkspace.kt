package dev.orcaxr.core

import java.util.UUID
import java.util.concurrent.CompletableFuture
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient

/** A text the device keeps (the printer directory: no secret is in it). */
interface DeviceTextStore {
    fun read(): String?
    fun write(text: String)
}

/** An edit the shared policy refused, in the words an operator reads. */
class DeviceRefusal(message: String) : Exception(message)

/**
 * The Device area's printers, credentials and session, as the browser shell
 * runs them over the same shared policies.
 *
 * The directory is the shared one ([PrinterDirectory]), stored as the
 * browser stores it; each printer's API key is its own, remembered in the
 * [CredentialVault] while the operator lets it be (and kept in memory for
 * this run when not), and removed with its printer. Switching printers
 * rebuilds the connection, so no socket, credential or capability crosses
 * from the printer selected before. Every exchange is judged by the
 * local-network permission first. Listeners hear every change.
 */
class DeviceWorkspace(
    private val directoryStore: DeviceTextStore,
    private val vault: CredentialVault,
    private val localNetwork: LocalNetworkPermission,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val http: OkHttpClient = OkHttpClient(),
    private val clock: () -> Double = { System.currentTimeMillis().toDouble() },
    /** The transport's diagnostics, redacted by the core before they arrive. */
    private val logger: ((ProjectIntents.MoonrakerLog) -> Unit)? = null,
) : AutoCloseable {
    private val lock = Any()
    private val listeners = LinkedHashSet<() -> Unit>()
    private var directoryValue = PrinterDirectory.load(directoryStore.read())
    private var credentialsValue = vault.load()

    /** The printer session; it opens a client for the active printer when asked to connect. */
    val session = PrinterSessionClient(::openClient, clock)

    val directory: ProjectIntents.PrinterDirectory get() = synchronized(lock) { directoryValue }
    val credentials: ProjectIntents.RememberedCredentials get() = synchronized(lock) { credentialsValue }

    /** The printer connections go to: the directory's default. */
    val active: ProjectIntents.PrinterEntry? get() = synchronized(lock) {
        directoryValue.printers.firstOrNull { it.id == directoryValue.defaultId }
    }

    fun subscribe(listener: () -> Unit): AutoCloseable {
        synchronized(lock) { listeners += listener }
        val session = session.subscribe(listener)
        return AutoCloseable {
            synchronized(lock) { listeners -= listener }
            session.close()
        }
    }

    private fun changed() {
        for (listener in synchronized(lock) { listeners.toList() }) listener()
    }

    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    private fun applied(reply: ProjectIntents.PrinterDirectoryReply): ProjectIntents.PrinterDirectory = when (reply) {
        is ProjectIntents.PrinterDirectoryReply.Directory -> reply.value
        is ProjectIntents.PrinterDirectoryReply.Refused -> throw DeviceRefusal(text(reply.value.message))
    }

    private fun store(directory: ProjectIntents.PrinterDirectory) {
        directoryStore.write(PrinterDirectory.save(directory))
        directoryValue = directory
    }

    private fun remember(credentials: ProjectIntents.RememberedCredentials) {
        vault.save(credentials)
        credentialsValue = credentials
    }

    /**
     * Adds a printer under a new id and makes it the active one; refuses an
     * address another entry already names, or one no endpoint can be made
     * from. Returns the new printer's id.
     */
    fun addPrinter(name: String, host: String, port: Int? = null): String {
        val id = newId()
        synchronized(lock) {
            val request = ProjectIntents.PrinterDirectoryAdd(
                directoryValue, units(name), units(host),
                port?.let { ProjectIntents.OptionalFinite.Value(it.toDouble()) } ?: ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty),
                units(id),
            )
            store(applied(PrinterDirectory.add(request)))
        }
        activate(id)
        return id
    }

    /** Renames a printer or changes its address. */
    fun updatePrinter(id: String, name: String? = null, host: String? = null, port: Int? = null) {
        synchronized(lock) {
            val text = { value: String? -> value?.let { ProjectIntents.OptionalText.Value(units(it)) } ?: ProjectIntents.OptionalText.Absent(ProjectIntents.Empty) }
            store(applied(PrinterDirectory.update(ProjectIntents.PrinterDirectoryUpdate(
                directoryValue, units(id), text(name), text(host),
                port?.let { ProjectIntents.OptionalFinite.Value(it.toDouble()) } ?: ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty),
                ProjectIntents.OptionalTextList.Absent(ProjectIntents.Empty), ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty),
            ))))
        }
        if (id == active?.let { text(it.id) }) session.clear()
        changed()
    }

    /**
     * Makes [id] the active printer. The connection is cleared rather than
     * reused, so nothing crosses from the printer selected before.
     */
    fun activate(id: String) {
        synchronized(lock) {
            store(applied(PrinterDirectory.setDefault(ProjectIntents.PrinterDirectorySelect(directoryValue, units(id)))))
        }
        session.clear()
        changed()
    }

    /**
     * Removes a printer with its key: a credential left behind would attach
     * to whatever printer came to use that id. The first remaining printer
     * becomes active.
     */
    fun removePrinter(id: String) {
        val wasActive = id == active?.let { text(it.id) }
        synchronized(lock) {
            store(applied(PrinterDirectory.remove(ProjectIntents.PrinterDirectorySelect(directoryValue, units(id)))))
            val record = credentialsValue
            remember(record.copy(printerApiKeys = record.printerApiKeys.filter { text(it.key) != id }))
        }
        if (wasActive) session.clear()
        changed()
    }

    /** The API key a printer connects with: its own, or the legacy key for the default printer. */
    fun apiKey(id: String): String = synchronized(lock) {
        val record = credentialsValue
        record.printerApiKeys.firstOrNull { text(it.key) == id }?.let { text(it.secret) }
            ?: if (id == text(directoryValue.defaultId)) text(record.printerApiKey) else ""
    }

    /** Sets a printer's API key; it is stored only while remembering is on. */
    fun setApiKey(id: String, key: String) {
        synchronized(lock) {
            val record = credentialsValue
            val others = record.printerApiKeys.filter { text(it.key) != id }
            val trimmed = key.trim()
            val keys = if (trimmed.isEmpty()) others else others + ProjectIntents.RememberedSecret(units(id), units(trimmed))
            remember(record.copy(printerApiKeys = keys))
        }
        if (id == active?.let { text(it.id) }) session.clear()
        changed()
    }

    /** Turns remembering on or off; off erases every stored secret but keeps this run's keys. */
    fun setRemember(remember: Boolean) {
        synchronized(lock) { remember(credentialsValue.copy(remember = remember)) }
        changed()
    }

    /** Forgets every key, stored and in memory. */
    fun forgetCredentials() {
        synchronized(lock) {
            vault.forget()
            credentialsValue = vault.load()
        }
        session.clear()
        changed()
    }

    /**
     * Whether reaching the active printer needs the local-network permission
     * the app lacks — so the shell can ask before the operator connects.
     * Resolving a name may block; call it off the main thread.
     */
    fun localNetworkBlocked(): Boolean {
        if (localNetwork.granted()) return false
        val printer = active ?: return false
        val reply = MoonrakerPolicy.endpoint(
            ProjectIntents.MoonrakerEndpointRequest(
                printer.host, ProjectIntents.OptionalFinite.Value(printer.port),
                ProjectIntents.OptionalText.Absent(ProjectIntents.Empty), ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
            ),
        )
        val endpoint = (reply as? ProjectIntents.MoonrakerEndpointReply.Endpoint)?.value ?: return false
        val host = text(endpoint.directHttpUrl).toHttpUrlOrNull()?.host ?: return false
        if (LocalNetworkAccess.multicastName(host)) return true
        return try {
            http.dns.lookup(host).any(LocalNetworkAccess::requiresPermission)
        } catch (_: java.io.IOException) {
            false
        }
    }

    /** Connects to the active printer with its own key. */
    fun connect(): CompletableFuture<ProjectIntents.MoonrakerHandshake> {
        val printer = active ?: return CompletableFuture.failedFuture(DeviceRefusal("Add a printer first."))
        val id = text(printer.id)
        val key = apiKey(id)
        session.select(
            ProjectIntents.PrinterSelection(
                printer.id, ProjectIntents.OptionalText.Value(printer.name), printer.host, printer.port.toLong(),
                if (key.isEmpty()) ProjectIntents.OptionalText.Absent(ProjectIntents.Empty) else ProjectIntents.OptionalText.Value(units(key)),
            ),
        )
        return session.connect()
    }

    fun disconnect() = session.clear()

    /** The status surfaces' summary of the session, as the browser renders it. */
    fun summary(): ProjectIntents.PrinterStatusSummary {
        val view = session.view
        val connection = session.state?.let { state ->
            ProjectIntents.OptionalMoonrakerConnectionView.Value(
                when (state) {
                    is ProjectIntents.MoonrakerConnectionState.Disconnected -> ProjectIntents.MoonrakerConnectionView.Disconnected(ProjectIntents.Empty)
                    is ProjectIntents.MoonrakerConnectionState.Connecting -> ProjectIntents.MoonrakerConnectionView.Connecting(ProjectIntents.Empty)
                    is ProjectIntents.MoonrakerConnectionState.Connected -> ProjectIntents.MoonrakerConnectionView.Connected(ProjectIntents.Empty)
                    is ProjectIntents.MoonrakerConnectionState.Reconnecting ->
                        ProjectIntents.MoonrakerConnectionView.Reconnecting(ProjectIntents.MoonrakerReconnectingView(state.value.delayMs))
                    is ProjectIntents.MoonrakerConnectionState.Error ->
                        ProjectIntents.MoonrakerConnectionView.Error(ProjectIntents.MoonrakerErrorView(state.value.error.code))
                },
            )
        } ?: ProjectIntents.OptionalMoonrakerConnectionView.Absent(ProjectIntents.Empty)
        return PrinterControl.summary(ProjectIntents.PrinterStatusRequest(view.snapshot, connection, clock(), active != null))
    }

    private fun openClient(selection: ProjectIntents.PrinterSelection): MoonrakerClient {
        val absentFinite = ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty)
        val absentText = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)
        val client = MoonrakerClient(
            ProjectIntents.MoonrakerTransportConfig(
                selection.endpoint, ProjectIntents.OptionalFinite.Value(selection.port.toDouble()), absentText, absentText,
                ProjectIntents.MoonrakerVersionPolicyInput(ProjectIntents.OptionalMoonrakerApiVersionInput.Absent(ProjectIntents.Empty), absentFinite),
                ProjectIntents.OptionalText.Value(units("OrcaXR Android")), absentText,
                absentFinite, absentFinite, absentFinite, absentFinite,
                ProjectIntents.MoonrakerReconnectPolicyInput(absentFinite, absentFinite, absentFinite, absentFinite),
            ),
            http,
            clock,
            logger = logger,
            localNetwork = localNetwork,
        )
        (selection.apiKey as? ProjectIntents.OptionalText.Value)?.let { client.setCredentials(apiKey = text(it.value)) }
        return client
    }

    override fun close() {
        session.close()
        synchronized(lock) { listeners.clear() }
    }
}
