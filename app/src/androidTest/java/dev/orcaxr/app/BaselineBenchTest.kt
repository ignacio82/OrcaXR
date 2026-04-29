package dev.orcaxr.app

import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Records baseline performance numbers for the slicing pipeline on
 * the user's actual hardware (Galaxy XR / SM-I610). Slices the
 * bundled 20 mm cube ten times back-to-back and emits a parseable
 * `[BENCH]` line to logcat with:
 *   - p50 / p95 / max wall time per slice
 *   - peak resident-set size during the run
 *   - thermal delta (max temperature change across all CPU/GPU
 *     thermal zones between run 1 and run 10)
 *
 * Soft assertions: peak RSS under 500 MB and thermal delta under
 * 15 °C — generous bounds, just to catch a clear regression.
 *
 * To pull the numbers after the run:
 *   adb logcat -d | grep '\[BENCH\] orcaxr_cube'
 *
 * Skip in CI by passing `-Pandroid.testInstrumentationRunnerArguments.notClass=dev.orcaxr.app.BaselineBenchTest`.
 */
@RunWith(AndroidJUnit4::class)
class BaselineBenchTest {

    private val tag = "OrcaXR/bench"

    @Test
    fun cubeSliceTenRunsBaseline() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context

        val stl = File(appCtx.cacheDir, "cube_bench.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val out = File(appCtx.cacheDir, "cube_bench.gcode")

        // Same minimal config the rest of the test suite uses to
        // satisfy Print::validate() under forced relative-E (see
        // SlicerEngineTest.minValidConfig + GEMINI.md gotcha 15).
        val cfg = mapOf("before_layer_change_gcode" to "G92 E0\n")

        val tempsBefore = readThermalZoneTemps()
        Log.i(tag, "[BENCH] thermal_baseline=${tempsBefore.joinToString(",") { "%.1f".format(it) }}°C")

        val timings = LongArray(10)
        var peakRssKb = 0L
        var failures = 0

        for (i in 0 until 10) {
            val rssBeforeKb = readRssKb()
            val t0 = System.nanoTime()
            val r = SlicerEngine.slice(stl, out, cfg)
            val elapsedMs = (System.nanoTime() - t0) / 1_000_000
            val rssAfterKb = readRssKb()
            timings[i] = elapsedMs
            peakRssKb = maxOf(peakRssKb, rssBeforeKb, rssAfterKb)
            if (r !is SliceResult.Success) {
                failures += 1
                Log.e(tag, "[BENCH] slice $i FAILED: $r")
            }
            Log.i(tag, "[BENCH] orcaxr_cube_slice_$i ms=$elapsedMs rss_kb=$rssAfterKb")
        }

        val tempsAfter = readThermalZoneTemps()
        val maxDelta: Double = if (tempsBefore.isNotEmpty() && tempsAfter.isNotEmpty()) {
            val n = minOf(tempsBefore.size, tempsAfter.size)
            (0 until n).maxOf { (tempsAfter[it] - tempsBefore[it]) }
        } else 0.0

        timings.sort()
        val p50 = timings[5]
        val p95 = timings[(timings.size * 0.95).toInt().coerceAtMost(timings.size - 1)]
        val maxMs = timings.last()
        val peakRssMb = peakRssKb / 1024
        Log.i(
            tag,
            "[BENCH] orcaxr_cube_summary p50_ms=$p50 p95_ms=$p95 max_ms=$maxMs " +
                "peak_rss_mb=$peakRssMb thermal_delta_c=%.1f failures=$failures runs=10".format(maxDelta),
        )

        assertTrue("$failures of 10 slices failed", failures == 0)
        assertTrue("peak RSS $peakRssMb MB exceeds 500 MB ceiling", peakRssMb < 500)
        assertTrue("thermal delta ${"%.1f".format(maxDelta)}°C exceeds 15°C ceiling", maxDelta < 15.0)
    }

    /**
     * Resident-set size in KB from /proc/self/statm. Field [1] is
     * resident pages; multiply by `Os.sysconf(_SC_PAGESIZE)` (4 KB
     * on arm64-v8a Android) and divide back to KB.
     */
    private fun readRssKb(): Long {
        return runCatching {
            val statm = File("/proc/self/statm").readText().trim().split(Regex("\\s+"))
            if (statm.size < 2) return 0L
            val residentPages = statm[1].toLong()
            val pageSizeBytes = android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE)
            (residentPages * pageSizeBytes) / 1024
        }.getOrDefault(0L)
    }

    /**
     * Read every accessible `thermal_zoneN/temp` under
     * `/sys/class/thermal/`. Values are typically millidegrees
     * Celsius — we divide by 1000 to get °C. Some zones are
     * sensor-locked and unreadable to non-root user-space; those
     * silently drop out.
     */
    private fun readThermalZoneTemps(): List<Double> {
        return runCatching {
            val dir = File("/sys/class/thermal")
            val zones = dir.listFiles { f -> f.name.startsWith("thermal_zone") }
                ?: return emptyList()
            zones.mapNotNull { zone ->
                runCatching {
                    val raw = File(zone, "temp").readText().trim().toLong()
                    raw / 1000.0
                }.getOrNull()
            }.sorted()
        }.getOrDefault(emptyList())
    }
}
