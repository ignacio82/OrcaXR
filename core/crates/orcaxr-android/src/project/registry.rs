//! JNI handles are never pointers or reused IDs. Removing a handle does not
//! release admission until every in-flight call has dropped its owner.
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    },
};

type Result<T> = std::result::Result<T, &'static str>;
struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}
fn permit(count: &Arc<AtomicUsize>, limit: usize) -> Result<Permit> {
    count
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
            (n < limit).then_some(n + 1)
        })
        .map_err(|_| "resource_limit")?;
    Ok(Permit(count.clone()))
}
pub(super) struct Slot<T> {
    value: Mutex<Option<T>>,
    closed: AtomicBool,
    // Drop the value before releasing admission, including during unwinding.
    _total: Permit,
    _document: Option<Permit>,
}
impl<T> Slot<T> {
    pub fn with<R>(&self, call: impl FnOnce(&mut Option<T>) -> Result<R>) -> Result<R> {
        // Kotlin serializes ordinary calls. Refuse concurrent or reentrant raw
        // JNI calls instead of deadlocking in a timezone-service callback.
        let mut value = self.value.try_lock().map_err(|_| "busy_or_failed")?;
        if self.closed.load(Ordering::Acquire) {
            return Err("closed");
        }
        let result = call(&mut value)?;
        if self.closed.load(Ordering::Acquire) {
            return Err("closed");
        }
        Ok(result)
    }
}
pub(super) struct Registry<T> {
    slots: Mutex<HashMap<i64, Arc<Slot<T>>>>,
    next: AtomicI64,
    total: Arc<AtomicUsize>,
    documents: Arc<AtomicUsize>,
    total_limit: usize,
    document_limit: usize,
}
pub(super) struct Reservation<'a, T> {
    registry: &'a Registry<T>,
    id: i64,
    total: Permit,
    document: Option<Permit>,
}
impl<T> Reservation<'_, T> {
    pub fn insert(self, value: T) -> Result<i64> {
        let slot = Arc::new(Slot {
            value: Mutex::new(Some(value)),
            closed: AtomicBool::new(false),
            _total: self.total,
            _document: self.document,
        });
        self.registry
            .slots
            .lock()
            .map_err(|_| "core_failure")?
            .insert(self.id, slot);
        Ok(self.id)
    }
}
impl<T> Registry<T> {
    pub fn new(total_limit: usize, document_limit: usize) -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
            next: AtomicI64::new(1),
            total: Default::default(),
            documents: Default::default(),
            total_limit,
            document_limit,
        }
    }
    /// Reserve a result handle before a command may commit. Capacity failure
    /// therefore cannot silently discard a completed response or its effects.
    pub fn reserve(&self, document: bool) -> Result<Reservation<'_, T>> {
        let total = permit(&self.total, self.total_limit)?;
        let document = if document {
            Some(permit(&self.documents, self.document_limit)?)
        } else {
            None
        };
        let id = self
            .next
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| v.checked_add(1))
            .map_err(|_| "resource_limit")?;
        Ok(Reservation {
            registry: self,
            id,
            total,
            document,
        })
    }
    pub fn slot(&self, handle: i64) -> Result<Arc<Slot<T>>> {
        self.slots
            .lock()
            .map_err(|_| "core_failure")?
            .get(&handle)
            .cloned()
            .ok_or("closed")
    }
    pub fn close(&self, handle: i64) -> Result<()> {
        let slot = self
            .slots
            .lock()
            .map_err(|_| "core_failure")?
            .remove(&handle);
        if let Some(slot) = slot {
            slot.closed.store(true, Ordering::Release);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn close_keeps_admission_until_inflight_owner_is_released() {
        let registry = Registry::new(4, 1);
        let id = registry.reserve(true).unwrap().insert(41).unwrap();
        let active = registry.slot(id).unwrap();
        registry.close(id).unwrap();
        assert!(registry.slot(id).is_err());
        assert!(registry.reserve(true).is_err());
        assert_eq!(active.with(|v| Ok(v.take())), Err("closed"));
        drop(active);
        let replacement = registry.reserve(true).unwrap().insert(42).unwrap();
        assert!(replacement > id);
        registry.close(replacement).unwrap();
        registry.close(replacement).unwrap();
        assert_eq!(registry.total.load(Ordering::Relaxed), 0);
        assert_eq!(registry.documents.load(Ordering::Relaxed), 0);
    }
    #[test]
    fn failed_reservations_do_not_leak_or_mutate_and_reentrant_calls_refuse() {
        let registry = Registry::new(1, 1);
        let id = registry.reserve(true).unwrap().insert(1).unwrap();
        let slot = registry.slot(id).unwrap();
        slot.with(|v| {
            assert!(registry.reserve(false).is_err());
            assert_eq!(slot.with(|_| Ok(())), Err("busy_or_failed"));
            assert_eq!(*v, Some(1));
            Ok(())
        })
        .unwrap();
        registry.close(id).unwrap();
        drop(slot);
        assert_eq!(registry.total.load(Ordering::Relaxed), 0);
        let reserved = registry.reserve(false).unwrap();
        drop(reserved);
        assert_eq!(registry.total.load(Ordering::Relaxed), 0);
    }
    #[test]
    fn handle_exhaustion_never_reuses_an_id_or_leaks_admission() {
        let registry = Registry::new(4, 1);
        registry.next.store(i64::MAX - 1, Ordering::Relaxed);
        let last = registry.reserve(true).unwrap().insert(7).unwrap();
        assert_eq!(last, i64::MAX - 1);
        registry.close(last).unwrap();
        assert!(registry.reserve(true).is_err());
        assert_eq!(registry.total.load(Ordering::Relaxed), 0);
        assert_eq!(registry.documents.load(Ordering::Relaxed), 0);
    }
}
