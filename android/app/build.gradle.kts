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
    buildFeatures { compose = true }
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
