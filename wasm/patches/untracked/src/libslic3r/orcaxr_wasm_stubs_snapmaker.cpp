// OrcaXR WASM stubs — replaces the OCCT-backed importers (STEP/TextShape/
// svg) in the WebAssembly build, where OCCT is not cross-compiled
// (the Snapmaker fork has no draco/DRC importer) (v1 scope: STL/3MF/OBJ slicing).
// Every entry point reports "unsupported" instead of crashing so the
// callers' existing failure paths handle it gracefully.
//
// Compiled ONLY when EMSCRIPTEN (see CMakeLists gate); the native builds
// keep the real implementations.

// NOTE: Format/STEP.hpp is NOT included/stubbed — it #includes OCCT
// headers directly, and its only libslic3r consumer is STEP.cpp itself
// (the GUI layer, absent from this build, is the real caller).

#include "GCode/PostProcessor.hpp"
#include "Format/svg.hpp"
#include "Shape/TextShape.hpp"
#include "TriangleMesh.hpp"

#include <map>
#include <string>
#include <vector>

namespace Slic3r {

class Model;
class ModelObject;

bool load_svg(const char * /*path*/, Model * /*model*/, std::string &message)
{
    message = "SVG import is not available in the OrcaXR web build yet.";
    return false;
}

std::vector<std::string> init_occt_fonts() { return {}; }

void load_text_shape(const char * /*text*/, const char * /*font*/,
                     const float /*text_height*/, const float /*thickness*/,
                     bool /*is_bold*/, bool /*is_italic*/, TextResult & /*text_result*/)
{
}

std::map<std::string, std::string> get_occt_fonts_maps() { return {}; }

// GCode/PostProcessor.cpp is excluded (boost::process spawns external
// scripts — impossible in a browser sandbox). No script ever runs.
bool run_post_process_scripts(std::string & /*src_path*/, bool /*make_copy*/,
                              const std::string & /*host*/, std::string & /*output_name*/,
                              const DynamicPrintConfig & /*config*/)
{
    return false;
}

} // namespace Slic3r
