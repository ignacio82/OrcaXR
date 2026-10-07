use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JObject, JValue},
};
use orcaxr_project::validation::{
    TimestampPolicy,
    timestamp::{self, V8IntegerMode},
};

pub(super) struct Timestamps {
    vm: JavaVM,
    resolver: GlobalRef,
    integers: V8IntegerMode,
}
impl Timestamps {
    pub fn new(env: &mut JNIEnv<'_>, resolver: JObject<'_>, integers: i32) -> super::Result<Self> {
        let integers = match integers {
            31 => V8IntegerMode::Smi31,
            32 => V8IntegerMode::Smi32,
            _ => return Err("invalid_timestamp_profile"),
        };
        if resolver.is_null()
            || !env
                .is_instance_of(&resolver, "dev/orcaxr/core/LocalTimestampResolver")
                .map_err(|_| "timestamp_service")?
        {
            return Err("timestamp_service");
        }
        Ok(Self {
            vm: env.get_java_vm().map_err(|_| "timestamp_service")?,
            resolver: env
                .new_global_ref(resolver)
                .map_err(|_| "timestamp_service")?,
            integers,
        })
    }
}
impl TimestampPolicy for Timestamps {
    type Error = &'static str;
    fn is_valid(&mut self, units: &[u16]) -> super::Result<bool> {
        let Some(parsed) = timestamp::parse(units, self.integers) else {
            return Ok(false);
        };
        parsed
            .resolve(|local| {
                let mut env = self
                    .vm
                    .attach_current_thread()
                    .map_err(|_| "timestamp_service")?;
                let result = env
                    .call_method(
                        self.resolver.as_obj(),
                        "resolve",
                        "(J)J",
                        &[JValue::Long(local.civil_milliseconds())],
                    )
                    .and_then(|v| v.j());
                if result.is_err() {
                    // A callback may throw private text. Clear it before returning
                    // the stable service error; never describe/log the exception.
                    let _ = env.exception_clear();
                }
                result.map_err(|_| "timestamp_service")
            })
            .map(|value| value.is_some())
    }
}
