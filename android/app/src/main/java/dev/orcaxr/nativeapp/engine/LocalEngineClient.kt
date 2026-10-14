package dev.orcaxr.nativeapp.engine

import android.app.ForegroundServiceStartNotAllowedException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Binder
import android.os.IBinder
import android.os.Process
import android.os.RemoteException
import android.os.SystemClock
import dev.orcaxr.core.LocalEngineEnd
import dev.orcaxr.core.LocalEngineResult
import dev.orcaxr.core.LocalSliceJob
import dev.orcaxr.core.LocalSliceRefusal
import dev.orcaxr.core.LocalSliceStatus
import dev.orcaxr.core.LocalSlicing
import java.lang.ref.Reference

/**
 * The editor's side of the local slicing engine: bound to [LocalEngineService]
 * in its own process for as long as this client lives. Each binding is a
 * generation with its process ID and a death watch. A job runs on the
 * caller's thread ([run]): the service is put in the foreground, the job
 * submitted with its staged inputs' identities and an owner token, and its
 * status polled. A cancel is first a cooperative stop; when the engine has not
 * stopped by [CANCEL_DEADLINE_MS] its process — that generation's alone — is
 * ended, and no other job is admitted until that process's death has been
 * observed. The engine's death without a cancel is an interruption; a job
 * whose end could not be observed is unknown.
 */
class LocalEngineClient(private val context: Context) : AutoCloseable {
    private val lock = Object()
    private var binding: Generation? = null
    private var bound = false
    private var generations = 0L
    /** A generation this client ended or lost track of; nothing is admitted until it has died. */
    private var awaitingDeath: Generation? = null

    private class Generation(val number: Long, val engine: ILocalEngine, val binder: IBinder) {
        var pid = 0
        @Volatile var dead = false
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            val generation = synchronized(lock) { Generation(++generations, ILocalEngine.Stub.asInterface(service), service) }
            try {
                service.linkToDeath({ died(generation) }, 0)
                generation.pid = generation.engine.processId()
            } catch (_: RemoteException) {
                generation.dead = true
            }
            synchronized(lock) {
                if (!generation.dead) binding = generation
                lock.notifyAll()
            }
        }

        override fun onServiceDisconnected(name: ComponentName) {
            synchronized(lock) {
                binding?.let { died(it) }
            }
        }

