//! File → Export Toolpaths as OBJ… (`exportToolpathsToObj` in
//! `GcodeToolpath.ts`): the published G-code's extrusion paths as the
//! browser's Wavefront OBJ, byte for byte.
//!
//! The browser parses the G-code with no options (`parseRichGcodeModel(gcode)`),
//! checks the path sidecar (`validateGcodePathSidecar`), then writes the header
//! line, every extrusion record's segments as two `v` lines each (a direct
//! move unless it starts where it ends; an arc's every interpolation edge and
//! its final edge, even an empty one), coordinates as `toFixed(4)` of the
//! binary32 columns, and then one `l` line per segment, all joined by `\n`
//! with none after the last. The `l` lines only count, so the file streams.
use crate::{Cancellation, Model, Options, ParseError, kind, parse_with_cancellation, path};
use std::io::{self, BufWriter, Write};

const HEADER: &str = "# Sliced Toolpaths exported by OrcaXR";
const DIRECT: u8 = 0;

/// What a written OBJ holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Written {
    /// Line segments (`l` lines; twice as many `v` lines).
    pub segments: u64,
    /// The file's length in bytes.
    pub bytes: u64,
}

/// Why no OBJ was written whole.
#[derive(Debug)]
pub enum Failure {
    Cancelled,
    /// The browser's `validateGcodePathSidecar` message; the parser's own
    /// output never fails it.
    Invalid(String),
    /// The destination failed.
    Io(io::Error),
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// The OBJ of G-code [source] (UTF-16, as the browser holds it), parsed as the browser parses it.
pub fn write(
    source: &[u16],
    out: &mut dyn Write,
    cancel: &Cancellation,
) -> Result<Written, Failure> {
    let model =
        parse_with_cancellation(source, &Options::default(), cancel).map_err(
            |error| match error {
                ParseError::Cancelled => Failure::Cancelled,
                other => Failure::Invalid(format!("{other:?}")),
            },
        )?;
    write_model(&model, out, cancel)
}

/// Counts what is written, for the reply.
struct Counted<'a> {
    out: &'a mut dyn Write,
    bytes: u64,
}
impl Write for Counted<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.out.write(buf)?;
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.out.flush()
    }
}

/// The OBJ of a parsed [model].
pub fn write_model(
    model: &Model,
    out: &mut dyn Write,
    cancel: &Cancellation,
) -> Result<Written, Failure> {
    path::validate(model, cancel).map_err(|error| match error {
        path::PathError::Cancelled => Failure::Cancelled,
        path::PathError::Invalid(message) => Failure::Invalid(String::from_utf16_lossy(&message.0)),
    })?;
    let mut counted = Counted { out, bytes: 0 };
    let mut out = BufWriter::with_capacity(1 << 16, &mut counted);
    out.write_all(HEADER.as_bytes())?;
    let c = &model.columns;
    let p = &model.path_points;
    let mut fixed = ryu_js::Buffer::new();
    let mut vertex =
        |out: &mut BufWriter<&mut Counted<'_>>, x: f32, y: f32, z: f32| -> io::Result<()> {
            out.write_all(b"\nv ")?;
            out.write_all(fixed.format_to_fixed(f64::from(x), 4).as_bytes())?;
            out.write_all(b" ")?;
            out.write_all(fixed.format_to_fixed(f64::from(y), 4).as_bytes())?;
            out.write_all(b" ")?;
            out.write_all(fixed.format_to_fixed(f64::from(z), 4).as_bytes())
        };
    let mut segments = 0u64;
    for i in 0..c.count {
        if i.is_multiple_of(4096) && cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        if c.kind[i] != kind::EXTRUDE {
            continue;
        }
        let (mut x, mut y, mut z) = (c.start_x[i], c.start_y[i], c.start_z[i]);
        let end = (c.end_x[i], c.end_y[i], c.end_z[i]);
        if c.path_kind[i] == DIRECT {
            // `samePoint`: `===` on the values, so -0 and 0 are one point.
            if (x, y, z) != end {
                vertex(&mut out, x, y, z)?;
                vertex(&mut out, end.0, end.1, end.2)?;
                segments += 1;
            }
            continue;
        }
        let first = c.path_point_offset[i] as usize;
        for point in first..first + c.path_point_count[i] as usize {
            vertex(&mut out, x, y, z)?;
            (x, y, z) = (p.x[point], p.y[point], p.z[point]);
            vertex(&mut out, x, y, z)?;
            segments += 1;
        }
        vertex(&mut out, x, y, z)?;
        vertex(&mut out, end.0, end.1, end.2)?;
        segments += 1;
    }
    let mut number = [0u8; 20];
    for segment in 0..segments {
        if segment.is_multiple_of(1 << 16) && cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        let first = 2 * segment + 1;
        out.write_all(b"\nl ")?;
        out.write_all(decimal(&mut number, first))?;
        out.write_all(b" ")?;
        out.write_all(decimal(&mut number, first + 1))?;
    }
    out.flush()?;
    drop(out);
    Ok(Written {
        segments,
        bytes: counted.bytes,
    })
}

/// `String(value)` of a whole number, into [buffer].
fn decimal(buffer: &mut [u8; 20], mut value: u64) -> &[u8] {
    let mut at = buffer.len();
    loop {
        at -= 1;
        buffer[at] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            return &buffer[at..];
        }
    }
}
