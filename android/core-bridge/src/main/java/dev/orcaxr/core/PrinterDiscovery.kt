package dev.orcaxr.core

import java.util.concurrent.CompletableFuture
import okhttp3.OkHttpClient

/** A service the platform's discovery reported: its advertised name and where it answers. */
data class DiscoveryCandidate(val name: String, val host: String, val port: Int)

/** What probing a candidate found. */
sealed interface DiscoveryProbe {
    /** Moonraker completed the handshake; [hostname] is how the machine names itself. */
    data class Moonraker(val hostname: String) : DiscoveryProbe
    /** Moonraker answered, but asks for a key before it says more. */
    data object NeedsKey : DiscoveryProbe
    /** Nothing that speaks Moonraker answered there. */
    data class Unverified(val reason: String) : DiscoveryProbe
}

/** A printer discovery verified, for the operator to add or ignore. */
data class DiscoveryProposal(val candidate: DiscoveryCandidate, val probe: DiscoveryProbe) {
    /** The name the printer is added under: how it names itself, else how it was advertised. */
    val name: String get() = (probe as? DiscoveryProbe.Moonraker)?.hostname?.takeIf { it.isNotBlank() } ?: candidate.name
}

/**
 * Printers the platform's discovery found, each verified before it is
 * proposed.
 *
 * Discovery only proposes: nothing is saved until the operator adds a
 * proposal, so a probe that completes late can never overwrite a choice.
 * Each run has its own generation, and a probe's answer for an earlier run —
 * or for a run that was stopped — is dropped. A candidate is probed once per
 * run (by host and port), at most [MAX_CANDIDATES] of them, and only one that
 * answers as Moonraker, with or without asking for a key, is proposed.
 * Listeners hear every change.
 */
class PrinterDiscovery(private val probe: (DiscoveryCandidate) -> CompletableFuture<DiscoveryProbe>) {
    companion object {
        /** Candidates probed in one run: a network answering with more is not a workshop's. */
        const val MAX_CANDIDATES = 32
    }

    private val lock = Any()
    private var generation = 0L
    private var running = false
    private val probed = HashSet<Pair<String, Int>>()
    private var pending = 0
    private val found = LinkedHashMap<Pair<String, Int>, DiscoveryProposal>()
    private val listeners = LinkedHashSet<() -> Unit>()

    val proposals: List<DiscoveryProposal> get() = synchronized(lock) { found.values.toList() }

    /** Whether a run is going on. */
    val active: Boolean get() = synchronized(lock) { running }

    /** How many of this run's candidates are still being probed. */
    val probing: Int get() = synchronized(lock) { pending }

    fun subscribe(listener: () -> Unit): AutoCloseable {
        synchronized(lock) { listeners += listener }
        return AutoCloseable { synchronized(lock) { listeners -= listener } }
    }

    private fun changed() {
        for (listener in synchronized(lock) { listeners.toList() }) listener()
    }

    /** Starts a run, forgetting the last one's proposals; returns its generation. */
    fun start(): Long {
        val started = synchronized(lock) {
            generation++
            running = true
            probed.clear()
            pending = 0
            found.clear()
            generation
        }
        changed()
        return started
    }

    /** Ends the run, keeping its proposals: probes still in flight are dropped when they answer. */
    fun stop() {
        synchronized(lock) {
            if (!running) return
            running = false
            pending = 0
            generation++
        }
        changed()
    }

    /** A candidate the platform reported during run [run]; probed once, proposed if it is Moonraker. */
    fun offer(run: Long, candidate: DiscoveryCandidate) {
        val key = candidate.host.lowercase() to candidate.port
        synchronized(lock) {
            if (run != generation || !running || probed.size >= MAX_CANDIDATES || !probed.add(key)) return
            pending++
        }
        changed()
        val answer = try {
            probe(candidate)
        } catch (failure: RuntimeException) {
            CompletableFuture.failedFuture(failure)
        }
        answer.whenComplete { result, _ ->
            synchronized(lock) {
                if (run != generation || !running) return@whenComplete
                pending--
                if (result != null && result !is DiscoveryProbe.Unverified) found[key] = DiscoveryProposal(candidate, result)
            }
            changed()
        }
    }
}

/**
 * Verifies a candidate by the Moonraker handshake itself — the same one a
 * connection makes — with no credential: a key is never sent to a machine
 * the operator has not added. A printer that asks for one is still
 * proposed, as one that needs a key. Every exchange is judged by the
 * local-network permission and the cleartext policy, as a connection's is.
 */
class MoonrakerProbe(
    private val http: OkHttpClient = OkHttpClient(),
    private val localNetwork: LocalNetworkPermission? = null,
    private val clock: () -> Double = { System.currentTimeMillis().toDouble() },
) : (DiscoveryCandidate) -> CompletableFuture<DiscoveryProbe> {
    companion object {
        /** Each request and the socket's opening: a printer on the network answers well within it. */
        const val TIMEOUT_MS = 5_000.0
    }

    private fun units(text: String) = text.map { it.code }
    private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

    override fun invoke(candidate: DiscoveryCandidate): CompletableFuture<DiscoveryProbe> {
        val absentFinite = ProjectIntents.OptionalFinite.Absent(ProjectIntents.Empty)
        val absentText = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty)
        val config = ProjectIntents.MoonrakerTransportConfig(
            units(candidate.host), ProjectIntents.OptionalFinite.Value(candidate.port.toDouble()), absentText, absentText,
            ProjectIntents.MoonrakerVersionPolicyInput(ProjectIntents.OptionalMoonrakerApiVersionInput.Absent(ProjectIntents.Empty), absentFinite),
            ProjectIntents.OptionalText.Value(units("OrcaXR Android")), absentText,
            ProjectIntents.OptionalFinite.Value(TIMEOUT_MS), ProjectIntents.OptionalFinite.Value(TIMEOUT_MS), absentFinite, absentFinite,
            ProjectIntents.MoonrakerReconnectPolicyInput(absentFinite, absentFinite, absentFinite, absentFinite),
        )
        val client = try {
            MoonrakerClient(config, http, clock, localNetwork = localNetwork)
        } catch (failure: RuntimeException) {
            return CompletableFuture.completedFuture(DiscoveryProbe.Unverified(failure.message ?: "not an address"))
        }
        // Closed off the client's thread: its answer arrives on that thread.
        return client.connect().result.handleAsync { handshake, failure ->
            client.close()
            val cause = generateSequence(failure) { it.cause }.firstOrNull { it is MoonrakerException } as MoonrakerException?
            when {
                handshake != null -> DiscoveryProbe.Moonraker(text(handshake.printer.hostname))
                cause?.fault?.code == ProjectIntents.MoonrakerErrorCode.AuthRequired ||
                    cause?.fault?.code == ProjectIntents.MoonrakerErrorCode.Forbidden -> DiscoveryProbe.NeedsKey
                else -> DiscoveryProbe.Unverified(
                    cause?.fault?.code?.name ?: failure?.let { generateSequence(it) { each -> each.cause }.last().javaClass.simpleName } ?: "no answer",
                )
            }
        }
    }
}
