package dev.orcaxr.app

import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Local crash reporting. No network egress, no third-party SDK.
 *
 * On install: registers a [Thread.UncaughtExceptionHandler] that
 * serializes any uncaught exception to a JSON file under
 * `${filesDir}/crashes/crash_<timestamp>.json` before delegating to
 * the previously-installed handler (which kills the process). On
 * next launch [scanPastCrashes] surfaces any files that landed during
 * the previous run.
 *
 * Native crashes (SIGSEGV from libslic3r etc.) are NOT captured here
 * — Android's debuggerd already produces a tombstone visible in
 * logcat with a full backtrace. Adding a parallel signal handler in
 * the JNI shim would conflict with debuggerd's hook chain.
 */
object CrashReporter {

    private const val TAG = "OrcaXR/crash"
    private const val DIR_NAME = "crashes"
    private val ISO = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)

    fun install(ctx: Context) {
        val appCtx = ctx.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            runCatching { recordCrash(appCtx, thread, throwable) }
                .onFailure { Log.e(TAG, "failed to write crash JSON", it) }
            // Delegate to whatever was installed before (Android's
            // default handler kills the process; AndroidX test runners
            // intercept and report). Don't swallow the crash.
            previous?.uncaughtException(thread, throwable)
        }
        Log.i(TAG, "CrashReporter installed; crash dir = ${File(appCtx.filesDir, DIR_NAME).absolutePath}")
    }

    /**
     * Write a crash JSON for [t] without going through the
     * UncaughtExceptionHandler chain. Useful for instrumented
     * testing — and for caller code that wants to capture a
     * non-fatal exception in the same on-disk format.
     */
    fun recordCrash(ctx: Context, thread: Thread, t: Throwable) {
        val appCtx = ctx.applicationContext
        val dir = File(appCtx.filesDir, DIR_NAME).also { it.mkdirs() }
        writeCrash(appCtx, dir, thread, t)
    }

    private fun writeCrash(ctx: Context, dir: File, thread: Thread, t: Throwable) {
        val now = System.currentTimeMillis()
        val fileName = "crash_${now}.json"
        val out = File(dir, fileName)
        val sw = StringWriter()
        t.printStackTrace(PrintWriter(sw))

        val pkg = runCatching {
            ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        }.getOrNull()
        val versionName = pkg?.versionName ?: "?"
        val versionCode = pkg?.longVersionCode ?: -1L

        // Last 200 OrcaXR logcat lines. Best-effort — fails silently
        // on devices that block app-level logcat reads (post API 16
        // restricts apps to their own pid by default; we still try).
        val logTail = runCatching {
            val proc = ProcessBuilder(
                "logcat", "-d", "-t", "200",
                "OrcaXR:V", "OrcaXR/jni:V", "OrcaXR/preview:V", "OrcaXR/bench:V", "OrcaXR/crash:V", "*:S",
            ).redirectErrorStream(true).start()
            proc.inputStream.bufferedReader().use { it.readText() }
                .lines().takeLast(200).joinToString("\n")
        }.getOrDefault("")

        val json = JSONObject().apply {
            put("timestamp", ISO.format(Date(now)))
            put("thread", thread.name)
            put("exception", t.javaClass.name)
            put("message", t.message ?: "")
            put("stack", sw.toString())
            put("versionName", versionName)
            put("versionCode", versionCode)
            put("device", "${Build.MANUFACTURER} ${Build.MODEL} (${Build.PRODUCT})")
            put("androidVersion", Build.VERSION.RELEASE)
            put("sdkInt", Build.VERSION.SDK_INT)
            put("logcatTail", logTail)
        }
        out.writeText(json.toString(2))
        Log.e(TAG, "wrote ${out.absolutePath}")
    }

    /** Returns crash JSON files written during prior process runs, newest first. */
    fun scanPastCrashes(ctx: Context): List<File> {
        val dir = File(ctx.applicationContext.filesDir, DIR_NAME)
        if (!dir.exists()) return emptyList()
        return (dir.listFiles { f -> f.name.startsWith("crash_") && f.name.endsWith(".json") }
            ?: emptyArray())
            .sortedByDescending { it.lastModified() }
            .toList()
    }

    /** Delete every past-crash file. Used by the dismiss action. */
    fun clearPastCrashes(ctx: Context) {
        val dir = File(ctx.applicationContext.filesDir, DIR_NAME)
        runCatching { dir.listFiles()?.forEach { it.delete() } }
    }

    /** Read a stored crash file back into a JSONObject for display. */
    fun readCrash(file: File): JSONObject? = runCatching {
        JSONObject(file.readText())
    }.getOrNull()
}
