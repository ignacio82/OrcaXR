use super::*;
impl Authoring<'_, '_> {
    /// Write to private output. An error discards the entire member/package;
    /// this never flushes a provider or acknowledges a saved checkpoint.
    pub fn write(
        &self,
        out: &mut impl Write,
        cancelled: impl FnMut() -> bool,
    ) -> Result<usize, Error> {
        let mut w = json::Writer::new(out, self.limits.output_bytes, cancelled)?;
        w.raw(b"{")?;
        for (i, (key, value)) in self.fields.iter().enumerate() {
            if i != 0 {
                w.raw(b",")?;
            }
            w.quoted(key)?;
            w.raw(b":")?;
            match value {
                Projection::Source(Value::Array(values)) => {
                    w.raw(b"[")?;
                    for (i, v) in values.iter().enumerate() {
                        if i != 0 {
                            w.raw(b",")?;
                        }
                        w.raw(b"\"")?;
                        w.bbs(v)?;
                        w.raw(b"\"")?;
                    }
                    w.raw(b"]")?;
                }
                Projection::Source(v) => {
                    w.raw(b"\"")?;
                    w.bbs(v)?;
                    w.raw(b"\"")?;
                }
                Projection::Scalar(v) => {
                    w.raw(b"\"")?;
                    atom(&mut w, *v)?;
                    w.raw(b"\"")?;
                }
                Projection::Vector(values) => {
                    w.raw(b"[")?;
                    for (i, v) in values.iter().enumerate() {
                        if i != 0 {
                            w.raw(b",")?;
                        }
                        w.raw(b"\"")?;
                        atom(&mut w, *v)?;
                        w.raw(b"\"")?;
                    }
                    w.raw(b"]")?;
                }
                Projection::Mixed => {
                    w.raw(b"\"")?;
                    for (i, row) in self.rows.iter().enumerate() {
                        if i != 0 {
                            w.raw(b";")?;
                        }
                        mixed::write(row, &self.physical, &mut w)?;
                    }
                    w.raw(b"\"")?;
                }
            }
        }
        w.raw(b"}\n")?;
        w.finish()
    }
}
fn atom<W: Write, C: FnMut() -> bool>(
    w: &mut json::Writer<'_, W, C>,
    atom: Atom<'_>,
) -> Result<(), Error> {
    match atom {
        Atom::Value(v) => w.bbs(v)?,
        Atom::Text(v) => w.contents(v)?,
        Atom::Number(v) => w.number(v)?,
        Atom::Bool(v) => w.raw(if v { b"1" } else { b"0" })?,
        Atom::Color(v) => w.contents(&v)?,
        Atom::Literal(v) => w.raw(v.as_bytes())?,
        Atom::Reset(v) => {
            w.contents(v)?;
            if !v.is_empty() {
                w.raw(b"\\n")?;
            }
            w.raw(b"G92 E0")?;
        }
    }
    Ok(())
}
