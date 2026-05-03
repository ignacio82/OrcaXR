package dev.orcaxr.app

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.zip.ZipFile

/**
 * D21b — auto-resolve a bundled paint template for a loaded model.
 *
 * Resolution order (highest priority first):
 *  1. MakerWorld design id parsed from the 3MF's `Metadata/
 *     model_settings.config` block (or, if the embedded metadata
 *     doesn't exist, from the 3MF filename when MakerWorld embeds it
 *     — e.g. `pikachu+US286aabafd2b978.3mf` ⇒ `US286aabafd2b978`).
 *  2. SHA-256 of the binary source file (covers re-uploaded /
 *     non-MakerWorld variants of well-known meshes).
 *  3. Lowercased basename-without-extension matched against the
 *     filename-alias map in `index.json` (covers unbranded STLs that
 *     follow common naming conventions like `pikachu_funko.stl`).
 *
 * Returns the recipe name (matching a `<name>.json` in the assets
 * directory) or null when no match is found.
 *
 * Pure (modulo file I/O on the source path); deterministic;
 * exercised by [PaintTemplateResolverTest] without going through the
 * MCP shell.
 */
internal object PaintTemplateResolver {

    private const val INDEX_PATH = "paint_templates/index.json"

    data class IndexEntry(
        val byMakerworldId: Map<String, String>,
        val bySha256: Map<String, String>,
        val byFilenameAlias: Map<String, String>,
    )

    data class Resolution(
        val recipeName: String,
        /** Which of the three keys produced the match — surfaced to
         *  the LLM so it knows whether the resolution was strong
         *  (sha/makerworld) or heuristic (filename alias). */
        val matchedBy: MatchKey,
        val key: String,
    )

    enum class MatchKey { MakerworldId, Sha256, FilenameAlias }

    fun loadIndex(ctx: Context): IndexEntry? {
        val text = runCatching {
            ctx.assets.open(INDEX_PATH).bufferedReader().use { it.readText() }
        }.getOrNull() ?: return null
        val obj = runCatching { JSONObject(text) }.getOrNull() ?: return null
        return IndexEntry(
            byMakerworldId = stringMap(obj.optJSONObject("by_makerworld_id")),
            bySha256 = stringMap(obj.optJSONObject("by_sha256")),
            byFilenameAlias = stringMap(obj.optJSONObject("by_filename_alias")),
        )
    }

    private fun stringMap(o: JSONObject?): Map<String, String> {
        if (o == null) return emptyMap()
        val out = HashMap<String, String>()
        for (k in o.keys()) {
            val v = o.optString(k, "")
            if (v.isNotEmpty()) out[k] = v
        }
        return out
    }

    /**
     * Resolve a recipe for [source]. Returns null when no match.
     */
    fun resolve(ctx: Context, source: File): Resolution? {
        val index = loadIndex(ctx) ?: return null
        return resolveAgainst(index, source)
    }

    /** Test entry point: resolve against an in-memory index. */
    fun resolveAgainst(index: IndexEntry, source: File): Resolution? {
        if (!source.exists() || !source.isFile) return null
        // 1. MakerWorld design id (3MF only).
        val mwId = makerworldIdFor(source)
        if (mwId != null) {
            index.byMakerworldId[mwId]?.let {
                return Resolution(it, MatchKey.MakerworldId, mwId)
            }
        }
        // 2. SHA-256 of the source file.
        val sha = sha256(source) ?: return resolveByFilename(index, source)
        index.bySha256[sha]?.let {
            return Resolution(it, MatchKey.Sha256, sha)
        }
        // 3. Filename alias.
        return resolveByFilename(index, source)
    }

    private fun resolveByFilename(index: IndexEntry, source: File): Resolution? {
        val key = filenameAlias(source) ?: return null
        index.byFilenameAlias[key]?.let {
            return Resolution(it, MatchKey.FilenameAlias, key)
        }
        return null
    }

    /** Lowercased basename, sans extension, with non-alnum collapsed to `_`. */
    internal fun filenameAlias(file: File): String? {
        val base = file.nameWithoutExtension.lowercase().ifEmpty { return null }
        // Strip MakerWorld id suffix tokens like `+US286aabafd2b978`.
        val noMwTail = base.substringBefore('+')
        // Replace runs of non-alphanumeric with single underscore.
        val collapsed = noMwTail.replace(Regex("[^a-z0-9]+"), "_").trim('_')
        if (collapsed.isEmpty()) return null
        return collapsed
    }

    /** Parse a MakerWorld design id out of [source]. Returns null if
     *  the file isn't a 3MF or no id is found. */
    internal fun makerworldIdFor(source: File): String? {
        // Filename pattern: `<anything>+<id>.3mf` with id like
        // `US286aabafd2b978` (uppercase letters + 14 hex chars). The
        // exact format isn't published; treat the suffix between `+`
        // and the extension as the id.
        val name = source.nameWithoutExtension
        val plus = name.lastIndexOf('+')
        if (plus >= 0 && plus + 1 < name.length) {
            val candidate = name.substring(plus + 1)
            if (looksLikeMakerworldId(candidate)) return candidate
        }
        // Fall back to embedded metadata if it's a 3MF zip.
        if (source.extension.equals("3mf", ignoreCase = true)) {
            return makerworldIdFromZip(source)
        }
        return null
    }

    private fun looksLikeMakerworldId(s: String): Boolean {
        if (s.length !in 8..64) return false
        // Allow alphanumeric + dash (MakerWorld uses both schemes).
        return s.all { it.isLetterOrDigit() || it == '-' || it == '_' }
    }

    private fun makerworldIdFromZip(source: File): String? {
        // Read `Metadata/model_settings.config` looking for a
        // makerworld design-id metadata line. The 3MF is a zip, so
        // open via ZipFile.
        return runCatching {
            ZipFile(source).use { zip ->
                // Possible filenames depending on which slicer wrote
                // the file. Walk a few candidates rather than
                // hard-coding one.
                val candidates = listOf(
                    "Metadata/model_settings.config",
                    "Metadata/Slic3r_PE_model.config",
                    "Metadata/project_settings.config",
                )
                for (name in candidates) {
                    val entry = zip.getEntry(name) ?: continue
                    val text = zip.getInputStream(entry).bufferedReader().use { it.readText() }
                    val match = Regex(
                        "(?:design[_-]?id|design_id|makerworld_design_id)\\s*=\\s*\"?([A-Za-z0-9_-]+)\"?",
                        RegexOption.IGNORE_CASE,
                    ).find(text)
                    if (match != null) return@use match.groupValues[1]
                }
                null
            }
        }.getOrNull()
    }

    /** SHA-256 of [source] as lowercase hex. Null on I/O failure. */
    internal fun sha256(source: File): String? {
        return runCatching {
            val md = MessageDigest.getInstance("SHA-256")
            source.inputStream().use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    md.update(buf, 0, n)
                }
            }
            val digest = md.digest()
            val sb = StringBuilder(64)
            for (b in digest) sb.append(String.format("%02x", b))
            sb.toString()
        }.getOrNull()
    }
}
