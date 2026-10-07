use super::*;
use std::io;

pub(super) fn escaped<W: Write, C: FnMut() -> bool>(
    w: &mut xml::Writer<'_, W, C>,
    value: &[u16],
    attr: bool,
) -> Result<(), Error> {
    if attr {
        w.attribute(value)?;
    } else {
        w.text(value)?;
    }
    Ok(())
}
/// bbsValue: null -> empty, bool -> 0/1, recursively flattened semicolon
/// arrays, and canonical JSON objects. All nested strings stay borrowed.
pub(super) fn bbs<W: Write, C: FnMut() -> bool>(
    w: &mut xml::Writer<'_, W, C>,
    v: &Value,
    attr: bool,
) -> Result<(), Error> {
    w.poll()?;
    match v {
        Value::Null => {}
        Value::Bool(v) => w.literal(if *v { "1" } else { "0" })?,
        Value::Number(v) => w.number(*v)?,
        Value::String(v) => escaped(w, v, attr)?,
        Value::Array(values) => {
            for (i, v) in values.iter().enumerate() {
                if i != 0 {
                    w.literal(";")?;
                }
                bbs(w, v, attr)?;
            }
        }
        Value::Object(_) => {
            // Canonical JSON emits complete UTF-8 scalars in each sink write.
            // Bound each conversion on the stack; never build the JSON string.
            struct Sink<'a, 'b, W, C> {
                w: &'a mut xml::Writer<'b, W, C>,
                attr: bool,
                error: Option<Error>,
            }
            impl<W: Write, C: FnMut() -> bool> Write for Sink<'_, '_, W, C> {
                fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                    let result = (|| {
                        let text = std::str::from_utf8(bytes).map_err(|_| Error::Attribute)?;
                        let mut units = [0u16; 256];
                        let mut used = 0;
                        for character in text.chars() {
                            if used + 2 > units.len() {
                                escaped(self.w, &units[..used], self.attr)?;
                                used = 0;
                            }
                            used += character.encode_utf16(&mut units[used..]).len();
                        }
                        escaped(self.w, &units[..used], self.attr)
                    })();
                    match result {
                        Ok(()) => Ok(bytes.len()),
                        Err(e) => {
                            self.error = Some(e);
                            Err(io::ErrorKind::Other.into())
                        }
                    }
                }
                fn flush(&mut self) -> io::Result<()> {
                    Ok(())
                }
            }
            let mut sink = Sink {
                w,
                attr,
                error: None,
            };
            let result = v.write_canonical(&mut sink);
            if let Some(e) = sink.error {
                return Err(e);
            }
            result.map_err(|_| Error::Attribute)?;
        }
    }
    Ok(())
}
pub(super) fn start<W: Write, C: FnMut() -> bool>(
    w: &mut xml::Writer<'_, W, C>,
    key: &[u16],
    indent: usize,
) -> Result<(), Error> {
    w.literal(if indent == 2 {
        "  <metadata key=\""
    } else {
        "   <metadata key=\""
    })?;
    w.attribute(key)?;
    w.literal("\" value=\"")?;
    Ok(())
}
pub(super) fn static_start<W: Write, C: FnMut() -> bool>(
    w: &mut xml::Writer<'_, W, C>,
    key: &'static str,
    indent: usize,
) -> Result<(), Error> {
    let mut units = [0; 32];
    for (i, u) in key.encode_utf16().enumerate() {
        units[i] = u;
    }
    start(w, &units[..key.len()], indent)
}
pub(super) fn end<W: Write, C: FnMut() -> bool>(
    w: &mut xml::Writer<'_, W, C>,
) -> Result<(), Error> {
    w.literal("\"/>\n")?;
    Ok(())
}
pub(super) fn number<W: Write, C: FnMut() -> bool>(
    w: &mut xml::Writer<'_, W, C>,
    key: &'static str,
    v: f64,
    indent: usize,
) -> Result<(), Error> {
    static_start(w, key, indent)?;
    w.number(v)?;
    end(w)
}
pub(super) fn text<W: Write, C: FnMut() -> bool>(
    w: &mut xml::Writer<'_, W, C>,
    key: &'static str,
    v: &[u16],
    indent: usize,
) -> Result<(), Error> {
    static_start(w, key, indent)?;
    w.attribute(v)?;
    end(w)
}
pub(super) fn config<W: Write, C: FnMut() -> bool>(
    w: &mut xml::Writer<'_, W, C>,
    config: &ConfigMap,
    indent: usize,
    plate: bool,
) -> Result<(), Error> {
    let Value::Object(fields) = config.value() else {
        return Err(Error::Attribute);
    };
    for (key, v) in fields {
        if plate
            && ["plater_id", "plater_name", "locked", "printable"]
                .iter()
                .any(|s| eq(key, s))
        {
            continue;
        }
        start(w, key, indent)?;
        bbs(w, v, true)?;
        end(w)?;
    }
    Ok(())
}
