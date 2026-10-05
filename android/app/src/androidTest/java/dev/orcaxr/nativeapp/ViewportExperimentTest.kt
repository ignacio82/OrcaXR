package dev.orcaxr.nativeapp

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.orcaxr.core.GcodeSession
import dev.orcaxr.renderer.*
import dev.orcaxr.renderer.filament.FilamentViewport
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class ViewportExperimentTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun <T> ui(action: () -> T): T {
        val value = AtomicReference<T>()
        instrumentation.runOnMainSync { value.set(action()) }
        return value.get()
    }
    private fun await(message: String, timeoutSeconds: Int = 45, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds.toLong())
        while (System.nanoTime() < deadline) {
            if (ui(condition)) return
            Thread.sleep(50)
        }
        fail(message)
    }
    private fun activity(scenario: ActivityScenario<ViewportExperimentActivity>): ViewportExperimentActivity {
        val reference = AtomicReference<ViewportExperimentActivity>()
        scenario.onActivity { reference.set(it) }
        return reference.get()
    }
    private fun ready(activity: ViewportExperimentActivity, facets: Int = 32_768) {
        await("Viewport did not become ready: ${ui { activity.viewport?.metrics() }}", 150) {
            activity.viewport?.metrics()?.let {
                it.state == "Ready" && it.pendingUploadBytes == 0L && it.uploadedFacets == facets && it.frames > 0
            } ?: false
        }
    }
    private fun pixels(activity: ViewportExperimentActivity): IntArray {
        val result = AtomicReference<Bitmap>()
        val status = AtomicReference<Int>()
        val latch = CountDownLatch(1)
        ui {
            val bitmap = Bitmap.createBitmap(activity.surface.width, activity.surface.height, Bitmap.Config.ARGB_8888)
            result.set(bitmap)
            PixelCopy.request(activity.surface, bitmap, { status.set(it); latch.countDown() }, Handler(Looper.getMainLooper()))
        }
        assertTrue("PixelCopy timed out", latch.await(10, TimeUnit.SECONDS))
        assertEquals(PixelCopy.SUCCESS, status.get())
        val bitmap = result.get()
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        bitmap.recycle()
        return pixels
    }
    private fun changed(a: IntArray, b: IntArray): Int {
        assertEquals(a.size, b.size)
        return a.indices.count { a[it] != b[it] }
    }
    private fun redraw(renderer: FilamentViewport, action: () -> Unit) {
        val before = ui { renderer.metrics().frames }
        ui(action)
        await("No frame after mutation") { renderer.metrics().frames >= before + 3 }
    }

    @Test fun toolpathKeepsRustColorsAndArcIdentityAfterNativeClose() {
        val source = PreviewFixture.source
        val owner = GcodeSession(source.length)
        val model: dev.orcaxr.core.GcodePacket
        val projection: dev.orcaxr.core.GcodeViewPacket
        owner.use {
            it.append(0, source.toCharArray()); it.seal()
            model = it.whole(); projection = it.view(PreviewFixture.request)
        }
        val geometry = ToolpathGeometry.from(model, projection)
        assertTrue(geometry.segments > model.recordCount)
        val selected = projection.column("recordIndices").asIntBuffer()
        val colors = projection.column("colorsRgba").asFloatBuffer()
        val positions = geometry.positions.asFloatBuffer()
        val packedColors = geometry.colors.asFloatBuffer()
        val indices = geometry.indices.asIntBuffer()
        val offset = (if (model.metadata.has("recordOffset")) model.metadata.getInt("recordOffset") else 0)
        val kind = model.column("columns", "pathKind")
        val counts = model.column("columns", "pathPointCount").asIntBuffer()
        val start = arrayOf("startX", "startY", "startZ").map { model.column("columns", it).asFloatBuffer() }
        val end = arrayOf("endX", "endY", "endZ").map { model.column("columns", it).asFloatBuffer() }
        var segment = 0
        for (selection in 0 until projection.recordCount) {
            val record = selected[selection]
            val count = if (kind[record].toInt() != 0) counts[record] + 1
                else if ((0..2).any { start[it][record] != end[it][record] }) 1 else 0
            for (step in 0 until count) {
                assertEquals(record + offset, geometry.originalRecords[segment])
                repeat(2) { vertex -> repeat(4) { channel ->
                    assertEquals(colors[selection * 4 + channel].toRawBits(), packedColors[(segment * 2 + vertex) * 4 + channel].toRawBits())
                } }
                assertEquals(segment * 2, indices[segment * 2])
                assertEquals(segment * 2 + 1, indices[segment * 2 + 1])
                if (step == 0) {
                    val expected = RenderSpace.point(Point3(start[0][record].toDouble(), start[1][record].toDouble(), start[2][record].toDouble()))
                    assertEquals(expected.x.toFloat(), positions[segment * 6], 0f)
                    assertEquals(expected.y.toFloat(), positions[segment * 6 + 1], 0f)
                    assertEquals(expected.z.toFloat(), positions[segment * 6 + 2], 0f)
                }
                segment++
            }
        }
        assertEquals(geometry.segments, segment)
        assertEquals(geometry.segments * 68L, geometry.cpuBytes)
        assertThrows(IllegalArgumentException::class.java) { ToolpathGeometry.from(model, projection, 1) }
    }

    @Test fun actualPixelsPaintingPickingClippingAndLifecycle() {
        ActivityScenario.launch(ViewportExperimentActivity::class.java).use { scenario ->
            var screen = activity(scenario)
            ready(screen)
            await("Rust toolpath was not rendered") { screen.viewport!!.metrics().drawEntities == 3 && screen.viewport!!.metrics().pendingUploadBytes == 0L }
            val renderer = ui { screen.viewport!! }
            redraw(renderer) { renderer.setCamera(OrbitCamera()) }
            val original = pixels(screen)
            val hit = ui { renderer.pick(screen.surface.width / 2.0, screen.surface.height / 2.0) }
            assertNotNull("Center ray must hit fixture", hit)
            assertTrue(hit!!.facet in 0 until 32_768)
            val before = ui { renderer.metrics() }
            redraw(renderer) { assertTrue(renderer.paint(14_336, 4096, 0xffff0066.toInt())) }
            await("Paint copies did not settle") { renderer.metrics().pendingUploadBytes == 0L }
            val painted = pixels(screen)
            assertTrue("Color subrange did not change actual pixels", changed(original, painted) > 100)
            val after = ui { renderer.metrics() }
            assertEquals(before.gpuBufferBytes, after.gpuBufferBytes)
            assertEquals(49_152, after.paintUploadBytes - before.paintUploadBytes)
            assertEquals(2, after.bufferUploads - before.bufferUploads) // Crosses a chunk boundary.
            assertEquals(hit.facet, ui { renderer.pick(screen.surface.width / 2.0, screen.surface.height / 2.0) }!!.facet)

            redraw(renderer) { renderer.select(0); renderer.setTransparent(true); renderer.showSecondInstance(true) }
            assertTrue(changed(painted, pixels(screen)) > 100)
            assertEquals(after.bufferUploads, ui { renderer.metrics().bufferUploads })
            assertEquals(after.gpuBufferBytes, ui { renderer.metrics().gpuBufferBytes })
            redraw(renderer) { renderer.clipAboveMm(-1f) }
            assertNull(ui { renderer.pick(screen.surface.width / 2.0, screen.surface.height / 2.0) })
            val clipped = pixels(screen)
            assertTrue(changed(painted, clipped) > 100)
            assertTrue("Clipped geometry left ${clipped.toSet().size} distinct pixel values", clipped.toSet().size <= 4)

            ui { renderer.setActive(false) }
            val stopped = ui { renderer.metrics().frames }
            Thread.sleep(300)
            assertEquals(stopped, ui { renderer.metrics().frames })
            redraw(renderer) { renderer.setActive(true); renderer.clipAboveMm(null) }
            // Cancellation/replacement must not publish the old two-million-facet build.
            ui { renderer.loadGrid(1000); renderer.loadGrid(128) }
            ready(screen)
            assertEquals(32_768, ui { renderer.metrics().facets })
            scenario.recreate()
            assertTrue(ui { renderer.metrics().closed })
            assertEquals(0, ui { renderer.metrics().gpuBufferBytes })
            assertEquals(0, ui { renderer.metrics().sourceAndIndexBytes })
            screen = activity(scenario); ready(screen)
            val replacement = ui { screen.viewport!! }
            scenario.moveToState(Lifecycle.State.CREATED)
            assertTrue(ui { replacement.metrics().closed })
            scenario.moveToState(Lifecycle.State.RESUMED)
            ready(activity(scenario))
        }
    }

    @Test fun twoMillionFacetUploadsStayBoundedAcrossReopen() {
        val observations = JSONArray()
        repeat(2) {
            ActivityScenario.launch(ViewportExperimentActivity::class.java).use { scenario ->
                val screen = activity(scenario)
                ready(screen)
                await("Initial toolpath upload") { screen.viewport!!.metrics().drawEntities == 3 && screen.viewport!!.metrics().pendingUploadBytes == 0L }
                val start = System.nanoTime()
                // Use the Activity's fixture intent, so a system pause/resume
                // retains the requested size just like the workbench buttons.
                ui { screen.loadFixture(1000) }
                ready(screen, 2_000_000)
                val renderer = ui { screen.viewport!! }
                val stats = ui { renderer.metrics() }
                assertEquals(2_000_000, stats.facets)
                assertEquals(124, stats.drawEntities) // 123 mesh chunks plus the existing lines.
                assertTrue(stats.gpuBufferBytes >= 120_000_000)
                assertTrue(stats.gpuBufferBytes < 121_000_000)
                assertTrue(stats.peakUploadBytes <= 983_040)
                assertTrue(stats.sourceAndIndexBytes in 50_000_000..60_000_000)
                assertNotNull(ui { renderer.pick(screen.surface.width / 2.0, screen.surface.height / 2.0) })
                val image = pixels(screen)
                assertTrue("Large fixture did not draw", image.toSet().size > 10)
                observations.put(JSONObject().put("elapsedMs", (System.nanoTime() - start) / 1_000_000.0)
                    .put("facets", stats.facets).put("gpuBufferBytesEstimate", stats.gpuBufferBytes)
                    .put("sourceAndIndexBytes", stats.sourceAndIndexBytes).put("peakUploadBytes", stats.peakUploadBytes)
                    .put("bufferUploads", stats.bufferUploads).put("frames", stats.frames).put("maxFrameCpuMs", stats.maxFrameCpuMs))
                ui { renderer.close() }
                assertEquals(0, ui { renderer.metrics().pendingUploadBytes })
                assertEquals(0, ui { renderer.metrics().gpuBufferBytes })
            }
        }
        instrumentation.targetContext.filesDir.resolve("viewport-observations.json").writeText(
            JSONObject().put("evidenceKind", "emulator-or-device-as-invoked").put("observations", observations).toString(2))
    }
}
