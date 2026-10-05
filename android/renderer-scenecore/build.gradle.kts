plugins { alias(libs.plugins.android.library) }
android {
    namespace = "dev.orcaxr.renderer.scenecore"
    compileSdk = 37
    defaultConfig { minSdk = 31 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    api(project(":renderer-api"))
    api(libs.androidx.xr.scenecore)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    testImplementation(libs.junit)
}
