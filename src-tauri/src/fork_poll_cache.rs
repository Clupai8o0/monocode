//! Short-lived, single-flight reads shared by every webview. A separate lock
//! per key lets unrelated projects load together without launching the same
//! helper process once per window.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_IDLE_KEYS: usize = 64;
const ERROR_TTL: Duration = Duration::from_secs(1);

struct Cached<T> {
    completed: Instant,
    result: Result<T, String>,
}

struct Slot<T> {
    value: Arc<Mutex<Option<Cached<T>>>>,
    touched: Instant,
}

pub(crate) struct PollCache<T> {
    ttl: Duration,
    slots: Mutex<HashMap<String, Slot<T>>>,
}

impl<T: Clone> PollCache<T> {
    pub(crate) fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            slots: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn get_or_load(
        &self,
        key: &str,
        load: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let slot = {
            let mut slots = self.slots.lock().map_err(|_| "poll cache locked")?;
            let slot = slots.entry(key.into()).or_insert_with(|| Slot {
                value: Arc::new(Mutex::new(None)),
                touched: Instant::now(),
            });
            slot.touched = Instant::now();
            Arc::clone(&slot.value)
        };
        let result = {
            let mut value = slot.lock().map_err(|_| "poll read locked")?;
            if let Some(cached) = value.as_ref() {
                let ttl = if cached.result.is_ok() {
                    self.ttl
                } else {
                    ERROR_TTL
                };
                if cached.completed.elapsed() < ttl {
                    return cached.result.clone();
                }
            }
            // Keep this key locked while loading; other keys and invalidation
            // remain independent. A waiting window reuses the completed read.
            let result = load();
            *value = Some(Cached {
                completed: Instant::now(),
                result: result.clone(),
            });
            result
        };
        drop(slot);
        self.trim();
        result
    }

    /// Removing the slot also detaches any older in-flight read. It can finish
    /// for its existing callers, but cannot overwrite a fresh post-change read.
    pub(crate) fn invalidate(&self, key: &str) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.remove(key);
        }
    }

    fn trim(&self) {
        let Ok(mut slots) = self.slots.lock() else {
            return;
        };
        while slots.len() > MAX_IDLE_KEYS {
            let oldest = slots
                .iter()
                // Never evict an active read: it would defeat single-flight.
                .filter(|(_, slot)| Arc::strong_count(&slot.value) == 1)
                .min_by_key(|(_, slot)| slot.touched)
                .map(|(key, _)| key.clone());
            let Some(key) = oldest else {
                break;
            };
            slots.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Barrier};
    use std::thread;

    fn cache() -> PollCache<usize> {
        PollCache::new(Duration::from_secs(10))
    }

    fn expire(cache: &PollCache<usize>, key: &str) {
        let slots = cache.slots.lock().unwrap();
        let mut value = slots[key].value.lock().unwrap();
        value.as_mut().unwrap().completed -= Duration::from_secs(11);
    }

    #[test]
    fn windows_share_one_read_and_refresh_after_expiry() {
        let cache = Arc::new(cache());
        let loads = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let (cache, loads, start) = (cache.clone(), loads.clone(), start.clone());
                thread::spawn(move || {
                    start.wait();
                    cache.get_or_load("project", || Ok(loads.fetch_add(1, Ordering::SeqCst)))
                })
            })
            .collect();
        for worker in workers {
            assert_eq!(worker.join().unwrap(), Ok(0));
        }
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        expire(&cache, "project");
        assert_eq!(cache.get_or_load("project", || Ok(9)), Ok(9));
    }

    #[test]
    fn different_projects_load_without_waiting_for_each_other() {
        let cache = Arc::new(cache());
        let (started, entered) = mpsc::channel();
        let (finish, wait) = mpsc::channel();
        let worker_cache = cache.clone();
        let worker = thread::spawn(move || {
            worker_cache.get_or_load("slow", || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(1)
            })
        });
        entered.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(cache.get_or_load("fast", || Ok(2)), Ok(2));
        finish.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), Ok(1));
    }

    #[test]
    fn invalidation_during_a_read_cannot_repopulate_stale_data() {
        let cache = Arc::new(cache());
        let (started, entered) = mpsc::channel();
        let (finish, wait) = mpsc::channel();
        let worker_cache = cache.clone();
        let worker = thread::spawn(move || {
            worker_cache.get_or_load("stacks", || {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(1)
            })
        });
        entered.recv_timeout(Duration::from_secs(3)).unwrap();
        cache.invalidate("stacks");
        assert_eq!(cache.get_or_load("stacks", || Ok(2)), Ok(2));
        finish.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), Ok(1));
        assert_eq!(
            cache.get_or_load("stacks", || panic!("stale load won")),
            Ok(2)
        );
    }

    #[test]
    fn failures_are_shared_briefly_then_retried() {
        let cache = cache();
        assert_eq!(
            cache.get_or_load("x", || Err("offline".into())),
            Err("offline".into())
        );
        assert_eq!(
            cache.get_or_load("x", || panic!("duplicate failure")),
            Err("offline".into())
        );
        expire(&cache, "x");
        assert_eq!(cache.get_or_load("x", || Ok(1)), Ok(1));
    }

    #[test]
    fn completed_project_reads_are_bounded() {
        let cache = cache();
        for n in 0..100 {
            assert_eq!(cache.get_or_load(&n.to_string(), || Ok(n)), Ok(n));
        }
        assert_eq!(cache.slots.lock().unwrap().len(), MAX_IDLE_KEYS);
    }
}
