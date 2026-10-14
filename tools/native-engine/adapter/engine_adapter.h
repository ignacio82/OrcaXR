#pragma once
// The application's local slicing adapter: a narrow C ABI over one pinned
// engine slice. JNI (engine_jni.cpp) and the fixture driver
// (engine_driver.cpp) are its only callers; libslic3r stays hidden behind it.
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** One job's private, staged files. Every path is absolute and owned by the
 * caller's job directory; the archive and overrides are immutable inputs whose
 * identities are checked before the engine reads them. */
typedef struct orcaxr_engine_request {
    /** An existing private directory holding nothing but the inputs. */
    const char* job_directory;
    /** The one-plate canonical BBS archive (what the external route uploads). */
    const char* archive;
    unsigned long long archive_bytes;
    /** 64 lowercase hexadecimal digits. */
    const char* archive_sha256;
    /** The plate's print overrides: a JSON object of engine wire strings. */
    const char* overrides;
    unsigned long long overrides_bytes;
    const char* overrides_sha256;
    /** The engine's resource directory (it holds info/). */
    const char* resources;
    /** Where the G-code is written; it must not exist yet. */
    const char* output;
} orcaxr_engine_request;

typedef struct orcaxr_repair_request {
    /** An existing private directory holding nothing but the inputs. */
    const char* job_directory;
    const char* input_stl;
    unsigned long long input_bytes;
    const char* input_sha256;
    const char* output_stl;
} orcaxr_repair_request;

typedef struct orcaxr_boolean_request {
    /** An existing private directory holding nothing but the inputs. */
    const char* job_directory;
    const char* input_a_stl;
    unsigned long long input_a_bytes;
    const char* input_a_sha256;
    const char* input_b_stl;
    unsigned long long input_b_bytes;
    const char* input_b_sha256;
    /** "UNION", "A_NOT_B", or "INTERSECTION". */
    const char* op;
    const char* output_stl;
} orcaxr_boolean_request;

enum {
    ORCAXR_ENGINE_COMPLETED = 0,
    ORCAXR_ENGINE_FAILED = 1,
    ORCAXR_ENGINE_CANCELLED = 2,
    /** Another job owns this process's engine. */
    ORCAXR_ENGINE_BUSY = 3,
    /** The result did not fit [capacity]; nothing was sliced. */
    ORCAXR_ENGINE_INVALID = -1,
};

/** The largest result document; callers give at least this much. */
#define ORCAXR_ENGINE_RESULT_BYTES 2048
/** The largest progress message, terminating NUL included. */
#define ORCAXR_ENGINE_MESSAGE_BYTES 128

/** Slices [request] on the calling thread and writes one ASCII JSON result
 * document (NUL-terminated) to [result]. Returns one of the codes above. */
int orcaxr_engine_slice(const orcaxr_engine_request* request, char* result, size_t capacity);

/** Repairs [request] on the calling thread and writes one ASCII JSON result
 * document (NUL-terminated) to [result]. Returns one of the codes above. */
int orcaxr_engine_repair(const orcaxr_repair_request* request, char* result, size_t capacity);

/** Performs boolean operation [request] on the calling thread and writes one ASCII JSON result
 * document (NUL-terminated) to [result]. Returns one of the codes above. */
int orcaxr_engine_boolean(const orcaxr_boolean_request* request, char* result, size_t capacity);

/** Requests a cooperative stop of the running job, from any thread. A request
 * made while no job runs is dropped when the next job starts. */
void orcaxr_engine_cancel(void);

/** The running job's latest progress: its percent (or -1 before the engine
 * reported one) and message (ASCII, bounded). Returns a sequence that grows
 * with every update; 0 while no job has reported. Thread-safe. */
unsigned long long orcaxr_engine_progress(int* percent, char* message, size_t capacity);

/** The adapter's identity: an ASCII JSON object naming the pinned engine and
 * adapter recipe this library was built from. Never freed. */
const char* orcaxr_engine_identity(void);

/** SHA-256 (64 lowercase hex digits and a NUL in [hex]) and length of a regular
 * file of at most [limit] bytes. Returns 0 on success. */
int orcaxr_engine_file_sha256(const char* path, unsigned long long limit, char hex[65], unsigned long long* bytes);

/** The engine's constructor regression (defaults_probe.cpp). Returns 0 when it holds. */
int orcaxr_engine_check_defaults(void);

#ifdef __cplusplus
}
#endif

