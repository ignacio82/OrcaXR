plugins { alias(libs.plugins.android.library) }
android {
    namespace = "dev.orcaxr.renderer"
    compileSdk = 37
    defaultConfig { minSdk = 31 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    // Public API (ProjectScene, PacketMeshes, ToolpathGeometry) speaks core-bridge's types.
    api(project(":core-bridge"))
    testImplementation(libs.junit)
}
