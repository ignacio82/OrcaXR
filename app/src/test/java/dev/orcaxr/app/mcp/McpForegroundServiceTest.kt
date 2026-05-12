package dev.orcaxr.app.mcp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pin the foreground-notification copy. The notification is the only
 * UX surface a remote-MCP user sees once they've put the phone down,
 * so the recovery prompt has to actually say "tap to resume" — that's
 * what they look for when their LLM starts seeing "OrcaXR not
 * attached" errors mid-session.
 */
class McpForegroundServiceTest {

    @Test fun startingWhileNotRunning() {
        val (title, body) = McpForegroundService.notificationContent(
            running = false,
            attached = false,
            port = 0,
        )
        assertEquals("OrcaXR MCP server starting…", title)
        assertTrue("body should mention socket bind", body.contains("Binding socket"))
    }

    @Test fun normalRunningAttachedShowsListenPort() {
        val (title, body) = McpForegroundService.notificationContent(
            running = true,
            attached = true,
            port = 7080,
        )
        assertEquals("OrcaXR MCP server running", title)
        assertTrue("body should advertise the port", body.contains("7080"))
        assertTrue("body should invite a tap", body.contains("Tap"))
    }

    @Test fun runningButDetachedShowsResumePrompt() {
        // The whole point of this service-side change: user
        // backgrounded the activity, MCP server keeps running, and
        // the remote client started getting `attached:false`. The
        // notification has to switch to a recovery prompt the user
        // can act on without hunting through the launcher.
        val (title, body) = McpForegroundService.notificationContent(
            running = true,
            attached = false,
            port = 7080,
        )
        assertEquals("OrcaXR MCP — tap to resume", title)
        assertTrue("body should explain the problem", body.contains("detached"))
        assertTrue("body should mention reattach", body.contains("reattach"))
    }

    @Test fun runningAttachedWithoutPortStillReadable() {
        // Edge case: server is up but port is reported as 0 (the
        // boundPort static lookup raced the running flow). Don't
        // emit "Listening on port 0" — just say listening.
        val (_, body) = McpForegroundService.notificationContent(
            running = true,
            attached = true,
            port = 0,
        )
        assertTrue("must not advertise port 0", !body.contains("port 0"))
        assertTrue(body.contains("Listening"))
    }
}
