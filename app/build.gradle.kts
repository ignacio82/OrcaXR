import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    // AGP 9+ has built-in Kotlin support — no kotlin-android plugin needed.
    alias(libs.plugins.kotlin.compose.compiler)
}

val localProperties = Properties()
val localPropertiesFile = rootProject.file("local.properties")

if (localPropertiesFile.exists()) {
    localPropertiesFile.inputStream().use { localProperties.load(it) }
}

android {
    namespace = "dev.orcaxr.app"
    compileSdk = 37

    signingConfigs {
        create("release") {
            storeFile =
                (project.findProperty("ORCAXR_KEYSTORE") as String?
                        ?: localProperties.getProperty("ORCAXR_KEYSTORE"))
                    ?.let { file(it) } ?: System.getenv("ORCAXR_KEYSTORE")?.let { file(it) }
            storePassword =
                project.findProperty("ORCAXR_KEYSTORE_PASSWORD") as String?
                    ?: localProperties.getProperty("ORCAXR_KEYSTORE_PASSWORD")
                    ?: System.getenv("ORCAXR_KEYSTORE_PASSWORD")
            keyAlias =
                project.findProperty("ORCAXR_KEY_ALIAS") as String?
                    ?: localProperties.getProperty("ORCAXR_KEY_ALIAS")
                    ?: System.getenv("ORCAXR_KEY_ALIAS")
            keyPassword =
                project.findProperty("ORCAXR_KEY_PASSWORD") as String?
                    ?: localProperties.getProperty("ORCAXR_KEY_PASSWORD")
                    ?: System.getenv("ORCAXR_KEY_PASSWORD")
        }
    }

    // Pin the NDK to the same version libslic3r was cross-compiled with
    // (scripts/build_native.sh). AGP otherwise picks the highest-version
    // NDK it finds anywhere on the host (in our case a stray r28.2 at
    // /usr/local/lib/android/sdk/ndk/), and r28's libc++ is missing
    // weak symbols (e.g. __from_chars_floating_point<float>) that
    // libslic3r references via std::from_chars.
    ndkVersion = "29.0.14206865"

    defaultConfig {
        applicationId = "dev.orcaxr.app"
        minSdk = 31
        targetSdk = 35
        versionCode = 2026051702
        versionName = "0.0.6"

        // Phase 0 targets arm64-v8a only. Add more ABIs when we support
        // other form factors; libslic3r_jni.so is arm64-only for now.
        // ABI filtering lives in `splits { abi { include("arm64-v8a") } }`
        // below — AGP rejects coexisting `ndk { abiFilters }` and
        // `splits { abi }` with "Conflicting configuration : ...
        // cannot be present when splits abi filters are set", even
        // when the two sets agree. Splits is authoritative.
        val isBuildingBundle =
            gradle.startParameter.taskNames.any { it.lowercase().contains("bundle") }
        if (isBuildingBundle) {
            ndk { abiFilters.add("arm64-v8a") }
        }

        externalNativeBuild {
            cmake {
                // libslic3r calls std::from_chars<float> whose implementation
                // (__from_chars_floating_point) is a weak symbol in
                // libc++_shared.so. Static linking (c++_static) misses it.
                arguments += listOf("-DANDROID_STL=c++_shared")

                // Forward ORCAXR_ASAN=1 in the host env to the CMake
                // option. Use this to debug the multi-color slicing
                // race: rebuild libslic3r with `ORCAXR_ASAN=1
                // ./scripts/build_native.sh` and gradle picks up the
                // matching flag here so slic3r_jni.so is also
                // instrumented + linked against the ASAN runtime.
                if (System.getenv("ORCAXR_ASAN") == "1") {
                    arguments += listOf("-DORCAXR_ASAN=ON")
                }
            }
        }

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Roadmap E10 — run every instrumented test in its own process so
        // libslic3r's per-process C++ allocations (Print / Model / Layer
        // graphs) can't leak across slicing tests. Without this, a 5-test
        // slicing sequence OOMs the test process well before it finishes.
        // See GEMINI.md gotcha §30 for the full rationale.
        testInstrumentationRunnerArguments["clearPackageData"] = "true"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    // AGP 9+ drives Kotlin's JVM target off compileOptions; no separate
    // kotlinOptions block needed.

    // Native build wired via externalNativeBuild — the Gradle plugin invokes
    // CMake on app/src/main/cpp/CMakeLists.txt and stages the produced .so
    // into the APK. libslic3r.a itself is built out-of-tree by
    // scripts/build_native.sh (much too large and slow to rebuild per app
    // build). CMake here only links our thin JNI shim against the prebuilt
    // archive.
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.28.0+"
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
        }
        release {
            // Audit H13 (2026-05-07) — R8 minify + baseline profile is
            // the biggest single perf lever (~75% startup / ~60%
            // frame-render per the `configuring-r8-for-compose`
            // skill). Tried to enable in this audit sweep but Kotlin
            // 2.3.21's Compose compiler (2.2.10) tries to download a
            // `compose-group-mapping:2.2.10` artifact that hasn't
            // been published upstream — produceReleaseComposeMapping
            // fails before R8 runs, independent of our minify config.
            // Workarounds tried: late `tasks.matching{}.disable` (too
            // late, configuration cache fails first), clearing
            // `composeMappingProducerClasspath` in afterEvaluate
            // (also too late). Real fix: wait for upstream artifact
            // OR pin Compose compiler to 2.0.x. Both bigger than
            // this sweep. Keep `proguard-rules.pro` ready to wire
            // back in when the blocker resolves.
            isMinifyEnabled = false
            signingConfig =
                if (signingConfigs.getByName("release").storeFile?.exists() == true) {
                    signingConfigs.getByName("release")
                } else {
                    null
                }
        }
    }

    splits {
        abi {
            // Disabled when building bundles due to AGP 8.9.0 bug:
            // https://issuetracker.google.com/issues/402800800
            val isBuildingBundle =
                gradle.startParameter.taskNames.any { it.lowercase().contains("bundle") }
            isEnable = !isBuildingBundle
            reset()
            // arm64-v8a only — must match `ndk { abiFilters }` above
            // (AGP rejects splits with ABIs the ndk filter excludes
            // with: "Conflicting configuration : 'arm64-v8a' in ndk
            // abiFilters cannot be present when splits abi filters
            // are set"). libslic3r_jni.so is arm64-only and Galaxy XR
            // / Android XR target arm64 exclusively, so armeabi-v7a
            // would never have actual native code in it anyway.
            include("arm64-v8a")
        }
    }

    buildFeatures {
        compose = true
        // BuildConfig.DEBUG is needed by TestBroadcastReceiver
        // (app/src/debug/java/dev/orcaxr/app/) as a runtime guard so a
        // future src/main/ leak still no-ops in release. AGP 9 turns
        // BuildConfig generation off by default — re-enable it here.
        buildConfig = true
    }

    testOptions {
        // JVM unit tests use the stub android.jar, where every method
        // throws "not mocked" by default. The MCP server (and any
        // future code) calls android.util.Log; turning on
        // returnDefaultValues makes Log.* a no-op in unit tests so we
        // can verify protocol-level behavior without spinning up
        // Robolectric or moving to androidTest.
        unitTests.isReturnDefaultValues = true
        // Roadmap E10 — instrumented tests run in their own process so
        // libslic3r's per-process C++ allocations can't leak across
        // slicing tests. See GEMINI.md gotcha §30.
        execution = "ANDROIDX_TEST_ORCHESTRATOR"
    }

    packaging {
        // JNI libs staged by externalNativeBuild end up under jniLibs/
        // automatically.
        //
        // Roadmap E9 — assert libslic3r_jni.so was built with Clang ≥ 17.
        // Pre-built .so's that slip through with an older NDK silently
        // miscompile libslic3r's paint segmentation (u1-slicer's B62
        // incident). gradle pin + bash assert + this gradle tripwire
        // form three independent layers — removing any one still fails
        // loudly. See GEMINI.md gotcha §29.
        //
        // ASAN debugging path: AGP 7+ packages wrap.sh from
        // src/main/resources/lib/<abi>/ at lib/<abi>/wrap.sh in the
        // APK. The Android Runtime detects wrap.sh on app launch and
        // execs it instead of the default app start, letting us
        // LD_PRELOAD the ASAN runtime before any native code touches
        // malloc. The ASAN runtime itself
        // (libclang_rt.asan-aarch64-android.so) sits in
        // jniLibs/<abi>/ — that path's .so filter doesn't strip it.
        //
        // Both files are debug-only and should be removed for release.
        jniLibs { useLegacyPackaging = true }
    }
}

