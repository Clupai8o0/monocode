//! Fork: what Claude usage would cost at API list price, read from the local
//! transcripts of each account. The same source and sums as the vault's
//! `usage_report.py`. No key and no network; the transcripts are never changed.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

const ACCOUNTS: [(&str, &str); 2] = [(".claude", "main"), (".claude-exec", "cx")];
const SECONDS_PER_DAY: i64 = 86_400;
const MAX_DAYS: u32 = 56;
/// Haiku 5.5 costs five times as much once a prompt passes this size.
const HAIKU_TIER_TOKENS: u64 = 100_000;

/// $ per million tokens: input, output, cache read. From Claude Code's bundled
/// claude-api skill (cached 6 Oct 2026). Haiku 5.5's cache read follows that
/// skill's general rule of 0.1x input, as it gives no figure of its own.
fn price(model: &str) -> Option<(f64, f64, f64)> {
    Some(match model {
        "claude-fable-5-1" => (10.0, 50.0, 0.25),
        "claude-fable-5" => (10.0, 50.0, 1.0),
        "claude-opus-5-5" => (4.0, 20.0, 0.20),
        "claude-opus-5" | "claude-opus-4-8" | "claude-opus-4-7" | "claude-opus-4-6" => {
            (5.0, 25.0, 0.5)
        }
        "claude-sonnet-5-5" | "claude-sonnet-5" => (2.0, 10.0, 0.2),
        "claude-sonnet-4-6" => (3.0, 15.0, 0.3),
        "claude-haiku-5-5" => (0.10, 0.50, 0.01),
        "claude-haiku-4-5" => (1.0, 5.0, 0.1),
        _ => return None,
    })
}

/// `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`.
fn base_model(raw: &str) -> &str {
    match raw.rfind('-') {
        Some(at) if raw.len() - at == 9 && raw[at + 1..].bytes().all(|b| b.is_ascii_digit()) => {
            &raw[..at]
        }
        _ => raw,
    }
}

fn family(model: &str) -> &'static str {
    ["fable", "opus", "sonnet", "haiku"]
        .into_iter()
        .find(|name| model.contains(name))
        .unwrap_or("other")
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostModel {
    pub model: String,
    pub family: String,
    pub usd: f64,
    /// What cache reads saved against paying full input price for them.
    pub saved_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostDay {
    /// Local date, `YYYY-MM-DD`.
    pub date: String,
    pub by_family: BTreeMap<String, f64>,
    pub saved_usd: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostReport {
    pub days: Vec<CostDay>,
    /// Each model over the whole period, dearest first.
    pub models: Vec<CostModel>,
    pub accounts: BTreeMap<String, f64>,
    /// Models with no known price. Their tokens are left out of the cost.
    pub unpriced: Vec<String>,
    /// Transcripts or folders that couldn't be read, so the totals may be low.
    pub unreadable: u32,
}

struct Call {
    account: &'static str,
    model: String,
    timestamp: String,
    usage: serde_json::Value,
}

fn count(value: &serde_json::Value, key: &str) -> u64 {
    value.get(key).and_then(|n| n.as_u64()).unwrap_or(0)
}

fn jsonl_files(dir: &Path, found: &mut Vec<PathBuf>, since: SystemTime, unreadable: &mut u32) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // An account that was never used has no folder; that isn't a failure.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            *unreadable += 1;
            return;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            *unreadable += 1;
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            *unreadable += 1;
            continue;
        };
        let path = entry.path();
        // Links are skipped: shared memory folders, and any loop.
        if kind.is_dir() {
            jsonl_files(&path, found, since, unreadable);
        } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            match entry.metadata().and_then(|meta| meta.modified()) {
                Ok(modified) if modified >= since => found.push(path),
                Ok(_) => {}
                Err(_) => *unreadable += 1,
            }
        }
    }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let shifted = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * shifted + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Seconds since the epoch of `2026-10-30T22:15:04.123Z`. Only UTC stamps, as
