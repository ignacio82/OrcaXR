// The application's local slicing adapter over the pinned engine. One job per
// process at a time: the canonical one-plate BBS archive and its overrides are
// read exactly as the browser engine's project route reads them
// (wasm/slic3r_wasm.cpp slice_project_inner: load_bbs_3mf with LoadModel |
// LoadConfig | AddDefaultInstances, the full print configuration with its enum
// maps, the project configuration, the overrides, normalize_fdm, then apply,
// validate, process and export), so FullSpectrum mixed filaments, painting and
// every annotation channel reach the same engine behaviour. It returns typed
// outcomes and bounded diagnostics; the host owns publication.
#include "engine_adapter.h"
#include "defaults_probe.hpp"

#include <boost/log/core.hpp>
#include <nlohmann/json.hpp>
#include <openssl/evp.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <exception>
#include <fcntl.h>
#include <filesystem>
#include <memory>
#include <mutex>
#include <new>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/GCode/GCodeProcessor.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/Preset.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/Utils.hpp"

#ifndef ORCAXR_ENGINE_COMMIT
#error "The adapter build names the pinned engine commit"
#endif
#ifndef ORCAXR_ENGINE_RECIPE
#error "The adapter build names the engine recipe it links"
#endif
#ifndef ORCAXR_ADAPTER_RECIPE
#error "The adapter build names its own recipe"
#endif

