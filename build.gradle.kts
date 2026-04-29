plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.version.catalog.update)
    alias(libs.plugins.ktfmt) apply false
}

subprojects {
    apply(plugin = "com.ncorti.ktfmt.gradle")

    configure<com.ncorti.ktfmt.gradle.KtfmtExtension> {
        kotlinLangStyle()
    }
}
