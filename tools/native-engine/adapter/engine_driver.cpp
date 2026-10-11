// Fixture driver for the application adapter: the slice probe's command line
// and private result-file protocol, but every slice goes through the same C
// entry point JNI calls (liborcaxr_engine.so), so emulator-slices.py can
// compare the application route's engine path with the browser references.
// It is a test executable; it never ships in an APK.
#include "engine_adapter.h"

#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <string>
#include <unistd.h>

namespace {
// The engine logs during static initialization, before main(); stdout is not
// a protocol channel. An exclusive private file carries the result instead.
FILE* open_result(const char* path) {
    const int descriptor = ::open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (descriptor < 0) return nullptr;
    FILE* stream = ::fdopen(descriptor, "w");
    if (!stream) ::close(descriptor);
    return stream;
}

bool finish(FILE* stream, const char* text) {
    const bool written = std::fputs(text, stream) >= 0 && std::fputc('\n', stream) != EOF && std::fflush(stream) == 0 &&
        !std::ferror(stream);
    return std::fclose(stream) == 0 && written;
}

std::string parent(const std::string& path) {
    const auto slash = path.rfind('/');
    return slash == std::string::npos || slash == 0 ? std::string() : path.substr(0, slash);
}
}  // namespace

int main(int argc, char** argv) {
    const bool defaults = argc == 3 && std::strcmp(argv[1], "--check-defaults") == 0;
    if (argc != 6 && !defaults) {
        std::fputs("Expected --check-defaults result.json or project.3mf overrides.json resources output.gcode result.json\n", stderr);
        return 2;
    }
    FILE* protocol = open_result(argv[argc - 1]);
    if (!protocol) return 1;
    if (::dup2(STDERR_FILENO, STDOUT_FILENO) < 0) {
        std::fclose(protocol);
        return 1;
    }
    if (defaults) {
        if (orcaxr_engine_check_defaults() != 0) {
            std::fclose(protocol);
            return 1;
        }
        return finish(protocol, R"({"schemaVersion":1,"defaultsChecked":true,"patterns":[0,90,165,255]})") ? 0 : 1;
    }
    char archive_sha[65], overrides_sha[65];
    unsigned long long archive_bytes = 0, overrides_bytes = 0;
    if (orcaxr_engine_file_sha256(argv[1], 1ULL << 30, archive_sha, &archive_bytes) != 0 ||
        orcaxr_engine_file_sha256(argv[2], 1ULL << 20, overrides_sha, &overrides_bytes) != 0) {
        std::fclose(protocol);
        return 1;
    }
    const std::string job = parent(argv[4]);
    orcaxr_engine_request request{};
    request.job_directory = job.c_str();
    request.archive = argv[1];
    request.archive_bytes = archive_bytes;
    request.archive_sha256 = archive_sha;
    request.overrides = argv[2];
    request.overrides_bytes = overrides_bytes;
    request.overrides_sha256 = overrides_sha;
    request.resources = argv[3];
    request.output = argv[4];
    char result[ORCAXR_ENGINE_RESULT_BYTES];
    const int code = orcaxr_engine_slice(&request, result, sizeof result);
    if (code == ORCAXR_ENGINE_INVALID) {
        std::fclose(protocol);
        return 1;
    }
    // The document is written for every outcome; only a completed one exits zero.
    const bool written = finish(protocol, result);
    return code == ORCAXR_ENGINE_COMPLETED && written ? 0 : 1;
}
