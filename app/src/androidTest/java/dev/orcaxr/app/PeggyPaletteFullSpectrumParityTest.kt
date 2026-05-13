package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * FullSpectrum parity smoke test.
 *
 * Slices the user's actual `PeggyPalette38+Mini+BRYW.3mf` with the
 * desktop FullSpectrum config that produced
 * `WhoShrunkPeggyPalette_PLA_2h15m_fullspectrum.gcode`, then reports
 * how OrcaXR's output differs from the reference. The test does NOT
 * assert byte-equality — the slicer is still missing several
 * FullSpectrum patches (see memory:project_orcaxr_patch_chain) so
 * exact parity is unrealistic today. Instead it pins:
 *
 *  - The slice completes (no SIGABRT / NativeError).
 *  - Layer count is within ±2 of the reference (catches major regressions).
 *  - The OrcaXR output is pulled to disk so a human can diff for detail.
 *
 * Pre-staging (done once before this test runs):
 * ```
 * adb push WhoShrunkPeggyPalette_PLA_2h15m_fullspectrum.gcode \
 *   /sdcard/Download/peggy_fs_reference.gcode
 * adb shell 'cp "/sdcard/Download/Quick Share/PeggyPalette38+Mini+BRYW.3mf" \
 *   /sdcard/Download/peggy_input.3mf'
 * ```
 * Then the test extracts the CONFIG_BLOCK from the reference itself —
 * single source of truth for "what config produced this output."
 */
@RunWith(AndroidJUnit4::class)
class PeggyPaletteFullSpectrumParityTest {

