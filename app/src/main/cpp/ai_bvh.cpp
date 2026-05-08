// AI paint pillar — M8b native mask-projection.
//
// This is the C++ equivalent of AiMaskProjection.project() +
// MeshBvh.intersect / intersectAll, ported line-for-line to keep
// parity with the Kotlin path the unit tests pin down. SIMD-free
// for now — tightening to NEON is a follow-up after profiling
// confirms the binding case.
//
// Coordinate frame: mesh-local mm (centered_preview), the same
// frame the BVH was built in. Per-pixel ray construction matches
// AiMaskProjection.castRay exactly: NDC offset by 0.5 px,
// y-axis flipped, far-plane unprojection, ray = far - origin.

#include "ai_bvh.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <unordered_set>

namespace orcaxr::ai_bvh {

namespace {

constexpr float kEps    = 1e-6f;
constexpr float kInf    = std::numeric_limits<float>::infinity();
constexpr float kEpsW   = 1e-7f;
constexpr float kEpsDet = 1e-10f;

struct Vec3 { float x, y, z; };

// Row-major 4x4 multiply: out = a * b.
void mat_mul(const float* a, const float* b, float out[16]) {
    for (int i = 0; i < 4; ++i) {
        for (int j = 0; j < 4; ++j) {
            float s = 0.f;
            for (int k = 0; k < 4; ++k) s += a[i * 4 + k] * b[k * 4 + j];
            out[i * 4 + j] = s;
        }
    }
}

// Row-major 4x4 inverse via cofactor expansion. Mirrors
// AiMaskProjection.invert4x4. Returns false on singular matrix.
bool invert4x4(const float* m, float out[16]) {
    const float* a = m;
    float inv[16];
    inv[0]  =  a[5]*a[10]*a[15] - a[5]*a[11]*a[14] - a[9]*a[6]*a[15]
             + a[9]*a[7]*a[14] + a[13]*a[6]*a[11] - a[13]*a[7]*a[10];
    inv[4]  = -a[4]*a[10]*a[15] + a[4]*a[11]*a[14] + a[8]*a[6]*a[15]
             - a[8]*a[7]*a[14] - a[12]*a[6]*a[11] + a[12]*a[7]*a[10];
    inv[8]  =  a[4]*a[9]*a[15]  - a[4]*a[11]*a[13] - a[8]*a[5]*a[15]
             + a[8]*a[7]*a[13] + a[12]*a[5]*a[11] - a[12]*a[7]*a[9];
    inv[12] = -a[4]*a[9]*a[14]  + a[4]*a[10]*a[13] + a[8]*a[5]*a[14]
             - a[8]*a[6]*a[13] - a[12]*a[5]*a[10] + a[12]*a[6]*a[9];
    inv[1]  = -a[1]*a[10]*a[15] + a[1]*a[11]*a[14] + a[9]*a[2]*a[15]
             - a[9]*a[3]*a[14] - a[13]*a[2]*a[11] + a[13]*a[3]*a[10];
    inv[5]  =  a[0]*a[10]*a[15] - a[0]*a[11]*a[14] - a[8]*a[2]*a[15]
             + a[8]*a[3]*a[14] + a[12]*a[2]*a[11] - a[12]*a[3]*a[10];
    inv[9]  = -a[0]*a[9]*a[15]  + a[0]*a[11]*a[13] + a[8]*a[1]*a[15]
             - a[8]*a[3]*a[13] - a[12]*a[1]*a[11] + a[12]*a[3]*a[9];
    inv[13] =  a[0]*a[9]*a[14]  - a[0]*a[10]*a[13] - a[8]*a[1]*a[14]
             + a[8]*a[2]*a[13] + a[12]*a[1]*a[10] - a[12]*a[2]*a[9];
    inv[2]  =  a[1]*a[6]*a[15]  - a[1]*a[7]*a[14]  - a[5]*a[2]*a[15]
             + a[5]*a[3]*a[14] + a[13]*a[2]*a[7]  - a[13]*a[3]*a[6];
    inv[6]  = -a[0]*a[6]*a[15]  + a[0]*a[7]*a[14]  + a[4]*a[2]*a[15]
             - a[4]*a[3]*a[14] - a[12]*a[2]*a[7]  + a[12]*a[3]*a[6];
    inv[10] =  a[0]*a[5]*a[15]  - a[0]*a[7]*a[13]  - a[4]*a[1]*a[15]
             + a[4]*a[3]*a[13] + a[12]*a[1]*a[7]  - a[12]*a[3]*a[5];
    inv[14] = -a[0]*a[5]*a[14]  + a[0]*a[6]*a[13]  + a[4]*a[1]*a[14]
             - a[4]*a[2]*a[13] - a[12]*a[1]*a[6]  + a[12]*a[2]*a[5];
    inv[3]  = -a[1]*a[6]*a[11]  + a[1]*a[7]*a[10]  + a[5]*a[2]*a[11]
             - a[5]*a[3]*a[10] - a[9]*a[2]*a[7]   + a[9]*a[3]*a[6];
    inv[7]  =  a[0]*a[6]*a[11]  - a[0]*a[7]*a[10]  - a[4]*a[2]*a[11]
             + a[4]*a[3]*a[10] + a[8]*a[2]*a[7]   - a[8]*a[3]*a[6];
    inv[11] = -a[0]*a[5]*a[11]  + a[0]*a[7]*a[9]   + a[4]*a[1]*a[11]
             - a[4]*a[3]*a[9]  - a[8]*a[1]*a[7]   + a[8]*a[3]*a[5];
    inv[15] =  a[0]*a[5]*a[10]  - a[0]*a[6]*a[9]   - a[4]*a[1]*a[10]
             + a[4]*a[2]*a[9]  + a[8]*a[1]*a[6]   - a[8]*a[2]*a[5];
    float det = a[0]*inv[0] + a[1]*inv[4] + a[2]*inv[8] + a[3]*inv[12];
    if (std::fabs(det) < kEpsDet) return false;
    float invDet = 1.f / det;
    for (int i = 0; i < 16; ++i) out[i] = inv[i] * invDet;
    return true;
}

// (ndcX, ndcY, ndcZ) → world via inverse MVP (with w-divide).
// Matches AiMaskProjection.unprojectNdc.
bool unproject_ndc(const float invMVP[16],
                   float ndcX, float ndcY, float ndcZ,
                   Vec3& out) {
    float x = invMVP[0]*ndcX + invMVP[1]*ndcY + invMVP[2]*ndcZ  + invMVP[3];
    float y = invMVP[4]*ndcX + invMVP[5]*ndcY + invMVP[6]*ndcZ  + invMVP[7];
    float z = invMVP[8]*ndcX + invMVP[9]*ndcY + invMVP[10]*ndcZ + invMVP[11];
    float w = invMVP[12]*ndcX + invMVP[13]*ndcY + invMVP[14]*ndcZ + invMVP[15];
    if (std::fabs(w) < kEpsW) return false;
    out.x = x / w; out.y = y / w; out.z = z / w;
    return true;
}

// Ray-vs-AABB slab test. Identical to MeshBvh.aabbHit semantics:
// hits when tmax >= max(tmin, 0) AND tmin <= tMaxBound. Sentinel
// inf for invD on zero direction matches the Kotlin behavior where
// 0 * inf becomes NaN and falls through the comparisons.
bool aabb_hit(const float* nodeAabb, int32_t node,
              float ox, float oy, float oz,
              float invDx, float invDy, float invDz,
              float tMaxBound) {
    int b = node * 6;
    float minX = nodeAabb[b];     float minY = nodeAabb[b + 1]; float minZ = nodeAabb[b + 2];
    float maxX = nodeAabb[b + 3]; float maxY = nodeAabb[b + 4]; float maxZ = nodeAabb[b + 5];
    float tx1 = (minX - ox) * invDx, tx2 = (maxX - ox) * invDx;
    float ty1 = (minY - oy) * invDy, ty2 = (maxY - oy) * invDy;
    float tz1 = (minZ - oz) * invDz, tz2 = (maxZ - oz) * invDz;
    float tmin = std::fmax(std::fmax(std::fmin(tx1, tx2), std::fmin(ty1, ty2)), std::fmin(tz1, tz2));
    float tmax = std::fmin(std::fmin(std::fmax(tx1, tx2), std::fmax(ty1, ty2)), std::fmax(tz1, tz2));
    return tmax >= std::fmax(tmin, 0.f) && tmin <= tMaxBound;
}

// Möller-Trumbore. Returns t (positive) or +inf for miss /
// behind-origin / parallel. Two-sided: matches MeshBvh.triHit.
float tri_hit(const float* positions, int32_t triIdx,
              float ox, float oy, float oz,
              float dx, float dy, float dz) {
    int b = triIdx * 9;
    float v0x = positions[b];     float v0y = positions[b + 1]; float v0z = positions[b + 2];
    float v1x = positions[b + 3]; float v1y = positions[b + 4]; float v1z = positions[b + 5];
    float v2x = positions[b + 6]; float v2y = positions[b + 7]; float v2z = positions[b + 8];
    float e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
    float e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
    float pvx = dy * e2z - dz * e2y;
    float pvy = dz * e2x - dx * e2z;
    float pvz = dx * e2y - dy * e2x;
    float det = e1x * pvx + e1y * pvy + e1z * pvz;
    if (det > -kEps && det < kEps) return kInf;
    float invDet = 1.f / det;
    float tvx = ox - v0x, tvy = oy - v0y, tvz = oz - v0z;
    float u = (tvx * pvx + tvy * pvy + tvz * pvz) * invDet;
    if (u < 0.f || u > 1.f) return kInf;
    float qvx = tvy * e1z - tvz * e1y;
    float qvy = tvz * e1x - tvx * e1z;
    float qvz = tvx * e1y - tvy * e1x;
    float v = (dx * qvx + dy * qvy + dz * qvz) * invDet;
    if (v < 0.f || u + v > 1.f) return kInf;
    float t = (e2x * qvx + e2y * qvy + e2z * qvz) * invDet;
    return (t > 0.f) ? t : kInf;
}

// Outward unit normal of a triangle. Returns zero on degenerate.
// Matches MeshBvh.triangleNormal.
Vec3 tri_normal(const float* positions, int32_t triIdx) {
    int b = triIdx * 9;
    float v0x = positions[b];     float v0y = positions[b + 1]; float v0z = positions[b + 2];
    float v1x = positions[b + 3]; float v1y = positions[b + 4]; float v1z = positions[b + 5];
    float v2x = positions[b + 6]; float v2y = positions[b + 7]; float v2z = positions[b + 8];
    float e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
    float e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
    float nx = e1y * e2z - e1z * e2y;
    float ny = e1z * e2x - e1x * e2z;
    float nz = e1x * e2y - e1y * e2x;
    float len = std::sqrt(nx * nx + ny * ny + nz * nz);
    if (len < kEps) return {0.f, 0.f, 0.f};
    return {nx / len, ny / len, nz / len};
}

Vec3 tri_centroid(const float* positions, int32_t triIdx) {
    int b = triIdx * 9;
    float cx = (positions[b]     + positions[b + 3] + positions[b + 6]) / 3.f;
    float cy = (positions[b + 1] + positions[b + 4] + positions[b + 7]) / 3.f;
    float cz = (positions[b + 2] + positions[b + 5] + positions[b + 8]) / 3.f;
    return {cx, cy, cz};
}

// All ray hits along the ray. Matches MeshBvh.intersectAll. Caller's
// `tris` and `ts` get populated in encounter order; pair-sort is the
// caller's responsibility (only needed for FrontPlusThin).
void intersect_all(const BvhView& bvh,
                   float ox, float oy, float oz,
                   float dx, float dy, float dz,
                   std::vector<int32_t>& tris,
                   std::vector<float>& ts) {
    if (bvh.triCount == 0) return;
    float invDx = (dx != 0.f) ? 1.f / dx : kInf;
    float invDy = (dy != 0.f) ? 1.f / dy : kInf;
    float invDz = (dz != 0.f) ? 1.f / dz : kInf;
    int32_t stack[64];
    int sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
        int32_t node = stack[--sp];
        if (!aabb_hit(bvh.nodeAabb, node, ox, oy, oz, invDx, invDy, invDz, kInf)) continue;
        int32_t left = bvh.nodeLeft[node];
        if (left < 0) {
            int32_t s = bvh.nodeLeafStart[node];
            int32_t e = bvh.nodeLeafEnd[node];
            for (int32_t j = s; j < e; ++j) {
                int32_t ti = bvh.triIdx[j];
                float t = tri_hit(bvh.positions, ti, ox, oy, oz, dx, dy, dz);
                if (std::isfinite(t) && t > 0.f) {
                    tris.push_back(ti);
                    ts.push_back(t);
                }
            }
        } else {
            stack[sp++] = left;
            stack[sp++] = bvh.nodeRight[node];
        }
    }
}

// Front-most ray hit (min t). Matches MeshBvh.intersect. Returns -1
// on miss.
int32_t intersect_front(const BvhView& bvh,
                        float ox, float oy, float oz,
                        float dx, float dy, float dz) {
    if (bvh.triCount == 0) return -1;
    float invDx = (dx != 0.f) ? 1.f / dx : kInf;
    float invDy = (dy != 0.f) ? 1.f / dy : kInf;
    float invDz = (dz != 0.f) ? 1.f / dz : kInf;
    int32_t stack[64];
    int sp = 0;
    stack[sp++] = 0;
    float bestT = kInf;
    int32_t bestTri = -1;
    while (sp > 0) {
        int32_t node = stack[--sp];
        if (!aabb_hit(bvh.nodeAabb, node, ox, oy, oz, invDx, invDy, invDz, bestT)) continue;
        int32_t left = bvh.nodeLeft[node];
        if (left < 0) {
            int32_t s = bvh.nodeLeafStart[node];
            int32_t e = bvh.nodeLeafEnd[node];
            for (int32_t j = s; j < e; ++j) {
                int32_t ti = bvh.triIdx[j];
                float t = tri_hit(bvh.positions, ti, ox, oy, oz, dx, dy, dz);
                if (t >= 0.f && t <= bestT) {
                    bestT = t;
                    bestTri = ti;
                }
            }
        } else {
            stack[sp++] = left;
            stack[sp++] = bvh.nodeRight[node];
        }
    }
    return bestTri;
}

void cast_ray(const BvhView& bvh,
              const float invMVP[16],
              const Vec3& camOrigin,
              int32_t px, int32_t py,
              int32_t width, int32_t height,
              DepthMode depthMode,
              float thicknessMm,
              bool backFaceFilter,
              std::unordered_set<int32_t>& hits) {
    float ndcX = 2.f * (px + 0.5f) / width - 1.f;
    float ndcY = 1.f - 2.f * (py + 0.5f) / height;
    Vec3 farPt;
    if (!unproject_ndc(invMVP, ndcX, ndcY, 1.f, farPt)) return;
    float dx = farPt.x - camOrigin.x;
    float dy = farPt.y - camOrigin.y;
    float dz = farPt.z - camOrigin.z;

    auto reject_back = [&](int32_t tri) -> bool {
        if (!backFaceFilter) return false;
        Vec3 n = tri_normal(bvh.positions, tri);
        return (n.x * dx + n.y * dy + n.z * dz) >= 0.f;
    };

    switch (depthMode) {
        case kFrontFacingOnly: {
            int32_t tri = intersect_front(bvh, camOrigin.x, camOrigin.y, camOrigin.z, dx, dy, dz);
            if (tri < 0) return;
            if (reject_back(tri)) return;
            hits.insert(tri);
            break;
        }
        case kAllHits: {
            std::vector<int32_t> tris;
            std::vector<float> ts;
            intersect_all(bvh, camOrigin.x, camOrigin.y, camOrigin.z, dx, dy, dz, tris, ts);
            for (int32_t t : tris) {
                if (reject_back(t)) continue;
                hits.insert(t);
            }
            break;
        }
        case kAnyFacing: {
            // intersectAll + accept every front-facing tri (lit
            // hemisphere from camera). Same loop body as kAllHits
            // but back-face filter is forced on, ignoring the
            // caller's flag — matches Kotlin AnyFacing semantics.
            std::vector<int32_t> tris;
            std::vector<float> ts;
            intersect_all(bvh, camOrigin.x, camOrigin.y, camOrigin.z, dx, dy, dz, tris, ts);
            for (int32_t t : tris) {
                Vec3 n = tri_normal(bvh.positions, t);
                if ((n.x * dx + n.y * dy + n.z * dz) >= 0.f) continue;
                hits.insert(t);
            }
            break;
        }
        case kFrontPlusThin: {
            std::vector<int32_t> tris;
            std::vector<float> ts;
            intersect_all(bvh, camOrigin.x, camOrigin.y, camOrigin.z, dx, dy, dz, tris, ts);
            if (tris.empty()) return;
            float dirLen = std::sqrt(dx * dx + dy * dy + dz * dz);
            if (dirLen < 1e-7f) return;
            float invDirLen = 1.f / dirLen;
            // distance helper closes over dx/dy/dz/camOrigin via
            // copy capture so it compiles under -Wshadow-style
            // strictness across NDK clang versions.
            auto distance = [&](int32_t tri) -> float {
                Vec3 c = tri_centroid(bvh.positions, tri);
                float cx = c.x - camOrigin.x;
                float cy = c.y - camOrigin.y;
                float cz = c.z - camOrigin.z;
                return (cx * dx + cy * dy + cz * dz) * invDirLen;
            };
            // Front-most by distance (subject to back-face filter
            // on the front pick).
            float frontDist = kInf;
            int32_t frontTri = -1;
            for (int32_t t : tris) {
                if (backFaceFilter) {
                    Vec3 n = tri_normal(bvh.positions, t);
                    if ((n.x * dx + n.y * dy + n.z * dz) >= 0.f) continue;
                }
                float d = distance(t);
                if (d < frontDist) {
                    frontDist = d;
                    frontTri = t;
                }
            }
            if (frontTri < 0) return;
            hits.insert(frontTri);
            float limit = frontDist + thicknessMm;
            for (int32_t t : tris) {
                if (t == frontTri) continue;
                float d = distance(t);
                if (d >= frontDist && d <= limit) hits.insert(t);
            }
            break;
        }
    }
}

} // namespace

