//! Immutable source assets and opaque rollback versions. Only public mutable
//! reads/imports copy payloads; leases and internal history share byte allocations.
//!
//! Descriptors retain their entire canonical JSON value, including unknown fields
//! and UTF-16 strings. This repository validates identity, canonical metadata,
//! byte length and declared FNV digests. The project graph validator separately
//! owns mesh layout, media type, source kind and reference validation.
use std::collections::BTreeMap;
use std::fmt;
use std::io::{self, Write};
use std::sync::{Arc, OnceLock, Weak};

use orcaxr_contracts::canonical::Value;

use crate::ids::AssetId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetError {
    InvalidDescriptor,
    ByteLengthMismatch,
    DigestMismatch,
    ImmutableConflict,
    DuplicateId,
    ForeignSnapshot,
    ForeignSelection,
    MissingAsset,
    SelectionLimit,
}
impl fmt::Display for AssetError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(match self {
            Self::InvalidDescriptor => "Invalid asset descriptor.",
            Self::ByteLengthMismatch => "Asset byte length does not match its descriptor.",
            Self::DigestMismatch => "Asset content does not match its declared digest.",
            Self::ImmutableConflict => "An immutable asset cannot be replaced.",
            Self::DuplicateId => "Asset snapshot contains a duplicate ID.",
            Self::ForeignSnapshot => "Invalid or foreign internal asset snapshot.",
            Self::ForeignSelection => "Invalid or foreign asset capture.",
            Self::MissingAsset => "Missing clipboard asset.",
            Self::SelectionLimit => "Clipboard assets exceed their capture limit.",
        })
    }
}
impl std::error::Error for AssetError {}

/// Mutable transport/import copy. Not an internal rollback handle.
#[derive(Clone, PartialEq)]
pub struct AssetPayload {
    pub descriptor: Value,
    pub bytes: Vec<u8>,
}

struct Record {
    id: AssetId,
    descriptor: Value,
    declared_digest: Vec<u16>,
    bytes: Box<[u8]>,
    content_digest: OnceLock<String>,
}
impl Record {
    fn copy(&self) -> AssetPayload {
        AssetPayload {
            descriptor: self.descriptor.clone(),
            bytes: self.bytes.to_vec(),
        }
    }
    fn content_digest(&self) -> &str {
        self.content_digest
            .get_or_init(|| content_digest(&self.bytes))
    }
}

