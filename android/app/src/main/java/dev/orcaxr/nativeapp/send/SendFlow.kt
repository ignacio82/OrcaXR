package dev.orcaxr.nativeapp.send

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectRevision
import dev.orcaxr.nativeapp.prepare.SlicedPlate
import java.io.File
import java.math.BigDecimal
import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale
import kotlin.math.abs

private fun text(units: List<Int>) = String(CharArray(units.size) { units[it].toChar() })

/** A finished slice offered to a printer: its G-code file, the names it is sent under, and whether it is still current. */
class SliceToSend(val file: File, val filename: String, val plateName: String, val isCurrent: () -> Boolean)

/**
 * The browser's `isCurrent` for a slice being sent (`OrcaWorkspace.sendToPrinter`):
 * the same published output, the same active plate, and the project unchanged
 * since it was sliced. Output that fails it is never sent.
 */
object SendGuard {
    fun current(published: SlicedPlate?, sent: SlicedPlate, activePlateId: String?, revision: ProjectRevision?): Boolean =
        published === sent && activePlateId == sent.plateId && revision == sent.revision
}

/** The send as the Prepare area shows it: whether one runs, and the browser's status line for it. */
data class SendState(val busy: Boolean = false, val status: String? = null)

/** The browser's words for a send (`web/src/main.ts`'s submission handler and `send_to_printer`). */
object SendWords {
    /** The action's name (`web/src/actions/groups/output.ts`). */
    const val ACTION = "Send to Printer"
    /** The same button while a send runs. */
    const val CANCEL = "Cancel send"
    const val CANCELLING = "Cancelling the send…"
    const val SLICE_FIRST = "Slice the active plate before sending it to the printer."
    const val BUSY = "A send is already in progress; cancel it before starting another."
    const val DECLINED = "Send cancelled; nothing was uploaded."
    /** The browser connects as it sends; this device sends only to the printer the Device area connected. */
    const val CONNECT_FIRST = "Connect to a printer in the Device area to send this plate."

    fun failed(reason: String) = "Send failed: $reason"

    /** The status line for each step the workflow reports. */
    fun phase(phase: ProjectIntents.PrintSubmissionPhase, filename: String): String = when (phase) {
        ProjectIntents.PrintSubmissionPhase.Checking -> "Checking the printer…"
        ProjectIntents.PrintSubmissionPhase.Confirming -> "Confirm the send options…"
        ProjectIntents.PrintSubmissionPhase.Uploading -> "Uploading $filename…"
        ProjectIntents.PrintSubmissionPhase.Verifying -> "Verifying the stored file…"
        ProjectIntents.PrintSubmissionPhase.Preparing -> "Preparing the printer with the confirmed options…"
        ProjectIntents.PrintSubmissionPhase.Starting -> "Starting the print…"
        ProjectIntents.PrintSubmissionPhase.Completed -> "Send completed."
    }

    /** Each second of an upload. */
    fun uploadElapsed(filename: String, elapsedMs: Long, totalBytes: Long): String {
        val seconds = elapsedMs / 1000
        val clock = "${seconds / 60}m ${(seconds % 60).toString().padStart(2, '0')}s"
        return "Uploading $filename (${fixed(totalBytes / 1048576.0, 1)} MB) — $clock elapsed. Press Cancel send to stop."
    }

    /** What a finished send did. */
    fun result(result: ProjectIntents.PrintSubmissionResult): String {
        val kilobytes = fixed(result.verifiedBytes / 1024.0, 0)
        return if (result.startedPrint) {
            "Printing ${text(result.path)} — $kilobytes KB verified on the printer."
        } else {
            "Uploaded ${text(result.path)} — $kilobytes KB verified; start it from the printer when ready."
        }
    }

    /** The dialog's size of a file (`formatBytes`). */
    fun bytes(byteLength: Long): String = when {
        byteLength < 1024 -> "$byteLength B"
        byteLength < 1024 * 1024 -> "${fixed(byteLength / 1024.0, 0)} KB"
        else -> "${fixed(byteLength / (1024.0 * 1024.0), 1)} MB"
    }

    /** The exact-name choice (`printOverwriteLabel`): the file it names and, when it replaces one, that file's identity. */
    fun overwrite(target: ProjectIntents.PrintOverwrite): String {
        if (!target.allowed) {
            return (target.reason as? ProjectIntents.OptionalText.Value)?.let { text(it.value) } ?: "Replacing this file is unavailable."
        }
        val name = text(target.filename)
        val existing = (target.existing as? ProjectIntents.OptionalPrintFileIdentity.Value)?.value
            ?: return "Use exact name $name (new file)"
        return "Use exact name $name, replacing ${jsNumber(existing.size)} bytes modified ${modified(existing.modified)}"
    }

    /** `Number.prototype.toFixed`: an exact binary value rounded half up, as both define it for these quotients. */
    private fun fixed(value: Double, digits: Int) = String.format(Locale.ROOT, "%.${digits}f", value)

