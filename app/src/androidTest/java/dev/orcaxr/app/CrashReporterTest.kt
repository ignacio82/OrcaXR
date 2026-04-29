package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Black-box smoke tests for CrashReporter. We can't actually crash
 * the test process (the test runner's own UncaughtExceptionHandler
 * would unwind it), so the test invokes CrashReporter's internal
 * file-write path via the public surface: install + inspect.
 *
 * Direct path: trigger the installed handler manually by calling
 * `Thread.getDefaultUncaughtExceptionHandler().uncaughtException`
 * with a synthetic exception, then verify a crash file landed.
 */
@RunWith(AndroidJUnit4::class)
class CrashReporterTest {

    private val ctx by lazy {
        ApplicationProvider.getApplicationContext<android.content.Context>()
    }
    private val crashDir by lazy { File(ctx.filesDir, "crashes") }

    @Before
    fun setup() {
        // Start clean — the OrcaXRApplication onCreate already
        // installed the handler, so we just clear any prior files.
        CrashReporter.clearPastCrashes(ctx)
    }

    @After
    fun tearDown() {
        CrashReporter.clearPastCrashes(ctx)
    }

    @Test
    fun recordCrashWritesJsonWithExpectedFields() {
        // Use the public recordCrash helper so we don't go through
        // the UncaughtExceptionHandler delegation chain — the test
        // runner's handler would otherwise mark the test as crashed.
        val ex = IllegalStateException("synthetic crash for CrashReporterTest")
        CrashReporter.recordCrash(ctx, Thread.currentThread(), ex)

        val files = CrashReporter.scanPastCrashes(ctx)
        assertEquals(
            "expected exactly one crash file, got ${files.map { it.name }}",
            1, files.size,
        )
        val json: JSONObject? = CrashReporter.readCrash(files[0])
        assertNotNull("crash JSON unparseable", json)
        assertTrue(
            "crash JSON missing exception class",
            json!!.optString("exception").contains("IllegalStateException"),
        )
        assertTrue(
            "crash JSON missing message",
            json.optString("message").contains("synthetic crash"),
        )
        assertTrue(
            "crash JSON missing stack",
            json.optString("stack").contains("CrashReporterTest"),
        )
        assertTrue(
            "crash JSON missing timestamp",
            json.optString("timestamp").isNotBlank(),
        )
        assertTrue(
            "crash JSON missing device",
            json.optString("device").isNotBlank(),
        )
    }

    @Test
    fun scanPastCrashesIsEmptyAfterClear() {
        CrashReporter.clearPastCrashes(ctx)
        assertTrue(
            "crashes dir not empty after clear: ${crashDir.list()?.toList()}",
            CrashReporter.scanPastCrashes(ctx).isEmpty(),
        )
    }
}