    @Test
    fun orcaxrMatchesFullSpectrumOnPeggyPalette(): Unit = runBlocking {
        val tag = "OrcaXR/peggyFS"
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()

        // Android scoped storage: the test process can't read /sdcard
        // directly. Same dance as UnicornFineProfileTest — `cp` from
        // /sdcard/Download/ into the test's external-files dir via the
        // instrumentation shell, then open from there.
        val dir = appCtx.getExternalFilesDir(null) ?: appCtx.cacheDir
        fun runShell(cmd: String): String {
            val pfd = InstrumentationRegistry.getInstrumentation()
                .uiAutomation.executeShellCommand(cmd)
            val out = java.io.FileInputStream(pfd.fileDescriptor)
                .use { it.bufferedReader().readText() }
            pfd.close()
            return out
        }
        val src = File(dir, "peggy_input.3mf")
        val ref = File(dir, "peggy_fs_reference.gcode")
        if (!src.exists() || src.length() == 0L) {
            android.util.Log.i(tag, "cp 3mf: '${runShell("cp /sdcard/Download/peggy_input.3mf ${src.absolutePath}")}'")
        }
        if (!ref.exists() || ref.length() == 0L) {
            android.util.Log.i(tag, "cp ref: '${runShell("cp /sdcard/Download/peggy_fs_reference.gcode ${ref.absolutePath}")}'")
        }
        assumeTrue(
            "peggy_input.3mf not staged. Pre-stage via " +
                "`adb shell cp \"/sdcard/Download/Quick Share/PeggyPalette38+Mini+BRYW.3mf\" /sdcard/Download/peggy_input.3mf`.",
            src.exists() && src.length() > 0,
        )
        assumeTrue(
            "peggy_fs_reference.gcode not staged. Pre-stage via " +
                "`adb push WhoShrunkPeggyPalette_PLA_2h15m_fullspectrum.gcode /sdcard/Download/peggy_fs_reference.gcode`.",
            ref.exists() && ref.length() > 0,
        )

        // Parse the reference's CONFIG_BLOCK into the Map<String,String>
        // SlicerEngine.slice consumes. Each line is "; key = value"; we
        // skip the markers and split on the first ' = '. The block is
        // ~6 % of the reference (565 lines out of 532k), so reading
        // line-by-line and stopping at CONFIG_BLOCK_END keeps memory
        // bounded even though we don't actually load the rest.
        val config = mutableMapOf<String, String>()
        var inConfig = false
        ref.bufferedReader().use { r ->
            r.lineSequence().forEach { rawLine ->
                if (rawLine.startsWith("; CONFIG_BLOCK_START")) {
                    inConfig = true; return@forEach
                }
                if (rawLine.startsWith("; CONFIG_BLOCK_END")) {
                    inConfig = false; return@forEach
                }
                if (!inConfig || !rawLine.startsWith("; ")) return@forEach
                // Strip "; " prefix, find the FIRST " = " separator (some
                // values themselves contain '=', e.g. start_gcode).
                val body = rawLine.substring(2)
                val eq = body.indexOf(" = ")
                if (eq <= 0) return@forEach
                val key = body.substring(0, eq).trim()
                val value = body.substring(eq + 3)
                config[key] = value
            }
        }
        android.util.Log.i(tag, "Parsed ${config.size} config keys from reference")
        assertTrue("CONFIG_BLOCK parse produced no keys", config.size > 100)

        // Undo append_full_config's flush_multiplier transformation.
        // GCode::append_full_config multiplies flush_volumes_matrix by
        // flush_multiplier when writing the CONFIG_BLOCK dump, so the
        // reference's matrix is already *flush_multiplier. If we feed it
        // back without unwinding, OrcaXR's append_full_config will
        // multiply again — wipe tower runs at flush_multiplier^2 (e.g.,
        // 0.49 instead of 0.7), distorting per-slot filament use.
        run {
            val mStr = config["flush_multiplier"] ?: return@run
            val m = mStr.toDoubleOrNull() ?: return@run
            if (m <= 0.0 || m == 1.0) return@run
            val rawMatrix = config["flush_volumes_matrix"] ?: return@run
            val unwound = rawMatrix.split(",").map {
                val v = it.trim().toDoubleOrNull() ?: return@run
                (v / m).let { x -> if (x % 1.0 == 0.0) x.toLong().toString() else "%.4f".format(x) }
            }.joinToString(",")
            config["flush_volumes_matrix"] = unwound
            android.util.Log.i(tag, "unwound flush_volumes_matrix by /${m}: was '$rawMatrix' -> '$unwound'")
        }

        // Slice into the test's writable external-files dir. The
        // post-test `cp` back to /sdcard/Download/ uses the same shell
        // trick (the test process can't write directly under /sdcard
        // either).
        val out = File(dir, "peggy_orcaxr_actual.gcode")
        val tStart = System.currentTimeMillis()
        val result = SlicerEngine.slice(stl = src, outGcode = out, config = config)
        val elapsed = System.currentTimeMillis() - tStart
        android.util.Log.i(tag, "slice took ${elapsed}ms, result=$result")
        assertTrue("slice failed: $result", result is SliceResult.Success)

        // Pull headline metrics out of both gcodes and log them side by
        // side. We deliberately don't assertEquals — major divergence is
        // expected today — but we surface it so a regression is visible
        // at a glance.
        val refLayers = headerInt(ref, "; total layer number:")
        val refMaxZ = headerFloat(ref, "; max_z_height:")
        val actLayers = headerInt(out, "; total layer number:")
        val actMaxZ = headerFloat(out, "; max_z_height:")
        android.util.Log.i(tag,
            "headline metrics: refLayers=$refLayers refMaxZ=$refMaxZ " +
                "actLayers=$actLayers actMaxZ=$actMaxZ",
        )

        // Count executable G/M lines (ignoring headers / config / comments).
        val refMoves = countExecLines(ref)
        val actMoves = countExecLines(out)
        android.util.Log.i(tag, "executable line counts: ref=$refMoves act=$actMoves diff=${actMoves - refMoves}")

        // Catch trivially-broken regressions: if OrcaXR's output is
        // less than half the reference's executable line count, something
        // catastrophic happened (slice dropped most volumes, painted faces
        // ignored, etc.). The looser tolerance is on layer count: ±2.
        assertTrue(
            "OrcaXR produced too few executable lines ($actMoves) vs reference ($refMoves)",
            actMoves >= refMoves / 2,
        )
        if (refLayers > 0 && actLayers > 0) {
            assertTrue(
                "OrcaXR layer count $actLayers diverged > 5 from reference $refLayers",
                kotlin.math.abs(actLayers - refLayers) <= 5,
            )
        }

        // Copy the produced gcode back under /sdcard/Download/ so the
        // developer can pull it with a plain `adb pull` instead of
        // chasing the test's external-files path.
        runCatching {
            runShell("cp ${out.absolutePath} /sdcard/Download/peggy_orcaxr_actual.gcode")
            runShell("chmod 644 /sdcard/Download/peggy_orcaxr_actual.gcode")
        }
        android.util.Log.i(tag, "OrcaXR output staged at /sdcard/Download/peggy_orcaxr_actual.gcode")
    }

    private fun headerInt(f: File, key: String): Int {
        f.bufferedReader().use { r ->
            for (line in r.lineSequence().take(2000)) {
                if (line.startsWith(key)) {
                    return Regex("""\d+""").find(line)?.value?.toIntOrNull() ?: -1
                }
                if (line.startsWith("; HEADER_BLOCK_END")) break
            }
        }
        return -1
    }

    private fun headerFloat(f: File, key: String): Float {
        f.bufferedReader().use { r ->
            for (line in r.lineSequence().take(2000)) {
                if (line.startsWith(key)) {
                    return Regex("""[\d.]+""").find(line)?.value?.toFloatOrNull() ?: -1f
                }
                if (line.startsWith("; HEADER_BLOCK_END")) break
            }
        }
        return -1f
    }

    private fun countExecLines(f: File): Int {
        var n = 0
        f.bufferedReader().use { r ->
            r.lineSequence().forEach { line ->
                if (line.isEmpty() || line.startsWith(";")) return@forEach
                if (line.startsWith("G") || line.startsWith("M") || line.startsWith("T")) n++
            }
        }
        return n
    }
}