/// A read-only lease can outlive the repository, a removal or a history branch.
/// Cloning it never copies bytes; callers cannot mutate the stored descriptor.
/// ```compile_fail
/// use orcaxr_project::assets::AssetLease;
/// fn mutate(lease: AssetLease) { lease.bytes()[0] = 42; }
/// ```
#[derive(Clone)]
pub struct AssetLease(Arc<Record>);
impl AssetLease {
    /// Validate a transfer once (descriptor, length, digest) into an immutable
    /// record that any repository can adopt by reference: staged command
    /// payloads are installed again on every redo without copying their bytes.
    pub fn from_payload(payload: AssetPayload) -> Result<Self, AssetError> {
        let validated = validate(&payload.descriptor, &payload.bytes)?;
        Ok(Self(owned_record(
            validated,
            payload.descriptor,
            payload.bytes.into_boxed_slice(),
        )))
    }
    pub fn id(&self) -> &AssetId {
        &self.0.id
    }
    pub fn descriptor(&self) -> &Value {
        &self.0.descriptor
    }
    pub fn bytes(&self) -> &[u8] {
        &self.0.bytes
    }
    pub fn content_digest(&self) -> &str {
        self.0.content_digest()
    }
    /// Stable renderer/cache identity, restored with the original history version.
    pub fn same_record(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl fmt::Debug for AssetLease {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("AssetLease")
            .field("byte_length", &self.0.bytes.len())
            .finish_non_exhaustive()
    }
}

#[derive(Default)]
struct Version {
    entries: BTreeMap<AssetId, Arc<Record>>,
    // Browser Map iteration order selects the first matching digest. Canonical
    // list/hash ordering is UTF-16 ID order instead; never conflate the two.
    insertion_order: Vec<AssetId>,
    fingerprint: OnceLock<String>,
}

/// Opaque repository-owned history. No public constructor or deserializer.
/// A weak owner avoids a snapshot/repository retention cycle; the version itself
/// owns the immutable records needed to restore this branch.
#[derive(Clone)]
pub struct AssetSnapshot {
    owner: Weak<()>,
    version: Arc<Version>,
}
impl AssetSnapshot {
    pub fn peek(&self, id: &AssetId) -> Option<AssetLease> {
        self.version.entries.get(id).cloned().map(AssetLease)
    }
    /// Select immutable records on a preparation worker without a live repository.
    pub fn capture_selection(
        &self,
        ids: &[AssetId],
        max_assets: usize,
        max_bytes: u64,
    ) -> Result<AssetSelection, AssetError> {
        if ids.len() > max_assets {
            return Err(AssetError::SelectionLimit);
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut records = Vec::with_capacity(ids.len());
        let mut bytes = 0u64;
        for id in ids {
            if !seen.insert(id) {
                return Err(AssetError::DuplicateId);
            }
            let record = self
                .version
                .entries
                .get(id)
                .ok_or(AssetError::MissingAsset)?;
            bytes = bytes
                .checked_add(record.bytes.len() as u64)
                .filter(|n| *n <= max_bytes)
                .ok_or(AssetError::SelectionLimit)?;
            records.push(record.clone());
        }
        Ok(AssetSelection {
            owner: self.owner.clone(),
            records: records.into(),
            bytes,
        })
    }
    pub fn same_version(&self, other: &Self) -> bool {
        Weak::ptr_eq(&self.owner, &other.owner) && Arc::ptr_eq(&self.version, &other.version)
    }
}
impl fmt::Debug for AssetSnapshot {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("AssetSnapshot")
            .field("entries", &self.version.entries.len())
            .finish_non_exhaustive()
    }
}

pub struct AssetRepository {
    owner: Arc<()>,
    version: Arc<Version>,
}

/// Selected immutable records, in capture order. This is not a whole repository
/// rollback version. Its weak owner cannot keep a disposed repository alive.
#[derive(Clone)]
pub struct AssetSelection {
    owner: Weak<()>,
    records: Arc<[Arc<Record>]>,
    bytes: u64,
}
impl AssetSelection {
    pub fn byte_length(&self) -> u64 {
        self.bytes
    }
    pub fn len(&self) -> usize {
        self.records.len()
    }
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
    pub fn leases(&self) -> impl ExactSizeIterator<Item = AssetLease> + '_ {
        self.records.iter().cloned().map(AssetLease)
    }
}
impl fmt::Debug for AssetSelection {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("AssetSelection")
            .field("records", &self.len())
            .field("bytes", &self.bytes)
            .finish()
    }
}
impl Default for AssetRepository {
    fn default() -> Self {
        Self::new()
    }
}
impl AssetRepository {
    /// Consume an already validated repository version without copying records.
    /// Preserve this authority's owner identity, including its clipboard subsets.
    pub(crate) fn adopt(&mut self, source: Self) {
        self.version = source.version;
    }
    pub fn new() -> Self {
        Self {
            owner: Arc::new(()),
            version: Arc::new(Version::default()),
        }
    }
    /// Borrow immutable descriptor IDs in canonical UTF-16 order, without
    /// copying public payloads while checking a project bundle.
    pub fn ids(&self) -> impl Iterator<Item = &AssetId> {
        self.version.entries.keys()
    }
    pub fn len(&self) -> usize {
        self.version.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.version.entries.is_empty()
    }
    pub fn has(&self, id: &AssetId) -> bool {
        self.version.entries.contains_key(id)
    }
    pub fn get(&self, id: &AssetId) -> Option<AssetPayload> {
        self.version.entries.get(id).map(|entry| entry.copy())
    }
    pub fn peek(&self, id: &AssetId) -> Option<AssetLease> {
        self.version.entries.get(id).cloned().map(AssetLease)
    }
    pub fn list(&self) -> Vec<AssetPayload> {
        self.version
            .entries
            .values()
            .map(|entry| entry.copy())
            .collect()
    }
    pub fn capture(&self) -> Vec<AssetPayload> {
        self.list()
    }
    /// The first asset, in insertion order, declaring `digest`, without copying it.
    pub fn find_id_by_digest(&self, digest: &[u16]) -> Option<&AssetId> {
        self.version
            .insertion_order
            .iter()
            .find(|id| self.version.entries[*id].declared_digest == digest)
    }
    pub fn find_by_digest(&self, digest: &[u16]) -> Option<AssetPayload> {
        self.version.insertion_order.iter().find_map(|id| {
            let entry = &self.version.entries[id];
            (entry.declared_digest == digest).then(|| entry.copy())
        })
    }