int project_mask(const BvhView& bvh,
                 const CameraView& camera,
                 const uint8_t* mask,
                 int32_t maskLen,
                 DepthMode depthMode,
                 float thicknessMm,
                 bool backFaceFilter,
                 std::vector<int32_t>& out) {
    out.clear();
    if (maskLen != camera.widthPx * camera.heightPx) return -1;
    if (depthMode == kFrontPlusThin && !(thicknessMm > 0.f)) return -1;

    float mvp[16];
    mat_mul(camera.proj, camera.view, mvp);
    float invMVP[16];
    if (!invert4x4(mvp, invMVP)) return -1;
    float invView[16];
    if (!invert4x4(camera.view, invView)) return -1;
    Vec3 camOrigin{ invView[3], invView[7], invView[11] };

    std::unordered_set<int32_t> hits;
    int32_t idx = 0;
    for (int32_t py = 0; py < camera.heightPx; ++py) {
        for (int32_t px = 0; px < camera.widthPx; ++px) {
            if (mask[idx]) {
                cast_ray(bvh, invMVP, camOrigin, px, py,
                         camera.widthPx, camera.heightPx,
                         depthMode, thicknessMm, backFaceFilter, hits);
            }
            ++idx;
        }
    }
    out.assign(hits.begin(), hits.end());
    std::sort(out.begin(), out.end());
    return 0;
}

} // namespace orcaxr::ai_bvh
