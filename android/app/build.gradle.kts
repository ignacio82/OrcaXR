plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
}

/** The browser's bundled profile catalog — the one file of `profiles/` the app reads — as an asset. */
abstract class BundleCatalog : DefaultTask() {
    @get:InputFile abstract val catalog: RegularFileProperty
    @get:OutputDirectory abstract val assets: DirectoryProperty

    @TaskAction fun copy() {
        val target = assets.get().dir("profiles").asFile
        target.mkdirs()
        catalog.get().asFile.copyTo(target.resolve("catalog.json"), overwrite = true)
    }
}
val bundleCatalog by tasks.registering(BundleCatalog::class) {
    catalog.set(rootProject.file("../web/public/profiles/catalog.json"))
}
androidComponents.onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(bundleCatalog) { it.assets }
}

/**
 * The slicing engine this device runs locally: the adapter library, its TBB and libc++ runtimes for
 * both ABIs and its resources, exported only from packages build-engine-adapter.py verifies against
 * the pinned engine recipe, with the identity manifest the engine's process checks the loaded
 * library against. Every build packages it unless `-Porcaxr.localEngine=none` (a host without the
 * engine build, such as the hosted CI job): that build says it carries no engine of its own and
 * slices only on an external slicer the operator turns on.
 */
abstract class BundleEngine : Exec() {
    @get:OutputDirectory abstract val jniDirectory: DirectoryProperty
    @get:OutputDirectory abstract val assetsDirectory: DirectoryProperty
}
val localEngine = providers.gradleProperty("orcaxr.localEngine").getOrElse("packaged")
require(localEngine == "packaged" || localEngine == "none") { "orcaxr.localEngine is packaged or none" }
if (localEngine == "packaged") {
    val bundleEngine by tasks.registering(BundleEngine::class) {
        val export = layout.buildDirectory.dir("generated/engine")
        val tools = rootProject.file("../tools/native-engine")
        workingDir(rootProject.projectDir.parentFile)
        environment("ANDROID_HOME", androidComponents.sdkComponents.sdkDirectory.get().asFile.path)
        commandLine("python3", "tools/native-engine/build-engine-adapter.py", "--export", export.get().asFile.path)
        inputs.files(fileTree(tools) { include("*.py", "adapter/**", "engine/**", "patches/**") })
        inputs.files(fileTree(tools.resolve("build/adapter")) { include("*/*/package/**") })
        jniDirectory.set(export.map { it.dir("jniLibs") })
        assetsDirectory.set(export.map { it.dir("assets") })
    }
    androidComponents.onVariants { variant ->
        variant.sources.jniLibs?.addGeneratedSourceDirectory(bundleEngine) { it.jniDirectory }
        variant.sources.assets?.addGeneratedSourceDirectory(bundleEngine) { it.assetsDirectory }
    }
}
android {
    namespace = "dev.orcaxr.nativeapp"
    compileSdk = 37
    ndkVersion = "29.0.14206865"
    defaultConfig {
        // Separate installation protects users of the retired dev.orcaxr.app.
        applicationId = "dev.orcaxr.nativeapp"
        minSdk = 31
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0-dev"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }
    buildTypes {
        // Android's pseudo-locales, as the browser exercises its own: en-XA expands and
        // accents every resource, ar-XB mirrors the layout right-to-left. A debug build
        // offers them; text left in Kotlin stays plain English under en-XA.
        debug {
            isPseudoLocalesEnabled = true
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // The engine's libraries are packaged exactly as the verified export hashed them (already
    // stripped): the build's own strip would rewrite their bytes, and the manifest would not hold.
    packaging {
        jniLibs {
            keepDebugSymbols += setOf("**/liborcaxr_engine.so", "**/libtbb.so", "**/libtbbmalloc.so", "**/libc++_shared.so")
        }
    }
    // AIDL: the engine service's binder, between the editor's process and the engine's.
    buildFeatures {
        compose = true
        aidl = true
    }
}
dependencies {
    implementation(project(":core-bridge"))
    // The Workspace draws the project with the flat renderer in every build.
    implementation(project(":renderer-filament"))
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    // Prepare's platform-free flow (connection, consent, the browser's words) on the JVM.
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
}
