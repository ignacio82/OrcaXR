package dev.orcaxr.app

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Roadmap E8 — verify the [SliceLifecycle] re-entrant counter is well
 * formed without spinning up a real Service. The Service-side wiring
 * (notification, foreground promotion, Activity rebind) is instrumented
 * territory; the counter is pure state and worth pinning here.
 *
 * Counter must:
 *   - increment on beginSlice and decrement on endSlice
 *   - publish the most-recent label on activeLabel
 *   - clamp to ≥ 0 on accidental over-decrements (defensive — if the
 *     foreground-service start fails partway, the matching endSlice
 *     would otherwise drive the counter negative and a future begin
 *     could fire incorrectly)
 *
 * `Context` calls (start/stop foreground service) get null'd out via
 * the JVM-stub `unitTests.isReturnDefaultValues = true` config, so
 * SliceLifecycle internally handles a null-ish service-start path
 * without throwing. The lifecycle's *counter* logic is what we pin
 * here — not the real Service interaction.
 */
class SliceLifecycleTest {

    @After fun reset() {
        SliceLifecycle.resetForTest()
    }

    @Test fun begin_then_end_returns_counter_to_zero() {
        // We call with a null-ish Context wrapper because Service start
        // throws under the stub android.jar. Catch + ignore so the
        // counter logic is still exercised.
        val ctx = nullContext()
        runCatching { SliceLifecycle.beginSlice(ctx, "dragon.3mf") }
        assertEquals(1, SliceLifecycle.activeCount())
        assertEquals("dragon.3mf", SliceLifecycle.activeLabel.value)
        runCatching { SliceLifecycle.endSlice(ctx) }
        assertEquals(0, SliceLifecycle.activeCount())
        assertNull(SliceLifecycle.activeLabel.value)
    }

    @Test fun nested_begin_increments_counter() {
        val ctx = nullContext()
        runCatching { SliceLifecycle.beginSlice(ctx, "outer") }
        runCatching { SliceLifecycle.beginSlice(ctx, "inner") }
        assertEquals(2, SliceLifecycle.activeCount())
        // Most-recent label wins.
        assertEquals("inner", SliceLifecycle.activeLabel.value)
        runCatching { SliceLifecycle.endSlice(ctx) }
        // Inner closed; outer still in flight; service must not stop yet.
        assertEquals(1, SliceLifecycle.activeCount())
        runCatching { SliceLifecycle.endSlice(ctx) }
        assertEquals(0, SliceLifecycle.activeCount())
    }

    @Test fun over_decrement_clamps_to_zero() {
        val ctx = nullContext()
        runCatching { SliceLifecycle.endSlice(ctx) }
        assertEquals(
            "endSlice with counter at 0 must clamp to 0, not go negative",
            0,
            SliceLifecycle.activeCount(),
        )
        // A subsequent begin/end pair must still resolve cleanly.
        runCatching { SliceLifecycle.beginSlice(ctx, "after-recovery") }
        assertEquals(1, SliceLifecycle.activeCount())
        runCatching { SliceLifecycle.endSlice(ctx) }
        assertEquals(0, SliceLifecycle.activeCount())
    }

    /**
     * Returns a stand-in Context. Under JVM unit tests with
     * `unitTests.isReturnDefaultValues = true`, every method on this
     * stub returns null/0/false — so the foreground-service start
     * call inside SliceLifecycle becomes a no-op throw that the
     * runCatching() at the call site swallows. The counter / label
     * state is what matters here; the Service interaction is
     * instrumented territory.
     */
    private fun nullContext(): android.content.Context = NullContextStub
}

/** Bare-bones Context shim — every method falls back to the
 *  stub-android.jar default ("not mocked" → null/0/false), which is
 *  enough for SliceLifecycle's start/stop path to no-op under unit
 *  tests. */
private object NullContextStub : android.content.ContextWrapper(null)
