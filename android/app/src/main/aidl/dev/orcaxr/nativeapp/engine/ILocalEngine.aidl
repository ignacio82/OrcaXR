package dev.orcaxr.nativeapp.engine;

/**
 * The local slicing engine's service, in its own process. Binder carries only
 * metadata and progress: a job's archive, overrides and G-code stay in its
 * private staged directory. Documents are LocalSlicing's (core-bridge).
 */
interface ILocalEngine {
    /** The engine process's ID, so its owner can end that process alone after a bounded cancel. */
    int processId();

    /** "ok " and the loaded adapter's identity document once it matches the app's manifest; otherwise "no " and why. */
    String identity();

    /**
     * Starts job [job] (its directory under the jobs root) whose staged inputs
     * have these lengths and SHA-256 digests. [owner] is the editor's token: its
     * death cancels the job. False when a job is already running.
     */
    boolean start(String job, long archiveBytes, String archiveSha256, long overridesBytes, String overridesSha256, IBinder owner);

    /**
     * Starts repair job [job] whose staged input STL has [inputBytes] and [inputSha256].
     * [owner] is the editor's token: its death cancels the job. False when a job is already running.
     */
    boolean startRepair(String job, long inputBytes, String inputSha256, IBinder owner);

    /**
     * Starts mesh boolean job [job] with operation [op] ("UNION", "A_NOT_B", "INTERSECTION")
     * whose staged inputs A and B have their respective lengths and digests. [owner] is the
     * editor's token: its death cancels the job. False when a job is already running.
     */
    boolean startBoolean(String job, long aBytes, String aSha256, long bBytes, String bSha256, String op, IBinder owner);

    /** The job's status document: running with progress, done with the engine's result, or unknown. */
    String poll(String job);

    /** Asks the engine to stop job [job] cooperatively. */
    void cancel(String job);
}