    /// Copy a caller-owned payload only after validation. Identical puts are
    /// no-ops; neither records, fingerprints nor snapshot identity change.
    pub fn put(&mut self, descriptor: &Value, bytes: &[u8]) -> Result<bool, AssetError> {
        let validated = validate(descriptor, bytes)?;
        if let Some(existing) = self.version.entries.get(&validated.id) {
            if existing.descriptor != *descriptor || existing.bytes.as_ref() != bytes {
                return Err(AssetError::ImmutableConflict);
            }
            return Ok(false);
        }
        let mut entries = self.version.entries.clone();
        let mut insertion_order = self.version.insertion_order.clone();
        insertion_order.push(validated.id.clone());
        entries.insert(
            validated.id.clone(),
            owned_record(validated, descriptor.clone(), bytes.into()),
        );
        self.version = Arc::new(Version {
            entries,
            insertion_order,
            fingerprint: OnceLock::new(),
        });
        Ok(true)
    }
    /// Consume a uniquely owned transfer after the same public validation. This
    /// is an ownership transfer, not a trust bypass: lengths, digests, metadata
    /// and immutable conflicts are still checked before publishing a record.
    pub fn put_owned(&mut self, payload: AssetPayload) -> Result<bool, AssetError> {
        let validated = validate(&payload.descriptor, &payload.bytes)?;
        if let Some(existing) = self.version.entries.get(&validated.id) {
            if existing.descriptor != payload.descriptor || existing.bytes.as_ref() != payload.bytes
            {
                return Err(AssetError::ImmutableConflict);
            }
            return Ok(false);
        }
        let mut entries = self.version.entries.clone();
        let mut insertion_order = self.version.insertion_order.clone();
        insertion_order.push(validated.id.clone());
        entries.insert(
            validated.id.clone(),
            owned_record(
                validated,
                payload.descriptor,
                payload.bytes.into_boxed_slice(),
            ),
        );
        self.version = Arc::new(Version {
            entries,
            insertion_order,
            fingerprint: OnceLock::new(),
        });
        Ok(true)
    }
    /// `put` of an already validated lease: the record is shared, never copied.
    /// An existing record must have the same descriptor and bytes.
    pub fn put_lease(&mut self, lease: &AssetLease) -> Result<bool, AssetError> {
        let record = &lease.0;
        if let Some(existing) = self.version.entries.get(&record.id) {
            if existing.descriptor != record.descriptor || existing.bytes != record.bytes {
                return Err(AssetError::ImmutableConflict);
            }
            return Ok(false);
        }
        let mut entries = self.version.entries.clone();
        let mut insertion_order = self.version.insertion_order.clone();
        insertion_order.push(record.id.clone());
        entries.insert(record.id.clone(), record.clone());
        self.version = Arc::new(Version {
            entries,
            insertion_order,
            fingerprint: OnceLock::new(),
        });
        Ok(true)
    }
    pub fn remove(&mut self, id: &AssetId) -> bool {
        if !self.has(id) {
            return false;
        }
        let mut entries = self.version.entries.clone();
        entries.remove(id);
        let insertion_order = self
            .version
            .insertion_order
            .iter()
            .filter(|entry| *entry != id)
            .cloned()
            .collect();
        self.version = Arc::new(Version {
            entries,
            insertion_order,
            fingerprint: OnceLock::new(),
        });
        true
    }
    pub fn capture_internal(&self) -> AssetSnapshot {
        AssetSnapshot {
            owner: Arc::downgrade(&self.owner),
            version: Arc::clone(&self.version),
        }
    }
    pub fn restore_internal(&mut self, snapshot: &AssetSnapshot) -> Result<(), AssetError> {
        if !Weak::ptr_eq(&snapshot.owner, &Arc::downgrade(&self.owner)) {
            return Err(AssetError::ForeignSnapshot);
        }
        self.version = Arc::clone(&snapshot.version);
        Ok(())
    }

