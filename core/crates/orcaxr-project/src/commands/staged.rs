//! Immutable command input, measured before it enters a session staging pool.
//! The charge is encoded UTF-16 units, not a claim about resident memory. Hosts
//! still budget their parser/preparation tasks independently. History estimates
//! cannot serve this purpose: an unapplied paste has a history estimate of one.
use super::*;
use std::io::{self, Write};

#[derive(Debug)]
pub enum CaptureError {
    Limit,
    Encoding,
    Preparation(PreparationError),
}
impl fmt::Display for CaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}
impl std::error::Error for CaptureError {}

/// Constructors capture and measure every retained input. Callers cannot forge
/// a smaller charge or mutate the resulting command. Preparation belongs to an
/// owned task; this is not a large synchronous operation for an authority worker.
pub struct CapturedCommand {
    pub(crate) command: PreparedCommand,
    units: u64,
}
impl CapturedCommand {
    pub fn units(&self) -> u64 {
        self.units
    }
    pub fn instance(
        object: ObjectId,
        instance: Arc<ProjectInstance>,
        index: Option<Number>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"createInstance\",")?;
            object.write_json(out)?;
            out.write_all(b",")?;
            instance.write_json(out)?;
            out.write_all(b",")?;
            optional(&index, out)?;
            out.write_all(b"]")
        })?;
        Ok(Self {
            command: PreparedCommand::create_instance(object, instance, index),
            units,
        })
    }
    pub fn paste(
        template: Arc<ProjectObject>,
        ids: IndependentObjectIds,
        destination: Option<PlateId>,
        name: Option<Text>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"pasteObject\",")?;
            template.write_json(out)?;
            out.write_all(b",")?;
            ids.object_id.write_json(out)?;
            out.write_all(b",")?;
            list(&ids.volume_ids, out)?;
            out.write_all(b",")?;
            list(&ids.instance_ids, out)?;
            out.write_all(b",")?;
            list(&ids.layer_range_ids, out)?;
            out.write_all(b",")?;
            optional(&destination, out)?;
            out.write_all(b",")?;
            optional(&name, out)?;
            out.write_all(b"]")
        })?;
        let command = PreparedCommand::paste_object(template, ids, destination, name)
            .map_err(CaptureError::Preparation)?;
        Ok(Self { command, units })
    }
    /// Existing small intents can participate in the same staged transaction.
    /// Their normal strict decoder and resource limits still precede execution.
    pub fn intent(json: &str, max_units: u64) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"intent\",")?;
            out.write_all(json.as_bytes())?;
            out.write_all(b"]")
        })?;
        let command = prepare_intent(json).map_err(CaptureError::Preparation)?;
        Ok(Self { command, units })
    }
    pub fn clipboard_paste(
        clipboard: Arc<crate::clipboard::ClipboardData>,
        ids: IndependentObjectIds,
        destination: Option<PlateId>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        let units = measure(max_units, |out| {
            out.write_all(b"[\"pasteObjectWithAssets\",")?;
            clipboard.object().write_json(out)?;
            out.write_all(b",")?;
            ids.object_id.write_json(out)?;
            out.write_all(b",")?;
            list(&ids.volume_ids, out)?;
            out.write_all(b",")?;
            list(&ids.instance_ids, out)?;
            out.write_all(b",")?;
            list(&ids.layer_range_ids, out)?;
            out.write_all(b",")?;
            optional(&destination, out)?;
            out.write_all(b",")?;
            list(clipboard.descriptors(), out)?;
            out.write_all(b"]")
        })?;
        let command = PreparedCommand::paste_clipboard(clipboard, ids, destination)
            .map_err(CaptureError::Preparation)?;
        Ok(Self { command, units })
    }
}
fn list<T: Encode>(values: &[T], out: &mut dyn Write) -> io::Result<()> {
    out.write_all(b"[")?;
    for (i, value) in values.iter().enumerate() {
        if i != 0 {
            out.write_all(b",")?;
        }
        value.write_json(out)?;
    }
    out.write_all(b"]")
}
fn optional<T: Encode>(value: &Option<T>, out: &mut dyn Write) -> io::Result<()> {
    match value {
        Some(value) => value.write_json(out),
        None => out.write_all(b"null"),
    }
}

pub struct StagedWork {
    pub(crate) kind: WorkKind,
    units: u64,
    commands: usize,
}
pub(crate) enum WorkKind {
    Single(PreparedCommand),
    Transaction {
        label: Text,
        commands: Vec<PreparedCommand>,
    },
}
impl StagedWork {
    pub fn single(captured: CapturedCommand) -> Self {
        Self {
            units: captured.units,
            commands: 1,
            kind: WorkKind::Single(captured.command),
        }
    }
    pub fn transaction(
        label: Text,
        commands: Vec<CapturedCommand>,
        max_units: u64,
    ) -> Result<Self, CaptureError> {
        // Charge the equivalent [label,[captured arguments...]] serialization.
        let mut units = measure(max_units, |out| {
            out.write_all(b"[")?;
            label.write_json(out)?;
            out.write_all(b",[]]")
        })?;
        for (i, command) in commands.iter().enumerate() {
            units = units
                .checked_add(command.units)
                .and_then(|n| n.checked_add(u64::from(i != 0)))
                .filter(|&n| n <= max_units)
                .ok_or(CaptureError::Limit)?;
        }
        Ok(Self {
            units,
            commands: commands.len(),
            kind: WorkKind::Transaction {
                label,
                commands: commands.into_iter().map(|c| c.command).collect(),
            },
        })
    }
    pub fn units(&self) -> u64 {
        self.units
    }
    pub fn command_count(&self) -> usize {
        self.commands
    }
}

fn measure(
    limit: u64,
    write: impl FnOnce(&mut dyn Write) -> io::Result<()>,
) -> Result<u64, CaptureError> {
    struct Counter {
        units: u64,
        limit: u64,
        exhausted: bool,
    }
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            for &byte in bytes {
                let units = if byte & 0xc0 == 0x80 {
                    0
                } else if byte >= 0xf0 {
                    2
                } else {
                    1
                };
                let Some(next) = self.units.checked_add(units).filter(|&n| n <= self.limit) else {
                    self.exhausted = true;
                    return Err(io::Error::other("command input budget exhausted"));
                };
                self.units = next;
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        units: 0,
        limit,
        exhausted: false,
    };
    write(&mut counter).map_err(|_| {
        if counter.exhausted {
            CaptureError::Limit
        } else {
            CaptureError::Encoding
        }
    })?;
    Ok(counter.units)
}
