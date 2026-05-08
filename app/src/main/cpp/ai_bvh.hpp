// AI paint pillar — Milestone 8b. Native re-implementation of
// AiMaskProjection.project() (Kotlin) for paint_projected_mask.
//
// Self-contained: depends only on <cstdint> and <vector>. NOT linked
// against libslic3r. The data shape exactly mirrors the Kotlin
// MeshBvh internals (so a JNI binding can hand the same primitive
// arrays through with zero translation):
//
//   mesh.positions       float[9 * triCount]    (vert0, vert1, vert2 per tri)
//   triIdx               int[triCount]          (BVH leaf order → mesh tri index)
//   nodeAabb             float[6 * nodeCount]   (minX,Y,Z, maxX,Y,Z per node)
//   nodeLeft / nodeRight int[nodeCount]         (-1 == leaf)
//   nodeLeafStart/End    int[nodeCount]         (range into triIdx for leaves)
//
// Kotlin parity is the load-bearing claim — every traversal,
// rejection rule, and ordering convention here matches
// MeshBvh.intersect / intersectAll and AiMaskProjection.project.
//
// Returns a sorted, deduplicated list of triangle indices. Keep this
// signature stable; it's consumed via JNI by NativeBvh.kt.
#pragma once

#include <cstdint>
#include <vector>

namespace orcaxr::ai_bvh {

// Matches AiMaskProjection.DepthMode (sealed interface in Kotlin).
enum DepthMode : int32_t {
    kFrontFacingOnly = 0,
    kAllHits         = 1,
    kAnyFacing       = 2,
    kFrontPlusThin   = 3,
};

struct BvhView {
    const float* positions;     // 9 * triCount
    int32_t      triCount;
    const int32_t* triIdx;      // triCount
    const float*   nodeAabb;    // 6 * nodeCount
    const int32_t* nodeLeft;    // nodeCount
    const int32_t* nodeRight;   // nodeCount
    const int32_t* nodeLeafStart; // nodeCount
    const int32_t* nodeLeafEnd; // nodeCount
};

struct CameraView {
    // Row-major 4x4. Mesh-local → camera (view), camera → clip (proj).
    float view[16];
    float proj[16];
    int32_t widthPx;
    int32_t heightPx;
};

// For each "on" pixel in `mask` (row-major top-to-bottom, length =
// widthPx * heightPx; non-zero == on), unproject through the camera
// and intersect against the BVH. Triangles matched per the depth
// mode rules end up in `out`, sorted ascending and deduplicated.
//
// `thicknessMm` is only consulted when depthMode == kFrontPlusThin.
//
// Returns 0 on success, -1 on bad input (singular MVP, dim mismatch,
// negative thickness for front-plus-thin), -2 on internal allocation
// failure.
int project_mask(
    const BvhView& bvh,
    const CameraView& camera,
    const uint8_t* mask,
    int32_t maskLen,
    DepthMode depthMode,
    float thicknessMm,
    bool backFaceFilter,
    std::vector<int32_t>& out
);

} // namespace orcaxr::ai_bvh
