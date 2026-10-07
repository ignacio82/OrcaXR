package dev.orcaxr.core;

/** Synchronous borrowed callback on the export worker. Chunks are owned byte
 * arrays of at most 64 KiB. Exceptions stop the writer and are redacted by JNI.
 * Return only after accepting the complete chunk; never log private contents. */
@FunctionalInterface
public interface ProjectJsonSink {
    void write(byte[] bytes);
}
