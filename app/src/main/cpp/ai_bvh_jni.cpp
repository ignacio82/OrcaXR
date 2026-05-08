// JNI binding for orcaxr::ai_bvh::project_mask. Lives in its own
// file so the algorithm header stays library-agnostic (testable
// from a hostt-side harness) and the Java symbol-name surface stays
// narrow.
//
// Java side: dev.orcaxr.app.NativeBvh.nativeProjectMask. The Kotlin
// wrapper `NativeBvh.kt` swallows UnsatisfiedLinkError so the JVM
// unit-test path keeps working (these tests don't loadLibrary).
//
// Inputs are passed as primitive arrays — we pin them with
// GetPrimitiveArrayCritical for zero-copy reads. The output is an
// IntArray; we materialize it via NewIntArray + SetIntArrayRegion.

#include <jni.h>
#include <android/log.h>
#include <vector>

#include "ai_bvh.hpp"

#define ORCAXR_BVH_LOG_TAG "ai_bvh_jni"
#define ORCAXR_LOGE(...) __android_log_print(ANDROID_LOG_ERROR, ORCAXR_BVH_LOG_TAG, __VA_ARGS__)

namespace {

struct CriticalPin {
    JNIEnv* env;
    jarray  arr;
    void*   ptr;
    CriticalPin(JNIEnv* e, jarray a) : env(e), arr(a), ptr(nullptr) {
        if (a != nullptr) ptr = env->GetPrimitiveArrayCritical(a, nullptr);
    }
    ~CriticalPin() {
        if (ptr != nullptr) env->ReleasePrimitiveArrayCritical(arr, ptr, JNI_ABORT);
    }
    template <typename T>
    const T* as() const { return reinterpret_cast<const T*>(ptr); }
};

} // namespace

extern "C" JNIEXPORT jintArray JNICALL
Java_dev_orcaxr_app_NativeBvh_nativeProjectMask(
    JNIEnv* env, jclass /*clazz*/,
    jfloatArray jPositions,           // 9 * triCount
    jintArray   jTriIdx,              // triCount
    jfloatArray jNodeAabb,            // 6 * nodeCount
    jintArray   jNodeLeft,            // nodeCount
    jintArray   jNodeRight,           // nodeCount
    jintArray   jNodeLeafStart,       // nodeCount
    jintArray   jNodeLeafEnd,         // nodeCount
    jfloatArray jViewMatrix,          // 16
    jfloatArray jProjMatrix,          // 16
    jint        widthPx,
    jint        heightPx,
    jbyteArray  jMask,                // widthPx * heightPx (non-zero == on)
    jint        depthModeOrdinal,     // 0..3 matching DepthMode
    jfloat      thicknessMm,          // for FrontPlusThin
    jboolean    backFaceFilter
) {
    if (jPositions == nullptr || jTriIdx == nullptr || jNodeAabb == nullptr
        || jNodeLeft == nullptr || jNodeRight == nullptr
        || jNodeLeafStart == nullptr || jNodeLeafEnd == nullptr
        || jViewMatrix == nullptr || jProjMatrix == nullptr || jMask == nullptr) {
        return env->NewIntArray(0);
    }

    const jsize triCount = env->GetArrayLength(jTriIdx);
    const jsize maskLen  = env->GetArrayLength(jMask);
    if (env->GetArrayLength(jPositions) != triCount * 9) {
        ORCAXR_LOGE("positions array len %d != 9 * triCount %d",
                    env->GetArrayLength(jPositions), triCount);
        return env->NewIntArray(0);
    }
    if (env->GetArrayLength(jViewMatrix) != 16 || env->GetArrayLength(jProjMatrix) != 16) {
        ORCAXR_LOGE("view/proj must be 16 floats");
        return env->NewIntArray(0);
    }
    if (maskLen != widthPx * heightPx) {
        ORCAXR_LOGE("mask len %d != width*height %d", (int)maskLen, (int)(widthPx * heightPx));
        return env->NewIntArray(0);
    }
    if (depthModeOrdinal < 0 || depthModeOrdinal > 3) {
        ORCAXR_LOGE("depth mode ordinal out of range: %d", (int)depthModeOrdinal);
        return env->NewIntArray(0);
    }

    // Pin every input array for the duration of the traversal.
    // GetPrimitiveArrayCritical may temporarily disable GC so the
    // critical region must be tight — and we never call back into
    // Java between pin and release.
    CriticalPin pPositions(env, jPositions);
    CriticalPin pTriIdx(env, jTriIdx);
    CriticalPin pNodeAabb(env, jNodeAabb);
    CriticalPin pNodeLeft(env, jNodeLeft);
    CriticalPin pNodeRight(env, jNodeRight);
    CriticalPin pNodeLeafStart(env, jNodeLeafStart);
    CriticalPin pNodeLeafEnd(env, jNodeLeafEnd);
    CriticalPin pView(env, jViewMatrix);
    CriticalPin pProj(env, jProjMatrix);
    CriticalPin pMask(env, jMask);

    if (pPositions.ptr == nullptr || pTriIdx.ptr == nullptr || pNodeAabb.ptr == nullptr
        || pNodeLeft.ptr == nullptr || pNodeRight.ptr == nullptr
        || pNodeLeafStart.ptr == nullptr || pNodeLeafEnd.ptr == nullptr
        || pView.ptr == nullptr || pProj.ptr == nullptr || pMask.ptr == nullptr) {
        ORCAXR_LOGE("primitive array pin failed");
        return env->NewIntArray(0);
    }

    orcaxr::ai_bvh::BvhView bvh;
    bvh.positions     = pPositions.as<float>();
    bvh.triCount      = static_cast<int32_t>(triCount);
    bvh.triIdx        = pTriIdx.as<int32_t>();
    bvh.nodeAabb      = pNodeAabb.as<float>();
    bvh.nodeLeft      = pNodeLeft.as<int32_t>();
    bvh.nodeRight     = pNodeRight.as<int32_t>();
    bvh.nodeLeafStart = pNodeLeafStart.as<int32_t>();
    bvh.nodeLeafEnd   = pNodeLeafEnd.as<int32_t>();

    orcaxr::ai_bvh::CameraView cam;
    for (int i = 0; i < 16; ++i) cam.view[i] = pView.as<float>()[i];
    for (int i = 0; i < 16; ++i) cam.proj[i] = pProj.as<float>()[i];
    cam.widthPx  = widthPx;
    cam.heightPx = heightPx;

    std::vector<int32_t> out;
    int rc = orcaxr::ai_bvh::project_mask(
        bvh, cam,
        // jbyte (signed) cast to uint8_t — only the zero / non-zero
        // bit matters, so reinterpreting is fine.
        reinterpret_cast<const uint8_t*>(pMask.as<int8_t>()),
        static_cast<int32_t>(maskLen),
        static_cast<orcaxr::ai_bvh::DepthMode>((int)depthModeOrdinal),
        thicknessMm,
        backFaceFilter == JNI_TRUE,
        out
    );
    if (rc != 0) {
        ORCAXR_LOGE("project_mask returned %d", rc);
        return env->NewIntArray(0);
    }

    jintArray result = env->NewIntArray(static_cast<jsize>(out.size()));
    if (result != nullptr && !out.empty()) {
        env->SetIntArrayRegion(result, 0, static_cast<jsize>(out.size()),
                               reinterpret_cast<const jint*>(out.data()));
    }
    return result;
}
