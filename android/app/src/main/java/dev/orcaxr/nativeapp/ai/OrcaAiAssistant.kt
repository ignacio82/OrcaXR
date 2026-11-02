package dev.orcaxr.nativeapp.ai

import android.content.Context
import android.util.Log
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.nativeapp.mcp.McpContent
import dev.orcaxr.nativeapp.mcp.McpJson
import dev.orcaxr.nativeapp.mcp.McpManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class AssistantResponse(
    val text: String,
    val toolCall: LlmToolCall? = null,
    val toolResultText: String? = null,
    val isError: Boolean = false,
)

data class AssistantMessage(
    val isUser: Boolean,
    val text: String,
    val toolCall: LlmToolCall? = null,
    val toolResult: String? = null,
)

class OrcaAiAssistant(
    private val context: Context,
    private val modelManager: LlmModelManager = LlmModelManager.getInstance(context),
) {
    companion object {
        private const val TAG = "OrcaAiAssistant"

        /**
         * Normalizes speech recognition mishearings and phonetic typos (e.g. "how kong" -> "how long").
         */
        fun normalizeSpeechQuery(prompt: String): String {
            var normalized = prompt.trim()
            normalized = normalized.replace(Regex("""\bhow\s+(?:kong|gong)\b""", RegexOption.IGNORE_CASE), "how long")
            return normalized
        }

        /**
         * Checks whether a user prompt asks about the live physical printer's completion time,
         * remaining print duration, or print status.
         */
        fun isPrinterStatusQuery(prompt: String): Boolean {
            val lower = prompt.lowercase()
            val mentionsPrinterOrJob = lower.contains("printer") || lower.contains("print job") || lower.contains("the print")
            val asksStatusOrTelemetry = lower.contains("finish") || lower.contains("done") || lower.contains("complete") ||
                    lower.contains("time left") || lower.contains("remaining") || lower.contains("how long") || lower.contains("how kong") ||
                    lower.contains("printing") || lower.contains("status") || lower.contains("progress") ||
                    lower.contains("temperature") || lower.contains("nozzle") || lower.contains("bed temp")
            if (mentionsPrinterOrJob && asksStatusOrTelemetry) return true
            if (Regex("""\bhow\s+(?:long|kong)\s+until\b.*\b(?:finish|done|end)\b""", RegexOption.IGNORE_CASE).containsMatchIn(lower)) return true
            if (Regex("""\bwhen\s+(?:will|does|is)\b.*\b(?:finish|done)\b""", RegexOption.IGNORE_CASE).containsMatchIn(lower)) return true
            return false
        }

        /**
         * Formats duration strings (e.g. "1h 04m", "25m 10s", "45s") into natural spoken English.
         */
        fun formatDurationForSpeech(raw: String): String {
            val clean = raw.trim()
                .removePrefix("about").removePrefix("approximately")
                .removeSuffix("left").removeSuffix("remaining").trim()
            if (clean.isBlank() || clean == "—" || clean == "-") return ""

            val hMatch = Regex("""(\d+)\s*h(?:our(?:s)?)?""", RegexOption.IGNORE_CASE).find(clean)
            val mMatch = Regex("""(\d+)\s*m(?:in(?:ute)?(?:s)?)?(?!\w)""", RegexOption.IGNORE_CASE).find(clean)
            val sMatch = Regex("""(\d+)\s*s(?:ec(?:ond)?(?:s)?)?(?!\w)""", RegexOption.IGNORE_CASE).find(clean)

            val hours = hMatch?.groupValues?.get(1)?.toIntOrNull()
            val minutes = mMatch?.groupValues?.get(1)?.toIntOrNull()
            val seconds = sMatch?.groupValues?.get(1)?.toIntOrNull()

            val parts = mutableListOf<String>()
            if (hours != null && hours > 0) {
                parts.add(if (hours == 1) "1 hour" else "$hours hours")
            }
            if (minutes != null && (minutes > 0 || hours == null)) {
                parts.add(if (minutes == 1) "1 minute" else "$minutes minutes")
            }
            if (seconds != null && hours == null) {
                parts.add(if (seconds == 1) "1 second" else "$seconds seconds")
            }
            return when (parts.size) {
                0 -> ""
                1 -> parts[0]
                2 -> "${parts[0]} and ${parts[1]}"
                else -> "${parts[0]}, ${parts[1]}, and ${parts[2]}"
            }
        }

        /**
         * Formats printer telemetry JSON from get_printer_status into concise, natural spoken English
         * suitable for Text-to-Speech (TTS).
         */
        fun formatPrinterStatusForTts(resultText: String): String {
            val obj = McpJson.parseObject(resultText) ?: return "Printer status unavailable."
            val connected = obj["connected"] as? Boolean ?: false
            val connecting = obj["connecting"] as? Boolean ?: false

            if (!connected) {
                return if (connecting) "The printer is currently connecting." else "The printer is not connected."
            }

            val headline = obj["headline"] as? String
            val detail = obj["detail"] as? String
            val progressPercent = (obj["progress_percent"] as? Number)?.toDouble()
            val facts = obj["facts"] as? Map<*, *>
            val tone = obj["tone"] as? String

            val headlineLower = (headline ?: "").lowercase()
            val isPrinting = headlineLower.startsWith("printing") || tone == "Active"
            val isPaused = headlineLower.startsWith("paused") || tone == "Attention"
            val isFinished = headlineLower.startsWith("finished") || headlineLower.startsWith("complete")
            val isIdle = headlineLower == "idle" || headlineLower == "standby" || tone == "Idle"
            val isError = headlineLower.startsWith("error") || tone == "Danger"

            // Look for remaining duration in facts or detail
            val rawLeft = facts?.get("Left (approx.)") as? String
            val spokenLeft = rawLeft?.let { formatDurationForSpeech(it) }?.ifBlank { null }
                ?: detail?.let { formatDurationForSpeech(it) }?.ifBlank { null }

            val pct = progressPercent?.toInt()

            if (isPrinting) {
                val printJobName = headline?.removePrefix("Printing")?.removePrefix("printing")
                    ?.trim()?.removeSuffix(".gcode")?.replace('_', ' ')?.ifBlank { null }

                val prefix = if (!printJobName.isNullOrBlank()) "Printing $printJobName is" else "The print is"
                val timePhrase = if (!spokenLeft.isNullOrBlank()) "with about $spokenLeft remaining" else ""
                val progressPhrase = when {
                    pct != null && timePhrase.isNotBlank() -> "$pct percent complete, $timePhrase."
                    pct != null -> "$pct percent complete."
                    timePhrase.isNotBlank() -> "$timePhrase."
                    else -> "in progress."
                }

                val layerInfo = facts?.get("Layer") as? String
                val layerPhrase = if (!layerInfo.isNullOrBlank()) {
                    val layerSpoken = VoiceInputManager.sanitizeForTts(layerInfo)
                    " On layer $layerSpoken."
                } else ""

                return "$prefix $progressPhrase$layerPhrase".trim()
            }

            if (isPaused) {
                val timePhrase = if (!spokenLeft.isNullOrBlank()) " with about $spokenLeft remaining" else ""
                return if (pct != null) {
                    "The print is currently paused at $pct percent$timePhrase."
                } else {
                    "The print is currently paused."
                }
            }

            if (isFinished) {
                return "The print is finished and ready on the bed."
            }

            if (isIdle) {
                val nozzle = facts?.get("Nozzle") as? String
                val nozzleTemp = nozzle?.let { Regex("""(\d+)\s*°C""").find(it)?.groupValues?.get(1)?.toIntOrNull() }
                return if (nozzleTemp != null && nozzleTemp > 50) {
                    "The printer is idle and no print is currently running. The nozzle is at $nozzleTemp degrees."
                } else {
                    "The printer is idle and no print is currently running."
                }
            }

            if (isError) {
                val msg = headline?.removePrefix("Error:")?.removePrefix("Error")?.trim() ?: "unknown error"
                return "The printer reported an error: $msg."
            }

            val factsStr = facts?.entries?.take(2)?.joinToString(", ") { "${it.key} is ${it.value}" }
            return buildString {
                if (!headline.isNullOrBlank()) append("Printer is $headline. ")
                if (!factsStr.isNullOrBlank()) append(factsStr)
            }.ifBlank { "Printer is connected." }
        }
    }

    suspend fun query(
        userPrompt: String,
        history: List<AssistantMessage> = emptyList(),
        onToken: ((String) -> Unit)? = null,
    ): AssistantResponse = withContext(Dispatchers.IO) {
        val normalizedPrompt = normalizeSpeechQuery(userPrompt)
        val engine = modelManager.ensureInitialized()
        if (engine == null) {
            val aicore = modelManager.aiCoreStatus.value
            val dl = modelManager.downloadState.value
            return@withContext AssistantResponse(
                text = "No on-device AI model is active yet.\n" +
                       "• Tensor TPU (AICore): ${formatAiCoreStatus(aicore)}\n" +
                       "• Local Gemma: ${formatDownloadState(dl)}\n\n" +
                       "Please download or enable a model in Settings to use Orca AI offline.",
                isError = true,
            )
        }

        // 1. Fetch current workspace state for context snapshot
        val workspaceSnapshot = try {
            val res = McpManager.registry?.callTool("get_workspace_state", emptyMap())
            res?.content?.firstOrNull()?.let { (it as? McpContent.Text)?.text } ?: "{}"
        } catch (t: Throwable) {
            "{}"
        }

        // 2. Prepare structured summary of physical filaments with color names
        val project = McpManager.context?.project
        val filamentsSummary = project?.view?.filaments?.options?.filter { !it.mixed }?.mapIndexed { idx, opt ->
            val colorName = ColorNames.nameOf(opt.color)
            val slot = idx + 1
            "• Slot $slot: $colorName (${opt.color}) - ${opt.name}"
        }?.joinToString("\n").orEmpty()

        val activePlateObjects = project?.view?.rows?.filter { it.kind.name == "Object" }?.map { row ->
            val label = String(CharArray(row.label.size) { row.label[it].toChar() })
            val fil = (row.indicators.filament as? ProjectIntents.OptionalObjectTreeFilament.Value)?.value?.let { f ->
                val color = String(CharArray(f.color.size) { f.color[it].toChar() })
                val colorName = ColorNames.nameOf(color)
                "using $colorName ($color)"
            } ?: "default filament"
            "• Object \"$label\": $fil"
        }?.joinToString("\n").orEmpty()

        val printerTelemetry = try {
            val device = McpManager.context?.device
            val state = device?.state
            if (state?.connected == true) {
                val summary = state.summary
                val headline = summary?.headline?.let { String(CharArray(it.size) { i -> it[i].toChar() }) }.orEmpty()
                val progress = (summary?.progress as? ProjectIntents.OptionalFinite.Value)?.let { " ${(it.value * 100).toInt()}%" }.orEmpty()
                val facts = summary?.facts?.joinToString(", ") { fact ->
                    val label = String(CharArray(fact.label.size) { i -> fact.label[i].toChar() })
                    val value = String(CharArray(fact.value.size) { i -> fact.value[i].toChar() })
                    "$label: $value"
                }.orEmpty()
                "Printer: Connected ($headline$progress, $facts)"
            } else "Printer: Disconnected"
        } catch (_: Throwable) {
            "Printer: Disconnected"
        }

        val sliceTelemetry = try {
            val prep = McpManager.context?.prepare
            val res = prep?.state?.result
            if (res != null) {
                "Slice ready: ${res.row.ifBlank { res.summary }}"
            } else if (prep?.state?.job != null) {
                "Slicing in progress: ${prep.state.job?.percent ?: 0}%"
            } else "Plate not sliced"
        } catch (_: Throwable) {
            "Plate not sliced"
        }

        // 3. Prepare tool definitions
        val tools = McpManager.registry?.listTools()?.map { mcpTool ->
            @Suppress("UNCHECKED_CAST")
            LlmToolDefinition(
                name = mcpTool.name,
                description = mcpTool.description,
                inputSchema = mcpTool.inputSchema as Map<String, Any>,
            )
        }.orEmpty()

        val promptWithContext = buildString {
            if (history.isNotEmpty()) {
                appendLine("RECENT CONVERSATION HISTORY:")
                val recent = history.takeLast(4)
                for (msg in recent) {
                    val role = if (msg.isUser) "User" else "Assistant"
                    appendLine("$role: ${msg.text.trim()}")
                }
                appendLine()
            }
            if (filamentsSummary.isNotBlank()) {
                appendLine("LOADED PRINTER FILAMENTS / SLOTS:")
                appendLine(filamentsSummary)
                appendLine()
            }
            if (activePlateObjects.isNotBlank()) {
                appendLine("OBJECTS ON BUILD PLATE:")
                appendLine(activePlateObjects)
                appendLine()
            }
            appendLine("DEVICE & SLICING TELEMETRY:")
            appendLine("• $printerTelemetry")
            appendLine("• $sliceTelemetry")
            appendLine()
            appendLine("WORKSPACE STATE JSON:")
            appendLine(workspaceSnapshot)
            appendLine()
            appendLine("COMMAND RULES:")
            appendLine("• To resize or scale a 3D model:")
            appendLine("  - For specific percentages (e.g. 'resize to 150%', 'scale model 50%', 'make it 80%'):")
            appendLine("    Call `scale_model` with percent = <number>.")
            appendLine("  - For relative multiplier factors (e.g. 'double the size', 'make it twice as big', 'shrink by half', 'half size'):")
            appendLine("    Call `scale_model` with factor = <number> (e.g. 2.0 for double, 0.5 for half).")
            appendLine("  - To scale to fit the print bed (e.g. 'scale to fit', 'maximize model on bed'):")
            appendLine("    Call `scale_model` with action = \"fit_volume\".")
            appendLine("  - To reset scale to default 100% (e.g. 'reset scale', 'reset size', 'restore original size'):")
            appendLine("    Call `scale_model` with action = \"reset\".")
            appendLine("• To duplicate a model (e.g. 'duplicate the model', 'make 2 copies of this', 'copy model 3 times'):")
            appendLine("  Call `duplicate_model` with count = <number> (default 1).")
            appendLine("• To delete or remove a model (e.g. 'delete this model', 'remove model', 'clear selected'):")
            appendLine("  Call `delete_model`.")
            appendLine("• To arrange all models on the plate (e.g. 'auto arrange the bed', 'arrange all models', 'nest objects'):")
            appendLine("  Call `arrange_bed`.")
            appendLine("• To move, center, or rotate a model on the plate:")
            appendLine("  - To center (e.g. 'center the model', 'center on plate'):")
            appendLine("    Call `transform_model` with operation = \"center\".")
            appendLine("  - To drop to bed (e.g. 'drop to bed', 'place flat on bed'):")
            appendLine("    Call `transform_model` with operation = \"drop_to_bed\".")
            appendLine("  - To rotate (e.g. 'rotate 90 degrees', 'turn 45 degrees'):")
            appendLine("    Call `transform_model` with operation = \"rotate\" and z_deg = <degrees>.")
            appendLine("  - To reset rotation (e.g. 'reset rotation'):")
            appendLine("    Call `transform_model` with operation = \"reset_rotation\".")
            appendLine("• To change/replace colors on a model (e.g. 'change the orange for the blue filament'):")
            appendLine("  1. Find slot of source color (e.g. Orange -> Slot 3) and target color (e.g. Blue -> Slot 1).")
            appendLine("  2. Call `remap_filaments` with mapping = {\"<source_slot>\": <target_slot>} (e.g. {\"3\": 1}).")
            appendLine("  3. ONLY include the changed slot(s) in mapping. Do NOT include unchanged slots.")
            appendLine("• To swap two colors on a model (e.g. 'swap orange and blue'):")
            appendLine("  Call `remap_filaments` with mapping = {\"3\": 1, \"1\": 3}.")
            appendLine("• To assign a filament slot to the selected model/part:")
            appendLine("  Call `assign_filament` with slot = <slot_number>.")
            appendLine("• To smart paint specific regions of a model (e.g. 'smart paint the top half white', 'paint overhangs blue', 'paint the bottom red'):")
            appendLine("  Call `smart_paint` with prompt = \"<region_description>\" and assignments = {\"<region>\": \"<color_or_slot_number>\"}.")
            appendLine("  Example: For 'smart paint the top half white', call `smart_paint` with prompt = \"top half\" and assignments = {\"top\": \"white\"}.")
            appendLine("  Example: For 'paint overhangs for support', call `smart_paint` with channel = \"support\", prompt = \"overhangs\", assignments = {\"overhang\": \"enforce\"}.")
            appendLine("• To paint an uncolored model as an iconic character or theme (e.g. 'paint this model like Pikachu', 'paint like a pumpkin', 'color as a frog', 'paint like Pikachu using available filaments only', 'paint Pikachu with full spectrum'):")
            appendLine("  Call `semantic_paint_model` with character = \"<character_name>\" (e.g. \"pikachu\", \"pumpkin\", \"frog\", \"fox\", \"benchy\").")
            appendLine("  Set palette_mode = \"full_spectrum\" if user mentions 'full spectrum', 'all colors', 'exact colors', or doesn't restrict to current filaments.")
            appendLine("  Set palette_mode = \"available_only\" if user mentions 'available filaments', 'loaded filaments only', 'current colors only', or 'without adding colors'.")
            appendLine("• To slice the plate:")
            appendLine("  Call `slice_active_plate`.")
            appendLine("• To check how long until the current print finishes, time remaining, or printer progress on the connected 3D printer (e.g. 'how long until the printer finishes', 'how kong until the printer finishes', 'when will the print finish', 'how much time is left on the printer', 'is the printer still printing', 'printer status'):")
            appendLine("  Call `get_printer_status`.")
            appendLine("• To check slicer estimates for the 3D model on the build plate in the editor (e.g. 'how long will this model take to print', 'how long will this plate take to print', 'how much filament does this slice need', 'slice summary'):")
            appendLine("  Call `get_slice_summary`.")
            appendLine("• To check printer temperatures, connection, or hardware state (e.g. 'what is the nozzle temperature', 'is the bed heated', 'what is the printer doing'):")
            appendLine("  Call `get_printer_status`.")
            appendLine()
            appendLine("USER INSTRUCTION:")
            append(normalizedPrompt)
        }.trim()

        Log.i(TAG, "Running tool inference on ${engine.backendName} with ${tools.size} tools...")
        var toolCall = try {
            engine.runToolCall(promptWithContext, tools, LlmInferenceProfile.COMMAND)
        } catch (t: Throwable) {
            Log.w(TAG, "runToolCall threw, falling back to conversational inference", t)
            null
        }

        // Resilient routing safeguard for printer status and time remaining queries
        if (isPrinterStatusQuery(normalizedPrompt)) {
            if (toolCall == null || toolCall.name == "get_slice_summary") {
                Log.i(TAG, "Routing query to get_printer_status (was: ${toolCall?.name})")
                toolCall = LlmToolCall(name = "get_printer_status", arguments = "{}")
            }
        }

        if (toolCall != null && McpManager.registry?.getTool(toolCall.name) != null) {
            Log.i(TAG, "Model selected tool: ${toolCall.name} with args: ${toolCall.arguments}")
            val parsedArgs = McpJson.parseObject(toolCall.arguments) ?: emptyMap()
            val result = try {
                McpManager.registry?.callTool(toolCall.name, parsedArgs)
            } catch (t: Throwable) {
                null
            }

            val resultText = result?.content?.joinToString("\n") {
                when (it) {
                    is McpContent.Text -> it.text
                    is McpContent.Image -> "[Image captured: ${it.mimeType}]"
                }
            } ?: "Tool executed."

            val summaryText = if (result?.isError == true) {
                val cleanError = VoiceInputManager.sanitizeForTts(resultText)
                    .removePrefix("Failed to")
                    .removePrefix("Error:")
                    .trim()
                "Could not execute ${toolCall.name}: $cleanError."
            } else {
                when (toolCall.name) {
                    "scale_model" -> resultText.trim()
                    "transform_model" -> resultText.trim()
                    "duplicate_model" -> resultText.trim()
                    "delete_model" -> resultText.trim()
                    "arrange_bed" -> resultText.trim()
                    "remap_filaments" -> "Updated model filament colors."
                    "smart_paint", "smart_paint_apply" -> "Smart painted the 3D model."
                    "semantic_paint_model" -> resultText.trim()
                    "slice_active_plate" -> "Started slicing the active build plate."
                    "assign_filament" -> "Assigned filament to the selected model."
                    "invoke_action" -> "Executed action ${parsedArgs["action_id"] ?: ""}."
                    "get_slice_summary" -> {
                        val obj = McpJson.parseObject(resultText)
                        val row = obj?.get("row_description") as? String ?: obj?.get("summary") as? String
                        if (!row.isNullOrBlank()) {
                            VoiceInputManager.sanitizeForTts(row)
                        } else {
                            "Slice summary retrieved."
                        }
                    }
                    "get_printer_status" -> formatPrinterStatusForTts(resultText)
                    else -> VoiceInputManager.sanitizeForTts(resultText.trim())
                }
            }

            return@withContext AssistantResponse(
                text = summaryText,
                toolCall = toolCall,
                toolResultText = resultText,
                isError = result?.isError ?: false,
            )
        }

        // If no tool was called, run plain inference to chat or explain
        Log.i(TAG, "No tool triggered, generating conversational answer...")
        val conversationalPrompt = """
You are OrcaXR AI, a voice-enabled 3D printing slicer assistant.
Respond in 1 or 2 short, direct sentences (maximum 25 words) that sound completely natural when read by text-to-speech.
RULES:
- NEVER use emojis or pictographs.
- NEVER use markdown formatting like asterisks, bullet points, hashtags, or code blocks.
- Speak in plain, clear conversational English.

$promptWithContext
""".trim()

        val responseText = try {
            val raw = engine.runInference(conversationalPrompt, profile = LlmInferenceProfile.CHAT, onToken = onToken)
            VoiceInputManager.sanitizeForTts(raw)
        } catch (t: Throwable) {
            Log.e(TAG, "runInference threw", t)
            "Error running inference: ${t.message}"
        }

        AssistantResponse(
            text = responseText,
            isError = false,
        )
    }

    private fun formatAiCoreStatus(status: AICoreStatus): String = when (status) {
        is AICoreStatus.Ready -> "Ready (Tensor TPU)"
        is AICoreStatus.Downloadable -> "Available (Download required in system)"
        is AICoreStatus.Downloading -> "Downloading (${(status.progress * 100).toInt()}%)"
        is AICoreStatus.Warming -> "Warming up"
        is AICoreStatus.Unavailable -> "Unavailable (${status.reason})"
        is AICoreStatus.Error -> "Error: ${status.message}"
        AICoreStatus.Unknown -> "Probing..."
    }

    private fun formatDownloadState(state: DownloadState): String = when (state) {
        is DownloadState.Ready -> "Ready (${state.file.name})"
        is DownloadState.Downloading -> "Downloading (${(state.progress * 100).toInt()}%)"
        is DownloadState.Idle -> "Not downloaded (Tap to download Gemma 4 E2B)"
        is DownloadState.Error -> "Error: ${state.message}"
    }
}