namespace {
namespace fs = std::filesystem;

// The browser's own archive budget (ProjectWorkspace.ARCHIVE) and the
// overrides document a plate can carry; anything larger is refused unread.
constexpr unsigned long long MAX_ARCHIVE_BYTES = 1ULL << 30;
constexpr unsigned long long MAX_OVERRIDES_BYTES = 1ULL << 20;
constexpr size_t MAX_OVERRIDES = 4096;
constexpr unsigned long long MAX_GCODE_BYTES = 2ULL << 30;
// The browser's boundedMessage: 240 characters, line breaks as spaces.
constexpr size_t MAX_MESSAGE = 240;

enum class Stage { Inputs, Project, Configuration, Validation, Processing, Export, Output };

const char* stage_name(Stage stage) {
    switch (stage) {
    case Stage::Inputs: return "inputs";
    case Stage::Project: return "project";
    case Stage::Configuration: return "configuration";
    case Stage::Validation: return "validation";
    case Stage::Processing: return "processing";
    case Stage::Export: return "export";
    case Stage::Output: return "output";
    }
    return "output";
}

/** A refusal with its stable code and a bounded, host-safe message. */
struct Failure : std::runtime_error {
    Failure(std::string code, std::string message, std::string option = {})
        : std::runtime_error(code), code(std::move(code)), message(std::move(message)), option(std::move(option)) {}
    std::string code, message, option;
};

struct Cancelled {};

// ASCII printable, runs of control characters as one space, at most [limit]
// bytes; other bytes (non-ASCII text) become '?' so the document stays ASCII.
std::string bounded(const std::string& text, size_t limit) {
    std::string out;
    bool space = false;
    for (unsigned char c : text) {
        if (out.size() >= limit) break;
        if (c == '\r' || c == '\n' || c == '\t') {
            if (!space && !out.empty()) out.push_back(' ');
            space = true;
            continue;
        }
        space = false;
        out.push_back(c >= 0x20 && c < 0x7f ? static_cast<char>(c) : '?');
    }
    while (!out.empty() && out.back() == ' ') out.pop_back();
    return out;
}

struct ProgressState {
    std::mutex mutex;
    int percent = -1;
    std::string message;
    unsigned long long sequence = 0;
};
ProgressState progress;

void report(int percent, const std::string& message) {
    std::lock_guard<std::mutex> lock(progress.mutex);
    progress.percent = percent;
    progress.message = bounded(message, ORCAXR_ENGINE_MESSAGE_BYTES - 1);
    ++progress.sequence;
}

// One job per process. The print, while it exists, is reachable for cancel.
std::mutex job_mutex;
std::mutex print_mutex;
Slic3r::Print* running_print = nullptr;
std::atomic<bool> cancel_requested{false};

void check_cancel() {
    if (cancel_requested.load(std::memory_order_acquire)) throw Cancelled{};
}

bool hex_digest(const std::string& value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}

struct Descriptor {
    explicit Descriptor(int fd) : fd(fd) {}
    ~Descriptor() { if (fd >= 0) ::close(fd); }
    Descriptor(const Descriptor&) = delete;
    Descriptor& operator=(const Descriptor&) = delete;
    const int fd;
};

// Opens [path] as a regular file (never through a symlink) and hashes it.
int digest_file(const char* path, unsigned long long limit, char hex[65], unsigned long long* bytes) {
    const Descriptor file(::open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
    const int fd = file.fd;
    if (fd < 0) return 1;
    struct stat info {};
    if (::fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size < 0 ||
        static_cast<unsigned long long>(info.st_size) > limit) return 1;
    std::unique_ptr<EVP_MD_CTX, void (*)(EVP_MD_CTX*)> context(EVP_MD_CTX_new(), EVP_MD_CTX_free);
    if (!context || EVP_DigestInit_ex(context.get(), EVP_sha256(), nullptr) != 1) return 1;
    std::vector<unsigned char> buffer(1 << 16);
    unsigned long long total = 0;
    for (;;) {
        const ssize_t count = ::read(fd, buffer.data(), buffer.size());
        if (count < 0) {
            if (errno == EINTR) continue;
            return 1;
        }
        if (count == 0) break;
        total += static_cast<unsigned long long>(count);
        if (total > limit || EVP_DigestUpdate(context.get(), buffer.data(), static_cast<size_t>(count)) != 1) return 1;
    }
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int length = 0;
    if (EVP_DigestFinal_ex(context.get(), digest, &length) != 1 || length != 32) return 1;
    static const char* digits = "0123456789abcdef";
    for (unsigned int i = 0; i < 32; ++i) {
        hex[2 * i] = digits[digest[i] >> 4];
        hex[2 * i + 1] = digits[digest[i] & 15];
    }
    hex[64] = '\0';
    *bytes = total;
    return 0;
}

// The input the host staged, exactly: a regular file of the stated length and digest.
void verify_input(const char* path, unsigned long long expected_bytes, const char* expected_sha256,
                  unsigned long long limit, const char* what) {
    if (!path || !expected_sha256 || !hex_digest(expected_sha256) || expected_bytes > limit)
        throw Failure("invalid-input", std::string("The staged ") + what + " is not described correctly.");
    char hex[65];
    unsigned long long bytes = 0;
    if (digest_file(path, limit, hex, &bytes) != 0 || bytes != expected_bytes || std::strcmp(hex, expected_sha256) != 0)
        throw Failure("invalid-input", std::string("The staged ") + what + " does not match what was prepared.");
}

std::string read_small(const char* path, unsigned long long bytes) {
    const Descriptor file(::open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
    if (file.fd < 0) throw Failure("invalid-input", "The staged overrides cannot be read.");
    std::string text(static_cast<size_t>(bytes), '\0');
    size_t done = 0;
    while (done < text.size()) {
        const ssize_t count = ::read(file.fd, text.data() + done, text.size() - done);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        done += static_cast<size_t>(count);
    }
    char extra;
    const bool at_end = ::read(file.fd, &extra, 1) == 0;
    if (done != text.size() || !at_end) throw Failure("invalid-input", "The staged overrides changed while being read.");
    return text;
}

// Match the project route's full-config construction: generic enum defaults
// need their definition map reattached before deserializing profile values.
void fix_enum_maps(Slic3r::DynamicPrintConfig& config) {
    const auto* definition = config.def();
    if (definition == nullptr) throw Failure("configuration", "The engine has no print configuration definition.");
    for (const auto& entry : definition->options) {
        const auto& value = entry.second;
        if (value.type != Slic3r::coEnums || value.enum_keys_map == nullptr) continue;
        auto* option = config.option(entry.first, false);
        if (auto* item = dynamic_cast<Slic3r::ConfigOptionEnumsGeneric*>(option)) {
            if (!item->keys_map) item->keys_map = value.enum_keys_map;
        } else if (auto* item = dynamic_cast<Slic3r::ConfigOptionEnumsGenericNullable*>(option)) {
            if (!item->keys_map) item->keys_map = value.enum_keys_map;
        }
    }
}

struct ImportedMetadata {
    Slic3r::PlateDataPtrs plates;
    std::vector<Slic3r::Preset*> presets;
    ~ImportedMetadata() {
        for (auto* plate : plates) delete plate;
        for (auto* preset : presets) delete preset;
    }
};

/** Registers the job's print for cancel while it exists. */
struct RunningPrint {
    explicit RunningPrint(Slic3r::Print& print) {
        std::lock_guard<std::mutex> lock(print_mutex);
        running_print = &print;
        if (cancel_requested.load(std::memory_order_acquire)) print.cancel();
    }
    ~RunningPrint() {
        std::lock_guard<std::mutex> lock(print_mutex);
        running_print = nullptr;
    }
};

struct Completed {
    size_t objects;
    unsigned long long bytes;
    std::string sha256;
    size_t rejected;
};

Completed slice(const orcaxr_engine_request& request, Stage& stage) {
    stage = Stage::Inputs;
    if (!request.job_directory || !request.archive || !request.overrides || !request.resources || !request.output)
        throw Failure("invalid-input", "The slice request is incomplete.");
    const fs::path job(request.job_directory);
    const fs::path output(request.output);
    std::error_code error;
    if (!job.is_absolute() || !output.is_absolute() || fs::is_symlink(job, error) || !fs::is_directory(job, error) ||
        output.parent_path() != job || fs::exists(fs::symlink_status(output, error)))
        throw Failure("invalid-input", "The slice job directory is not usable.");
    if (!fs::is_directory(fs::path(request.resources) / "info", error))
        throw Failure("invalid-input", "The engine's resources are missing.");
    verify_input(request.archive, request.archive_bytes, request.archive_sha256, MAX_ARCHIVE_BYTES, "plate archive");
    verify_input(request.overrides, request.overrides_bytes, request.overrides_sha256, MAX_OVERRIDES_BYTES, "overrides");
    const auto overrides_text = read_small(request.overrides, request.overrides_bytes);
    check_cancel();

    report(0, "Loading the plate");
    Slic3r::set_resources_dir(request.resources);
    Slic3r::DynamicPrintConfig loaded;
    Slic3r::ConfigSubstitutionContext substitutions(Slic3r::ForwardCompatibilitySubstitutionRule::Enable);
    ImportedMetadata imported;
    Slic3r::Semver version;
    Slic3r::Model model;
    // Even without LoadAuxiliary, the BBS loader stages embedded configuration
    // in Model's backup directory. Android has no writable desktop /tmp; bind
    // that staging area to this owned job before importing any project bytes.
    const auto scratch = job / "import";
    if (!fs::create_directory(scratch, error) || !fs::create_directories(scratch / "3D/Objects", error) ||
        !fs::create_directory(scratch / "Metadata", error))
        throw Failure("invalid-input", "The slice job directory is not usable.");
    model.set_backup_path(scratch.string());
    bool is_bbs = false;
    const auto strategy = Slic3r::LoadStrategy::LoadModel | Slic3r::LoadStrategy::LoadConfig |
                          Slic3r::LoadStrategy::AddDefaultInstances;
    stage = Stage::Project;
    // The loader asks whether to stop between its steps; a cancel stops it there.
    Slic3r::Import3mfProgressFn loading = [](int, int, int, bool& cancel) {
        if (cancel_requested.load(std::memory_order_acquire)) cancel = true;
    };
    const bool loaded_ok = Slic3r::load_bbs_3mf(request.archive, &loaded, &substitutions, &model, &imported.plates,
        &imported.presets, &is_bbs, &version, loading, strategy, nullptr, 0);
    check_cancel();
    // The canonical capture is one plate, with its configuration. Never merge
    // plates or substitute generic settings for a configuration that did not load.
    if (!loaded_ok || model.objects.empty() || imported.plates.size() > 1 || loaded.keys().empty())
        throw Failure("project-load", "The engine could not load the plate archive.");

    stage = Stage::Configuration;
    auto config = Slic3r::DynamicPrintConfig::full_print_config();
    fix_enum_maps(config);
    config.apply(loaded, true);
    nlohmann::json values;
    try {
        values = nlohmann::json::parse(overrides_text);
    } catch (const std::exception&) {
        throw Failure("configuration", "The plate's overrides are not a JSON object.");
    }
    if (!values.is_object() || values.size() > MAX_OVERRIDES)
        throw Failure("configuration", "The plate's overrides are not a JSON object.");
    // As the browser engine applies them: a value the engine refuses is
    // skipped and counted, never fatal (wasm/slic3r_wasm.cpp apply_overrides_json).
    size_t rejected = 0;
    for (auto it = values.begin(); it != values.end(); ++it) {
        if (!it.value().is_string()) throw Failure("configuration", "A plate override is not engine text.");
        if (!config.set_deserialize_nothrow(it.key(), it.value().get<std::string>(), substitutions)) ++rejected;
    }
    // The command-line route normalizes before Print::apply.
    config.normalize_fdm();
    check_cancel();

    Slic3r::Print print;
    RunningPrint registered(print);
    print.apply(model, config);
    stage = Stage::Validation;
    Slic3r::StringObjectException warning{};
    const auto validation = print.validate(&warning);
    if (!validation.string.empty()) {
        // A known schema key and the engine's own words, bounded, for the operator.
        const auto key = validation.opt_key.size() <= 96 && config.def()->get(validation.opt_key)
            ? validation.opt_key : std::string();
        throw Failure("validation", bounded(validation.string, MAX_MESSAGE), key);
    }
    // Numeric progress and the engine's step names; warnings (percent -1) are not progress.
    print.set_status_callback([](const Slic3r::PrintBase::SlicingStatus& status) {
        if (status.percent < 0 || status.percent > 100) return;
        if (status.flags & (Slic3r::PrintBase::SlicingStatus::UPDATE_PRINT_STEP_WARNINGS |
                            Slic3r::PrintBase::SlicingStatus::UPDATE_PRINT_OBJECT_STEP_WARNINGS)) return;
        report(status.percent, status.text);
    });
    stage = Stage::Processing;
    print.process();
    Slic3r::GCodeProcessorResult result;
    stage = Stage::Export;
    print.export_gcode(output.string(), &result, nullptr);
    check_cancel();

    // The file is closed and renamed by the exporter. Read back what it holds.
    stage = Stage::Output;
    char hex[65];
    unsigned long long bytes = 0;
    if (digest_file(output.c_str(), MAX_GCODE_BYTES, hex, &bytes) != 0 || bytes == 0)
        throw Failure("output", "The engine wrote no G-code.");
    report(100, "Done");
    return {model.objects.size(), bytes, hex, rejected};
}

bool write_result(const nlohmann::json& document, char* result, size_t capacity) {
    // ensure_ascii: the host reads one ASCII document; nothing here is raw engine text.
    const auto text = document.dump(-1, ' ', true, nlohmann::json::error_handler_t::replace);
    if (text.size() + 1 > capacity) return false;
    std::memcpy(result, text.c_str(), text.size() + 1);
    return true;
}

nlohmann::json failure(Stage stage, const std::string& code, const std::string& message, const std::string& option = {}) {
    auto words = bounded(message, MAX_MESSAGE);
    if (words.empty()) words = "The slicing engine failed.";
    nlohmann::json document{{"schemaVersion", 1}, {"outcome", "failed"}, {"stage", stage_name(stage)},
        {"code", code}, {"message", words}};
    if (!option.empty()) document["option"] = option;
    return document;
}

const std::string identity_document = nlohmann::json{
    {"schemaVersion", 1},
    {"engineCommit", ORCAXR_ENGINE_COMMIT},
    {"engineRecipe", ORCAXR_ENGINE_RECIPE},
    {"adapterRecipe", ORCAXR_ADAPTER_RECIPE},
}.dump();
}  // namespace

extern "C" int orcaxr_engine_slice(const orcaxr_engine_request* request, char* result, size_t capacity) {
    if (!request || !result || capacity < ORCAXR_ENGINE_RESULT_BYTES) return ORCAXR_ENGINE_INVALID;
    std::unique_lock<std::mutex> owner(job_mutex, std::try_to_lock);
    if (!owner.owns_lock()) {
        write_result(nlohmann::json{{"schemaVersion", 1}, {"outcome", "busy"}}, result, capacity);
        return ORCAXR_ENGINE_BUSY;
    }
    // A cancel meant for an earlier job never stops this one.
    cancel_requested.store(false, std::memory_order_release);
    {
        std::lock_guard<std::mutex> lock(progress.mutex);
        progress.percent = -1;
        progress.message.clear();
        progress.sequence = 0;
    }
    // Engine logs may name projects and paths; they are not a host channel.
    boost::log::core::get()->set_logging_enabled(false);
    Stage stage = Stage::Inputs;
    nlohmann::json document;
    int code = ORCAXR_ENGINE_FAILED;
    try {
        const auto done = slice(*request, stage);
        document = {{"schemaVersion", 1}, {"outcome", "completed"}, {"stage", stage_name(stage)},
            {"objects", done.objects}, {"gcodeBytes", done.bytes}, {"gcodeSha256", done.sha256},
            {"rejectedOverrides", done.rejected}};
        code = ORCAXR_ENGINE_COMPLETED;
    } catch (const Cancelled&) {
        document = {{"schemaVersion", 1}, {"outcome", "cancelled"}, {"stage", stage_name(stage)}};
        code = ORCAXR_ENGINE_CANCELLED;
    } catch (const Slic3r::CanceledException&) {
        document = {{"schemaVersion", 1}, {"outcome", "cancelled"}, {"stage", stage_name(stage)}};
        code = ORCAXR_ENGINE_CANCELLED;
    } catch (const Failure& refused) {
        document = failure(stage, refused.code, refused.message, refused.option);
    } catch (const std::bad_alloc&) {
        document = failure(stage, "memory", "The slicing engine ran out of memory.");
    } catch (const std::exception& thrown) {
        // The browser shows the engine's own words, bounded; so does this route.
        document = failure(stage, "engine", thrown.what());
    } catch (...) {
        document = failure(stage, "engine", "The slicing engine failed.");
    }
    // A cancel that raced completion: the job's work is done but it was not wanted.
    if (code == ORCAXR_ENGINE_COMPLETED && cancel_requested.load(std::memory_order_acquire)) {
        document = {{"schemaVersion", 1}, {"outcome", "cancelled"}, {"stage", stage_name(stage)}};
        code = ORCAXR_ENGINE_CANCELLED;
    }
    if (!write_result(document, result, capacity)) return ORCAXR_ENGINE_INVALID;
    return code;
}

extern "C" void orcaxr_engine_cancel(void) {
    cancel_requested.store(true, std::memory_order_release);
    std::lock_guard<std::mutex> lock(print_mutex);
    if (running_print != nullptr) running_print->cancel();
}

extern "C" unsigned long long orcaxr_engine_progress(int* percent, char* message, size_t capacity) {
    std::lock_guard<std::mutex> lock(progress.mutex);
    if (percent) *percent = progress.percent;
    if (message && capacity > 0) {
        const size_t count = std::min(capacity - 1, progress.message.size());
        std::memcpy(message, progress.message.data(), count);
        message[count] = '\0';
    }
    return progress.sequence;
}

extern "C" const char* orcaxr_engine_identity(void) {
    return identity_document.c_str();
}

extern "C" int orcaxr_engine_file_sha256(const char* path, unsigned long long limit, char hex[65], unsigned long long* bytes) {
    if (!path || !hex || !bytes) return 1;
    return digest_file(path, limit, hex, bytes);
}

extern "C" int orcaxr_engine_check_defaults(void) {
    try {
        check_engine_defaults();
        return 0;
    } catch (...) {
        return 1;
    }
}
