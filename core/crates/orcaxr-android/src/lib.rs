use jni::{
    JNIEnv,
    objects::{JClass, JString},
    sys::jstring,
};
mod gcode;
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
};

fn reply(
    env: &mut JNIEnv<'_>,
    operation: impl FnOnce() -> Result<String, &'static str>,
) -> jstring {
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok(value)) => match env.new_string(value) {
            Ok(value) => value.into_raw(),
            Err(_) => {
                let _ = env.throw_new(
                    "java/lang/IllegalStateException",
                    "Core response allocation failed.",
                );
                ptr::null_mut()
            }
        },
        _ => {
            let _ = env.throw_new("java/lang/IllegalStateException", "Core operation failed.");
            ptr::null_mut()
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeCore_coreInfo(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
) -> jstring {
    reply(&mut env, || Ok(orcaxr_contracts::core_info()))
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeCore_evaluate(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    request: JString<'_>,
) -> jstring {
    // Check the Java UTF-16 length before allocating a UTF-8 copy. The Rust
    // protocol also checks the resulting byte count. No borrowed JNI data escapes.
    let length = env
        .call_method(&request, "length", "()I", &[])
        .and_then(|value| value.i());
    if !matches!(length, Ok(length) if length >= 0 && length as usize <= orcaxr_contracts::generated::MAX_REQUEST_BYTES)
    {
        let _ = env.throw_new(
            "java/lang/IllegalArgumentException",
            "Core request exceeds the supported limit.",
        );
        return ptr::null_mut();
    }
    let source = env.get_string(&request).map(String::from);
    reply(&mut env, || {
        source
            .map(|value| orcaxr_contracts::evaluate(&value))
            .map_err(|_| "invalid request")
    })
}
