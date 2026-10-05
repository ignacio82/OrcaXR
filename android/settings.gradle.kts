pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "OrcaXR"
include(":app")
include(":core-bridge")
include(":renderer-api")
include(":renderer-filament")
include(":renderer-scenecore")
include(":xr-experiment")