    pub fn capture_selection(
        &self,
        ids: &[AssetId],
        max_assets: usize,
        max_bytes: u64,
    ) -> Result<AssetSelection, AssetError> {
        self.capture_internal()
            .capture_selection(ids, max_assets, max_bytes)
    }
    pub fn owns_selection(&self, selection: &AssetSelection) -> bool {
        Weak::ptr_eq(&selection.owner, &Arc::downgrade(&self.owner))
    }
    /// Check every conflict before publishing a new version. Captured records
    /// retain allocation identity through removal, reintroduction and history.
    pub fn merge_selection(&mut self, selection: &AssetSelection) -> Result<bool, AssetError> {
        if !self.owns_selection(selection) {
            return Err(AssetError::ForeignSelection);
        }
        let mut missing = Vec::new();
        for record in selection.records.iter() {
            if let Some(existing) = self.version.entries.get(&record.id) {
                if !Arc::ptr_eq(existing, record)
                    && (existing.descriptor != record.descriptor || existing.bytes != record.bytes)
                {
                    return Err(AssetError::ImmutableConflict);
                }
            } else {
                missing.push(record.clone());
            }
        }
        if missing.is_empty() {
            return Ok(false);
        }
        let mut entries = self.version.entries.clone();
        let mut insertion_order = self.version.insertion_order.clone();
        for record in missing {
            insertion_order.push(record.id.clone());
            entries.insert(record.id.clone(), record);
        }
        self.version = Arc::new(Version {
            entries,
            insertion_order,
            fingerprint: OnceLock::new(),
        });
        Ok(true)
    }

    /// Validate/copy a public import before publishing any change. Identical
    /// imports still create fresh record/version identities, like the browser.
    pub fn restore(&mut self, payloads: &[AssetPayload]) -> Result<(), AssetError> {
        let mut entries = BTreeMap::new();
        let mut insertion_order = Vec::with_capacity(payloads.len());
        for payload in payloads {
            // Duplicate identity takes precedence over a later bad length/digest.
            let id = descriptor_id(&payload.descriptor)?;
            if entries.contains_key(&id) {
                return Err(AssetError::DuplicateId);
            }
            let validated = validate(&payload.descriptor, &payload.bytes)?;
            insertion_order.push(id.clone());
            entries.insert(
                id,
                owned_record(
                    validated,
                    payload.descriptor.clone(),
                    payload.bytes.as_slice().into(),
                ),
            );
        }
        self.version = Arc::new(Version {
            entries,
            insertion_order,
            fingerprint: OnceLock::new(),
        });
        Ok(())
    }

    /// `restore` for payloads a staged command already validated: the records
    /// are adopted by reference, so a large import is not copied again. Each
    /// capture made its own records, so an identical import is still fresh.
    pub fn restore_leases(&mut self, leases: &[AssetLease]) -> Result<(), AssetError> {
        let mut entries = BTreeMap::new();
        let mut insertion_order = Vec::with_capacity(leases.len());
        for lease in leases {
            if entries.contains_key(lease.id()) {
                return Err(AssetError::DuplicateId);
            }
            insertion_order.push(lease.id().clone());
            entries.insert(lease.id().clone(), lease.0.clone());
        }
        self.version = Arc::new(Version {
            entries,
            insertion_order,
            fingerprint: OnceLock::new(),
        });
        Ok(())
    }

    /// Stream canonical metadata and cached byte digests in UTF-16 ID order.
    /// No complete JSON string, serialized bundle or mesh copy is allocated.
    pub fn bundle_fingerprint(&self) -> &str {
        self.version.fingerprint.get_or_init(|| {
            let mut sink = Fnv::default();
            sink.write_all(b"[").expect("infallible digest sink");
            for (index, entry) in self.version.entries.values().enumerate() {
                if index > 0 {
                    sink.write_all(b",").expect("infallible digest sink");
                }
                sink.write_all(b"{\"content\":\"")
                    .expect("infallible digest sink");
                sink.write_all(entry.content_digest().as_bytes())
                    .expect("infallible digest sink");
                sink.write_all(b"\",\"descriptor\":")
                    .expect("infallible digest sink");
                entry
                    .descriptor
                    .write_canonical(&mut sink)
                    .expect("validated immutable descriptor");
                sink.write_all(b"}").expect("infallible digest sink");
            }
            sink.write_all(b"]").expect("infallible digest sink");
            sink.digest()
        })
    }
}

