# Audit H13 (2026-05-07) — keep rules for the OrcaXR app under R8 full
# mode. Per the `configuring-r8-for-compose` skill: prefer narrow keeps
# over package-wide blanket rules. Compose ships its own consumer
# ProGuard rules (so we don't keep androidx.compose.* ourselves).
#
# Keep set, organized by reason:
#
# ────────────────────────────────────────────────────────────────────
# 1. JNI native methods + the classes that declare them. The linker
#    resolves Java_dev_orcaxr_app_<Class>_<method> by name, so any
#    R8 rename or strip of the Kotlin side breaks libslic3r_jni.
# ────────────────────────────────────────────────────────────────────
-keepclasseswithmembers class * {
    native <methods>;
}

# Keep the entire SlicerEngine surface (companion + nested data
# classes) — JNI constructs ObjectMeta / RepairResult / SimplifyResult
# / Read3mfObjectConfig / Read3mfVolumeConfig / etc. via env->NewObject.
# R8 would otherwise rename their constructors / fields out of sync
# with the C++ side's `GetMethodID(...)` lookups.
-keep class dev.orcaxr.app.SlicerEngine { *; }
-keep class dev.orcaxr.app.SlicerEngine$* { *; }

# ────────────────────────────────────────────────────────────────────
# 2. AndroidX XR — alpha13. The Jetpack XR runtime resolves SceneCore
#    entity / component types reflectively in places (component
#    binding, gltf loading). Until the artifact stabilizes past alpha,
#    keep the public surface so a release build doesn't crash with
#    `NoSuchMethodError` deep inside SceneCore.
# ────────────────────────────────────────────────────────────────────
-keep class androidx.xr.** { *; }
-dontwarn androidx.xr.**

# ────────────────────────────────────────────────────────────────────
# 3. OkHttp / okio — already ship consumer ProGuard rules; nothing
#    extra needed. The MoonrakerClient + VisionApiClient paths use
#    only the public OkHttp surface.
# ────────────────────────────────────────────────────────────────────

# ────────────────────────────────────────────────────────────────────
# 4. Coroutines internals — keep the debug agent off (we don't ship
#    DebugProbes), and silence the warning that R8 emits for the
#    optional kotlinx.coroutines.debug package.
# ────────────────────────────────────────────────────────────────────
-dontwarn kotlinx.coroutines.debug.**

# ────────────────────────────────────────────────────────────────────
# 5. Crash reporting — keep stack frames meaningful in production.
#    Without -keepattributes, every crash trace from a Compose path
#    becomes obfuscated noise we can't grep against the source tree.
# ────────────────────────────────────────────────────────────────────
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ────────────────────────────────────────────────────────────────────
# 6. Process-singleton stores accessed via reflection? — none today.
#    PlateStore / FilamentEntriesStore / etc. are normal Kotlin
#    objects; R8 inlines them safely.
# ────────────────────────────────────────────────────────────────────
