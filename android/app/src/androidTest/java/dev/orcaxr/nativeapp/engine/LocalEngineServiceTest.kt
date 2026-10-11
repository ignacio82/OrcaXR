package dev.orcaxr.nativeapp.engine

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.orcaxr.core.LiveSlicingChoice
import dev.orcaxr.core.LocalEngineEnd
import dev.orcaxr.core.LocalEngineResult
import dev.orcaxr.core.LocalSliceOutcome
import dev.orcaxr.core.LocalSlicing
import dev.orcaxr.core.PrimitiveShape
import dev.orcaxr.core.ProfileCatalogs
import dev.orcaxr.core.ProjectWorkspace
import dev.orcaxr.core.SliceStatusTally
import dev.orcaxr.nativeapp.MainActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A cube on the default profile (the Snapmaker U1 plate) sliced through the
 * engine service in its own `:engine` process — the production route minus
 * the Prepare screen: the plate staged as the external route's upload, the
 * job run with progress, its G-code claimed, verified and published for the
 * state it came from; then a second job cancelled while it runs. Emulator or
 * device only (the engine is built for Android); the editor's process here is
 * the instrumentation's, kept in the foreground by the app's activity.
 */
@RunWith(AndroidJUnit4::class)
class LocalEngineServiceTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun id() = UUID.randomUUID().toString().replace("-", "")

    @Test
    fun slicesACubeInTheEngineProcessThenCancelsOne() {
        ActivityScenario.launch(MainActivity::class.java).use {
            val state = LocalEngineDevice.measure(context)
            assertTrue("the debug build packages the engine: ${state.reason}", state.available)
            val catalogBytes = context.assets.open("profiles/catalog.json").use { it.readBytes() }
            ProfileCatalogs.build(catalogBytes).use { catalog ->
                ProjectWorkspace().use { workspace ->
                    workspace.ready().get(60, TimeUnit.SECONDS)
                    val live = checkNotNull(catalog.defaultSelection(LiveSlicingChoice.EMPTY)?.live)
                    workspace.applySlicingChoice(catalog, live).get(60, TimeUnit.SECONDS)
                    workspace.addPrimitive(PrimitiveShape.CUBE).get(60, TimeUnit.SECONDS)
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (workspace.view.activePlate?.objects != 1) {
                        assertTrue("the cube never landed", System.nanoTime() < deadline)
                        Thread.sleep(20)
                    }
                    val plate = checkNotNull(workspace.view.activePlate).id
                    val jobs = LocalEngineDevice.jobs(context)
                    LocalEngineClient(context).use { client ->
                        val job = LocalSlicing.stage(jobs, id()) { workspace.projectPlate(plate, it).get(60, TimeUnit.SECONDS) }
                        val messages = mutableListOf<String>()
                        val end = client.run(job, { message, _ -> messages += message }) { false }
                        assertTrue("completed: $end", end is LocalEngineEnd.Reported && end.result is LocalEngineResult.Completed)
                        val outcome = LocalSlicing.outcome(end) as LocalSliceOutcome.Output
                        val folder = File(context.cacheDir, "engine-test").apply { mkdirs() }
                        val (verified, figures) = SliceStatusTally().use { tally ->
                            LocalSlicing.claim(job, outcome.result, File(folder, "slice.gcode.part"), tally) to tally.figures()
                        }
                        val published = LocalSlicing.publish(verified, job, workspace.view.revision, File(folder, "cube.gcode"))
                        assertTrue("published for the state it came from", published?.isFile == true)
                        assertEquals(verified.bytes, published!!.length())
                        assertTrue("a 20 mm cube has layers: ${figures.layers}", figures.layers.toLong() >= 50)
                        assertEquals(verified.bytes, figures.bytes)
                        assertTrue("the engine reported its steps", messages.isNotEmpty())
                        LocalSlicing.discard(job)

                        // A second job, cancelled once it runs: the engine stops cooperatively (or its process is ended).
                        val second = LocalSlicing.stage(jobs, id()) { workspace.projectPlate(plate, it).get(60, TimeUnit.SECONDS) }
                        val cancel = AtomicBoolean(false)
                        val stopped = client.run(second, { _, _ -> cancel.set(true) }) { cancel.get() }
                        val cancelled = LocalSlicing.outcome(stopped)
                        assertTrue("cancelled: $stopped", cancelled is LocalSliceOutcome.Cancelled)
                        LocalSlicing.discard(second)
                        assertFalse("the cancelled job leaves nothing", second.directory.exists())
                        published.delete()
                    }
                }
            }
        }
    }
}
