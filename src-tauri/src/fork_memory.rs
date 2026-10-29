//! Fork: the Memory manager's report. How tight memory is on this Mac, and
//! how much RAM each MonoCode session's agent process tree holds, so the
//! footer can suggest which idle sessions to park. Idle time is not here:
//! the TS harness registry knows when each turn settled.
use crate::harness::HarnessHost;
use crate::resources::{self, Process, ProcessRoot};
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Pressure {
    Normal,
    Warn,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMemory {
    /// MonoCode session id (the harness child key).
    session_id: String,
    /// Resident memory summed over the agent and every descendant.
    rss_bytes: u64,
    process_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReport {
    pressure: Pressure,
    total_bytes: u64,
    /// Free plus easily reclaimed (speculative and file cache) memory.
    available_bytes: u64,
    sessions: Vec<SessionMemory>,
}

/// The kernel reports 1 (normal), 2 (warn) or 4 (critical).
fn pressure_from_level(level: Option<u32>) -> Pressure {
    match level {
        Some(level) if level >= 4 => Pressure::Critical,
        Some(level) if level >= 2 => Pressure::Warn,
        _ => Pressure::Normal,
    }
}

/// Sum each process into the session whose agent it descends from, largest first.
fn aggregate(processes: &HashMap<u32, Process>, roots: &[ProcessRoot]) -> Vec<SessionMemory> {
    let mut totals: HashMap<&str, (u64, u32)> = HashMap::new();
    for process in processes.values() {
        if let Some(root) = resources::owner(process.pid, processes, roots) {
            let entry = totals.entry(root.session_id.as_str()).or_default();
            entry.0 = entry.0.saturating_add(process.memory);
            entry.1 += 1;
        }
    }
    let mut sessions: Vec<SessionMemory> = totals
        .into_iter()
        .map(|(id, (rss_bytes, process_count))| SessionMemory {
            session_id: id.to_string(),
            rss_bytes,
            process_count,
        })
        .collect();
    sessions.sort_by(|a, b| {
        b.rss_bytes
            .cmp(&a.rss_bytes)
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    sessions
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn mach_host_self() -> u32;
}

#[cfg(target_os = "macos")]
fn memory_totals() -> (u64, u64) {
    unsafe {
        let mut total: u64 = 0;
        let mut length = std::mem::size_of_val(&total);
        if libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            &mut total as *mut _ as *mut _,
            &mut length,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            return (0, 0);
        }
        // One send right for the app's life, not one leaked per poll.
        static HOST: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
        let host = *HOST.get_or_init(|| mach_host_self());
        let mut stats: libc::vm_statistics64 = std::mem::zeroed();
        let mut count = libc::HOST_VM_INFO64_COUNT;
        if libc::host_statistics64(
            host,
            libc::HOST_VM_INFO64,
            &mut stats as *mut _ as *mut _,
            &mut count,
        ) != 0
        {
            return (total, 0);
        }
        let page = libc::sysconf(libc::_SC_PAGESIZE).max(0) as u64;
        let pages = stats.free_count as u64
            + stats.speculative_count as u64
            + stats.external_page_count as u64;
        (total, pages.saturating_mul(page).min(total))
    }
}

#[cfg(not(target_os = "macos"))]
fn memory_totals() -> (u64, u64) {
    (0, 0)
}

/// Off the main thread: `ps` and the sysctls run on the blocking pool.
#[tauri::command]
pub async fn fork_memory_report(host: State<'_, HarnessHost>) -> Result<MemoryReport, String> {
    let roots = host.process_roots();
    crate::background_work::read(move || {
        // A root whose PID now belongs to another process owns nothing.
        let verified = |roots: Vec<ProcessRoot>| -> Vec<ProcessRoot> {
            roots
                .into_iter()
                .filter(|root| {
                    root.identity.is_some() && resources::identity(root.pid) == root.identity
                })
                .collect()
        };
        let roots = verified(roots);
        let sessions = if roots.is_empty() {
            Vec::new()
        } else {
            let processes = resources::process_snapshot()?;
            // Checked again after `ps`, so a PID reused meanwhile is not counted.
            aggregate(&processes, &verified(roots))
        };
        let (total_bytes, available_bytes) = memory_totals();
        Ok(MemoryReport {
            pressure: pressure_from_level(resources::memory_pressure_level()),
            total_bytes,
            available_bytes,
            sessions,
        })
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(rows: &[&str]) -> HashMap<u32, Process> {
        rows.iter()
            .filter_map(|row| resources::parse_process(row))
            .map(|process| (process.pid, process))
            .collect()
    }

    fn root(session_id: &str, pid: u32) -> ProcessRoot {
        ProcessRoot {
            session_id: session_id.into(),
            pid,
            identity: Some(format!("{pid}:1:1")),
            cwd: "/repo".into(),
        }
    }

    #[test]
    fn sums_each_session_over_its_whole_process_tree() {
        // rss is in KiB, as ps prints it.
        let processes = snapshot(&[
            "10 1 0.0 1000 claude",
            "11 10 0.0 200 node mcp-server",
            "12 11 0.0 300 rustc",
            "20 1 0.0 4000 claude",
            "30 1 0.0 9000 unrelated",
        ]);
        let sessions = aggregate(&processes, &[root("a", 10), root("b", 20)]);
        assert_eq!(
            sessions,
            vec![
                SessionMemory {
                    session_id: "b".into(),
                    rss_bytes: 4000 * 1024,
                    process_count: 1,
                },
                SessionMemory {
                    session_id: "a".into(),
                    rss_bytes: 1500 * 1024,
                    process_count: 3,
                },
            ]
        );
    }

    #[test]
    fn unverified_roots_and_strangers_count_for_nothing() {
        let processes = snapshot(&["10 1 0.0 1000 claude", "11 10 0.0 200 child"]);
        let mut unverified = root("a", 10);
        unverified.identity = None;
        assert!(aggregate(&processes, &[unverified]).is_empty());
        assert!(aggregate(&processes, &[root("gone", 99)]).is_empty());
    }

    #[test]
    fn maps_kernel_levels_to_pressure() {
        assert_eq!(pressure_from_level(None), Pressure::Normal);
        assert_eq!(pressure_from_level(Some(1)), Pressure::Normal);
        assert_eq!(pressure_from_level(Some(2)), Pressure::Warn);
        assert_eq!(pressure_from_level(Some(4)), Pressure::Critical);
        assert_eq!(
            serde_json::to_value(Pressure::Critical).unwrap(),
            serde_json::json!("critical")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_this_macs_memory() {
        let (total, available) = memory_totals();
        assert!(total > 0);
        assert!(available <= total);
    }
}
