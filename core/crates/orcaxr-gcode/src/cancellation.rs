use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// One-way cancellation shared by an operation and its native owner. A browser
/// without shared memory cancels by terminating its owned computation worker.
#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}