    /** `new Date(seconds * 1000).toISOString()`, or the number itself when that is no date. */
    internal fun modified(seconds: Double): String {
        val ms = seconds * 1000
        if (!ms.isFinite() || abs(ms) > MAX_TIME_MS) return jsNumber(seconds)
        val at = Instant.ofEpochMilli(ms.toLong()).atOffset(ZoneOffset.UTC)
        val year = at.year
        val yearText = if (year in 0..9999) "%04d".format(Locale.ROOT, year) else (if (year < 0) "-" else "+") + "%06d".format(Locale.ROOT, abs(year))
        return yearText + String.format(
            Locale.ROOT, "-%02d-%02dT%02d:%02d:%02d.%03dZ",
            at.monthValue, at.dayOfMonth, at.hour, at.minute, at.second, at.nano / 1_000_000,
        )
    }

    /** A number as JavaScript writes it (`Number::toString`), from its shortest round-trip digits. */
    internal fun jsNumber(value: Double): String {
        if (value.isNaN()) return "NaN"
        if (value.isInfinite()) return if (value > 0) "Infinity" else "-Infinity"
        if (value == 0.0) return "0"
        val sign = if (value < 0) "-" else ""
        val decimal = BigDecimal(abs(value).toString()).stripTrailingZeros()
        val digits = decimal.unscaledValue().toString()
        val k = digits.length
        // value = 0.digits × 10^n
        val n = k - decimal.scale()
        return sign + when {
            n in k..21 -> digits + "0".repeat(n - k)
            n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
            n in -5..0 -> "0." + "0".repeat(-n) + digits
            else -> {
                val exponent = n - 1
                digits.substring(0, 1) + (if (k > 1) "." + digits.substring(1) else "") +
                    "e" + (if (exponent > 0) "+" else "-") + abs(exponent)
            }
        }
    }

    private const val MAX_TIME_MS = 8.64e15
}

/** One "Before printing" choice: what it does when available, why not when it is not. */
data class SendOption(
    val id: ProjectIntents.PrintStartOptionId,
    val label: String,
    val text: String,
    val available: Boolean,
    /** As the dialog opens: on only when the printer can and the core suggests it. */
    val checked: Boolean,
)

/**
 * The browser's `PrintSubmissionDialog` for one confirmation: exactly what is
 * about to be sent and to which printer, the mapping problems that block
 * starting it, the start options the printer supports (unavailable ones kept,
 * with the printer's reason), the explicit exact-name choice, and two separate
 * buttons — storing and starting are never one action with a checkbox.
 */
class SendDialogView(val input: ProjectIntents.PrintWorkflowConfirmation) {
    val stored = input.stored
    val title = if (stored) "Start stored file" else "Send to printer"
    val blockers = input.blockers.map(::text)
    val warnings = input.warnings.map(::text)
    val options = input.startOptions.map { option ->
        SendOption(
            option.id, text(option.label), text(if (option.available) option.detail else option.reason), option.available,
            option.available && option.defaultEnabled,
        )
    }
    /** "Before printing" shows only when the printer offered options. */
    val optionsHeading = if (options.isEmpty()) null else "Before printing"
    /** The exact-name choice; a stored file has none. */
    val overwriteLabel = if (stored) null else SendWords.overwrite(input.overwrite)
    val overwriteAllowed = !stored && input.overwrite.allowed
    val startLabel = if (stored) "Start print" else "Upload and start print"
    /** A mapping problem disables starting while still allowing the file to be stored. */
    val startEnabled = blockers.isEmpty()
    /** Why starting is disabled (the browser's hint on its disabled button). */
    val startRefusal = if (startEnabled) null else "Resolve the filament mapping problems above before starting this print"
    val uploadLabel = if (stored) null else "Upload only"
    val cancelLabel = "Cancel"

    /** Printer, Plate, File — the exact name once it is chosen — and Filaments. */
    fun facts(overwrite: Boolean): List<Pair<String, String>> {
        val file = if (overwrite && overwriteAllowed) text(input.overwrite.filename) else text(input.filename)
        return listOf(
            "Printer" to "${text(input.endpointLabel)} — ${text(input.printerStateLabel)}",
            "Plate" to text(input.plateName),
            "File" to "$file (${SendWords.bytes(input.byteLength)})",
            "Filaments" to text(input.toolSummary),
        )
    }

    /** The decision a button makes: only enabled choices count, in the printer's order. */
    fun decide(
        choice: ProjectIntents.PrintWorkflowDecisionChoice,
        overwrite: Boolean = false,
        chosen: Set<ProjectIntents.PrintStartOptionId> = emptySet(),
    ): ProjectIntents.PrintWorkflowDecision = if (choice == ProjectIntents.PrintWorkflowDecisionChoice.Cancel) {
        CANCEL
    } else {
        ProjectIntents.PrintWorkflowDecision(choice, overwrite && overwriteAllowed, options.filter { it.available && it.id in chosen }.map { it.id })
    }

    companion object {
        /** Closing the dialog, or anything that withdraws it, sends nothing. */
        val CANCEL = ProjectIntents.PrintWorkflowDecision(ProjectIntents.PrintWorkflowDecisionChoice.Cancel, false, emptyList())
    }
}
