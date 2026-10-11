package dev.orcaxr.nativeapp.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.os.RemoteException
import dev.orcaxr.core.LocalSlicing
import dev.orcaxr.nativeapp.R
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.MessageDigest

/**
 * The local slicing engine's service, alone in the app's `:engine` process
 * (not exported, not an isolated sandbox): the editor survives whatever the
 * engine does. One job at a time, read from and written to the job's private
 * staged directory; Binder carries only the job's identities, its progress
 * and the engine's result document.
 *
 * While a job runs the service is in the foreground (type dataSync: local
 * file processing the operator started, shown with progress and a Cancel
 * action), so the slice continues when the operator switches tasks or locks
 * the screen. A cancel asks the engine to stop at its next cancellation
 * point; ending this process when it does not is the editor's decision
 * ([LocalEngineClient]). When the editor that owns a job dies, the job is
 * cancelled and its files removed.
 */
class LocalEngineService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    private var running: Job? = null
    private var engine: Load? = null
    private var foreground = false
    private val jobs by lazy { File(noBackupFilesDir, LocalEngineFiles.JOBS) }

    private class Job(val id: String, val directory: File, val owner: IBinder) {
        @Volatile var result: String? = null
        @Volatile var ownerGone = false
        lateinit var death: IBinder.DeathRecipient
    }

    private sealed interface Load {
        class Ready(val identity: String, val resources: File) : Load
        class Refused(val reason: String) : Load
    }

    override fun onBind(intent: Intent): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SLICE -> {
                // The editor starts the foreground before it submits the job; one that never comes is let go.
                promote()
                main.postDelayed({ synchronized(lock) { if (running == null) demote() } }, ADMISSION_MS)
            }
            ACTION_CANCEL -> {
                synchronized(lock) { running }?.let { NativeEngine.nativeCancel() }
                // Nothing keeps a service started only to hear a cancel.
                if (!foreground) stopSelf(startId)
            }
        }
        return START_NOT_STICKY
    }

    /** Android 15's foreground time limit for this type: the job is stopped as a cancel would. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        synchronized(lock) { running }?.let { NativeEngine.nativeCancel() }
        demote()
    }

    private fun promote() {
        if (foreground) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.engine_channel), NotificationManager.IMPORTANCE_LOW),
        )
        startForeground(NOTIFICATION, notification(-1), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        foreground = true
        main.post(ticker)
    }

    private fun demote() {
        main.removeCallbacks(ticker)
        if (!foreground) return
        foreground = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun notification(percent: Int): Notification {
        val cancel = PendingIntent.getService(
            this, 0, Intent(this, LocalEngineService::class.java).setAction(ACTION_CANCEL),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(getString(R.string.engine_notification))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(100, percent.coerceAtLeast(0), percent < 0)
            .setContentIntent(launch)
            .addAction(Notification.Action.Builder(null, getString(R.string.prepare_cancel), cancel).build())
            .build()
    }

    /** The notification follows the engine's percent while a job runs. */
    private val ticker = object : Runnable {
        override fun run() {
            if (!foreground) return
            val job = synchronized(lock) { running }
            if (job != null && job.result == null) {
                val percent = JSONObject(NativeEngine.nativeProgress()).optInt("percent", -1)
                getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification(percent))
            }
            main.postDelayed(this, TICK_MS)
        }
    }

    /** The packaged library, loaded once and checked against the app's engine manifest. */
    private fun load(): Load = synchronized(lock) {
        engine ?: try {
            val manifest = JSONObject(assets.open(LocalEngineFiles.MANIFEST).use { it.readBytes().decodeToString() })
            val abis = manifest.getJSONObject("abis")
            if (Build.SUPPORTED_ABIS.none(abis::has)) throw IllegalStateException(LocalEngineWords.NO_ABI)
            NativeEngine.load()
            val identityText = NativeEngine.nativeIdentity()
            val identity = JSONObject(identityText)
            for (key in listOf("engineCommit", "engineRecipe")) {
                if (identity.getString(key) != manifest.getString(key)) throw IllegalStateException("its $key differs from the build's manifest")
            }
            if (identity.getString("adapterRecipe") != manifest.getString("adapterRecipe")) {
                throw IllegalStateException("its adapter recipe differs from the build's manifest")
            }
            Load.Ready(identityText, resources(manifest))
        } catch (failure: Throwable) {
            Load.Refused(failure.message ?: failure.javaClass.simpleName)
        }.also { engine = it }
    }

    /** The engine's resource files, copied from the APK's assets and each checked against the manifest. */
    private fun resources(manifest: JSONObject): File {
        val expected = manifest.getJSONObject("resources")
        val root = File(noBackupFilesDir, LocalEngineFiles.RESOURCES + "/" + manifest.getString("adapterRecipe"))
        for (name in expected.keys()) {
            require(Regex("[a-z]+/[a-z_]+\\.json").matches(name)) { "unexpected resource $name" }
            val bytes = assets.open(LocalEngineFiles.RESOURCE_ASSETS + "/" + name).use { it.readBytes() }
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            check(digest == expected.getString(name)) { "resource $name differs from the build's manifest" }
            val target = File(root, name)
            if (target.isFile && target.readBytes().contentEquals(bytes)) continue
            target.parentFile!!.mkdirs()
            val part = File(target.parentFile, target.name + ".part")
            FileOutputStream(part).use { stream ->
                stream.write(bytes)
                stream.fd.sync()
            }
            check(part.renameTo(target)) { "resource $name could not be placed" }
        }
        return root
    }

    private val binder = object : ILocalEngine.Stub() {
        private fun owned() {
            // Not exported: only this app binds. Checked anyway, per call.
            if (Binder.getCallingUid() != Process.myUid()) throw SecurityException("not this app")
        }

        override fun processId(): Int {
            owned()
            return Process.myPid()
        }

        override fun identity(): String {
            owned()
            return when (val loaded = load()) {
                is Load.Ready -> "ok " + loaded.identity
                is Load.Refused -> "no " + loaded.reason
            }
        }

        override fun start(id: String, archiveBytes: Long, archiveSha256: String, overridesBytes: Long, overridesSha256: String, owner: IBinder): Boolean {
            owned()
            val ready = load() as? Load.Ready ?: return false
            require(LocalEngineFiles.validJob(id)) { "invalid job" }
            val directory = File(jobs, id)
            // The editor staged it; a link in its place is refused.
            require(Files.isDirectory(directory.toPath(), LinkOption.NOFOLLOW_LINKS)) { "invalid job" }
            val job = Job(id, directory, owner)
            synchronized(lock) {
                if (running != null) return false
                running = job
            }
            job.death = IBinder.DeathRecipient {
                // The editor that owns the job is gone: nobody will claim its output.
                job.ownerGone = true
                NativeEngine.nativeCancel()
            }
            try {
                owner.linkToDeath(job.death, 0)
            } catch (_: RemoteException) {
                job.ownerGone = true
            }
            main.post {
                // The editor started the foreground before submitting; this keeps a job that raced it covered.
                try {
                    promote()
                } catch (_: IllegalStateException) {
                }
            }
            Thread(null, {
                // An owner gone before the engine started: nothing to slice for. (A job resets the
                // engine's cancel flag as it starts, so a cancel sent earlier would be lost.)
                val result = if (job.ownerGone) OWNER_GONE else try {
                    NativeEngine.nativeSlice(
                        directory.absolutePath,
                        File(directory, "input.3mf").absolutePath, archiveBytes, archiveSha256,
                        File(directory, "overrides.json").absolutePath, overridesBytes, overridesSha256,
                        ready.resources.absolutePath, File(directory, "output.gcode").absolutePath,
                    )
                } catch (failure: Throwable) {
                    ENGINE_FAILED
                }
                job.result = try {
                    LocalSlicing.result(result)
                    result
                } catch (_: IllegalArgumentException) {
                    ENGINE_FAILED
                }
                main.post { finished(job) }
            }, "orcaxr-engine", STACK_BYTES).start()
            return true
        }

        override fun poll(id: String): String {
            owned()
            val job = synchronized(lock) { running?.takeIf { it.id == id } ?: finished?.takeIf { it.id == id } } ?: return LocalSlicing.UNKNOWN
            job.result?.let { return LocalSlicing.done(it) }
            val progress = JSONObject(NativeEngine.nativeProgress())
            return LocalSlicing.running(progress.optInt("percent", -1), progress.optString("message", ""))
        }

        override fun cancel(id: String) {
            owned()
            if (synchronized(lock) { running }?.id == id) NativeEngine.nativeCancel()
        }
    }

    /** The last finished job, kept so its owner's next poll reads its result. */
    @Volatile private var finished: Job? = null

    private fun finished(job: Job) {
        synchronized(lock) {
            if (running === job) running = null
            finished = job
        }
        try {
            job.owner.unlinkToDeath(job.death, 0)
        } catch (_: Throwable) {
        }
        // An owner that died never claims its job; nothing of it is kept.
        if (job.ownerGone) LocalSlicing.discard(job.directory)
        demote()
    }

    internal companion object {
        /** Sent by the editor before it submits a job: the service enters the foreground. */
        const val ACTION_SLICE = "dev.orcaxr.nativeapp.engine.SLICE"
        /** The notification's Cancel. */
        const val ACTION_CANCEL = "dev.orcaxr.nativeapp.engine.CANCEL"
        const val CHANNEL = "slicing"
        const val NOTIFICATION = 1
        const val ADMISSION_MS = 15_000L
        const val TICK_MS = 1_000L
        /** libslic3r recurses deeply on its calling thread; give it a desktop-sized stack. */
        const val STACK_BYTES = 64L shl 20
        const val OWNER_GONE = "{\"schemaVersion\":1,\"outcome\":\"cancelled\",\"stage\":\"inputs\"}"
        const val ENGINE_FAILED = "{\"schemaVersion\":1,\"outcome\":\"failed\",\"stage\":\"output\",\"code\":\"invalid-result\"," +
            "\"message\":\"The slicing engine returned no valid result.\"}"
    }
}
