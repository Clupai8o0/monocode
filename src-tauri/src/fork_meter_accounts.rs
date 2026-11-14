//! Fork feature: account folders that exist only to read usage from. A
//! "meter-only" folder (prefix `meter-`) points at a login MonoCode should show
//! usage for, without offering it as a usable account. This reads only the
//! folder names and symlink targets under
//! `<app_data_dir>/provider-accounts/<provider>/`, never a credential or a file
//! inside a profile.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Codex only: a Claude meter would need the Keychain lookup keyed by the
/// link target, and `fork_account_homes` would read it as the cx login.
const PROVIDERS: [&str; 1] = ["codex"];
/// The name prefix that marks a folder as usage-only.
const METER_PREFIX: &str = "meter-";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterAccount {
    provider: String,
    id: String,
    /// The folder the provider reads for this account, with `~` for the home
    /// folder.
    home: String,
}

/// `a/./b/../c` as `a/c`, without touching the file system.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn tilde(path: &Path, home: &Path) -> String {
    match normalize(path).strip_prefix(normalize(home)) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Every meter-only account folder under `<accounts_root>/<provider>/`.
pub(crate) fn read_meter_accounts(home: &Path, accounts_root: &Path) -> Vec<MeterAccount> {
    let mut found: Vec<MeterAccount> = PROVIDERS
        .iter()
        .flat_map(|provider| {
            let provider_root = accounts_root.join(provider);
            std::fs::read_dir(&provider_root)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|entry| {
                    let id = entry.file_name().to_str()?.to_string();
                    if !valid_id(&id) || !id.starts_with(METER_PREFIX) {
                        return None;
                    }
                    let path = entry.path();
                    let metadata = std::fs::symlink_metadata(&path).ok()?;
                    let target = if metadata.file_type().is_symlink() {
                        let link = std::fs::read_link(&path).ok()?;
                        if link.is_absolute() {
                            link
                        } else {
                            provider_root.join(link)
                        }
                    } else if metadata.is_dir() {
                        path
                    } else {
                        return None;
                    };
                    Some(MeterAccount {
                        provider: (*provider).to_string(),
                        id,
                        home: tilde(&target, home),
                    })
                })
                .collect::<Vec<_>>()
        })
        .collect();
    found.sort_by(|a, b| a.provider.cmp(&b.provider).then_with(|| a.id.cmp(&b.id)));
    found
}

fn locations(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let home = crate::dirs_home().ok_or("No home folder")?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("provider-accounts");
    Ok((PathBuf::from(home), root))
}

#[tauri::command(async)]
pub fn fork_meter_accounts(app: AppHandle) -> Result<Vec<MeterAccount>, String> {
    let (home, root) = locations(&app)?;
    Ok(read_meter_accounts(&home, &root))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monocode-meter-accounts-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_meter_folders_and_skips_plain_ones() {
        let home = temp("list");
        let root = home.join("app/provider-accounts");
        std::fs::create_dir_all(root.join("codex")).unwrap();
        std::fs::create_dir_all(root.join("claude")).unwrap();
        std::os::unix::fs::symlink(home.join(".codex-3"), root.join("codex/meter-codex-3"))
            .unwrap();
        std::fs::create_dir_all(root.join("codex/account-abc")).unwrap();
        std::fs::create_dir_all(root.join("claude/meter-x")).unwrap();
        std::fs::write(root.join("claude/meter-file"), "x").unwrap();

        let accounts = read_meter_accounts(&home, &root);
        let summary: Vec<(&str, &str, &str)> = accounts
            .iter()
            .map(|a| (a.provider.as_str(), a.id.as_str(), a.home.as_str()))
            .collect();
        // claude/meter-x is ignored: meters are Codex only.
        assert_eq!(summary, vec![("codex", "meter-codex-3", "~/.codex-3")]);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn missing_root_lists_nothing() {
        let home = temp("empty");
        assert_eq!(read_meter_accounts(&home, &home.join("nope")), Vec::new());
        std::fs::remove_dir_all(&home).unwrap();
    }
}
