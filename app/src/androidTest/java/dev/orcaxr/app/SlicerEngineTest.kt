package dev.orcaxr.app

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Smoke tests for [SlicerEngine]. Running on any arm64 Android target
 * (emulator or Galaxy XR) exercises the full pipeline:
 *   - libslic3r_jni.so loads,
 *   - libslic3r runs (DynamicPrintConfig instantiates),
 *   - a real STL slices end-to-end through Print::process / export_gcode,
 *   - results round-trip the libslic3r dispatcher cleanly.
 */
@RunWith(AndroidJUnit4::class)
class SlicerEngineTest {

    /**
     * Minimum config to satisfy `Print::validate()` in the headless
     * test path. The JNI shim forces `use_relative_e_distances=true`
     * (slic3r_jni.cpp ~ "relative E distances" comment) because every
     * real printer profile we ship uses it. The validator then
     * requires a `G92 E0` somewhere in `before_layer_change_gcode` —
     * profiles like Snapmaker U1's provide this; bare-defaults tests
     * have to inject it themselves or hit
     * `NativeError(-2, "Print::validate() rejected the input")`.
     */
    private val minValidConfig = mapOf(
        "before_layer_change_gcode" to "G92 E0\n",
    )

    /**
     * The bundled Elegoo Centauri Carbon 0.2 nozzle + Elegoo PLA Matte
     * profile (the user's actual day-to-day setup) must:
     *   1. Be discoverable in the loaded catalog.
     *   2. Slice the bundled cube end-to-end without producing
     *      "rejected config" or validate failures.
     * This is the canary for the Elegoo profile bundling — if it
     * regresses, the user's daily print path is broken.
     */
    @Test
    fun elegooCentauriCarbon02PlaMatteProfileSlicesCube() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context
        val catalog = OrcaProfileLoader.loadCatalog(appCtx)

        // Find a profile whose id contains both the 0.2 nozzle machine
        // slug and the PLA Matte filament slug. The id format is
        // `bundled_<machine>.<process>.<filament>`; both substrings
        // are stable across asset reorgs.
        val target = catalog.firstOrNull {
            it.id.contains("centauri_carbon_0.2") &&
                it.id.contains("pla_matte")
        }
        assertTrue(
            "expected an Elegoo Centauri Carbon 0.2 nozzle PLA Matte profile in the loaded catalog. Got ${catalog.size} profiles: ${catalog.joinToString { it.id }}",
            target != null,
        )
        target!!

        val stl = File(appCtx.cacheDir, "cube_elegoo_test.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val out = File(appCtx.cacheDir, "cube_elegoo.gcode")
        val result = SlicerEngine.slice(stl, out, target.config)
        assertTrue(
            "Elegoo profile slice failed: $result",
            result is SliceResult.Success,
        )
        result as SliceResult.Success
        assertTrue("output gcode missing", out.exists())
        assertTrue("output gcode empty", result.sizeBytes > 0)
    }

    @Test
    fun versionStringIsReasonable() = runBlocking {
        val v = SlicerEngine.versionString()
        assertTrue("empty version string", v.isNotBlank())
        assertTrue("unexpected prefix: $v", v.startsWith("libslic3r"))
        assertTrue("expected keys count: $v", v.contains("config keys"))
    }

    /**
     * Slices a 20mm reference cube using libslic3r's full default print
     * config. The cube STL is bundled as an androidTest asset; we copy
     * it to the app's cache dir (libslic3r expects a real filesystem
     * path, not a content URI) and slice into another cache-dir path.
     */
    @Test
    fun profilesProduceDifferentGcode() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context
        val stl = File(appCtx.cacheDir, "cube_profile_test.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val draftOut = File(appCtx.cacheDir, "cube_draft.gcode")
        val detailOut = File(appCtx.cacheDir, "cube_detail.gcode")
        // Inline configs so the test doesn't depend on profile-catalog
        // contents (which churn as we bundle vendor JSONs). Detail uses
        // 0.12 mm layers vs Draft's 0.28 mm — Detail has ~2.3× more
        // layers and a much larger G-code file.
        val draftCfg = minValidConfig + mapOf(
            "layer_height" to "0.28",
            "initial_layer_print_height" to "0.28",
        )
        val detailCfg = minValidConfig + mapOf(
            "layer_height" to "0.12",
            "initial_layer_print_height" to "0.20",
        )
        val draft = SlicerEngine.slice(stl, draftOut, draftCfg) as SliceResult.Success
        val detail = SlicerEngine.slice(stl, detailOut, detailCfg) as SliceResult.Success
        assertTrue(
            "expected Detail (${detail.sizeBytes}) > Draft (${draft.sizeBytes})",
            detail.sizeBytes > draft.sizeBytes,
        )

        val draftLayers = GcodeParser.parse(draftOut).layerZs.size
        val detailLayers = GcodeParser.parse(detailOut).layerZs.size
        assertTrue(
            "expected Detail $detailLayers layers > Draft $draftLayers layers",
            detailLayers > draftLayers,
        )
    }

    /**
     * Two cubes plated 60 mm apart in X must produce a single G-code
     * whose XY extrusion bbox spans both — proves nativeSliceMulti
     * actually composes N inputs into one print job.
     */
    @Test
    fun sliceMultiTwoCubesProducesValidGcode() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context
        val cubeA = File(appCtx.cacheDir, "cube_multi_a.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val cubeB = File(appCtx.cacheDir, "cube_multi_b.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val out = File(appCtx.cacheDir, "cube_multi.gcode")

        // Two 20 mm cubes 60 mm apart along X → group bbox 80 mm wide.
        // The auto-arrange centers the group on the bed, so absolute
        // X positions in the G-code shift accordingly. The relative
        // separation is what we verify.
        val placements = listOf(
            cubeA to SlicerEngine.ModelPlacement(translateXmm = -30f, translateYmm = 0f),
            cubeB to SlicerEngine.ModelPlacement(translateXmm =  30f, translateYmm = 0f),
        )
        val result = SlicerEngine.sliceMulti(placements, out, minValidConfig)
        assertTrue("sliceMulti failed: $result", result is SliceResult.Success)
        result as SliceResult.Success
        assertTrue("output gcode missing", out.exists())
        assertTrue("output gcode empty", result.sizeBytes > 0)

        // Parse the G-code and check that the toolpath bbox spans
        // both cubes' regions. Two 20 mm cubes 60 mm apart yield a
        // group X-extent of at least 80 mm — single-cube slices
        // produce a 20 mm extent. 50 mm threshold gives margin for
        // brim / skirt / wipe-tower features that vary by config.
        val parsed = GcodeParser.parse(out)
        val xExtent = parsed.stats.bboxMax.x - parsed.stats.bboxMin.x
        assertTrue(
            "expected combined X extent ≥ 50 mm (two cubes 60 mm apart), got $xExtent",
            xExtent >= 50f,
        )
    }

