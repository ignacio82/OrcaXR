//! The pool owns finished immutable inputs. A lease follows accepted work into
//! the queue, so taking a handle never bypasses the aggregate staging budget.
//! Parser/preparation tasks have separate host budgets; they are not registered
//! here before finishing and must observe their own cancellation/lifetime.
use super::*;
use crate::commands::staged::StagedWork;
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct StagingLimits {
    pub max_resources: usize,
    pub max_commands: usize,
    pub max_units: u64,
    /// Payload bytes held by staged work: each distinct asset once per work.
    pub max_asset_bytes: u64,
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct StagingUsage {
    pub resources: usize,
    pub commands: usize,
    pub units: u64,
    pub asset_bytes: u64,
}
impl StagingUsage {
    fn fits(self, limits: StagingLimits) -> bool {
        self.resources <= limits.max_resources
            && self.commands <= limits.max_commands
            && self.units <= limits.max_units
            && self.asset_bytes <= limits.max_asset_bytes
    }
}
struct Lease {
    budget: Arc<Mutex<StagingUsage>>,
    usage: StagingUsage,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut usage = self.budget.lock().expect("private staging counter lock");
        usage.resources -= self.usage.resources;
        usage.commands -= self.usage.commands;
        usage.units -= self.usage.units;
        usage.asset_bytes -= self.usage.asset_bytes;
    }
}
pub(super) struct StagedResource {
    pub guard: LocalGuard,
    pub work: StagedWork,
    // Last, so dropping prepared work and its guard precedes quota release.
    _lease: Lease,
}
#[derive(Default)]
pub(super) struct StagingPool {
    limits: StagingLimits,
    budget: Arc<Mutex<StagingUsage>>,
    next: u64,
    ready: BTreeMap<u64, StagedResource>,
}
impl StagingPool {
    pub fn usage(&self) -> StagingUsage {
        *self.budget.lock().expect("private staging counter lock")
    }
    pub fn configure(&mut self, limits: StagingLimits) -> Result<(), wire::SessionError> {
        let max = crate::store::MAX_REVISION;
        if limits.max_resources as u64 > max
            || limits.max_commands as u64 > max
            || limits.max_units > max
            || limits.max_asset_bytes > max
        {
            return Err(wire::SessionError::InvalidRequest);
        }
        if !self.usage().fits(limits) {
            return Err(wire::SessionError::Busy);
        }
        self.limits = limits;
        Ok(())
    }
    pub fn stage(
        &mut self,
        guard: LocalGuard,
        work: StagedWork,
    ) -> Result<u64, wire::SessionError> {
        if self.next == crate::store::MAX_REVISION {
            return Err(wire::SessionError::ResourceLimit);
        }
        let charge = StagingUsage {
            resources: 1,
            commands: work.command_count(),
            units: work.units(),
            asset_bytes: work.asset_bytes(),
        };
        let mut usage = self.budget.lock().expect("private staging counter lock");
        let next = StagingUsage {
            resources: usage
                .resources
                .checked_add(charge.resources)
                .ok_or(wire::SessionError::ResourceLimit)?,
            commands: usage
                .commands
                .checked_add(charge.commands)
                .ok_or(wire::SessionError::ResourceLimit)?,
            units: usage
                .units
                .checked_add(charge.units)
                .ok_or(wire::SessionError::ResourceLimit)?,
            asset_bytes: usage
                .asset_bytes
                .checked_add(charge.asset_bytes)
                .ok_or(wire::SessionError::ResourceLimit)?,
        };
        if !next.fits(self.limits) {
            return Err(wire::SessionError::ResourceLimit);
        }
        *usage = next;
        drop(usage);
        self.next += 1;
        self.ready.insert(
            self.next,
            StagedResource {
                guard,
                work,
                _lease: Lease {
                    budget: self.budget.clone(),
                    usage: charge,
                },
            },
        );
        Ok(self.next)
    }
    pub fn take(&mut self, id: u64) -> Option<StagedResource> {
        self.ready.remove(&id)
    }
    pub fn release(&mut self, id: u64) -> bool {
        self.ready.remove(&id).is_some()
    }
    pub fn clear(&mut self) {
        self.ready.clear();
    }
}
