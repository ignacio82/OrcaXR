package dev.orcaxr.app.mcp

import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Audit H25 (2026-05-07) — leaky-bucket rate limit shared across the
 * four vision tools (`find_feature_anchors`,
 * `score_paint_against_reference`, `generate_mask_from_point`,
 * `get_mask_for_text`). Without this, a runaway LLM client can dispatch
 * 30+ vision calls per second back-to-back during a refinement loop
 * and burn through the user's Anthropic quota in seconds — the
 * Anthropic v1/messages endpoint accepts these at full speed and
 * bills for every one. The rate floor (~2 req/s with a 4-call burst
 * head) keeps interactive iteration smooth without being a footgun.
 *
 * Token-bucket implementation: refill at [ratePerSec], cap at
 * [burstCapacity]. Each [acquire] consumes 1 token; suspends with
 * [delay] until the next is available. Process-singleton via
 * [shared].
 *
 * Why a leaky bucket vs. a sliding window: a leaky bucket lets a
 * burst of small requests through (the user might fire two
 * `render_view`s before the first vision call lands, that's fine)
 * but caps sustained throughput at the refill rate. A sliding
 * window would be lumpier — bursts at window edges still pass.
 */
internal class VisionRateLimiter(
    private val ratePerSec: Double = DEFAULT_RATE_PER_SEC,
    private val burstCapacity: Int = DEFAULT_BURST_CAPACITY,
    private val timeSource: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()
    private var tokens: Double = burstCapacity.toDouble()
    private var lastRefillMs: Long = -1L

    /**
     * Suspend until at least one token is available, then consume it.
     * Cooperative cancellation: `delay` is cancellable, so a tool's
     * structured-cancellation will surface a CancellationException
     * out of this call without consuming a token.
     */
    suspend fun acquire() {
        while (true) {
            val waitMs: Long = mutex.withLock {
                refillLocked()
                if (tokens >= 1.0) {
                    tokens -= 1.0
                    return
                }
                // Time until the next whole token. ratePerSec is
                // tokens-per-second, so milliseconds-per-token is
                // 1000 / ratePerSec. Round up to avoid spin-loops
                // on the boundary.
                val needed = 1.0 - tokens
                ((needed / ratePerSec) * 1000.0 + 0.5).toLong().coerceAtLeast(1L)
            }
            delay(waitMs)
        }
    }

    private fun refillLocked() {
        val now = timeSource()
        if (lastRefillMs < 0) {
            lastRefillMs = now
            return
        }
        val elapsed = now - lastRefillMs
        if (elapsed <= 0) return
        tokens = (tokens + elapsed * ratePerSec / 1000.0).coerceAtMost(burstCapacity.toDouble())
        lastRefillMs = now
    }

    companion object {
        const val DEFAULT_RATE_PER_SEC: Double = 2.0
        const val DEFAULT_BURST_CAPACITY: Int = 4

        /**
         * Process-singleton. The four vision tools share this so the
         * rate limit is global per-OrcaXR-process, not per-tool. A
         * background `find_feature_anchors` followed immediately by a
         * `score_paint_against_reference` counts as 2 calls toward the
         * burst budget.
         */
        @Volatile private var instance: VisionRateLimiter? = null

        val shared: VisionRateLimiter
            get() {
                instance?.let { return it }
                return synchronized(this) {
                    instance ?: VisionRateLimiter().also { instance = it }
                }
            }

        /** Test-only — replace the singleton so the unit harness can
         *  inject a fake clock or stricter limits without leaking
         *  state across tests. */
        @androidx.annotation.VisibleForTesting
        internal fun installForTest(limiter: VisionRateLimiter) {
            instance = limiter
        }

        @androidx.annotation.VisibleForTesting
        internal fun resetForTest() {
            instance = null
        }
    }
}