/**
 * Roadmap E9 — assert any libslic3r_jni.so under app/build/intermediates was compiled with Clang
 * ≥ 17. Reads each .so's `.comment` section (which the linker preserves) via a streaming byte scan
 * — no toolchain dependencies, runs on every host. Fails the build with a pointer at the gotcha so
 * a future contributor doesn't downgrade NDK to "make builds faster" and silently regress paint
 * segmentation.
 *
 * Wired as a `finalizedBy` of mergeDebugNativeLibs so the assertion runs immediately after the .so
 * lands in the merge output. We don't gate `assembleDebug` directly because at -task-graph build
 * time the intermediates path doesn't exist yet — pinning to mergeDebug keeps the order correct on
 * a clean build.
 */
val verifyNdkClangFloor by tasks.registering {
    group = "verification"
    description =
        "Assert staged libslic3r_jni.so was built with Clang >= 17 (E9 / GEMINI gotcha 29)."
    val intermediatesRoot = layout.buildDirectory.dir("intermediates").map { it.asFile }
    doLast {
        val root = intermediatesRoot.get()
        val candidates =
            listOf(
                // externalNativeBuild stages here.
                File(root, "cxx"),
                // mergeDebugNativeLibs / mergeReleaseNativeLibs land here.
                File(root, "merged_native_libs"),
            )
        val sos =
            candidates
                .filter { it.exists() }
                .flatMap { dir ->
                    dir.walkTopDown().filter { it.isFile && it.name == "libslic3r_jni.so" }.toList()
                }
        if (sos.isEmpty()) {
            // Nothing to verify yet — the JNI build may not have run.
            // Don't fail; the bash assert in scripts/build_native.sh
            // covers fresh native builds.
            logger.lifecycle("verifyNdkClangFloor: no libslic3r_jni.so staged yet, skipping.")
            return@doLast
        }
        val clangVersionRegex = Regex("""clang version (\d+)""")
        val FLOOR = 17
        for (so in sos) {
            val text = so.readBytes().toString(Charsets.ISO_8859_1)
            val match =
                clangVersionRegex.find(text)
                    ?: throw GradleException(
                        "verifyNdkClangFloor: ${so.name} carries no `clang version` marker — " +
                            "was it built with a non-Clang toolchain? (See GEMINI.md gotcha §29.)"
                    )
            val major = match.groupValues[1].toIntOrNull() ?: 0
            if (major < FLOOR) {
                throw GradleException(
                    "verifyNdkClangFloor: ${so.name} was built with Clang $major (< $FLOOR). " +
                        "libslic3r's paint segmentation miscompiles on Clang < 17 — see " +
                        "GEMINI.md gotcha §29 (u1-slicer B62). Update NDK to >= r26b and rebuild."
                )
            }
            logger.lifecycle("verifyNdkClangFloor: ${so.name} OK (Clang $major).")
        }
    }
}

