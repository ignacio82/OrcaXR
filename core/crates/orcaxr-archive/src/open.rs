//! One archive Open for hosts: a package with the OrcaXR envelope completes
//! through canonical staging; any other 3MF imports as a foreign BBS package.
//! This mirrors the browser serializer's `deserialize` dispatch. Both paths end in
//! the same completed archive, whose guarded adoption belongs to the host.
use crate::{
    Archive,
    bbs::foreign,
    canonical::{
        CanonicalArchiveSource, CompleteLimits, CompletedCanonicalArchive, ENVELOPE_PATH, Error,
    },
};
use orcaxr_project::{ingress::ProjectInputLimits, validation::TimestampPolicy};
use std::io::{Read, Seek};

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Canonical envelope staging (document and declared asset budgets).
    pub canonical: ProjectInputLimits,
    /// Completion, preservation and admission, shared by both paths.
    pub complete: CompleteLimits,
    /// Foreign model structure and metadata members. Its `complete` budgets are
    /// replaced by `complete` above so one policy governs both paths.
    pub foreign: foreign::Limits,
}

/// Which path an archive took; hosts may report it but never need it to adopt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Canonical,
    Foreign,
}

pub fn format<R: Read + Seek>(archive: &Archive<R>) -> Format {
    if archive
        .entries()
        .iter()
        .any(|e| !e.is_directory() && e.path() == ENVELOPE_PATH)
    {
        Format::Canonical
    } else {
        Format::Foreign
    }
}

/// Complete one privately staged archive. Failure or cancellation publishes no
/// state; the result must still be adopted under the host's original Open guard.
pub fn open<R: Read + Seek, P: TimestampPolicy>(
    archive: Archive<R>,
    limits: Limits,
    timestamps: &mut P,
    mut cancelled: impl FnMut() -> bool,
) -> Result<CompletedCanonicalArchive, Error<P::Error>> {
    match format(&archive) {
        Format::Canonical => {
            CanonicalArchiveSource::decode(archive, limits.canonical, timestamps, &mut cancelled)?
                .complete(limits.complete, timestamps, &mut cancelled)
        }
        Format::Foreign => foreign::import(
            archive,
            foreign::Limits {
                complete: limits.complete,
                ..limits.foreign
            },
            timestamps,
            &mut cancelled,
        ),
    }
}
