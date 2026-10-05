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
    implementation(project(":core-bridge"))
    testImplementation(libs.junit)
}
