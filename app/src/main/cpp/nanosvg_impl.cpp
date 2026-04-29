// nanosvg_impl.cpp — provides the NanoSVG implementation symbols.
//
// libslic3r's NSVGUtils.cpp and Format/svg.cpp call into NanoSVG, but no
// translation unit inside libslic3r defines NANOSVG_IMPLEMENTATION — only
// the wx GUI layer (src/slic3r/GUI/BitmapCache.cpp) does. With our GUI
// excluded from the build, those symbols (nsvgParse, nsvgDelete, etc.)
// would be undefined at link time.
//
// Provide the implementation in our JNI shim so libslic3r's SVG calls
// resolve.

#define NANOSVG_IMPLEMENTATION
#define NANOSVGRAST_IMPLEMENTATION
#include <nanosvg.h>
#include <nanosvgrast.h>
