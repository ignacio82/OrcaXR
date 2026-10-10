plugins { alias(libs.plugins.android.library) }

abstract class BuildRust : Exec() {
    @get:OutputDirectory abstract val jniDirectory: DirectoryProperty
}

val buildRust by tasks.registering(BuildRust::class) {
    workingDir(rootProject.projectDir.parentFile)
    commandLine("python3", "tools/cross-platform/build-android.py")
    inputs.files(fileTree("../../core/crates"), file("../../core/Cargo.toml"),
        file("../../core/Cargo.lock"), file("../../core/rust-toolchain.toml"),
        fileTree("../../tools/cross-platform") { include("*.py") },
        fileTree("../../contracts") { include("*.json") })
    jniDirectory.set(layout.buildDirectory.dir("generated/jniLibs"))
    outputs.file(layout.buildDirectory.file("generated/core-native-manifest.json"))
}

android {
    namespace = "dev.orcaxr.core"
    compileSdk = 37
    ndkVersion = "29.0.14206865"
    defaultConfig {
        minSdk = 31
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

androidComponents.onVariants { variant ->
    variant.sources.jniLibs?.addGeneratedSourceDirectory(buildRust) { it.jniDirectory }
    variant.deviceTests.values.forEach { test ->
        test.sources.assets?.addStaticSourceDirectory(rootProject.file("../testdata/cross-platform").path)
        // The bundled profile catalog, built on the device as the app builds it.
        test.sources.assets?.addStaticSourceDirectory(rootProject.file("../web/public/profiles").path)
    }
}
dependencies {
    // The Moonraker host's HTTP and WebSocket client. Okio is pinned to the
    // version OkHttp's own is resolved to elsewhere in the build.
    implementation(libs.okhttp)
    implementation(libs.okio)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
}
