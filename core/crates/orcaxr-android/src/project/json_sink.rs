//! Bounded streaming JSON bridge. JNI local references and staging bytes do not
//! grow with the document. Callback failures never leak Java exception text.
use super::*;
use jni::objects::JValue;

pub(super) struct Sink<'env, 'local, 'target> {
    env: &'env mut JNIEnv<'local>,
    target: JObject<'target>,
    handle: jlong,
    limit: usize,
    total: usize,
    bytes: Vec<u8>,
    failure: &'static str,
}
impl Sink<'_, '_, '_> {
    fn fail(&mut self, code: &'static str) -> io::Error {
        self.failure = code;
        io::Error::other(code)
    }
    fn send(&mut self) -> io::Result<()> {
        // Closing the owner stops the next chunk, including raw-JNI callbacks
        // that close their own handle. In-flight callback work is not interrupted.
        if registry().slot(self.handle).is_err() {
            return Err(self.fail("closed"));
        }
        if self.bytes.is_empty() {
            return Ok(());
        }
        let sent = (|| -> jni::errors::Result<()> {
            let bytes = self.env.byte_array_from_slice(&self.bytes)?;
            let bytes = self.env.auto_local(bytes);
            self.env.call_method(
                &self.target,
                "write",
                "([B)V",
                &[JValue::Object(bytes.as_ref())],
            )?;
            Ok(())
        })();
        if sent.is_err() {
            let _ = self.env.exception_clear();
            return Err(self.fail("export_service"));
        }
        self.bytes.clear();
        Ok(())
    }
}
impl Write for Sink<'_, '_, '_> {
    fn write(&mut self, value: &[u8]) -> io::Result<usize> {
        if value.len() > self.limit - self.total {
            return Err(self.fail("output_limit"));
        }
        self.total += value.len();
        let mut rest = value;
        while !rest.is_empty() {
            let count = rest.len().min(layout::MAX_CHUNK_BYTES - self.bytes.len());
            self.bytes.extend_from_slice(&rest[..count]);
            rest = &rest[count..];
            if self.bytes.len() == layout::MAX_CHUNK_BYTES {
                self.send()?;
            }
        }
        Ok(value.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.send()
    }
}
impl<'env, 'local, 'target> Sink<'env, 'local, 'target> {
    /// A bounded writer of chunks to [target] (a `ProjectJsonSink`) while
    /// [handle] stays open; [failure] names why a write stopped.
    pub(super) fn open(
        env: &'env mut JNIEnv<'local>,
        handle: jlong,
        limit: usize,
        target: JObject<'target>,
    ) -> Result<Self> {
        if limit > layout::MAX_BUDGET {
            return Err("invalid_options");
        }
        if target.is_null()
            || !env
                .is_instance_of(&target, "dev/orcaxr/core/ProjectJsonSink")
                .map_err(|_| "export_service")?
        {
            return Err("export_service");
        }
        Ok(Self {
            env,
            target,
            handle,
            limit,
            total: 0,
            bytes: Vec::with_capacity(layout::MAX_CHUNK_BYTES),
            failure: "export_failed",
        })
    }
    pub(super) fn failure(&self) -> &'static str {
        self.failure
    }
}
pub(super) fn write_json<'local, 'target>(
    env: &mut JNIEnv<'local>,
    handle: jlong,
    max_bytes: jlong,
    target: JObject<'target>,
) -> Result<jlong> {
    let limit = index(max_bytes)?;
    let mut sink = Sink::open(env, handle, limit, target)?;
    with_project(handle, |project| {
        if project
            .state()
            .write_json(&mut sink)
            .and_then(|_| sink.flush())
            .is_err()
        {
            return Err(sink.failure);
        }
        Ok(sink.total as jlong)
    })
}
