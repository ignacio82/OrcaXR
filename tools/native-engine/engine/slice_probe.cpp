// Internal canonical-fixture adapter. This is not an application slicing route,
// artifact publisher, printer client or a replacement editable project model.
#include <boost/log/core.hpp>
#include <nlohmann/json.hpp>
#include <cstdio>
#include <cstdint>
#include <filesystem>
#include <fcntl.h>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <unistd.h>
#include "defaults_probe.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/Preset.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/Utils.hpp"
#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/GCode/GCodeProcessor.hpp"

namespace {
namespace fs = std::filesystem;
enum class Stage { Inputs, Project, Configuration, Validation, Processing, Export };
Stage stage = Stage::Inputs;

void require(bool condition) {
    if (!condition) throw std::runtime_error("Invalid native slice fixture");
}

std::string read_config(const fs::path& path) {
    require(fs::is_regular_file(path));
    const auto size = fs::file_size(path);
    require(size <= 1024 * 1024);
    std::ifstream stream(path, std::ios::binary);
    require(bool(stream));
    std::string text(static_cast<size_t>(size), '\0');
    stream.read(text.data(), static_cast<std::streamsize>(text.size()));
    require(stream.gcount() == static_cast<std::streamsize>(text.size()));
    require(stream.peek() == std::char_traits<char>::eof());
    return text;
}

// Match the existing project's full-config construction: generic enum defaults
// need their definition map reattached before deserializing profile values.
void fix_enum_maps(Slic3r::DynamicPrintConfig& config) {
    const auto* definition = config.def();
    require(definition != nullptr);
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

struct SliceResult { size_t objects; std::uintmax_t bytes; };

SliceResult slice(const fs::path& project, const fs::path& overrides, const fs::path& resources,
           const fs::path& output) {
    require(fs::is_regular_file(project) && fs::file_size(project) <= 512ULL * 1024 * 1024);
    require(fs::is_directory(resources / "info"));
    require(fs::is_directory(output.parent_path()) && !fs::exists(output));
    Slic3r::set_resources_dir(resources.string());
    Slic3r::DynamicPrintConfig loaded;
    Slic3r::ConfigSubstitutionContext substitutions(Slic3r::ForwardCompatibilitySubstitutionRule::Enable);
    ImportedMetadata imported;
    Slic3r::Semver version;
    Slic3r::Model model;
    // Even without LoadAuxiliary, the BBS loader stages embedded configuration
    // in Model's backup directory. Android has no writable desktop /tmp; bind
    // that staging area to this owned job before importing any project bytes.
    const auto scratch = output.parent_path() / "import";
    require(fs::create_directory(scratch));
    require(fs::create_directories(scratch / "3D/Objects"));
    require(fs::create_directory(scratch / "Metadata"));
    model.set_backup_path(scratch.string());
    bool is_bbs = false;
    const auto strategy = Slic3r::LoadStrategy::LoadModel | Slic3r::LoadStrategy::LoadConfig |
                          Slic3r::LoadStrategy::AddDefaultInstances;
    // Consume the captured BBS projection through the same entry point as the
    // published project route. Broader format detection belongs to host import.
    stage = Stage::Project;
    const auto input = project.string();
    const bool loaded_ok = Slic3r::load_bbs_3mf(input.c_str(), &loaded, &substitutions, &model,
        &imported.plates, &imported.presets, &is_bbs, &version, nullptr, strategy, nullptr, 0);
    // Fixtures are captured active-plate projects. Never silently merge several
    // plates or construct replacement profiles from a viewport/STL projection.
    require(loaded_ok && !model.objects.empty() && imported.plates.size() <= 1 && !loaded.keys().empty());
    stage = Stage::Configuration;
    auto config = Slic3r::DynamicPrintConfig::full_print_config();
    fix_enum_maps(config);
    config.apply(loaded, true);
    const auto values = nlohmann::json::parse(read_config(overrides));
    require(values.is_object() && values.size() <= 4096);
    for (auto it = values.begin(); it != values.end(); ++it) {
        require(it.value().is_string());
        require(config.set_deserialize_nothrow(it.key(), it.value().get<std::string>(), substitutions));
    }
    // A fixture cannot authorize executing host post-processing commands.
    if (const auto* commands = config.option<Slic3r::ConfigOptionStrings>("post_process")) {
        for (const auto& command : commands->values) require(command.empty());
    }
    config.normalize_fdm();
    Slic3r::Print print;
    print.apply(model, config);
    stage = Stage::Validation;
    Slic3r::StringObjectException warning{};
    const auto validation = print.validate(&warning);
    if (!validation.string.empty()) {
        // Report only a known schema key and numeric classification, never the
        // engine message (which can include project names or other private text).
        const auto key = validation.opt_key.size() <= 96 && config.def()->get(validation.opt_key)
            ? validation.opt_key : std::string();
        const auto diagnostic = nlohmann::json{{"validationType", static_cast<int>(validation.type)},
            {"option", key}, {"messageBytes", validation.string.size()}}.dump();
        std::fprintf(stderr, "%s\n", diagnostic.c_str());
        require(false);
    }
    // Numeric progress only; model names, configuration and engine errors stay
    // out of the probe's public protocol. No engine thread cap is imposed.
    print.set_status_callback([](const Slic3r::PrintBase::SlicingStatus& status) {
        std::fprintf(stderr, "{\"progress\":%d}\n", status.percent);
    });
    stage = Stage::Processing;
    print.process();
    Slic3r::GCodeProcessorResult result;
    stage = Stage::Export;
    print.export_gcode(output.string(), &result, nullptr);
    require(fs::is_regular_file(output) && fs::file_size(output) > 0);
    return {model.objects.size(), fs::file_size(output)};
}
}

int main(int argc, char** argv) {
    const bool defaults = argc == 3 && std::string(argv[1]) == "--check-defaults";
    if (argc != 6 && !defaults) {
        std::fputs("Expected --check-defaults result.json or project.3mf overrides.json resources output.gcode result.json\n", stderr);
        return 2;
    }
    // Static engine initialization logs before main(), so even redirecting
    // stdout here cannot make it a protocol stream. An exclusive private file
    // carries the result; the host accepts it only after successful exit.
    const int descriptor = ::open(argv[argc - 1], O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (descriptor < 0) return 1;
    auto* stream = ::fdopen(descriptor, "w");
    if (!stream) { ::close(descriptor); return 1; }
    std::unique_ptr<FILE, decltype(&std::fclose)> protocol(stream, &std::fclose);
    if (::dup2(STDERR_FILENO, STDOUT_FILENO) < 0) return 1;
    boost::log::core::get()->set_logging_enabled(false);
    try {
        if (defaults) {
            check_engine_defaults();
            std::fputs("{\"schemaVersion\":1,\"defaultsChecked\":true,\"patterns\":[0,90,165,255]}\n", protocol.get());
        } else {
            const auto result = slice(argv[1], argv[2], argv[3], argv[4]);
            std::fprintf(protocol.get(), "{\"schemaVersion\":1,\"completed\":true,\"objects\":%zu,\"gcodeBytes\":%llu}\n",
                         result.objects, static_cast<unsigned long long>(result.bytes));
        }
        require(std::fflush(protocol.get()) == 0 && !std::ferror(protocol.get()));
        return 0;
    } catch (...) {
        // The harness keeps its entire job directory private until exit zero.
        // It owns cleanup, timeout and result hashing; no partial file is a result.
        std::fprintf(stderr, "{\"failed\":true,\"stage\":%d}\n", static_cast<int>(stage));
        return 1;
    }
}
