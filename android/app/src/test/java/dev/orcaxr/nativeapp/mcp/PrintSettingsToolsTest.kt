package dev.orcaxr.nativeapp.mcp

import dev.orcaxr.nativeapp.device.DeviceModel
import dev.orcaxr.nativeapp.mcp.tools.PrintSettingsTools
import dev.orcaxr.nativeapp.prepare.PrepareModel
import dev.orcaxr.nativeapp.project.ProjectModel
import java.util.concurrent.CompletableFuture
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrintSettingsToolsTest {

    private fun mockContext(projectModel: ProjectModel? = null): McpContext = object : McpContext {
        override val project: ProjectModel? = projectModel
        override val prepare: PrepareModel? = null
        override val device: DeviceModel? = null
        override fun runAction(actionId: String): Boolean = false
        override fun captureScreenshot(width: Int, height: Int, format: String): CompletableFuture<String> =
            CompletableFuture.completedFuture("")
        override fun runOnMain(block: () -> Unit) = block()
    }

    @Test
    fun registersToolsCorrectly() {
        val registry = McpToolRegistry()
        val context = mockContext()

        PrintSettingsTools.register(registry, context)

        val getTool = registry.getTool("get_print_settings")
        assertNotNull(getTool)
        assertEquals("get_print_settings", getTool?.name)

        val updateTool = registry.getTool("update_print_settings")
        assertNotNull(updateTool)
        assertEquals("update_print_settings", updateTool?.name)
    }

    @Test
    fun errorWhenProjectUnavailable() = runBlocking {
        val registry = McpToolRegistry()
        val context = mockContext()

        PrintSettingsTools.register(registry, context)

        val getTool = registry.getTool("get_print_settings")!!
        val getResult = getTool.handler(emptyMap())
        assertTrue(getResult.isError)
        assertTrue(getResult.content.first().let { (it as McpContent.Text).text.contains("Project workspace is not available") })

        val updateTool = registry.getTool("update_print_settings")!!
        val updateResult = updateTool.handler(mapOf("brim_type" to "no_brim"))
        assertTrue(updateResult.isError)
        assertTrue(updateResult.content.first().let { (it as McpContent.Text).text.contains("Project workspace is not available") })
    }
}