        override fun onBindingDied(name: ComponentName) {
            // The app was updated or the binding broken for good: bind again for the next job.
            synchronized(lock) {
                binding?.let { died(it) }
                if (bound) {
                    context.unbindService(this)
                    bound = false
                }
            }
        }
    }

    private fun died(generation: Generation) {
        synchronized(lock) {
            generation.dead = true
            if (binding === generation) binding = null
            if (awaitingDeath === generation) awaitingDeath = null
            lock.notifyAll()
        }
    }

    /** The current engine generation, binding and waiting up to [timeoutMs] for it. */
    private fun connect(timeoutMs: Long): Generation? = synchronized(lock) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        // A process this client ended (or lost) must be gone before another job starts.
        while (awaitingDeath != null) {
            val left = deadline - SystemClock.elapsedRealtime()
            if (left <= 0) throw LocalSliceRefusal(LocalSlicing.failed(LocalEngineWords.PREVIOUS_RUNNING))
            lock.wait(left)
        }
        if (!bound) {
            bound = context.bindService(Intent(context, LocalEngineService::class.java), connection, Context.BIND_AUTO_CREATE)
            if (!bound) return null
        }
        while (binding == null) {
            val left = deadline - SystemClock.elapsedRealtime()
            if (left <= 0) return null
            lock.wait(left)
        }
        binding
    }

    /** Waits up to [timeoutMs] for [generation]'s process to die; true once it has. */
    private fun awaitDeath(generation: Generation, timeoutMs: Long): Boolean = synchronized(lock) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (!generation.dead) {
            val left = deadline - SystemClock.elapsedRealtime()
            if (left <= 0) return false
            lock.wait(left)
        }
        true
    }

    /** Ends [generation]'s process (this app's own) and waits for its death; capacity stays held until then. */
    private fun terminate(generation: Generation, afterCancel: Boolean): LocalEngineEnd {
        synchronized(lock) { awaitingDeath = generation }
        if (generation.pid > 0 && generation.pid != Process.myPid()) Process.killProcess(generation.pid)
        return if (awaitDeath(generation, DEATH_DEADLINE_MS)) LocalEngineEnd.Died(afterCancel) else LocalEngineEnd.Lost
    }

    /**
     * Runs staged [job] on the engine, on the calling thread: [progress]
     * receives the engine's step and percent, [cancelled] is asked between
     * polls. Refusals before the job reached the engine throw
     * [LocalSliceRefusal] with the status line's words.
     */
    fun run(job: LocalSliceJob, progress: (String, Double?) -> Unit, cancelled: () -> Boolean): LocalEngineEnd =
        executeJob(job.id, { gen, owner ->
            gen.engine.start(job.id, job.archive.bytes, job.archive.sha256, job.overrides.bytes, job.overrides.sha256, owner)
        }, progress, cancelled)

    fun runRepair(job: dev.orcaxr.core.LocalRepairJob, progress: (String, Double?) -> Unit, cancelled: () -> Boolean): LocalEngineEnd =
        executeJob(job.id, { gen, owner ->
            gen.engine.startRepair(job.id, job.input.bytes, job.input.sha256, owner)
        }, progress, cancelled)

    fun runBoolean(job: dev.orcaxr.core.LocalBooleanJob, progress: (String, Double?) -> Unit, cancelled: () -> Boolean): LocalEngineEnd =
        executeJob(job.id, { gen, owner ->
            gen.engine.startBoolean(job.id, job.inputA.bytes, job.inputA.sha256, job.inputB.bytes, job.inputB.sha256, job.op, owner)
        }, progress, cancelled)

    private inline fun executeJob(
        jobId: String,
        startJob: (generation: Generation, owner: IBinder) -> Boolean,
        progress: (String, Double?) -> Unit,
        cancelled: () -> Boolean,
    ): LocalEngineEnd {
        val generation = connect(CONNECT_DEADLINE_MS) ?: throw LocalSliceRefusal(LocalSlicing.failed(LocalEngineWords.NOT_STARTED))
        val identity = try {
            generation.engine.identity()
        } catch (_: RemoteException) {
            throw LocalSliceRefusal(LocalSlicing.failed(LocalEngineWords.NOT_STARTED))
        }
        if (!identity.startsWith("ok ")) throw LocalSliceRefusal(LocalSlicing.failed(LocalEngineWords.refused(identity.removePrefix("no "))))
        if (cancelled()) return LocalEngineEnd.Reported(LocalEngineResult.Cancelled("inputs"))
        // The foreground keeps the engine running when the operator leaves the app; Android only allows starting it now.
        try {
            context.startForegroundService(Intent(context, LocalEngineService::class.java).setAction(LocalEngineService.ACTION_SLICE))
        } catch (_: ForegroundServiceStartNotAllowedException) {
            throw LocalSliceRefusal(LocalSlicing.failed(LocalEngineWords.BACKGROUND))
        }
        val owner = Binder()
        val started = try {
            startJob(generation, owner)
        } catch (_: RemoteException) {
            return if (awaitDeath(generation, DEATH_DEADLINE_MS)) LocalEngineEnd.Died(false) else terminate(generation, false)
        }
        if (!started) return LocalEngineEnd.Reported(LocalEngineResult.Busy)
        var cancelAt = 0L
        while (true) {
            if (cancelAt == 0L && cancelled()) {
                cancelAt = SystemClock.elapsedRealtime()
                try {
                    generation.engine.cancel(jobId)
                } catch (_: RemoteException) {
                }
            }
            val status = try {
                LocalSlicing.status(generation.engine.poll(jobId))
            } catch (_: RemoteException) {
                null
            } catch (_: IllegalArgumentException) {
                // A malformed answer is no outcome: the process is not trusted with this job any longer.
                val end = terminate(generation, cancelAt != 0L)
                return if (cancelAt != 0L) end else LocalEngineEnd.Lost
            }
            when (status) {
                null, LocalSliceStatus.Unknown ->
                    // The process died or restarted under the job: wait for its death to be reported.
                    return if (awaitDeath(generation, DEATH_DEADLINE_MS)) LocalEngineEnd.Died(cancelAt != 0L) else terminate(generation, cancelAt != 0L)
                is LocalSliceStatus.Done -> return LocalEngineEnd.Reported(status.result)
                is LocalSliceStatus.Running -> if (cancelAt == 0L) progress(status.message, status.percent?.toDouble())
            }
            if (cancelAt != 0L && SystemClock.elapsedRealtime() - cancelAt > CANCEL_DEADLINE_MS) return terminate(generation, true)
            Thread.sleep(POLL_MS)
            // The token lives as long as the job: its death is how the engine learns the editor is gone.
            Reference.reachabilityFence(owner)
        }
    }

    override fun close() {
        synchronized(lock) {
            if (bound) {
                context.unbindService(connection)
                bound = false
            }
            binding = null
            lock.notifyAll()
        }
    }

    private companion object {
        const val CONNECT_DEADLINE_MS = 15_000L
        /** How long a cooperative cancel may take before the engine's process is ended. */
        const val CANCEL_DEADLINE_MS = 10_000L
        const val DEATH_DEADLINE_MS = 10_000L
        const val POLL_MS = 250L
    }
}
