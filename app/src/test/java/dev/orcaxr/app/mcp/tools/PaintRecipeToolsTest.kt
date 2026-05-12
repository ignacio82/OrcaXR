package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.PaintCacheStore
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class PaintRecipeToolsTest {

    private lateinit var ws: WorkspaceModel
    private lateinit var store: PaintCacheStore
    private lateinit var tmpDir: File
    private val modelId = "m_test"

    @Before fun setUp() {
        ws = WorkspaceModel()
        ws.setAttached(true)
        ws.publishWiredTierBCapabilities(dev.orcaxr.app.mcp.TierBCapability.entries.toSet())
        // Build a PaintCacheStore against a fake "filesDir" so tests
        // don't share state with each other or with the device cache.
        // PaintCacheStore takes a Context — we sidestep by writing
        // directly to a known dir via the public API.
        tmpDir = Files.createTempDirectory("orcaxr-recipe-test").toFile()
        // Use a real Android Context-less path: PaintCacheStore needs
        // a Context. Instead, create the store via a stub Context that
        // returns tmpDir as filesDir.
        store = StubContext.makeStore(tmpDir)
    }

    @After fun tearDown() {
        tmpDir.deleteRecursively()
    }

    private fun primeModel(triCount: Int) {
        val color = ByteArray(triCount).apply {
            for (i in indices) this[i] = ((i % 4) + 1).toByte()  // tags 1..4
        }
        ws.publishPlacedModels(listOf(PlacedModel(
            id = modelId, source = File("/dev/null"), label = "test",
            paintFilamentIndex = color,
        )))
    }

    private suspend fun captureNextAction(block: suspend () -> Unit): WorkspaceAction {
        val collected = GlobalScope.async(start = CoroutineStart.UNDISPATCHED) {
            ws.actions.first()
        }
        block()
        return collected.await()
    }

    @Test fun saveRecipeWritesFileAndReturnsBytes() = runTest {
        primeModel(triCount = 100)
        val tool = PaintRecipeTools.SavePaintRecipe(ws, store)
        val res = tool.call(JSONObject().apply {
            put("name", "pirate_v1"); put("model_id", modelId)
        })
        assertFalse(res.isError)
        val s = res.structured!!
        assertEquals("pirate_v1", s.getString("name"))
        assertEquals(100, s.getInt("tri_count"))
        assertEquals(100, s.getInt("color_bytes"))
        assertTrue("file exists on disk", File(tmpDir, "paint_recipes/pirate_v1.bin").exists())
    }

    @Test fun listEnumeratesSavedRecipes() = runTest {
        primeModel(triCount = 50)
        PaintRecipeTools.SavePaintRecipe(ws, store).call(JSONObject().apply {
            put("name", "alpha"); put("model_id", modelId)
        })
        PaintRecipeTools.SavePaintRecipe(ws, store).call(JSONObject().apply {
            put("name", "beta"); put("model_id", modelId)
        })
        val res = PaintRecipeTools.ListPaintRecipes(store).call(JSONObject())
        val s = res.structured!!
        assertEquals(2, s.getInt("count"))
        val names = (0 until s.getJSONArray("names").length()).map { s.getJSONArray("names").getString(it) }
        assertTrue(names.contains("alpha"))
        assertTrue(names.contains("beta"))
    }

    @Test fun loadEmitsLoadPaintStateAction() = runTest {
        primeModel(triCount = 100)
        PaintRecipeTools.SavePaintRecipe(ws, store).call(JSONObject().apply {
            put("name", "rec1"); put("model_id", modelId)
        })
        val loadTool = PaintRecipeTools.LoadPaintRecipe(ws, store)
        val action = captureNextAction {
            loadTool.call(JSONObject().apply {
                put("name", "rec1"); put("model_id", modelId)
            })
        } as WorkspaceAction.LoadPaintState
        assertEquals(modelId, action.modelId)
        assertNotNull(action.paintFilamentIndex)
        assertEquals(100, action.paintFilamentIndex!!.size)
        // Round-trip checked via byte equality on the first 4 entries.
        assertEquals(1, action.paintFilamentIndex!![0].toInt())
        assertEquals(2, action.paintFilamentIndex!![1].toInt())
        assertEquals(3, action.paintFilamentIndex!![2].toInt())
        assertEquals(4, action.paintFilamentIndex!![3].toInt())
    }

    /**
     * Audit H11 — a model with no paint state used to fail
     * `load_paint_recipe` with "paint a single stroke first."
     * With the BVH-provider fallback, the error is now about the BVH
     * not being built — which is the actual root cause and points at
     * the right next step (re-select in paint mode).
     */
    @Test fun loadOnUnpaintedModelFailsWithBvhMessage() = runTest {
        // Place a model with NO paint arrays.
        ws.publishPlacedModels(listOf(PlacedModel(
            id = modelId, source = File("/dev/null"), label = "test",
        )))
        val res = PaintRecipeTools.LoadPaintRecipe(ws, store).call(JSONObject().apply {
            put("name", "anything"); put("model_id", modelId)
        })
        assertTrue("load on unpainted+no-BVH model should error", res.isError)
        // The error message must point at the BVH path, not the old
        // "paint a stroke first" fallback the audit called gross UX.
        val msg = res.text
        assertTrue(
            "expected BVH-related error message, got: $msg",
            msg.contains("BVH") || msg.contains("paint mode"),
        )
    }

    @Test fun loadFailsOnTriCountMismatch() = runTest {
        primeModel(triCount = 100)
        PaintRecipeTools.SavePaintRecipe(ws, store).call(JSONObject().apply {
            put("name", "rec_tri100"); put("model_id", modelId)
        })
        // Re-prime model with different tri count.
        primeModel(triCount = 200)
        val res = PaintRecipeTools.LoadPaintRecipe(ws, store).call(JSONObject().apply {
            put("name", "rec_tri100"); put("model_id", modelId)
        })
        assertTrue("expected tri-count mismatch error", res.isError)
    }

    @Test fun deleteRemovesFromDisk() = runTest {
        primeModel(triCount = 50)
        PaintRecipeTools.SavePaintRecipe(ws, store).call(JSONObject().apply {
            put("name", "to_delete"); put("model_id", modelId)
        })
        assertTrue(File(tmpDir, "paint_recipes/to_delete.bin").exists())
        val res = PaintRecipeTools.DeletePaintRecipe(store).call(JSONObject().apply {
            put("name", "to_delete")
        })
        assertFalse(res.isError)
        assertEquals(true, res.structured!!.getBoolean("deleted"))
        assertFalse(File(tmpDir, "paint_recipes/to_delete.bin").exists())
    }

    @Test fun nameValidationRejectsInvalidChars() = runTest {
        primeModel(triCount = 50)
        for (badName in listOf("../escape", "with space", "UPPER", "")) {
            val res = PaintRecipeTools.SavePaintRecipe(ws, store).call(JSONObject().apply {
                put("name", badName); put("model_id", modelId)
            })
            assertTrue("expected error for '$badName'", res.isError)
        }
    }

    @Test fun saveRefusesModelWithNoPaint() = runTest {
        ws.publishPlacedModels(listOf(PlacedModel(
            id = modelId, source = File("/dev/null"), label = "test",
            // No paint arrays.
        )))
        val res = PaintRecipeTools.SavePaintRecipe(ws, store).call(JSONObject().apply {
            put("name", "empty"); put("model_id", modelId)
        })
        assertTrue(res.isError)
    }
}

/** Minimal Android Context stub for tests — only `filesDir` is
 *  read by PaintCacheStore. Done via a minimal subclass; the real
 *  test runs in a Robolectric-free pure-JVM harness so we can't use
 *  actual ApplicationContext. */
private object StubContext {
    fun makeStore(rootDir: File): PaintCacheStore {
        val ctx = object : android.content.ContextWrapper(null) {
            override fun getFilesDir(): File = rootDir
        }
        return PaintCacheStore(ctx, dirName = "paint_recipes", maxEntries = 200)
    }
}
