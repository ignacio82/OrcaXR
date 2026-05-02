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
                    ?: localProperties.getProperty("ORCAXR_KEYSTORE"))?.let { file(it) }
                    ?: System.getenv("ORCAXR_KEYSTORE")?.let { file(it) }
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
        versionCode = 1
        versionName = "0.0.1"

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
            ndk {
                abiFilters.add("arm64-v8a")
            }
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
            isMinifyEnabled = false // Phase 0/1: R8 disabled during initial
                                    // development pending androidx.xr stability.
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

    packaging {
        // JNI libs staged by externalNativeBuild end up under jniLibs/
        // automatically.
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
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
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

    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.kotlinx.coroutines.test)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    // org.json.JSONObject is stubbed-only in the android.jar shipped with
    // the Android plugin — JVM unit tests need a real implementation on
    // the classpath. The "json" jar (Apache 2.0) is the canonical drop-in.
    // Mirrors the same dependency the Android runtime ships.
    testImplementation("org.json:json:20240303")
}