/// the transcripts write them.
fn parse_timestamp(stamp: &str) -> Option<i64> {
    let field = |range: std::ops::Range<usize>| stamp.get(range)?.parse::<i64>().ok();
    let days = days_from_civil(field(0..4)?, field(5..7)?, field(8..10)?);
    Some(days * SECONDS_PER_DAY + field(11..13)? * 3600 + field(14..16)? * 60 + field(17..19)?)
}

fn date_of(local_seconds: i64) -> String {
    let (year, month, day) = civil_from_days(local_seconds.div_euclid(SECONDS_PER_DAY));
    format!("{year:04}-{month:02}-{day:02}")
}

/// `offset` gives the zone's offset in seconds at that moment, not today's: a
/// date on the far side of a daylight-saving change has a different one.
fn local_date(stamp: &str, offset: &impl Fn(i64) -> i64) -> Option<String> {
    let utc = parse_timestamp(stamp)?;
    Some(date_of(utc + offset(utc)))
}

/// Midnight in the zone, `days - 1` days before today, so the totals cover
/// exactly the days the chart can show. Returned as a UTC stamp to compare with
/// the transcripts' own, and as a time for the file filter.
fn period_start(now_seconds: i64, days: u32, offset: &impl Fn(i64) -> i64) -> (String, SystemTime) {
    let local_day = (now_seconds + offset(now_seconds)).div_euclid(SECONDS_PER_DAY);
    let local_start = (local_day - i64::from(days) + 1) * SECONDS_PER_DAY;
    let start = local_start - offset(local_start);
    let (year, month, day) = civil_from_days(start.div_euclid(SECONDS_PER_DAY));
    let rest = start.rem_euclid(SECONDS_PER_DAY);
    (
        format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}",
            rest / 3600,
            rest % 3600 / 60,
            rest % 60
        ),
        SystemTime::UNIX_EPOCH + Duration::from_secs(start.max(0) as u64),
    )
}

/// One response is logged once per content block, and only the last line has
/// the final output count, so each call keeps the line with the most output.
fn read_calls(
    path: &Path,
    account: &'static str,
    since: &str,
    calls: &mut HashMap<String, Call>,
    unreadable: &mut u32,
) {
    let Ok(bytes) = std::fs::read(path) else {
        *unreadable += 1;
        return;
    };
    let text = String::from_utf8_lossy(&bytes);
    for line in text.lines() {
        if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if entry.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let timestamp = entry
            .get("timestamp")
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if timestamp < since {
            continue;
        }
        let Some(message) = entry.get("message") else {
            continue;
        };
        let Some(usage) = message.get("usage").filter(|usage| usage.is_object()) else {
            continue;
        };
        let model = message.get("model").and_then(|m| m.as_str()).unwrap_or("");
        if model == "<synthetic>" {
            continue;
        }
        let Some(id) = message
            .get("id")
            .or_else(|| entry.get("uuid"))
            .and_then(|id| id.as_str())
        else {
            continue;
        };
        match calls.get_mut(id) {
            Some(known) => {
                if count(usage, "output_tokens") >= count(&known.usage, "output_tokens") {
                    known.usage = usage.clone();
                }
            }
            None => {
                calls.insert(
                    id.to_string(),
                    Call {
                        account,
                        model: model.to_string(),
                        timestamp: timestamp.to_string(),
                        usage: usage.clone(),
                    },
                );
            }
        }
    }
}

