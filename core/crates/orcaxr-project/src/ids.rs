//! Byte-for-byte compatible identifiers from the browser project domain.
//!
//! IDs preserve their original UTF-16 code units, including case and malformed
//! surrogates. Import namespaces use ASCII case-insensitive syntax, while the
//! payload rejects exactly ECMAScript whitespace. Rust Unicode whitespace and
//! UTF-8 strings would change which persisted IDs can round-trip.
use std::fmt;
use std::marker::PhantomData;
use std::sync::Arc;

/// An immutable, validated identifier. Cloning shares its text allocation.
/// `Hash` and `Ord` are for in-memory lookup, not persisted semantic hashes.
///
/// Entity families cannot be substituted for one another:
/// ```compile_fail
/// use orcaxr_project::ids::{ObjectId, PlateId};
/// let object = ObjectId::try_from_str("import:test:object").unwrap();
/// let plate: PlateId = object;
/// ```
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EntityId<K> {
    units: Arc<[u16]>,
    kind: PhantomData<K>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidEntityId;
impl fmt::Display for InvalidEntityId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Invalid stable entity ID.")
    }
}
impl std::error::Error for InvalidEntityId {}

impl<K> EntityId<K> {
    pub fn try_from_utf16(value: impl Into<Arc<[u16]>>) -> Result<Self, InvalidEntityId> {
        let units = value.into();
        if !is_stable_entity_id(&units) {
            return Err(InvalidEntityId);
        }
        Ok(Self {
            units,
            kind: PhantomData,
        })
    }

    /// Convenience for already-valid Unicode text. Use UTF-16 for transport data.
    pub fn try_from_str(value: &str) -> Result<Self, InvalidEntityId> {
        Self::try_from_utf16(value.encode_utf16().collect::<Vec<_>>())
    }

    pub fn as_utf16(&self) -> &[u16] {
        &self.units
    }
}

// IDs may contain arbitrary imported text. Diagnostics deliberately omit it.
impl<K> fmt::Debug for EntityId<K> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EntityId")
            .field("kind", &std::any::type_name::<K>())
            .field("utf16_length", &self.units.len())
            .finish()
    }
}

macro_rules! entity_kinds {
    ($($kind:ident => $alias:ident),+ $(,)?) => {
        pub mod kind {
            $(#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
            pub enum $kind {})+
        }
        $(pub type $alias = EntityId<kind::$kind>;)+
    };
}
entity_kinds! {
    Project => ProjectId, Plate => PlateId, Object => ObjectId,
    Volume => VolumeId, Instance => InstanceId, LayerRange => LayerRangeId,
    PhysicalFilament => PhysicalFilamentId, MixedFilament => MixedFilamentId,
    Filament => FilamentId, Asset => AssetId, Thumbnail => ThumbnailId,
    ExtensionBlob => ExtensionBlobId, CustomGcode => CustomGcodeId,
}

impl From<PhysicalFilamentId> for FilamentId {
    fn from(value: PhysicalFilamentId) -> Self {
        Self {
            units: value.units,
            kind: PhantomData,
        }
    }
}
impl From<MixedFilamentId> for FilamentId {
    fn from(value: MixedFilamentId) -> Self {
        Self {
            units: value.units,
            kind: PhantomData,
        }
    }
}

/// Matches the browser validator without normalizing, trimming or allocating.
pub fn is_stable_entity_id(value: &[u16]) -> bool {
    let uuid = value.len() == 36
        && value.iter().enumerate().all(|(index, unit)| match index {
            8 | 13 | 18 | 23 => *unit == u16::from(b'-'),
            14 => (u16::from(b'1')..=u16::from(b'8')).contains(unit),
            19 => matches!(*unit, 0x38 | 0x39 | 0x61 | 0x62 | 0x41 | 0x42),
            _ => matches!(*unit, 0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66),
        });
    if uuid {
        return true;
    }
    if value.len() < 10
        || !value[..7].iter().zip(b"import:").all(|(unit, expected)| {
            *unit <= 0x7f && (*unit as u8).to_ascii_lowercase() == *expected
        })
    {
        return false;
    }
    let rest = &value[7..];
    let Some(separator) = rest.iter().position(|unit| *unit == u16::from(b':')) else {
        return false;
    };
    separator > 0
        && separator + 1 < rest.len()
        && ascii_alphanumeric(rest[0])
        && rest[..separator]
            .iter()
            .all(|unit| ascii_alphanumeric(*unit) || matches!(*unit, 0x2e | 0x5f | 0x2d))
        && rest[separator + 1..]
            .iter()
            .all(|unit| !ecmascript_whitespace(*unit))
}

fn ascii_alphanumeric(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a)
}

pub(crate) fn ecmascript_whitespace(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

/// Injected by the host. Production randomness is the composition root's job;
/// this domain crate does not silently choose an entropy source.
pub trait RandomWordSource {
    fn next_word(&mut self) -> f64;
}
impl<F: FnMut() -> f64> RandomWordSource for F {
    fn next_word(&mut self) -> f64 {
        self()
    }
}

pub trait IdSource {
    fn next<K>(&mut self) -> EntityId<K>;
}

pub struct UuidIdSource<R> {
    random: R,
}
impl<R: RandomWordSource> UuidIdSource<R> {
    pub fn new(random: R) -> Self {
        Self { random }
    }
}
impl<R: RandomWordSource> IdSource for UuidIdSource<R> {
    fn next<K>(&mut self) -> EntityId<K> {
        let mut bytes = [0u8; 16];
        for byte in &mut bytes {
            let value = (self.random.next_word() * 256.0).floor();
            // JavaScript floor(... ) & 0xff wraps instead of saturating. Its
            // bitwise conversion maps non-finite input to zero.
            *byte = if value.is_finite() {
                value.rem_euclid(256.0) as u8
            } else {
                0
            };
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex = b"0123456789abcdef";
        let mut units = Vec::with_capacity(36);
        for (index, byte) in bytes.into_iter().enumerate() {
            if matches!(index, 4 | 6 | 8 | 10) {
                units.push(u16::from(b'-'));
            }
            units.push(u16::from(hex[usize::from(byte >> 4)]));
            units.push(u16::from(hex[usize::from(byte & 0x0f)]));
        }
        EntityId {
            units: units.into(),
            kind: PhantomData,
        }
    }
}

/// Browser-compatible xorshift32 for deterministic fixtures, not security.
#[derive(Clone)]
pub struct SeededRandom {
    state: u32,
}
impl SeededRandom {
    pub fn new(seed: f64) -> Self {
        let state = if seed.is_finite() {
            seed.trunc().rem_euclid(4294967296.0) as u32
        } else {
            0
        };
        Self {
            state: if state == 0 { 0x9e3779b9 } else { state },
        }
    }
}
impl RandomWordSource for SeededRandom {
    fn next_word(&mut self) -> f64 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 17;
        self.state ^= self.state << 5;
        f64::from(self.state) / 4294967296.0
    }
}
