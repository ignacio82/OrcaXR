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
 * local-network permission first. Discovery ([discovery]) only proposes
 * printers it verified; one is saved only when the operator adds it.
 * Listeners hear every change.
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

    /**
     * The printer session. The active printer is selected as soon as it is
     * chosen, so its recovery commands (emergency stop, firmware restart),
     * which need neither a status reading nor the socket, are reachable
     * before and without a connection.
     */
    val session = PrinterSessionClient(::openClient, clock)

    /** Printers the platform's discovery found and verified, offered for the operator to add. */
    val discovery = PrinterDiscovery(MoonrakerProbe(http, localNetwork, clock))

    init {
        selectActive()
    }

    val directory: ProjectIntents.PrinterDirectory get() = synchronized(lock) { directoryValue }
    val credentials: ProjectIntents.RememberedCredentials get() = synchronized(lock) { credentialsValue }

    /** The printer connections go to: the directory's default. */
    val active: ProjectIntents.PrinterEntry? get() = synchronized(lock) {
        directoryValue.printers.firstOrNull { it.id == directoryValue.defaultId }
    }

    /** Selects the active printer with its key, after whatever was selected before was cleared. */
    private fun selectActive() {
        val printer = active ?: return
        val key = apiKey(text(printer.id))
        session.select(
            ProjectIntents.PrinterSelection(
                printer.id, ProjectIntents.OptionalText.Value(printer.name), printer.host, printer.port.toLong(),
                if (key.isEmpty()) ProjectIntents.OptionalText.Absent(ProjectIntents.Empty) else ProjectIntents.OptionalText.Value(units(key)),
            ),
        )
    }

    /** Clears the session (nothing crosses from what was selected) and selects the active printer anew. */
    private fun reselect() {
        session.clear()
        selectActive()
    }

    fun subscribe(listener: () -> Unit): AutoCloseable {
        synchronized(lock) { listeners += listener }
        val session = session.subscribe(listener)
        val discovery = discovery.subscribe(listener)
        return AutoCloseable {
            synchronized(lock) { listeners -= listener }
            session.close()
            discovery.close()
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

    /** Adds a printer discovery proposed, under the name it gives itself; returns its id. */
    fun addDiscovered(proposal: DiscoveryProposal): String =
        addPrinter(proposal.name, proposal.candidate.host, proposal.candidate.port)

    /** The saved printer at the machine [candidate] names, if any. */
    fun savedAs(candidate: DiscoveryCandidate): ProjectIntents.PrinterEntry? {
        val machine = endpoint(units(candidate.host), candidate.port.toDouble()) ?: return null
        return directory.printers.firstOrNull { endpoint(it.host, it.port) == machine }
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
        if (id == active?.let { text(it.id) }) reselect()
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
        reselect()
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
        if (wasActive) reselect()
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
        if (id == active?.let { text(it.id) }) reselect()
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
        reselect()
        changed()
    }

    /**
     * Whether reaching the active printer needs the local-network permission
     * the app lacks — so the shell can ask before the operator connects.
     * Resolving a name may block; call it off the main thread.
     */
    fun localNetworkBlocked(): Boolean {
        if (localNetwork.granted()) return false
        val host = activeEndpoint()?.toHttpUrlOrNull()?.host ?: return false
        if (LocalNetworkAccess.multicastName(host)) return true
        return try {
            http.dns.lookup(host).any(LocalNetworkAccess::requiresPermission)
        } catch (_: java.io.IOException) {
            false
        }
    }

    /** Whether the app may use the local network now: discovery needs it before it looks. */
    fun localNetworkGranted(): Boolean = localNetwork.granted()

    /** The URL the active printer's address names (the shared endpoint normalization), or null. */
    fun activeEndpoint(): String? = active?.let { endpoint(it.host, it.port) }

    private fun endpoint(host: List<Int>, port: Double): String? {
        val reply = MoonrakerPolicy.endpoint(
            ProjectIntents.MoonrakerEndpointRequest(
                host, ProjectIntents.OptionalFinite.Value(port),
                ProjectIntents.OptionalText.Absent(ProjectIntents.Empty), ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
            ),
        )
        return (reply as? ProjectIntents.MoonrakerEndpointReply.Endpoint)?.let { text(it.value.directHttpUrl) }
    }

    /** The printer's files, history, console and cameras over the current connection, or null without one. */
    fun exchanges(): PrinterExchanges? {
        val client = session.client ?: return null
        return PrinterExchanges(client, activeEndpoint(), localNetwork, http)
    }

    /** Connects to the active printer with its own key. */
    fun connect(): CompletableFuture<ProjectIntents.MoonrakerHandshake> {
        val printer = active ?: return CompletableFuture.failedFuture(DeviceRefusal("Add a printer first."))
        // Refused up front, in words: the transport would report only a network fault.
        if (localNetworkBlocked()) {
            return CompletableFuture.failedFuture(DeviceRefusal(LocalNetworkDeniedException(text(printer.host)).message.orEmpty()))
        }
        // The same selection reuses its client.
        selectActive()
        return session.connect()
    }

    /** Ends the connection; the printer stays selected, so recovery stays reachable. */
    fun disconnect() = reselect()

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
        discovery.stop()
        session.close()
        synchronized(lock) { listeners.clear() }
    }
}
