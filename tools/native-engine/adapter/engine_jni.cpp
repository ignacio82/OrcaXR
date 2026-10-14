// JNI over the adapter's C ABI for dev.orcaxr.nativeapp.engine.NativeEngine,
// which runs only in the app's own engine service process. Methods are
// registered by name at load, so the library exports nothing else of JNI's.
// Strings crossing here are ASCII: app-private paths in, ASCII JSON out.
#include "engine_adapter.h"

#include <jni.h>
#include <nlohmann/json.hpp>

#include <cstring>
#include <string>

namespace {
constexpr const char* ENGINE_CLASS = "dev/orcaxr/nativeapp/engine/NativeEngine";
constexpr size_t MAX_PATH_BYTES = 4096;

/** A Java string as ASCII, or false for anything else (a missing, overlong or non-ASCII path). */
bool ascii(JNIEnv* env, jstring value, std::string& out) {
    if (value == nullptr) return false;
    const jsize length = env->GetStringLength(value);
    if (length <= 0 || static_cast<size_t>(length) > MAX_PATH_BYTES) return false;
    const jchar* units = env->GetStringChars(value, nullptr);
    if (units == nullptr) return false;
    out.resize(static_cast<size_t>(length));
    bool valid = true;
    for (jsize i = 0; i < length; ++i) {
        if (units[i] == 0 || units[i] > 0x7e) valid = false;
        out[static_cast<size_t>(i)] = static_cast<char>(units[i]);
    }
    env->ReleaseStringChars(value, units);
    return valid;
}

jstring identity(JNIEnv* env, jclass) {
    return env->NewStringUTF(orcaxr_engine_identity());
}

jstring slice(JNIEnv* env, jclass, jstring job, jstring archive, jlong archive_bytes, jstring archive_sha256,
              jstring overrides, jlong overrides_bytes, jstring overrides_sha256, jstring resources, jstring output) {
    std::string paths[7];
    const jstring values[7] = {job, archive, archive_sha256, overrides, overrides_sha256, resources, output};
    for (int i = 0; i < 7; ++i) {
        if (!ascii(env, values[i], paths[i]) || archive_bytes < 0 || overrides_bytes < 0) {
            return env->NewStringUTF(R"({"schemaVersion":1,"outcome":"failed","stage":"inputs","code":"invalid-input","message":"The slice request is not valid."})");
        }
    }
    orcaxr_engine_request request{};
    request.job_directory = paths[0].c_str();
    request.archive = paths[1].c_str();
    request.archive_bytes = static_cast<unsigned long long>(archive_bytes);
    request.archive_sha256 = paths[2].c_str();
    request.overrides = paths[3].c_str();
    request.overrides_bytes = static_cast<unsigned long long>(overrides_bytes);
    request.overrides_sha256 = paths[4].c_str();
    request.resources = paths[5].c_str();
    request.output = paths[6].c_str();
    char result[ORCAXR_ENGINE_RESULT_BYTES];
    if (orcaxr_engine_slice(&request, result, sizeof result) == ORCAXR_ENGINE_INVALID) {
        return env->NewStringUTF(R"({"schemaVersion":1,"outcome":"failed","stage":"output","code":"invalid-result","message":"The engine's result did not fit."})");
    }
    return env->NewStringUTF(result);
}

jstring repair(JNIEnv* env, jclass, jstring job, jstring input_stl, jlong input_bytes, jstring input_sha256, jstring output_stl) {
    std::string paths[4];
    const jstring values[4] = {job, input_stl, input_sha256, output_stl};
    for (int i = 0; i < 4; ++i) {
        if (!ascii(env, values[i], paths[i]) || input_bytes < 0) {
            return env->NewStringUTF(R"({"schemaVersion":1,"outcome":"failed","stage":"inputs","code":"invalid-input","message":"The repair request is not valid."})");
        }
    }
    orcaxr_repair_request request{};
    request.job_directory = paths[0].c_str();
    request.input_stl = paths[1].c_str();
    request.input_bytes = static_cast<unsigned long long>(input_bytes);
    request.input_sha256 = paths[2].c_str();
    request.output_stl = paths[3].c_str();
    char result[ORCAXR_ENGINE_RESULT_BYTES];
    if (orcaxr_engine_repair(&request, result, sizeof result) == ORCAXR_ENGINE_INVALID) {
        return env->NewStringUTF(R"({"schemaVersion":1,"outcome":"failed","stage":"output","code":"invalid-result","message":"The engine's result did not fit."})");
    }
    return env->NewStringUTF(result);
}

jstring boolean_mesh(JNIEnv* env, jclass, jstring job, jstring a_stl, jlong a_bytes, jstring a_sha256,
                     jstring b_stl, jlong b_bytes, jstring b_sha256, jstring op, jstring output_stl) {
    std::string paths[7];
    const jstring values[7] = {job, a_stl, a_sha256, b_stl, b_sha256, op, output_stl};
    for (int i = 0; i < 7; ++i) {
        if (!ascii(env, values[i], paths[i]) || a_bytes < 0 || b_bytes < 0) {
            return env->NewStringUTF(R"({"schemaVersion":1,"outcome":"failed","stage":"inputs","code":"invalid-input","message":"The boolean request is not valid."})");
        }
    }
    orcaxr_boolean_request request{};
    request.job_directory = paths[0].c_str();
    request.input_a_stl = paths[1].c_str();
    request.input_a_bytes = static_cast<unsigned long long>(a_bytes);
    request.input_a_sha256 = paths[2].c_str();
    request.input_b_stl = paths[3].c_str();
    request.input_b_bytes = static_cast<unsigned long long>(b_bytes);
    request.input_b_sha256 = paths[4].c_str();
    request.op = paths[5].c_str();
    request.output_stl = paths[6].c_str();
    char result[ORCAXR_ENGINE_RESULT_BYTES];
    if (orcaxr_engine_boolean(&request, result, sizeof result) == ORCAXR_ENGINE_INVALID) {
        return env->NewStringUTF(R"({"schemaVersion":1,"outcome":"failed","stage":"output","code":"invalid-result","message":"The engine's result did not fit."})");
    }
    return env->NewStringUTF(result);
}

void cancel(JNIEnv*, jclass) {
    orcaxr_engine_cancel();
}

jstring progress(JNIEnv* env, jclass) {
    int percent = -1;
    char message[ORCAXR_ENGINE_MESSAGE_BYTES];
    const auto sequence = orcaxr_engine_progress(&percent, message, sizeof message);
    const auto document = nlohmann::json{{"sequence", sequence}, {"percent", percent}, {"message", message}};
    return env->NewStringUTF(document.dump(-1, ' ', true, nlohmann::json::error_handler_t::replace).c_str());
}

const JNINativeMethod METHODS[] = {
    {const_cast<char*>("nativeIdentity"), const_cast<char*>("()Ljava/lang/String;"), reinterpret_cast<void*>(identity)},
    {const_cast<char*>("nativeSlice"),
     const_cast<char*>("(Ljava/lang/String;Ljava/lang/String;JLjava/lang/String;Ljava/lang/String;JLjava/lang/String;"
                       "Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;"),
     reinterpret_cast<void*>(slice)},
    {const_cast<char*>("nativeRepair"),
     const_cast<char*>("(Ljava/lang/String;Ljava/lang/String;JLjava/lang/String;Ljava/lang/String;)Ljava/lang/String;"),
     reinterpret_cast<void*>(repair)},
    {const_cast<char*>("nativeBoolean"),
     const_cast<char*>("(Ljava/lang/String;Ljava/lang/String;JLjava/lang/String;Ljava/lang/String;JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;"),
     reinterpret_cast<void*>(boolean_mesh)},
    {const_cast<char*>("nativeCancel"), const_cast<char*>("()V"), reinterpret_cast<void*>(cancel)},
    {const_cast<char*>("nativeProgress"), const_cast<char*>("()Ljava/lang/String;"), reinterpret_cast<void*>(progress)},
};
}  // namespace

extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void*) {
    JNIEnv* env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    jclass engine = env->FindClass(ENGINE_CLASS);
    if (engine == nullptr) return JNI_ERR;
    const jint registered = env->RegisterNatives(engine, METHODS, sizeof METHODS / sizeof METHODS[0]);
    env->DeleteLocalRef(engine);
    return registered == JNI_OK ? JNI_VERSION_1_6 : JNI_ERR;
}
