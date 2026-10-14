package dev.orcaxr.nativeapp.engine

/**
 * The slicing engine's JNI adapter (liborcaxr_engine.so, built by
 * tools/native-engine/build-engine-adapter.py). Loaded only in the engine
 * service's own process, never the editor's, so an engine crash ends that
 * process alone. Every string here is ASCII: app-private paths and digests
 * in, the adapter's JSON documents out (read by `LocalSlicing`).
 */
internal object NativeEngine {
    @Volatile private var loaded = false

    /** Loads the library (and through it TBB and libc++); its JNI_OnLoad registers the methods below. */
    @Synchronized fun load() {
        if (loaded) return
        System.loadLibrary("orcaxr_engine")
        loaded = true
    }

    /** The adapter's identity: the pinned engine commit, engine recipe and adapter recipe it was built from. */
    @JvmStatic external fun nativeIdentity(): String

    /** Slices one staged job on the calling thread; answers the engine's result document. */
    @JvmStatic external fun nativeSlice(
        job: String,
        archive: String,
        archiveBytes: Long,
        archiveSha256: String,
        overrides: String,
        overridesBytes: Long,
        overridesSha256: String,
        resources: String,
        output: String,
    ): String

    /** Repairs one staged STL mesh on the calling thread; answers the engine's result document. */
    @JvmStatic external fun nativeRepair(
        job: String,
        input: String,
        inputBytes: Long,
        inputSha256: String,
        output: String,
    ): String

    /** Computes mesh boolean on two staged STL meshes on the calling thread; answers the engine's result document. */
    @JvmStatic external fun nativeBoolean(
        job: String,
        inputA: String,
        inputABytes: Long,
        inputASha256: String,
        inputB: String,
        inputBBytes: Long,
        inputBSha256: String,
        op: String,
        output: String,
    ): String

    /** Asks the running job to stop at the engine's next cancellation point; callable from any thread. */
    @JvmStatic external fun nativeCancel()

    /** The running job's progress: `{"sequence":n,"percent":p,"message":"..."}`. */
    @JvmStatic external fun nativeProgress(): String
}