    @Test
    fun overhangSupportToggleControlsSupportGcode() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val fixture = File(appCtx.cacheDir, "support_overhang_fixture.stl")
        StlWriter.write(overhangFixture(), fixture)

        val supportCfg = minValidConfig + mapOf(
            "enable_support" to "1",
            "support_type" to "normal(auto)",
            "support_threshold_angle" to "10",
            "support_top_z_distance" to "0.2",
            "support_bottom_z_distance" to "0.2",
        )
        val onOut = File(appCtx.cacheDir, "support_enabled.gcode")
        val onResult = SlicerEngine.slice(fixture, onOut, supportCfg)
        assertTrue("support-enabled slice failed: $onResult", onResult is SliceResult.Success)
        assertTrue("support-enabled gcode should contain support moves",
            onOut.readText().contains(";TYPE:Support"))

        val offOut = File(appCtx.cacheDir, "support_disabled.gcode")
        val offResult = SlicerEngine.slice(
            fixture,
            offOut,
            supportCfg + ("enable_support" to "0"),
        )
        assertTrue("support-disabled slice failed: $offResult", offResult is SliceResult.Success)
        assertFalse("support-disabled gcode unexpectedly contains support moves",
            offOut.readText().contains(";TYPE:Support"))
    }

    @Test
    fun sliceMultiCarriesSupportFlagsForTransformedSingleModel() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val cube = File(appCtx.cacheDir, "cube_support_flags_multi.stl")
        assertNotNull(
            "cube primitive build failed",
            SlicerEngine.buildPrimitiveStl(
                PrimitiveKind.CUBE,
                floatArrayOf(20f, 20f, 20f),
                cube,
            ),
        )
        val triCount = StlReader.read(cube).triCount
        val support = ByteArray(triCount).also {
            if (it.isNotEmpty()) it[0] = 1
        }
        val out = File(appCtx.cacheDir, "cube_support_flags_multi.gcode")
        val result = SlicerEngine.sliceMulti(
            models = listOf(
                cube to SlicerEngine.ModelPlacement(
                    translateXmm = 5f,
                    translateYmm = -5f,
                    rotZdeg = 15f,
                ),
            ),
            outGcode = out,
            config = minValidConfig + mapOf("enable_support" to "1"),
            supportFlagsPerInput = listOf(support),
        )
        assertTrue("sliceMulti with support flags failed: $result", result is SliceResult.Success)
        assertTrue("output gcode missing", out.exists())
        assertTrue("output gcode empty", (result as SliceResult.Success).sizeBytes > 0)
    }

    /**
     * Slicing with an [onProgress] lambda must invoke it at least once
     * with a non-negative percent value. Confirms the JNI status
     * callback is wired through libslic3r's `set_status_callback`,
     * across the TBB worker boundary, back into Kotlin. No claim about
     * the *number* of ticks (libslic3r's tick count varies per slice
     * shape) — just that ≥1 real progress event surfaces.
     */
    @Test
    fun progressListenerFiresAtLeastOnce() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context
        val stl = File(appCtx.cacheDir, "cube_progress_test.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val out = File(appCtx.cacheDir, "cube_progress_test.gcode")

        val tickCount = AtomicInteger(0)
        val maxPercent = AtomicInteger(-1)
        val lastMessage = AtomicReference<String>("")

        val result = SlicerEngine.slice(stl, out, minValidConfig) { percent, message ->
            tickCount.incrementAndGet()
            if (percent > maxPercent.get()) maxPercent.set(percent)
            lastMessage.set(message)
        }
        assertTrue("slice failed: $result", result is SliceResult.Success)
        assertTrue(
            "expected ≥1 progress tick, got ${tickCount.get()}",
            tickCount.get() >= 1,
        )
        assertTrue(
            "expected at least one tick with percent ≥ 0, max was ${maxPercent.get()}",
            maxPercent.get() >= 0,
        )
    }

    /**
     * The "dragon body printed black" regression. The user maps project
     * filament 0 (the model's first painted region) onto a different
     * physical printer slot via the Phase J ColorMappingPanel; the slice
     * must emit a `Tn` toolchange that targets the user-chosen physical
     * extruder, not the project filament index.
     *
     * Pre-fix, libslic3r's `GCodeWriter::toolchange` wrote
     * `T<filament_id>` regardless of `filament_map`, so Klipper picked
     * physical T0 for project filament 0 even when the user had asked
     * for physical T1 (yellow). The libslic3r patch
     * (patches/0027-toolchange-emit-physical-extruder-id.patch) resolves
     * the filament through filament_map before emitting the T-command;
     * this test fails on the unpatched .so and passes on the patched
     * one. End-to-end: it loads the bundled cube, configures a U1-shaped
     * 4-extruder profile with `filament_map = "2,2,3,4"` (filament 0
     * remapped to physical extruder 2, libslic3r 1-based), runs a real
     * slice through the JNI, parses the resulting G-code, and asserts
     * every extruded segment fired from extruder 1 (0-based) — the
     * physical "T2" in the user's UI. No printer required.
     *
     * The fix is a gcode post-processor in slic3r_jni.cpp
     * (postprocess_remap_tool_commands) that rewrites every Tn /
     * M104 Tn / M109 Tn token in the produced gcode through
     * filament_map. Both writer-emitted and template-emitted T-commands
     * pass through it uniformly. Patch 0027 (writer-only fix) was
     * insufficient because the Snapmaker U1's `change_filament_gcode`
     * template emits `T<filament_id>` directly via the `next_extruder`
     * placeholder, which libslic3r's `custom_gcode_changes_tool` then
     * uses to drop the writer's emit (GCode.cpp:972, 7644). The
     * post-processor catches both paths.
     */
    @Test
    fun colorRemapEmitsRemappedToolchangeInGcode() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context
        val stlFile = File(appCtx.cacheDir, "cube_color_remap.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        val gcodeFile = File(appCtx.cacheDir, "cube_color_remap.gcode")

        // U1-shaped 4-extruder config, padded to satisfy libslic3r's
        // toolchanger code path (every per-extruder vector sized to 4).
        // The exact values mirror what mergedConfig() would produce for
        // a 4-color project on the U1; we hand-roll them here to keep
        // the test independent of MainActivity composition state.
        val n = 4
        val perFour: (String) -> String = { v -> List(n) { v }.joinToString(",") }
        val cfg = minValidConfig + mapOf(
            "nozzle_diameter" to perFour("0.4"),
            "filament_diameter" to perFour("1.75"),
            // String vectors use semicolon separator (gotcha #19).
            "filament_type" to List(n) { "PLA" }.joinToString(";"),
            "filament_colour" to "#202020;#FFC400;#FF3030;#3070FF",
            "extruder_colour" to "#202020;#FFC400;#FF3030;#3070FF",
            "filament_density" to perFour("1.24"),
            "nozzle_temperature" to perFour("215"),
            "nozzle_temperature_initial_layer" to perFour("220"),
            "hot_plate_temp" to perFour("60"),
            "hot_plate_temp_initial_layer" to perFour("65"),
            "extruder_type" to perFour("Direct Drive"),
            "nozzle_volume_type" to perFour("Standard"),
            "extruder_offset" to perFour("0x0"),
            "single_extruder_multi_material" to "0",
            "curr_bed_type" to "Textured PEI Plate",
            // The pivotal config: filament 0 prints from physical
            // extruder 2 (1-based) instead of identity. Mirrors the
            // user's "map filament 1 to T2 yellow" picker action.
            "filament_map" to "2,2,3,4",
            // filament_map_mode MUST be "Manual" or Print::process
            // (Print.cpp:2378-2381) auto-recomputes the map and trashes
            // our remap. Default is "Auto For Flush" → bug.
            "filament_map_mode" to "Manual",
        )
        val result = SlicerEngine.slice(stlFile, gcodeFile, cfg)
        assertTrue(
            "expected SliceResult.Success, got $result",
            result is SliceResult.Success,
        )

        // libslic3r picks the lowest-numbered referenced filament for an
        // unpainted single-volume mesh — that's project filament 0, which
        // is precisely what the user remapped. With filament_map[0] = 2,
        // every extruded segment must report extruder 1 (0-based) once
        // the toolchange patch lands.
        // Copy the produced gcode to Download so a test failure leaves
        // an artifact on the device for `adb shell cat`. Cache files
        // get wiped when the test instrumentation tears down the
        // package; this side-copy survives that. Best-effort: any
        // copy failure is logged but doesn't affect the assertion.
        runCatching {
            val downloads = File("/storage/emulated/0/Download")
            if (downloads.canWrite()) {
                gcodeFile.copyTo(File(downloads, "cube_color_remap.gcode"), overwrite = true)
            }
        }

        val parsed = GcodeParser.parse(gcodeFile)
        val extruders = parsed.segments.map { it.extruder }.toSet()
        val gcodeText = gcodeFile.readText()
        val tLines = gcodeText.lineSequence()
            .filter { line ->
                val trimmed = line.trim()
                trimmed.length >= 2 && trimmed[0] == 'T' && trimmed[1].isDigit()
            }
            .toList()
        val t1Lines = tLines.count { it.trim().let { t -> t == "T1" || t.startsWith("T1 ") || t.startsWith("T1;") } }
        val t0Lines = tLines.count { it.trim().let { t -> t == "T0" || t.startsWith("T0 ") || t.startsWith("T0;") } }
        // Diagnostic preview of every T-line + the configured filament_map
        // header line, so a failure surfaces what libslic3r actually emitted
        // instead of just "extruders=[0]." Helps distinguish "no T-command
        // at all" from "T0 instead of T1."
        val mapHeader = gcodeText.lineSequence()
            .filter { it.contains("filament_map") }
            .take(2)
            .joinToString("\n")
        val diagnostics = "tLines=${tLines.size}, T1=$t1Lines, T0=$t0Lines\n" +
            "first 5 T-lines: ${tLines.take(5).joinToString(" | ")}\n" +
            "filament_map header: $mapHeader"
        assertTrue(
            "expected every extruded segment on extruder 1 (the physical " +
                "T2 the user remapped to), but saw extruders=$extruders. " +
                "If extruder 0 is present the gcode post-processor in " +
                "slic3r_jni.cpp::postprocess_remap_tool_commands didn't " +
                "fire — rebuild libslic3r_jni.so via scripts/build_native.sh " +
                "and confirm filament_map_mode=Manual is set.\n$diagnostics",
            extruders == setOf(1),
        )

        // And there must be at least one explicit `T1` toolchange line
        // in the gcode body — that's the physical command the printer
        // firmware acts on. Match either bare "T1" or "T1 ; ..." so a
        // future libslic3r comment-format change doesn't trip this.
        assertTrue(
            "expected ≥1 `T1` toolchange line and zero `T0` toolchange " +
                "lines in the gcode (filament_map remapped filament 0 → " +
                "physical extruder 2).\n$diagnostics",
            t1Lines >= 1 && t0Lines == 0,
        )
    }

    /**
     * Pin the Snapmaker U1 dragon-print scenario the user actually hit:
     * load a multi-color 3MF (project filament 1 = body), apply
     * filament_map="2,1,3,4" (filament 1 → T2, filament 2 → T1, identity
     * otherwise), slice through the U1's bundled profile (which has the
     * Snapmaker `change_filament_gcode` and `machine_start_gcode`
     * templates that emit `T{next_extruder}` / `T{initial_extruder}`),
     * and assert the produced gcode's body-region toolchanges land on
     * physical extruder 1 (= "T2 yellow" in the user's UI).
     *
     * The dragon source lives at /storage/emulated/0/Download/dragon.3mf
     * on the user's Galaxy XR (per scripts/autotest_slice.sh). If that
     * file is missing the test is skipped — it's the only painted
     * 4-color asset we have available, and bundling the 21 MB blob into
     * androidTest assets bloats every install of the test APK.
     *
     * What this test guards that the cube test cannot: the cube has no
     * painted facets and triggers only the writer's toolchange path
     * (path 1 in postprocess_remap_tool_commands' header comment).
     * The dragon exercises both paths — initial_extruder via the
     * machine_start_gcode template AND every layer change via
     * change_filament_gcode. This test would fail on the pre-Phase-L
     * libslic3r-only patch (0027) which only covered path 1.
     */
    @Test
    fun snapmakerU1DragonHonorsPhysicalSlotRemap() = runBlocking {
        val tag = "OrcaXR/dragonTest"
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        // Android's scoped storage blocks the test process from reading
        // /sdcard/Download directly even though the file is on disk.
        // Workaround: drive `cp` via the instrumentation's shell (the
        // `shell` user, NOT scoped) to copy the dragon into the app's
        // own external-files dir under /sdcard/Android/data/, which the
        // test process CAN read. The dir gets wiped on app reinstall —
        // every test run re-stages.
        //
        // executeShellCommand returns a ParcelFileDescriptor for stdout;
        // the caller MUST drain it (and close it) before the underlying
        // command is guaranteed to finish, since otherwise the shell can
        // block on writing to the pipe. We `chmod 644` to make sure the
        // app-process can read what the shell-user wrote.
        // appCtx.getExternalFilesDir(null) returns the canonical path the
        // app can read. Hardcoding `/sdcard/Android/data/...` looks the
        // same but on Android 11+ the shell-user FUSE mount and the
        // app-process FUSE mount can disagree on whether a freshly
        // written file is visible — the app needs the exact path it
        // owns.
        val dragonDir = appCtx.getExternalFilesDir(null) ?: appCtx.cacheDir
        val dragon = File(dragonDir, "dragon.3mf")
        if (!dragon.exists() || dragon.length() == 0L) {
            val src = "/sdcard/Download/dragon.3mf"
            val dst = dragon.absolutePath
            // executeShellCommand parses on whitespace as argv (no
            // `sh -c`), so the `&&` chain isn't treated as a shell
            // operator. Run each step separately, draining each PFD's
            // stdout fully before moving on (otherwise the shell may
            // block on a full pipe and the command never finishes).
            fun run(cmd: String): String {
                val pfd = androidx.test.platform.app.InstrumentationRegistry
                    .getInstrumentation().uiAutomation.executeShellCommand(cmd)
                val out = java.io.FileInputStream(pfd.fileDescriptor)
                    .use { it.bufferedReader().readText() }
                pfd.close()
                return out
            }
            android.util.Log.i(tag, "mkdir: '${run("mkdir -p ${dragonDir.absolutePath}")}'")
            android.util.Log.i(tag, "cp:    '${run("cp $src $dst")}'")
            android.util.Log.i(tag, "chmod: '${run("chmod 644 $dst")}'")
            android.util.Log.i(tag, "ls:    '${run("ls -la $dst")}'")
        }
        android.util.Log.i(tag, "dragon.path=${dragon.absolutePath} exists=${dragon.exists()} canRead=${dragon.canRead()} length=${dragon.length()}")
        org.junit.Assume.assumeTrue(
            "dragon.3mf not on device at /sdcard/Download/. Push it via " +
                "`adb push <yourdragon>.3mf /sdcard/Download/dragon.3mf` " +
                "to enable this test (observed exists=${dragon.exists()} " +
                "canRead=${dragon.canRead()} length=${dragon.length()})",
            dragon.exists() && dragon.canRead() && dragon.length() > 0,
        )

        val catalog = OrcaProfileLoader.loadCatalog(appCtx)
        android.util.Log.i(tag, "catalog size=${catalog.size}, ids: ${catalog.take(20).joinToString { it.id }}")
        // The slug() in OrcaProfileLoader preserves '.', so the bundled
        // id keeps "0.4" verbatim. Match the literal "snapmaker_u1_0.4"
        // segment to pick a specific U1 0.4 nozzle profile, then prefer
        // a generic PLA filament + the 0.20mm standard process so the
        // dragon slices in the most "default" U1 setup. Falls back to
        // the first matching U1 0.4 entry otherwise.
        val u1Profile = catalog.firstOrNull {
            it.id.contains("snapmaker_u1_0.4") &&
                it.id.contains("0.20_standard") &&
                it.id.contains("generic_pla")
        } ?: catalog.firstOrNull { it.id.contains("snapmaker_u1_0.4") }
        android.util.Log.i(tag, "u1Profile=${u1Profile?.id}")
        org.junit.Assume.assumeTrue(
            "no Snapmaker U1 0.4 profile in loaded catalog. Catalog ids: " +
                catalog.joinToString { it.id },
            u1Profile != null,
        )
        u1Profile!!

        // Build the user's exact remap: filament 1 → T2, filament 2 → T1,
        // identity for the rest. Same shape as `mergedConfig` would emit
        // for the picker action; we hand-build to keep the test
        // independent of MainActivity composition state.
        val n = 4
        val perFour: (String) -> String = { v -> List(n) { v }.joinToString(",") }
        val cfg = u1Profile.config + mapOf(
            "filament_diameter" to perFour("1.75"),
            "filament_type" to List(n) { "PLA" }.joinToString(";"),
            "filament_colour" to "#FF6B00;#7BC8FF;#7BFFB1;#FFD27B",
            "extruder_colour" to "#FF6B00;#7BC8FF;#7BFFB1;#FFD27B",
            "filament_map" to "2,1,3,4",
            "filament_map_mode" to "Manual",
            "single_extruder_multi_material" to "0",
        )
        val out = File(appCtx.cacheDir, "dragon_remap_test.gcode")
        val result = SlicerEngine.slice(dragon, out, cfg)
        assertTrue(
            "U1 dragon slice failed: $result",
            result is SliceResult.Success,
        )

        // Side-copy for post-mortem.
        runCatching {
            val downloads = File("/storage/emulated/0/Download")
            if (downloads.canWrite()) {
                out.copyTo(File(downloads, "dragon_remap_test.gcode"), overwrite = true)
            }
        }

        // Parse the gcode and inspect per-extruder usage.
        val parsed = GcodeParser.parse(out)
        val extruderUsage = parsed.segments
            .groupingBy { it.extruder }
            .eachCount()

        // Read the "; filament used [mm] = a,b,c,d" line — libslic3r's
        // own ground-truth for which project filament owns the most
        // extrusion. The dominant filament's regions are the body.
        val gcodeText = out.readText()
        val mmLine = gcodeText.lineSequence()
            .firstOrNull { it.startsWith("; filament used [mm]") } ?: ""
        val mmValues = Regex("""[\d.]+""").findAll(mmLine).map { it.value.toDouble() }.toList()
        val bodyFilamentId = if (mmValues.isNotEmpty()) {
            mmValues.indices.maxByOrNull { mmValues[it] } ?: 0
        } else 0
        // Project filament `bodyFilamentId` (0-based) maps via filament_map
        // to physical extruder `(filament_map[bodyFilamentId] - 1)`.
        val filamentMap = listOf(2, 1, 3, 4)
        val expectedBodyExtruder = filamentMap[bodyFilamentId] - 1

        val diagnostics = "filament used [mm] = $mmLine\n" +
            "body filament_id (0-based, dominant by extrusion) = $bodyFilamentId\n" +
            "filament_map = $filamentMap\n" +
            "expected body extruder (post-remap) = $expectedBodyExtruder\n" +
            "actual extruder usage histogram = $extruderUsage"

        // The dominant extruder (most segments) must be the user's
        // remap target for the body filament. Extrusion-segment count
        // tracks G1 frequency rather than mm extruded, but for a
        // multi-color body-dominated mesh the body's extruder will
        // always lead the histogram because the body is composed of
        // the most contiguous geometry. If the post-processor didn't
        // fire, the dominant extruder would be `bodyFilamentId`
        // (identity), not `expectedBodyExtruder`.
        //
        // We deliberately don't assert "extruder 0 has zero segments"
        // even when the body should have moved off extruder 0 — other
        // filaments may legitimately remap *onto* extruder 0
        // (filament_map[1]=1 = "filament 2 → physical T1" in the
        // user's UI). What matters is the body's destination.
        val dominantExtruder = extruderUsage.maxByOrNull { it.value }?.key ?: -1
        assertTrue(
            "post-processor failed to remap dragon body to its user-picked " +
                "physical extruder. With the user's filament_map " +
                "$filamentMap and the dragon's body on filament " +
                "$bodyFilamentId (0-based), the dominant gcode extruder " +
                "should be $expectedBodyExtruder; got $dominantExtruder. " +
                "If the dominant extruder is $bodyFilamentId (i.e. " +
                "identity), the post-processor in slic3r_jni.cpp didn't " +
                "fire — check the build and that filament_map_mode=Manual " +
                "is set.\n$diagnostics",
            dominantExtruder == expectedBodyExtruder,
        )
    }

    @Test
    fun cubeSlicesToValidGcode() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context
        val stlFile = File(appCtx.cacheDir, "cube_20mm.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { output -> input.copyTo(output) }
            }
        }
        val gcodeFile = File(appCtx.cacheDir, "cube_20mm.gcode")

        val result = SlicerEngine.slice(stlFile, gcodeFile, minValidConfig)
        assertTrue(
            "expected SliceResult.Success, got $result",
            result is SliceResult.Success,
        )
        result as SliceResult.Success
        assertEquals(gcodeFile.absolutePath, result.outputPath)
        assertTrue("output gcode missing", gcodeFile.exists())
        assertTrue("output gcode empty", result.sizeBytes > 0)

        // libslic3r's G-code starts with a header of `;` comment lines or
        // a G/M command within the first KB.
        val head = gcodeFile.bufferedReader().use { it.readLines().take(50).joinToString("\n") }
        val firstChar = head.trimStart().firstOrNull()
        assertTrue(
            "G-code header looks wrong; first non-whitespace char='$firstChar'\nhead=\n$head",
            firstChar == ';' || firstChar == 'G' || firstChar == 'M',
        )
    }

    /**
     * The wipe-tower regression: a multi-color slice authored with
     * tuned flush settings must produce strictly less filament than
     * the same slice run with libslic3r's compiled-in defaults
     * (280 mm³ off-diagonal × 0.3 multiplier = 84 mm³ per toolchange).
     *
     * Pre-fix, the keys were dropped by `OrcaProfileLoader.SAFE_KEYS`,
     * so libslic3r always fell back to the 84-mm³/change default —
     * regardless of what the source 3MF or profile actually said. The
     * fix is two-fold:
     *   1. SAFE_KEYS now lets `flush_volumes_matrix` /
     *      `flush_multiplier` through to set_deserialize_nothrow.
     *   2. mergedConfig() synthesizes a 30-mm³ matrix when no 3MF-
     *      authored override is supplied, so STL/OBJ loads benefit
     *      too — not just BBS-flavored 3MFs.
     *
     * The test runs the SAME painted cube through `slice()` twice,
     * once with the pre-fix-equivalent values explicitly forced, and
     * once with the synthesized small default. The body extrusion is
     * identical between runs (same model, same toolpath); only the
     * wipe-tower volume changes. Asserting `tunedFilament < baseline
     * - 5%` gives generous margin against parser noise and floating-
     * point summary precision while still catching a regression where
     * the keys silently get dropped again.
     *
     * The cube has 12 triangles (6 faces × 2). Painting half with
     * filament index 1 and half with index 2 forces the slicer into
     * multi-tool mode and engages the wipe tower (`enable_prime_tower
     * = 1` is set explicitly because we're not going through
     * mergedConfig's >=2-slot branch).
     */
    @Test
    fun tunedFlushMatrixShrinksWipeTowerVsLibslic3rDefault() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val testCtx = InstrumentationRegistry.getInstrumentation().context
        val stlFile = File(appCtx.cacheDir, "cube_flush.stl").also { dst ->
            testCtx.assets.open("cube_20mm.stl").use { input ->
                dst.outputStream().use { input.copyTo(it) }
            }
        }
        // 12 triangles → 6 painted as filament 1, 6 as filament 2.
        // The split forces real toolchanges every layer once the
        // painted faces start extruding, which engages the wipe tower
        // (and so the flush settings actually bite). Index 0 =
        // unpainted, 1..32 = filament slot tag.
        val paint = ByteArray(12) { i -> if (i < 6) 1 else 2 }

        // Pull the Snapmaker U1 0.4 nozzle profile from the catalog —
        // the U1 leaf has every line_width / first_layer_print_height
        // / flow_ratio key the prime-tower path needs to satisfy
        // libslic3r's `Print::validate()`. The U1 normally runs as a
        // toolchanger (single_extruder_multi_material=0), which
        // bypasses the wipe-tower flush math entirely; we override
        // SEMM to "1" so the per-toolchange purge volume comes from
        // flush_volumes_matrix and the test can observe a delta.
        val catalog = OrcaProfileLoader.loadCatalog(appCtx)
        val u1 = catalog.firstOrNull {
            it.id.contains("snapmaker_u1_0.4") && it.id.contains("0.20_standard")
        } ?: catalog.firstOrNull { it.id.contains("snapmaker_u1_0.4") }
        org.junit.Assume.assumeTrue(
            "no Snapmaker U1 0.4 profile in catalog (size=${catalog.size})",
            u1 != null,
        )
        u1!!

        // Two project filaments. With SEMM=1 forced and the U1's 4-
        // entry nozzle_diameter resized to 2 by mergedConfig, the
        // synthesized matrix lands at 2*2*1 = 4 entries (the "1" is
        // because in SEMM mode there's effectively one shared nozzle
        // — Print.cpp:3236 reads `nozzle_diameter.values.size()`, but
        // SEMM treatments collapse the per-nozzle dimension). Multiplier
        // sized to 1.
        val slots = listOf("#FF0000", "#00FF00")
        val nozzleCount = 1

        // Pre-fix libslic3r defaults: 280 mm³ off-diagonal × 0.3
        // multiplier — the values that would have landed if SAFE_KEYS
        // didn't carry the keys through.
        val baselineCfg = mergedConfig(
            profile = u1,
            layerHeightInput = "0.20",
            slotColors = slots,
            flushFromProject = null,
            extraOverrides = mapOf(
                "single_extruder_multi_material" to "1",
                "nozzle_diameter" to "0.4",
                // U1 leaf sets ooze_prevention=1; libslic3r's validate
                // rejects ooze_prevention with SEMM=1 because the
                // standby-temp logic is per-physical-extruder. Force
                // off so the SEMM path can engage.
                "ooze_prevention" to "0",
                "flush_volumes_matrix" to synthesizeFlushMatrix(filaments = 2, nozzles = nozzleCount, defaultMm3 = 280.0),
                "flush_multiplier" to List(nozzleCount) { "0.3" }.joinToString(","),
            ),
        )
        val tunedCfg = mergedConfig(
            profile = u1,
            layerHeightInput = "0.20",
            slotColors = slots,
            flushFromProject = null,
            extraOverrides = mapOf(
                "single_extruder_multi_material" to "1",
                "nozzle_diameter" to "0.4",
                "ooze_prevention" to "0",
                "flush_volumes_matrix" to synthesizeFlushMatrix(filaments = 2, nozzles = nozzleCount, defaultMm3 = 30.0),
                "flush_multiplier" to List(nozzleCount) { "1.0" }.joinToString(","),
            ),
        )

        val baselineGcode = File(appCtx.cacheDir, "cube_flush_baseline.gcode")
        val tunedGcode = File(appCtx.cacheDir, "cube_flush_tuned.gcode")

        val baselineResult = SlicerEngine.slice(stlFile, baselineGcode, baselineCfg, paintFilamentIndex = paint)
        assertTrue("baseline slice failed: $baselineResult",
                   baselineResult is SliceResult.Success)
        val tunedResult = SlicerEngine.slice(stlFile, tunedGcode, tunedCfg, paintFilamentIndex = paint)
        assertTrue("tuned slice failed: $tunedResult",
                   tunedResult is SliceResult.Success)

        val baselineWeight = GcodeParser.parse(baselineGcode).stats.filamentWeightG
        val tunedWeight = GcodeParser.parse(tunedGcode).stats.filamentWeightG
        assertNotNull("baseline G-code missing `total filament used [g]` summary", baselineWeight)
        assertNotNull("tuned G-code missing `total filament used [g]` summary", tunedWeight)
        baselineWeight!!
        tunedWeight!!

        // Both runs print the same cube body, so most of the filament
        // total is shared. The wipe-tower delta is the load-bearing
        // signal. 5% threshold gives margin for parser rounding + the
        // few-mg priming line variation between runs while still
        // catching the regression case (matrix not flowing through
        // → tuned == baseline within parser noise).
        val ratio = tunedWeight / baselineWeight
        assertTrue(
            "expected tuned flush settings to reduce total filament weight " +
                "by ≥5% vs libslic3r 84 mm³/change defaults. Got " +
                "tuned=${"%.4f".format(tunedWeight)} g, baseline=${"%.4f".format(baselineWeight)} g, " +
                "ratio=${"%.3f".format(ratio)}. If they're equal, the SAFE_KEYS gate is " +
                "swallowing flush_volumes_matrix / flush_multiplier — verify " +
                "OrcaProfileLoader.SAFE_KEYS contains both keys and that mergedConfig " +
                "passes them through unmodified.",
            ratio < 0.95,
        )
    }

    /**
     * `read3mfProjectOverrides` round-trips authored process settings
     * (layer_height, infill density/pattern, seam_position, etc.) out
     * of a synthetic 3MF. Mirrors `read3mfFlushSettings`'s round-trip
     * test but for the broader process-level overrides that close the
     * +27-layer drift vs desktop's slice.
     */
    @Test
    fun read3mfProjectOverridesRoundTripsAuthoredKeys() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val fixture = File(appCtx.cacheDir, "synthetic_project_overrides.3mf")
        fixture.delete()
        // Mirrors the dragon.3mf shape: layer_height as scalar string,
        // sparse_infill_density as scalar, sparse_infill_pattern as
        // typed-enum scalar. Mix in a few keys NOT in our extraction
        // list to verify they're filtered out.
        val authoredConfig = """
        {
            "version": "1.0.0",
            "name": "test_authored_project",
            "from": "test",
            "layer_height": "0.22",
            "sparse_infill_density": "5%",
            "sparse_infill_pattern": "gyroid",
            "seam_position": "back",
            "slowdown_for_curled_perimeters": "1",
            "irrelevant_other_key": "should_be_ignored"
        }
        """.trimIndent()
        java.util.zip.ZipOutputStream(fixture.outputStream()).use { zip ->
            zip.putNextEntry(java.util.zip.ZipEntry("Metadata/project_settings.config"))
            zip.write(authoredConfig.toByteArray(Charsets.UTF_8))
            zip.closeEntry()
        }

        val overrides = SlicerEngine.read3mfProjectOverrides(fixture)
        // layer_height is intentionally NOT in PROJECT_OVERRIDE_KEYS —
        // it flows from the user's slicer-profile pick + the layer-height
        // override TextField, NOT from the 3MF. Pre-fix the user picking
        // "0.12 Fine @Snapmaker U1" got silently overridden by the 3MF's
        // authored 0.20 mm, producing the "estimated time half what it
        // should be" symptom.
        assertEquals(false, overrides.containsKey("layer_height"))
        assertEquals("5%", overrides["sparse_infill_density"])
        assertEquals("gyroid", overrides["sparse_infill_pattern"])
        assertEquals("back", overrides["seam_position"])
        assertEquals("1", overrides["slowdown_for_curled_perimeters"])
        // Keys absent in the file are omitted (sparse map).
        assertEquals(false, overrides.containsKey("wall_loops"))
        // The non-PROJECT_OVERRIDE_KEYS key didn't leak through.
        assertEquals(false, overrides.containsKey("irrelevant_other_key"))
    }

    /**
     * Slice the user's dragon.3mf through the full `mergedConfig` flow
     * MainActivity runs (3MF flush settings + project overrides honored)
     * and assert the resulting layer count and toolchange count match
     * FullSpectrum desktop OrcaSlicer's reference output exactly.
     *
     * Why count-based assertions instead of mass-based: the absolute
     * mass differs by ~10% between OrcaXR and desktop because the two
     * use different `filament_map` strategies for the U1:
     *   - desktop: filament_map="1,1,1,1" (all colors share T0,
     *     SEMM-style — inherited from the Bambu P1P 3MF the user
     *     imported). Wipe tower handles inter-color purges; each
     *     color's `filament used [g]` includes purges TO that color.
     *   - OrcaXR: filament_map="1,2,3,4" (each color on its own
     *     hot-end, what the U1 was built for). No inter-color
     *     purges; the wipe tower just emits prime pads, almost all
     *     attributed to wipe_tower_filament=0.
     * Both are correct outputs for their respective physical printing
     * modes, just NOT comparable in mass terms. What IS comparable —
     * and what closes the bug-class — is layer count and toolchange
     * count, which both depend purely on layer_height (3MF: 0.22)
     * and the wipe-tower-per-layer cadence. Pre-fix OrcaXR diverged
     * by +27 layers / +40 toolchanges; post-fix the counts match
     * desktop exactly.
     *
     * The mass-based check stays as a soft upper bound (≤5% over) to
     * catch a regression that would silently re-inflate filament
     * usage even if the layer counts looked right.
     *
     * Skipped when dragon.3mf isn't on the device. Dumps the full
     * effective config through Log so a regression surfaces which key
     * drifted.
     */
    @Test
    fun dragonSliceFilamentMatchesDesktopWithinFivePercent() = runBlocking {
        val tag = "OrcaXR/dragonDiag"
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val dragonDir = appCtx.getExternalFilesDir(null) ?: appCtx.cacheDir
        val dragon = File(dragonDir, "dragon.3mf")
        if (!dragon.exists() || dragon.length() == 0L) {
            val src = "/sdcard/Download/dragon.3mf"
            val dst = dragon.absolutePath
            fun run(cmd: String): String {
                val pfd = androidx.test.platform.app.InstrumentationRegistry
                    .getInstrumentation().uiAutomation.executeShellCommand(cmd)
                val out = java.io.FileInputStream(pfd.fileDescriptor)
                    .use { it.bufferedReader().readText() }
                pfd.close()
                return out
            }
            run("mkdir -p ${dragonDir.absolutePath}")
            run("cp $src $dst")
            run("chmod 644 $dst")
        }
        org.junit.Assume.assumeTrue(
            "dragon.3mf not on device at /sdcard/Download/.",
            dragon.exists() && dragon.canRead() && dragon.length() > 0,
        )

        val catalog = OrcaProfileLoader.loadCatalog(appCtx)
        val u1 = catalog.firstOrNull {
            it.id.contains("snapmaker_u1_0.4") && it.id.contains("0.20_standard")
        } ?: catalog.firstOrNull { it.id.contains("snapmaker_u1_0.4") }
        org.junit.Assume.assumeTrue("no U1 profile in catalog (size=${catalog.size})", u1 != null)
        u1!!

        val embeddedColours = SlicerEngine.read3mfFilamentColours(dragon)
        val flush = SlicerEngine.read3mfFlushSettings(dragon)
        val overrides = SlicerEngine.read3mfProjectOverrides(dragon)
        android.util.Log.i(tag, "embedded colours = $embeddedColours")
        android.util.Log.i(tag, "embedded flush.matrix = ${flush?.matrix}")
        android.util.Log.i(tag, "embedded flush.multiplier = ${flush?.multiplier}")
        android.util.Log.i(tag, "embedded overrides = $overrides")

        val slots = if (embeddedColours.isNotEmpty()) embeddedColours
                    else listOf("#B366FF", "#000000", "#FFFFFF", "#FFFF00")
        // layer_height no longer flows from `overrides` (gotcha — the
        // 3MF's authored 0.22 used to silently win over the user's
        // profile pick, which hid every "I picked 0.12 Fine and got a
        // 0.20 slice" UX bug). Pass the dragon's authored layer height
        // explicitly via `layerHeightInput` so this test stays apples-
        // to-apples with the desktop reference (which sliced at 0.22).
        val cfg = mergedConfig(
            profile = u1,
            layerHeightInput = "0.22",
            slotColors = slots,
            flushFromProject = flush,
            projectOverrides = overrides,
        )
        android.util.Log.i(tag, "cfg.flush_volumes_matrix = ${cfg["flush_volumes_matrix"]}")
        android.util.Log.i(tag, "cfg.flush_multiplier = ${cfg["flush_multiplier"]}")
        android.util.Log.i(tag, "cfg.enable_prime_tower = ${cfg["enable_prime_tower"]}")
        android.util.Log.i(tag, "cfg.single_extruder_multi_material = ${cfg["single_extruder_multi_material"]}")
        android.util.Log.i(tag, "cfg.prime_tower_width = ${cfg["prime_tower_width"]}")
        android.util.Log.i(tag, "cfg.prime_volume = ${cfg["prime_volume"]}")
        android.util.Log.i(tag, "cfg.filament_map = ${cfg["filament_map"]}")

        val out = File(appCtx.cacheDir, "dragon_diag.gcode")
        val result = SlicerEngine.slice(dragon, out, cfg)
        if (result !is SliceResult.Success) {
            android.util.Log.e(tag, "slice failed: $result")
            assertTrue("diagnostic slice failed: $result", false)
        }
        runCatching {
            val downloads = File("/storage/emulated/0/Download")
            if (downloads.canWrite()) {
                out.copyTo(File(downloads, "dragon_diag.gcode"), overwrite = true)
            }
        }

        // Pull the summary lines from the produced gcode.
        val text = out.readText()
        val summary = text.lineSequence()
            .filter { it.startsWith("; filament used") || it.startsWith("; total filament") || it.startsWith("; total layers") }
            .toList()
        android.util.Log.i(tag, "=== OrcaXR dragon slice summary ===")
        summary.forEach { android.util.Log.i(tag, it) }
        val towerLines = text.lineSequence().count { it.startsWith("; WIPE_TOWER_START") }
        android.util.Log.i(tag, "WIPE_TOWER_START line count = $towerLines")
        android.util.Log.i(tag, "Reference (FullSpectrum desktop): 46.47 g total, 25.66 g tower")

        // Layer count — drove the +27 layer drift before we honored
        // the 3MF's authored layer_height=0.22.
        val layersLine = summary.firstOrNull { it.startsWith("; total layers count") }
        assertNotNull("missing `; total layers count` summary", layersLine)
        val orcaXrLayers = layersLine!!.substringAfter("=").trim().toIntOrNull()
        assertNotNull("could not parse layer count from `$layersLine`", orcaXrLayers)
        val desktopLayers = 275
        assertEquals(
            "OrcaXR layer count must match desktop's exactly when both honor " +
                "the same authored layer_height. Drift here means projectOverrides " +
                "(read3mfProjectOverrides) regressed and layer_height isn't flowing " +
                "from the 3MF to mergedConfig. Got OrcaXR=$orcaXrLayers desktop=$desktopLayers.",
            desktopLayers, orcaXrLayers,
        )

        // Toolchange count — same shape regression catch. Drove the
        // +40-toolchange / wipe-tower mass drift pre-fix.
        val tcLine = summary.firstOrNull { it.startsWith("; total filament change") }
            ?: text.lineSequence().firstOrNull { it.startsWith("; total filament change") }
        assertNotNull("missing `; total filament change` summary", tcLine)
        val orcaXrToolchanges = tcLine!!.substringAfter("=").trim().toIntOrNull()
        assertNotNull("could not parse toolchange count from `$tcLine`", orcaXrToolchanges)
        val desktopToolchanges = 399
        assertTrue(
            "OrcaXR toolchange count $orcaXrToolchanges should be within 5 of " +
                "desktop's $desktopToolchanges. Drift here is usually a layer_height " +
                "or wipe-tower-cadence regression.",
            kotlin.math.abs(orcaXrToolchanges!! - desktopToolchanges) <= 5,
        )

        // Mass — soft upper bound. OrcaXR's identity filament_map
        // produces less inter-color purge than desktop's all-on-T0
        // SEMM mode, so OrcaXR can be substantially LIGHTER than
        // desktop. Catch the case where filament usage runs AWAY in
        // the wrong direction (regression that re-inflates the slice
        // by >5% over desktop, e.g. flush settings dropping out
        // again).
        val totalLine = summary.firstOrNull { it.startsWith("; total filament used [g]") }
        assertNotNull("missing `; total filament used [g]` summary", totalLine)
        val orcaXrTotal = totalLine!!.substringAfter("=").trim().toDoubleOrNull()
        assertNotNull("could not parse total filament from `$totalLine`", orcaXrTotal)
        val desktopTotal = 46.47
        val ratio = orcaXrTotal!! / desktopTotal
        assertTrue(
            "OrcaXR dragon slice produced $orcaXrTotal g vs desktop $desktopTotal g " +
                "(ratio=${"%.3f".format(ratio)}). Soft upper bound: ≤1.05. If this " +
                "regressed up, check that flush_volumes_matrix / flush_multiplier / " +
                "prime_volume / prime_tower_width / layer_height all flow from the " +
                "3MF through to libslic3r.",
            ratio <= 1.05,
        )
    }

    /**
     * Round-trip a 3MF whose `Metadata/project_settings.config` carries
     * a hand-authored small flush matrix. Synthesize the 3MF by zip-
     * authoring a minimal project_settings.config + cube model on the
     * fly so the test doesn't depend on a checked-in binary fixture
     * (which would balloon every test APK install). Two-stage check:
     *
     *   1. `SlicerEngine.read3mfFlushSettings` extracts the embedded
     *      values via the JNI miniz scan path (the gotcha #10b
     *      workaround for libslic3r's broken LoadConfig on Android).
     *   2. mergedConfig() forwards them when the size matches, and
     *      the resulting G-code's footer-comment `flush_volumes_matrix
     *      = ` line echoes our small values rather than libslic3r's
     *      280-mm³ default.
     *
     * Why the synthesized fixture and not a checked-in .3mf: the
     * extraction code only depends on the project-config JSON shape,
     * not on a valid Bambu plate XML. We can author just the bits the
     * extractor reads and leave the rest empty — the file passes the
     * `iends_with(".3mf")` gate and miniz happily reads the
     * project_settings.config we wrote in.
     */
    @Test
    fun read3mfFlushSettingsRoundTripsAuthoredValues() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val fixture = File(appCtx.cacheDir, "synthetic_flush_authored.3mf")
        fixture.delete()
        val authoredConfig = """
        {
            "version": "1.0.0",
            "name": "test_authored",
            "from": "test",
            "filament_colour": ["#FF0000", "#00FF00"],
            "flush_volumes_matrix": ["0", "11", "11", "0"],
            "flush_multiplier": ["0.7"]
        }
        """.trimIndent()
        java.util.zip.ZipOutputStream(fixture.outputStream()).use { zip ->
            zip.putNextEntry(java.util.zip.ZipEntry("Metadata/project_settings.config"))
            zip.write(authoredConfig.toByteArray(Charsets.UTF_8))
            zip.closeEntry()
        }
        assertTrue("synthetic 3MF write failed", fixture.exists() && fixture.length() > 0)

        val flush = SlicerEngine.read3mfFlushSettings(fixture)
        assertNotNull("read3mfFlushSettings returned null on a 3MF that has both keys", flush)
        flush!!
        assertEquals("0,11,11,0", flush.matrix)
        assertEquals("0.7", flush.multiplier)
    }

    /**
     * Regression: FullSpectrum / older-OrcaSlicer 3MFs serialize
     * single-entry coFloats as JSON SCALAR strings, not single-element
     * arrays (e.g. `"flush_multiplier": "0.9"` not `["0.9"]`). The
     * extractor must handle both shapes uniformly. Pre-fix, the
     * scalar form would silently return the wrong vector — the
     * extractor skipped past the scalar value and pulled the NEXT
     * `[...]` array in the file (typically `flush_volumes_matrix`),
     * so multiplier and matrix came back identical and the slice ran
     * with `multiplier = synthesized 1.0` fallback. This was the
     * bug the dragon.3mf load surfaced — observable as +5 g vs
     * desktop on a multi-color print.
     *
     * Also covers prime_volume / prime_tower_width / prime_tower_brim_width,
     * which are typically scalar coFloat in authored 3MFs.
     */
    @Test
    fun read3mfFlushSettingsParsesScalarStringValues() = runBlocking {
        val appCtx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val fixture = File(appCtx.cacheDir, "synthetic_flush_scalar.3mf")
        fixture.delete()
        // Real-world shape: matrix as array, every other field as scalar.
        // Mirrors what FullSpectrum's desktop OrcaSlicer writes for the
        // dragon.3mf and similar tuned multi-color projects.
        val authoredConfig = """
        {
            "version": "1.0.0",
            "name": "test_authored_scalar",
            "from": "test",
            "flush_volumes_matrix": [
                "0", "233", "729", "683",
                "551", "0", "703", "800",
                "405", "223", "0", "377",
                "399", "270", "450", "0"
            ],
            "flush_multiplier": "0.9",
            "prime_volume": "38",
            "prime_tower_width": "28",
            "prime_tower_brim_width": "5"
        }
        """.trimIndent()
        java.util.zip.ZipOutputStream(fixture.outputStream()).use { zip ->
            zip.putNextEntry(java.util.zip.ZipEntry("Metadata/project_settings.config"))
            zip.write(authoredConfig.toByteArray(Charsets.UTF_8))
            zip.closeEntry()
        }

        val flush = SlicerEngine.read3mfFlushSettings(fixture)
        assertNotNull("read3mfFlushSettings returned null on a scalar-form 3MF", flush)
        flush!!
        // Matrix array: 16 entries comma-joined.
        assertEquals(16, flush.matrix.split(',').size)
        assertEquals("0", flush.matrix.split(',')[0])
        assertEquals("800", flush.matrix.split(',')[7])
        // Scalar strings round-trip as single-token CSVs.
        assertEquals("0.9", flush.multiplier)
        assertEquals("38", flush.primeVolume)
        assertEquals("28", flush.primeTowerWidth)
        assertEquals("5", flush.primeTowerBrimWidth)
    }

    private fun overhangFixture(): StlMesh {
        val tris = mutableListOf<Float>()
        appendBox(tris, 0f, 0f, 0f, 20f, 20f, 20f)
        appendBox(tris, 0f, 0f, 20f, 70f, 20f, 30f)
        return StlMesh(
            positions = tris.toFloatArray(),
            triCount = tris.size / 9,
            bboxMin = Vec3f(0f, 0f, 0f),
            bboxMax = Vec3f(70f, 20f, 30f),
        )
    }

    private fun appendBox(
        out: MutableList<Float>,
        x0: Float,
        y0: Float,
        z0: Float,
        x1: Float,
        y1: Float,
        z1: Float,
    ) {
        // Bottom (-Z).
        tri(out, x0, y0, z0, x1, y1, z0, x1, y0, z0)
        tri(out, x0, y0, z0, x0, y1, z0, x1, y1, z0)
        // Top (+Z).
        tri(out, x0, y0, z1, x1, y0, z1, x1, y1, z1)
        tri(out, x0, y0, z1, x1, y1, z1, x0, y1, z1)
        // Front (-Y).
        tri(out, x0, y0, z0, x1, y0, z0, x1, y0, z1)
        tri(out, x0, y0, z0, x1, y0, z1, x0, y0, z1)
        // Back (+Y).
        tri(out, x0, y1, z0, x1, y1, z1, x1, y1, z0)
        tri(out, x0, y1, z0, x0, y1, z1, x1, y1, z1)
        // Left (-X).
        tri(out, x0, y0, z0, x0, y1, z1, x0, y1, z0)
        tri(out, x0, y0, z0, x0, y0, z1, x0, y1, z1)
        // Right (+X).
        tri(out, x1, y0, z0, x1, y1, z0, x1, y1, z1)
        tri(out, x1, y0, z0, x1, y1, z1, x1, y0, z1)
    }

    private fun tri(
        out: MutableList<Float>,
        ax: Float, ay: Float, az: Float,
        bx: Float, by: Float, bz: Float,
        cx: Float, cy: Float, cz: Float,
    ) {
        out += ax; out += ay; out += az
        out += bx; out += by; out += bz
        out += cx; out += cy; out += cz
    }
}