struct Validated {
    id: AssetId,
    declared_digest: Vec<u16>,
    content_digest: Option<String>,
}
fn field<'a>(descriptor: &'a Value, name: &str) -> Result<&'a Value, AssetError> {
    let Value::Object(fields) = descriptor else {
        return Err(AssetError::InvalidDescriptor);
    };
    fields
        .get(&name.encode_utf16().collect::<Vec<_>>())
        .ok_or(AssetError::InvalidDescriptor)
}
fn descriptor_id(descriptor: &Value) -> Result<AssetId, AssetError> {
    let Value::String(units) = field(descriptor, "id")? else {
        return Err(AssetError::InvalidDescriptor);
    };
    AssetId::try_from_utf16(units.clone()).map_err(|_| AssetError::InvalidDescriptor)
}
fn validate(descriptor: &Value, bytes: &[u8]) -> Result<Validated, AssetError> {
    let id = descriptor_id(descriptor)?;
    let Value::Number(byte_length) = field(descriptor, "byteLength")? else {
        return Err(AssetError::InvalidDescriptor);
    };
    if *byte_length != bytes.len() as f64 {
        return Err(AssetError::ByteLengthMismatch);
    }
    let Value::String(digest) = field(descriptor, "digest")? else {
        return Err(AssetError::InvalidDescriptor);
    };
    let content_digest = if digest.starts_with(&[102, 110, 118, 49, 97, 54, 52, 58]) {
        let actual = content_digest(bytes);
        if !digest.iter().copied().eq(actual.encode_utf16()) {
            return Err(AssetError::DigestMismatch);
        }
        Some(actual)
    } else {
        None
    };
    // Preserve opaque canonical metadata, but never retain non-finite values
    // that would make a later snapshot fingerprint fail after commit.
    descriptor
        .write_canonical(&mut io::sink())
        .map_err(|_| AssetError::InvalidDescriptor)?;
    Ok(Validated {
        id,
        declared_digest: digest.clone(),
        content_digest,
    })
}
fn owned_record(validated: Validated, descriptor: Value, bytes: Box<[u8]>) -> Arc<Record> {
    let content_digest = OnceLock::new();
    if let Some(digest) = validated.content_digest {
        content_digest.set(digest).expect("new cell");
    }
    Arc::new(Record {
        id: validated.id,
        descriptor,
        declared_digest: validated.declared_digest,
        bytes,
        content_digest,
    })
}

pub fn content_digest(bytes: &[u8]) -> String {
    let mut sink = Fnv::default();
    sink.write_all(bytes).expect("infallible digest sink");
    sink.digest()
}
struct Fnv(u64);
impl Default for Fnv {
    fn default() -> Self {
        Self(0xcbf29ce484222325)
    }
}
impl Fnv {
    fn digest(&self) -> String {
        format!("fnv1a64:{:016x}", self.0)
    }
}
impl Write for Fnv {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        for byte in bytes {
            self.0 = (self.0 ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod lifetime_tests {
    use super::*;
    use orcaxr_contracts::canonical::parse;
    #[test]
    fn cached_versions_and_records_are_released_after_last_owner() {
        let mut repository = AssetRepository::new();
        let descriptor =
            parse(r#"{"id":"import:test:asset","byteLength":3,"digest":"opaque"}"#).unwrap();
        repository.put(&descriptor, &[1, 2, 3]).unwrap();
        let lease = repository
            .peek(&descriptor_id(&descriptor).unwrap())
            .unwrap();
        let record = Arc::downgrade(&lease.0);
        let snapshot = repository.capture_internal();
        let version = Arc::downgrade(&snapshot.version);
        assert!(lease.0.content_digest.get().is_none());
        let fingerprint = repository.bundle_fingerprint().as_ptr();
        assert!(lease.0.content_digest.get().is_some());
        let digest = lease.0.content_digest.get().unwrap().as_ptr();
        repository.remove(lease.id());
        repository.restore_internal(&snapshot).unwrap();
        assert_eq!(repository.bundle_fingerprint().as_ptr(), fingerprint);
        assert_eq!(lease.content_digest().as_ptr(), digest);
        drop(repository);
        assert!(version.upgrade().is_some());
        drop(snapshot);
        assert!(version.upgrade().is_none());
        assert!(record.upgrade().is_some());
        assert_eq!(lease.bytes(), &[1, 2, 3]);
        drop(lease);
        assert!(record.upgrade().is_none());
    }
}
