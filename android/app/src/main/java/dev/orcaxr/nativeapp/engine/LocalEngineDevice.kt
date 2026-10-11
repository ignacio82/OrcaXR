package dev.orcaxr.nativeapp.engine

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** This build's engine and this device's memory, measured now (read on the editor's side, no engine loaded). */
object LocalEngineDevice {
    /** The packaged engine manifest's commit and the device ABI it runs as; nulls when the build carries none. */
    private fun packaged(context: Context): Pair<String?, String?> = try {
        val manifest = JSONObject(context.assets.open(LocalEngineFiles.MANIFEST).use { it.readBytes().decodeToString() })
        val abis = manifest.getJSONObject("abis")
        manifest.getString("engineCommit") to Build.SUPPORTED_ABIS.firstOrNull(abis::has)
    } catch (_: IOException) {
        null to null
    }

    fun measure(context: Context): LocalEngineState {
        val (commit, abi) = packaged(context)
        val memory = ActivityManager.MemoryInfo()
        context.getSystemService(ActivityManager::class.java).getMemoryInfo(memory)
        return LocalEngineState(commit, abi, memory.totalMem, memory.availMem, memory.lowMemory)
    }

    /** The private directory local jobs are staged in, shared with the engine's process. */
    fun jobs(context: Context) = File(context.noBackupFilesDir, LocalEngineFiles.JOBS)
}
