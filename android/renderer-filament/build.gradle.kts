import groovy.json.JsonSlurper
import java.security.MessageDigest

plugins { alias(libs.plugins.android.library) }
android {
    namespace = "dev.orcaxr.renderer.filament"
    compileSdk = 37
    defaultConfig { minSdk = 31 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    api(project(":renderer-api"))
    implementation(libs.filament.android)
    testImplementation(libs.junit)
}
val verifyMaterials by tasks.registering {
    val sources = layout.projectDirectory.dir("materials")
    val assets = layout.projectDirectory.dir("src/main/assets/materials")
    val buildScript = rootProject.layout.projectDirectory.file("../tools/renderer/build-materials.py")
    inputs.file(buildScript)
    inputs.dir(sources)
    inputs.dir(assets)
    doLast {
        fun hash(file: java.io.File) = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
            .joinToString("") { "%02x".format(it) }
        val manifest = JsonSlurper().parse(assets.file("manifest.json").asFile) as Map<*, *>
        check(manifest["schemaVersion"] == 1)
        check(manifest["buildScriptSha256"] == hash(buildScript.asFile)) { "Material compiler script drift" }
        val compilerScript = buildScript.asFile.readText()
        for ((field, constant) in mapOf("compilerSha256" to "COMPILER_SHA", "archiveSha256" to "ARCHIVE_SHA")) {
            check(manifest[field] == Regex("$constant = \"([a-f0-9]{64})\"").find(compilerScript)?.groupValues?.get(1))
        }
        check(manifest["arguments"] == listOf("-p", "mobile", "-a", "opengl", "-a", "vulkan"))
        check(manifest["filamentVersion"] == libs.versions.filament.get()) { "Material/runtime version mismatch" }
        for (section in listOf("inputs", "outputs")) {
            val directory = if (section == "inputs") sources else assets
            val entries = manifest[section] as Map<*, *>
            check(entries.keys == setOf("opaque.${if (section == "inputs") "mat" else "filamat"}",
                "transparent.${if (section == "inputs") "mat" else "filamat"}"))
            for ((name, expected) in entries) check(hash(directory.file(name as String).asFile) == expected) {
                "Material provenance drift: $name; run tools/renderer/build-materials.py"
            }
        }
    }
}
tasks.named("preBuild") { dependsOn(verifyMaterials) }