// Wire after mergeDebugNativeLibs / mergeReleaseNativeLibs so the .so
// is staged and visible to the verify task.
tasks.whenTaskAdded {
    if (name == "mergeDebugNativeLibs" || name == "mergeReleaseNativeLibs") {
        finalizedBy(verifyNdkClangFloor)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.datastore.preferences)
    // WorkManager — drives the background download of the Gemma 4
    // .litertlm bundle as a foreground service so a multi-GB fetch
    // survives the user backgrounding the app or taking off the
    // headset. dev.orcaxr.app.llm.local.Gemma4DownloadWorker is the
    // load-bearing piece; the dep also provides
    // androidx.work.impl.foreground.SystemForegroundService which the
    // manifest re-declares with foregroundServiceType="dataSync".
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.kotlinx.coroutines.android)
    // On-device LLM runtimes. Two are bundled, one per accelerator:
    //
    //  - com.google.ai.edge.litertlm:litertlm-android — wraps
    //    libLiteRtLm + the GPU/NPU dispatchers. Loads .litertlm
    //    bundles (Gemma 4 E2B / E4B) and exposes a synchronous
    //    Engine + streaming Conversation API. Used by
    //    dev.orcaxr.app.llm.local.LiteRtEngineHolder. This is the
    //    only on-device path that runs on Galaxy XR (no Tensor TPU
    //    in the headset SoC).
    //
    //  - com.google.mlkit:genai-prompt — entry point into AICore /
    //    Gemini Nano on Pixel 8/9/10 class devices. Runs on the
    //    Tensor TPU at the OS level via ML Kit GenAI Prompt; the
    //    no-arg Generation.getClient() overload is publicly
    //    available (no allowlist) and is what SpatialFin and Google
    //    AI Edge Gallery use. Used by
    //    dev.orcaxr.app.llm.aicore.AICoreEngineHolder. Backstop for
    //    Pixel-class phones where the Adreno path under LiteRT-LM
    //    over-commits VRAM and freezes the device.
    implementation(libs.litertlm.android)
    implementation(libs.mlkit.genai.prompt)
    // Moonraker / printer HTTP client. Android's stock HttpURLConnection
    // returns SocketException("closed") talking to Mainsail's nginx in
    // front of Moonraker on the user's LAN even though curl from the
    // same shell works fine — see Phase 3 commits for the trace.
    implementation(libs.okhttp)

    // Compose UI surface for the SpatialPanel content.
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.compose.runtime)
    implementation(libs.androidx.compose.ui)
    // Downloadable Google Fonts at runtime — bundles Instrument Sans,
    // Space Grotesk, and JetBrains Mono into the OrcaXrTheme typography
    // without shipping TTFs in the APK. First use fetches via the
    // Play Services font provider; subsequent loads are cached on-device.
    implementation(libs.androidx.compose.ui.text.google.fonts)
    debugImplementation(libs.androidx.compose.ui.tooling)
    implementation(libs.androidx.compose.ui.tooling.preview)

    // Jetpack XR — runtime (Session), SceneCore (entities), Compose XR
    // (Subspace + SpatialPanel).
    implementation(libs.androidx.xr.runtime)
    implementation(libs.androidx.xr.scenecore)
    implementation(libs.androidx.xr.compose)
    implementation(libs.androidx.xr.compose.material3)

    // Filament — direct GPU rendering for the mobile-shell 3D toolpath
    // viewer. Loads the GLB produced by `ToolpathGlb.write` (the same
    // bake the XR path consumes) so the mobile and XR previews share a
    // single source of truth. `filament-utils-android` carries the
    // orbit-camera Manipulator + KTX/IBL loaders; `gltfio-android`
    // pulls glTF/GLB asset loading on top of the core engine.
    implementation(libs.filament.android)
    implementation(libs.filament.utils.android)
    implementation(libs.gltfio.android)

    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.kotlinx.coroutines.test)
    // Roadmap E10 — Android Test Orchestrator is staged as a separate APK
    // alongside the app under test; the runner shells out to it to start
    // each instrumented test in its own process. `androidTestUtil`
    // (instead of `androidTestImplementation`) is the AGP-supported
    // configuration for that staging.
    androidTestUtil(libs.androidx.test.orchestrator)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    // org.json.JSONObject is stubbed-only in the android.jar shipped with
    // the Android plugin — JVM unit tests need a real implementation on
    // the classpath. The "json" jar (Apache 2.0) is the canonical drop-in.
    // Mirrors the same dependency the Android runtime ships.
    testImplementation("org.json:json:20240303")
    // OkHttp's MockWebServer powers WebcamSession / MoonrakerClient
    // tests. Pinned to the same version as the runtime client so the
    // request/response APIs stay aligned.
    testImplementation("com.squareup.okhttp3:mockwebserver:5.3.2")
}