pub fn build_report(
    roots: &[(PathBuf, &'static str)],
    now: SystemTime,
    days: u32,
    offset: impl Fn(i64) -> i64,
) -> CostReport {
    let days = days.clamp(1, MAX_DAYS);
    let now_seconds = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64);
    let (since, since_time) = period_start(now_seconds, days, &offset);

    let mut calls = HashMap::new();
    let mut unreadable = 0;
    for (root, account) in roots {
        let mut files = Vec::new();
        jsonl_files(
            &root.join("projects"),
            &mut files,
            since_time,
            &mut unreadable,
        );
        for file in files {
            read_calls(&file, account, &since, &mut calls, &mut unreadable);
        }
    }

    let mut by_day: BTreeMap<String, CostDay> = BTreeMap::new();
    let mut by_model: BTreeMap<String, CostModel> = BTreeMap::new();
    let mut accounts: BTreeMap<String, f64> = BTreeMap::new();
    let mut unpriced = BTreeSet::new();
    for call in calls.values() {
        let model = base_model(&call.model);
        let Some((mut input_price, mut output_price, mut read_price)) = price(model) else {
            if !model.is_empty() {
                unpriced.insert(model.to_string());
            }
            continue;
        };
        let usage = &call.usage;
        let cache = usage.get("cache_creation").filter(|c| c.is_object());
        let write_1h = cache.map_or(0, |c| count(c, "ephemeral_1h_input_tokens"));
        let write_5m = match cache {
            Some(c) => count(c, "ephemeral_5m_input_tokens"),
            None => count(usage, "cache_creation_input_tokens"),
        };
        let input = count(usage, "input_tokens");
        let read = count(usage, "cache_read_input_tokens");
        let output = count(usage, "output_tokens");
        if model == "claude-haiku-5-5" && input + read + write_1h + write_5m > HAIKU_TIER_TOKENS {
            input_price *= 5.0;
            output_price *= 5.0;
            read_price *= 5.0;
        }
        let per_million = |tokens: u64, rate: f64| tokens as f64 * rate / 1e6;
        let usd = per_million(input, input_price)
            + per_million(write_5m, input_price * 1.25)
            + per_million(write_1h, input_price * 2.0)
            + per_million(read, read_price)
            + per_million(output, output_price);
        let saved = per_million(read, input_price - read_price);

        let Some(date) = local_date(&call.timestamp, &offset) else {
            continue;
        };
        let name = family(model);
        let day = by_day.entry(date.clone()).or_insert_with(|| CostDay {
            date,
            ..CostDay::default()
        });
        *day.by_family.entry(name.to_string()).or_default() += usd;
        day.saved_usd += saved;
        let row = by_model
            .entry(model.to_string())
            .or_insert_with(|| CostModel {
                model: model.to_string(),
                family: name.to_string(),
                ..CostModel::default()
            });
        row.usd += usd;
        row.saved_usd += saved;
        row.input_tokens += input;
        row.output_tokens += output;
        row.cache_read_tokens += read;
        row.cache_write_tokens += write_1h + write_5m;
        *accounts.entry(call.account.to_string()).or_default() += usd;
    }

    let mut models: Vec<CostModel> = by_model.into_values().collect();
    models.sort_by(|a, b| b.usd.total_cmp(&a.usd));
    CostReport {
        days: by_day.into_values().collect(),
        models,
        accounts,
        unpriced: unpriced.into_iter().collect(),
        unreadable,
    }
}

/// The webview sends the zone's offsets for the period, as `[from, seconds]`
/// pairs oldest first, since it knows the zone's history and this crate doesn't.
fn offset_at(offsets: &[(i64, i64)], utc: i64) -> i64 {
    offsets
        .iter()
        .rev()
        .find(|(from, _)| *from <= utc)
        .or_else(|| offsets.first())
        .map_or(0, |(_, seconds)| *seconds)
}

#[tauri::command(async)]
pub fn fork_cost_report(days: u32, offsets: Vec<(i64, i64)>) -> Result<CostReport, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or("No home folder")?;
    let roots: Vec<(PathBuf, &'static str)> = ACCOUNTS
        .iter()
        .map(|(dir, name)| (home.join(dir), *name))
        .collect();
    Ok(build_report(&roots, SystemTime::now(), days, |utc| {
        offset_at(&offsets, utc)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);
    // 2026-10-30T12:00:00Z.
    const NOW: u64 = 1_793_361_600;
    const STAMP: &str = "2026-10-30T10:00:00.000Z";

    struct Home(PathBuf);

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn home() -> Home {
        let id = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("mc-cost-{}-{id}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("main/projects/p")).unwrap();
        fs::create_dir_all(dir.join("cx/projects/p/subagents")).unwrap();
        Home(dir)
    }

    fn line(id: &str, model: &str, stamp: &str, usage: serde_json::Value) -> String {
        serde_json::json!({
            "type": "assistant",
            "timestamp": stamp,
            "message": { "id": id, "model": model, "usage": usage },
        })
        .to_string()
    }

    fn report(home: &Home) -> CostReport {
        let roots = vec![(home.0.join("main"), "main"), (home.0.join("cx"), "cx")];
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(NOW);
        // Files on disk are newer than NOW, so the file filter lets them through.
        build_report(&roots, now, 7, |_| 0)
    }

    fn write(home: &Home, path: &str, lines: &[String]) {
        fs::write(home.0.join(path), lines.join("\n")).unwrap();
    }

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} != {b}");
    }

    #[test]
    fn prices_every_kind_of_token() {
        let home = home();
        let usage = serde_json::json!({
            "input_tokens": 1_000_000,
            "output_tokens": 1_000_000,
            "cache_read_input_tokens": 1_000_000,
            "cache_creation": {
                "ephemeral_5m_input_tokens": 1_000_000,
                "ephemeral_1h_input_tokens": 1_000_000,
            },
        });
        write(
            &home,
            "main/projects/p/a.jsonl",
            &[line("m1", "claude-opus-5-5", STAMP, usage)],
        );
        let result = report(&home);
        // 4 input + 5 write 5m + 8 write 1h + 0.2 read + 20 output.
        close(result.models[0].usd, 37.2);
        close(result.models[0].saved_usd, 3.8);
        close(result.days[0].by_family["opus"], 37.2);
        close(result.accounts["main"], 37.2);
        assert_eq!(result.days[0].date, "2026-10-30");
    }

    #[test]
    fn counts_a_response_logged_several_times_once() {
        let home = home();
        let partial = serde_json::json!({ "input_tokens": 0, "output_tokens": 10 });
        let done = serde_json::json!({ "input_tokens": 0, "output_tokens": 1_000_000 });
        write(
            &home,
            "main/projects/p/a.jsonl",
            &[
                line("m1", "claude-opus-5-5", STAMP, partial),
                line("m1", "claude-opus-5-5", STAMP, done),
            ],
        );
        close(report(&home).models[0].usd, 20.0);
    }

    #[test]
    fn splits_accounts_reads_subagents_and_ignores_old_calls() {
        let home = home();
        let usage = serde_json::json!({ "output_tokens": 1_000_000 });
        write(
            &home,
            "main/projects/p/a.jsonl",
            &[line("m1", "claude-sonnet-5-5", STAMP, usage.clone())],
        );
        write(
            &home,
            "cx/projects/p/subagents/b.jsonl",
            &[
                line("m2", "claude-sonnet-5-5", STAMP, usage.clone()),
                line("m3", "claude-sonnet-5-5", "2026-10-01T00:00:00.000Z", usage),
            ],
        );
        let result = report(&home);
        close(result.accounts["main"], 10.0);
        close(result.accounts["cx"], 10.0);
        close(result.models[0].usd, 20.0);
    }

    #[test]
    fn haiku_costs_five_times_as_much_past_its_tier() {
        let home = home();
        let small = serde_json::json!({ "input_tokens": 100_000, "output_tokens": 1_000_000 });
        let large = serde_json::json!({ "input_tokens": 100_001, "output_tokens": 1_000_000 });
        write(
            &home,
            "main/projects/p/a.jsonl",
            &[line("m1", "claude-haiku-5-5", STAMP, small)],
        );
        close(report(&home).models[0].usd, 0.51);
        write(
            &home,
            "main/projects/p/a.jsonl",
            &[line("m1", "claude-haiku-5-5", STAMP, large)],
        );
        close(report(&home).models[0].usd, 2.5 + 100_001.0 * 0.5 / 1e6);
    }

    #[test]
    fn reports_unknown_models_instead_of_guessing() {
        let home = home();
        let usage = serde_json::json!({ "output_tokens": 5 });
        write(
            &home,
            "main/projects/p/a.jsonl",
            &[
                line("m1", "claude-new-9", STAMP, usage.clone()),
                line("m2", "<synthetic>", STAMP, usage),
            ],
        );
        let result = report(&home);
        assert_eq!(result.unpriced, vec!["claude-new-9".to_string()]);
        assert!(result.models.is_empty());
    }

    #[test]
    fn strips_a_date_from_a_model_name() {
        assert_eq!(base_model("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
        assert_eq!(base_model("claude-opus-5-5"), "claude-opus-5-5");
    }

    // Melbourne in 2026: +10 until 4 October 16:00 UTC, then +11.
    fn melbourne(utc: i64) -> i64 {
        if utc < parse_timestamp("2026-10-03T16:00:00Z").unwrap() {
            36_000
        } else {
            39_600
        }
    }

    #[test]
    fn groups_days_with_the_offset_of_that_moment() {
        assert_eq!(
            local_date("2026-10-30T22:15:04.123Z", &|_| 39_600).unwrap(),
            "2026-10-31"
        );
        assert_eq!(
            local_date("2026-10-30T01:00:00Z", &|_| -7_200).unwrap(),
            "2026-10-29"
        );
        assert_eq!(local_date("nonsense", &|_| 0), None);
        // Before the change it's 23:30 on the 3rd; today's offset would say the 4th.
        assert_eq!(
            local_date("2026-10-03T13:30:00Z", &melbourne).unwrap(),
            "2026-10-03"
        );
        assert_eq!(
            local_date("2026-10-04T13:30:00Z", &melbourne).unwrap(),
            "2026-10-05"
        );
    }

    #[test]
    fn finds_the_offset_in_force_at_a_moment() {
        let offsets = [(100, 36_000), (200, 39_600)];
        assert_eq!(offset_at(&offsets, 150), 36_000);
        assert_eq!(offset_at(&offsets, 200), 39_600);
        assert_eq!(offset_at(&offsets, 999), 39_600);
        // Before the list starts, the oldest is the best guess.
        assert_eq!(offset_at(&offsets, 50), 36_000);
        assert_eq!(offset_at(&[], 50), 0);
    }

    #[test]
    fn the_period_starts_at_local_midnight() {
        let now = parse_timestamp("2026-10-31T12:00:00Z").unwrap();
        // Local today is 31 Oct at 23:00; 7 days back from it is the 25th.
        let (since, _) = period_start(now, 7, &melbourne);
        assert_eq!(since, "2026-10-24T13:00:00");
        // Across the change, that midnight used the older offset.
        let (since, _) = period_start(now, 56, &melbourne);
        assert_eq!(since, "2026-09-05T14:00:00");
    }

    #[test]
    fn counts_transcripts_it_could_not_read() {
        let home = home();
        fs::create_dir(home.0.join("main/projects/p/gone.jsonl")).unwrap();
        fs::write(home.0.join("main/projects/p/real.jsonl"), "").unwrap();
        // A folder named like a transcript is walked, not read, so nothing is lost.
        assert_eq!(report(&home).unreadable, 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = home.0.join("main/projects/p/real.jsonl");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
            // Root can read anything, so this only holds for a normal user.
            if fs::read(&path).is_err() {
                assert_eq!(report(&home).unreadable, 1);
            }
        }
    }

    #[test]
    fn tolerates_broken_lines_and_missing_folders() {
        let home = home();
        fs::write(
            home.0.join("main/projects/p/a.jsonl"),
            "not json with \"usage\" and \"assistant\"\n",
        )
        .unwrap();
        let roots = vec![
            (home.0.join("nowhere"), "cx"),
            (home.0.join("main"), "main"),
        ];
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(NOW);
        assert_eq!(build_report(&roots, now, 7, |_| 0), CostReport::default());
    }
}
