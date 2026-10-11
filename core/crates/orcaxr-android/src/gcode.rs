use jni::{
    JNIEnv,
    objects::{JByteArray, JByteBuffer, JCharArray, JClass, JString},
    sys::{jcharArray, jdouble, jint, jlong, jstring},
};
use orcaxr_gcode::{Cancellation, Session, SessionError, artifact::SliceTally, layout};
use std::{
    collections::HashMap,
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicI64, AtomicUsize, Ordering},
    },
};

struct Owner {
    work: Mutex<Work>,
    cancellation: Cancellation,
    // Fields drop in declaration order: release admission only after the
    // source, index and packet owned by Work have actually been dropped.
    _permit: Permit,
}
struct Permit;
impl Drop for Permit {
    fn drop(&mut self) {
        LIVE_OWNERS.fetch_sub(1, Ordering::Relaxed);
    }
}
struct Work {
    session: Session,
    packet: Option<Vec<u8>>,
}
static OWNERS: OnceLock<Mutex<HashMap<i64, Arc<Owner>>>> = OnceLock::new();
static NEXT: AtomicI64 = AtomicI64::new(1);
static LIVE_OWNERS: AtomicUsize = AtomicUsize::new(0);
fn owners() -> &'static Mutex<HashMap<i64, Arc<Owner>>> {
    OWNERS.get_or_init(Default::default)
}
fn owner(handle: i64) -> Result<Arc<Owner>, &'static str> {
    owners()
        .lock()
        .map_err(|_| "invalid_state")?
        .get(&handle)
        .cloned()
        .ok_or("closed")
}
fn code(error: SessionError) -> &'static str {
    error.code()
}
fn boundary<T: Default>(
    env: &mut JNIEnv<'_>,
    call: impl FnOnce(&mut JNIEnv<'_>) -> Result<T, &'static str>,
) -> T {
    match catch_unwind(AssertUnwindSafe(|| call(env))) {
        Ok(Ok(value)) => value,
        result => {
            let code = match result {
                Ok(Err(code)) => code,
                _ => "core_failure",
            };
            let _ = env.throw_new("java/lang/IllegalStateException", code);
            T::default()
        }
    }
}
fn integer(value: jint) -> Result<usize, &'static str> {
    usize::try_from(value).map_err(|_| "invalid_range")
}
fn string(env: &mut JNIEnv<'_>, value: String) -> Result<jstring, &'static str> {
    env.new_string(value)
        .map(|v| v.into_raw())
        .map_err(|_| "allocation_failed")
}

fn register(units: usize, options: &str) -> Result<i64, &'static str> {
    let mut owners = owners().lock().map_err(|_| "invalid_state")?;
    if LIVE_OWNERS.load(Ordering::Relaxed) >= 4 {
        return Err("resource_limit");
    }
    let cancellation = Cancellation::default();
    let session = Session::new(units, options, cancellation.clone()).map_err(code)?;
    // Never reuse a handle, including after close. Overflow refuses new owners.
    let handle = NEXT
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| v.checked_add(1))
        .map_err(|_| "resource_limit")?;
    LIVE_OWNERS.fetch_add(1, Ordering::Relaxed);
    owners.insert(
        handle,
        Arc::new(Owner {
            work: Mutex::new(Work {
                session,
                packet: None,
            }),
            cancellation,
            _permit: Permit,
        }),
    );
    Ok(handle)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_open(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    version: jint,
    units: jint,
    options: JString<'_>,
) -> jlong {
    boundary(&mut env, |env| {
        if version as usize != layout::VERSION {
            return Err("unsupported_protocol");
        }
        let length = env
            .call_method(&options, "length", "()I", &[])
            .and_then(|v| v.i())
            .map_err(|_| "invalid_options")?;
        if !(0..=65536).contains(&length) {
            return Err("resource_limit");
        }
        let options: String = env
            .get_string(&options)
            .map_err(|_| "invalid_options")?
            .into();
        register(integer(units)?, &options)
    })
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_append(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    offset: jint,
    units: JCharArray<'_>,
) {
    boundary(&mut env, |env| {
        let owner = owner(handle)?;
        let length = env.get_array_length(&units).map_err(|_| "invalid_source")?;
        if length < 0 || length as usize > layout::MAX_CHUNK_UNITS {
            return Err("source_length");
        }
        let mut copy = vec![0u16; length as usize];
        env.get_char_array_region(&units, 0, &mut copy)
            .map_err(|_| "invalid_source")?;
        owner
            .work
            .lock()
            .map_err(|_| "invalid_state")?
            .session
            .append(integer(offset)?, &copy)
            .map_err(code)
    });
}
/// The parser's whole input budget, in bytes of source.
const MAX_DECODE_BYTES: usize = 256 * 1024 * 1024;
/// G-code file bytes decoded as the browser decodes a G-code file.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_decodeUtf8(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    bytes: JByteArray<'_>,
) -> jcharArray {
    boundary(&mut env, |env| {
        let length = env.get_array_length(&bytes).map_err(|_| "invalid_source")?;
        if length < 0 || length as usize > MAX_DECODE_BYTES {
            return Err("source_length");
        }
        let input = env
            .convert_byte_array(&bytes)
            .map_err(|_| "invalid_source")?;
        let units = orcaxr_gcode::decode_utf8(&input);
        let array = env
            .new_char_array(units.len() as i32)
            .map_err(|_| "allocation_failed")?;
        env.set_char_array_region(&array, 0, &units)
            .map_err(|_| "allocation_failed")?;
        Ok(array.into_raw())
    })
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_seal(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) -> jstring {
    boundary(&mut env, |env| {
        let owner = owner(handle)?;
        let value = owner
            .work
            .lock()
            .map_err(|_| "invalid_state")?
            .session
            .seal()
            .map_err(code)?;
        string(env, value)
    })
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_page(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    start: jint,
    count: jint,
) -> jstring {
    boundary(&mut env, |env| {
        let owner = owner(handle)?;
        let value = owner
            .work
            .lock()
            .map_err(|_| "invalid_state")?
            .session
            .page(integer(start)?, integer(count)?)
            .map_err(code)?;
        string(env, value)
    })
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_summary(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) -> jstring {
    boundary(&mut env, |env| {
        let owner = owner(handle)?;
        let value = owner
            .work
            .lock()
            .map_err(|_| "invalid_state")?
            .session
            .summary()
            .map_err(code)?;
        string(env, value)
    })
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_textWindow(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    from: jdouble,
    count: jdouble,
) -> jstring {
    boundary(&mut env, |env| {
        let owner = owner(handle)?;
        let value = owner
            .work
            .lock()
            .map_err(|_| "invalid_state")?
            .session
            .text_window(from, count)
            .map_err(code)?;
        string(env, value)
    })
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_textSearch(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    query: JCharArray<'_>,
    limit: jint,
) -> jstring {
    boundary(&mut env, |env| {
        let owner = owner(handle)?;
        // Bound the Java array before copying it into Rust.
        let length = env
            .get_array_length(&query)
            .map_err(|_| "invalid_request")?;
        if length < 0 || length as usize > layout::MAX_QUERY_UNITS {
            return Err("resource_limit");
        }
        let mut copy = vec![0u16; length as usize];
        env.get_char_array_region(&query, 0, &mut copy)
            .map_err(|_| "invalid_request")?;
        let value = owner
            .work
            .lock()
            .map_err(|_| "invalid_state")?
            .session
            .text_search(&copy, integer(limit)?)
            .map_err(code)?;
        string(env, value)
    })
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_prepare(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    first: jint,
    last: jint,
) -> jint {
    boundary(&mut env, |_| {
        let owner = owner(handle)?;
        let mut work = owner.work.lock().map_err(|_| "invalid_state")?;
        work.packet = None;
        let packet = if first == -1 && last == -1 {
            work.session.whole()
        } else {
            work.session.window(integer(first)?, integer(last)?)
        }
        .map_err(code)?;
        let length = packet.len() as jint;
        work.packet = Some(packet);
        Ok(length)
    })
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_prepareView(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    request: JString<'_>,
) -> jint {
    boundary(&mut env, |env| {
        let owner = owner(handle)?;
        let mut work = owner.work.lock().map_err(|_| "invalid_state")?;
        // Every prepare supersedes the pending transfer, even when rejected.
        work.packet = None;
        let length = env
            .call_method(&request, "length", "()I", &[])
            .and_then(|v| v.i())
            .map_err(|_| "invalid_request")?;
        if length < 0 || length as usize > orcaxr_gcode::view_layout::MAX_REQUEST_BYTES {
            return Err("resource_limit");
        }
        let request: String = env
            .get_string(&request)
            .map_err(|_| "invalid_request")?
            .into();
        let packet = work.session.view(&request).map_err(code)?;
        let length = packet.len() as jint;
        work.packet = Some(packet);
        Ok(length)
    })
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_copy(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    target: JByteBuffer<'_>,
) {
    boundary(&mut env, |env| {
        let owner = owner(handle)?;
        let mut work = owner.work.lock().map_err(|_| "invalid_state")?;
        if owner.cancellation.is_cancelled() {
            return Err("cancelled");
        }
        let packet = work.packet.as_ref().ok_or("invalid_state")?;
        let capacity = env
            .get_direct_buffer_capacity(&target)
            .map_err(|_| "invalid_buffer")?;
        if capacity != packet.len() {
            return Err("invalid_buffer");
        }
        let read_only = env
            .call_method(&target, "isReadOnly", "()Z", &[])
            .and_then(|v| v.z())
            .map_err(|_| "invalid_buffer")?;
        if read_only {
            return Err("invalid_buffer");
        }
        let address = env
            .get_direct_buffer_address(&target)
            .map_err(|_| "invalid_buffer")?;
        // SAFETY: JNI keeps this Java-owned direct buffer alive for the call.
        // Its checked writable capacity exactly equals the packet length. The
        // Kotlin owner serializes prepare/copy; no Rust pointer escapes the call.
        unsafe {
            ptr::copy_nonoverlapping(packet.as_ptr(), address, packet.len());
        }
        work.packet = None;
        if owner.cancellation.is_cancelled() {
            return Err("cancelled");
        }
        Ok(())
    });
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_close(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) {
    boundary(&mut env, |_| close(handle));
}

fn close(handle: i64) -> Result<(), &'static str> {
    if let Some(owner) = owners()
        .lock()
        .map_err(|_| "invalid_state")?
        .remove(&handle)
    {
        // Does not wait on the work mutex. In-flight work owns Arc<Owner>
        // and cooperatively exits before its resources can be released.
        owner.cancellation.cancel();
    }
    Ok(())
}

// --- Slice status tallies -------------------------------------------------------------------
// What the status line says of a finished slice (`SliceTally`), streamed by
// the host as it writes or reads the artifact. Each tally keeps at most two
// trailer windows (~400 KiB); a few may live at once, handles never reused.

const MAX_TALLIES: usize = 8;
const MAX_TALLY_CHUNK: usize = 1 << 20;
static TALLIES: OnceLock<Mutex<HashMap<i64, SliceTally>>> = OnceLock::new();
static NEXT_TALLY: AtomicI64 = AtomicI64::new(1);
fn tallies() -> &'static Mutex<HashMap<i64, SliceTally>> {
    TALLIES.get_or_init(Default::default)
}
fn tally_open() -> Result<i64, &'static str> {
    let mut tallies = tallies().lock().map_err(|_| "invalid_state")?;
    if tallies.len() >= MAX_TALLIES {
        return Err("resource_limit");
    }
    let handle = NEXT_TALLY
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| v.checked_add(1))
        .map_err(|_| "resource_limit")?;
    tallies.insert(handle, SliceTally::new());
    Ok(handle)
}
fn tally_push(handle: i64, chunk: &[u8]) -> Result<(), &'static str> {
    tallies()
        .lock()
        .map_err(|_| "invalid_state")?
        .get_mut(&handle)
        .ok_or("closed")?
        .push(chunk);
    Ok(())
}
fn tally_figures(handle: i64) -> Result<String, &'static str> {
    Ok(tallies()
        .lock()
        .map_err(|_| "invalid_state")?
        .get(&handle)
        .ok_or("closed")?
        .finish()
        .json())
}
fn tally_close(handle: i64) -> Result<(), &'static str> {
    tallies()
        .lock()
        .map_err(|_| "invalid_state")?
        .remove(&handle);
    Ok(())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_tallyOpen(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
) -> jlong {
    boundary(&mut env, |_| tally_open())
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_tallyPush(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    bytes: JByteArray<'_>,
    length: jint,
) {
    boundary(&mut env, |env| {
        let capacity = env.get_array_length(&bytes).map_err(|_| "invalid_source")?;
        let length = integer(length)?;
        if length > MAX_TALLY_CHUNK || length > integer(capacity)? {
            return Err("source_length");
        }
        let mut chunk = vec![0i8; length];
        env.get_byte_array_region(&bytes, 0, &mut chunk)
            .map_err(|_| "invalid_source")?;
        let chunk: Vec<u8> = chunk.into_iter().map(|byte| byte as u8).collect();
        tally_push(handle, &chunk)
    });
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_tallyFigures(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) -> jstring {
    boundary(&mut env, |env| {
        let value = tally_figures(handle)?;
        string(env, value)
    })
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_orcaxr_core_NativeGcode_tallyClose(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) {
    boundary(&mut env, |_| tally_close(handle));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slice_tallies_are_bounded_and_never_reused() {
        let handles: Vec<_> = (0..MAX_TALLIES).map(|_| tally_open().unwrap()).collect();
        assert_eq!(tally_open(), Err("resource_limit"));
        tally_push(handles[0], b";LAYER_CHANGE\nG1 Z0.2\n").unwrap();
        let figures = tally_figures(handles[0]).unwrap();
        assert!(
            figures.contains("\"layers\":\"1\"") && figures.contains("\"lines\":3"),
            "{figures}"
        );
        for handle in &handles {
            tally_close(*handle).unwrap();
        }
        assert_eq!(tally_push(handles[0], b"x"), Err("closed"));
        assert_eq!(tally_figures(handles[0]), Err("closed"));
        let next = tally_open().unwrap();
        assert!(next > *handles.last().unwrap());
        tally_close(next).unwrap();
    }
    #[test]
    fn cancelled_work_keeps_its_admission_slot_until_the_last_owner_drops() {
        let first = register(0, "{}").unwrap();
        let active = owner(first).unwrap();
        close(first).unwrap();
        assert!(owner(first).is_err());
        assert!(active.cancellation.is_cancelled());
        let mut replacements = Vec::new();
        for _ in 0..3 {
            replacements.push(register(0, "{}").unwrap());
        }
        assert_eq!(register(0, "{}"), Err("resource_limit"));
        drop(active);
        replacements.push(register(0, "{}").unwrap());
        for handle in replacements {
            assert!(handle > first);
            close(handle).unwrap();
        }
        assert_eq!(LIVE_OWNERS.load(Ordering::Relaxed), 0);
    }
}
