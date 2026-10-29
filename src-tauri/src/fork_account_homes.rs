//! Fork feature: which Claude login each provider account runs on. The owner
//! keeps two logins on this Mac, "main" (`~/.claude`) and "cx"
//! (`~/.claude-exec`), and points a MonoCode account folder at the second one
//! with a symlink. This reads only the symlink targets under
//! `<app_data_dir>/provider-accounts/claude/` (never a credential or a file
//! inside a profile) and can create that symlink for a new account.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const DEFAULT_ACCOUNT_ID: &str = "default";
/// Folders the second login may live in, in the order they are preferred.
const CX_DIRS: [&str; 2] = [".claude-exec", ".claude-cx"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountHome {
    id: String,
    /// The folder Claude reads for this account, with `~` for the home folder.
    home: String,
    /// "main", "cx" or "other".
    role: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountHomes {
    accounts: Vec<AccountHome>,
    /// The cx login folder when it exists, so Settings can offer to add it.
    cx_home: Option<String>,
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

fn role_for(target: &Path, home: &Path) -> &'static str {
    let target = normalize(target);
    if target == normalize(&home.join(".claude")) {
        return "main";
    }
    if CX_DIRS
        .iter()
        .any(|dir| target == normalize(&home.join(dir)))
    {
        return "cx";
    }
    "other"
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

fn cx_dir(home: &Path) -> Option<PathBuf> {
    CX_DIRS
        .iter()
        .map(|dir| home.join(dir))
        .find(|path| path.is_dir())
}

/// Every Claude account's folder and role. The stock account is `~/.claude`.
pub(crate) fn read_homes(home: &Path, accounts_root: &Path) -> AccountHomes {
    let mut accounts = vec![AccountHome {
        id: DEFAULT_ACCOUNT_ID.into(),
        home: "~/.claude".into(),
        role: "main",
    }];
    let mut found: Vec<AccountHome> = std::fs::read_dir(accounts_root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().to_str()?.to_string();
            if !valid_id(&id) || id == DEFAULT_ACCOUNT_ID {
                return None;
            }
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if metadata.file_type().is_symlink() {
                let link = std::fs::read_link(&path).ok()?;
                let target = if link.is_absolute() {
                    link
                } else {
                    accounts_root.join(link)
                };
                Some(AccountHome {
                    id,
                    home: tilde(&target, home),
                    role: role_for(&target, home),
                })
            } else if metadata.is_dir() {
                Some(AccountHome {
                    id,
                    home: tilde(&path, home),
                    role: "other",
                })
            } else {
                None
            }
        })
        .collect();
    found.sort_by(|a, b| a.id.cmp(&b.id));
    accounts.extend(found);
    AccountHomes {
        accounts,
        cx_home: cx_dir(home).map(|dir| tilde(&dir, home)),
    }
}

/// Point a new account folder at the cx login. Nothing is copied.
pub(crate) fn link_cx(home: &Path, accounts_root: &Path, id: &str) -> Result<AccountHome, String> {
    if !valid_id(id) || id == DEFAULT_ACCOUNT_ID {
        return Err("Invalid provider account id".into());
    }
    let target = cx_dir(home).ok_or("There is no ~/.claude-exec folder to link")?;
    let path = accounts_root.join(id);
    if std::fs::symlink_metadata(&path).is_ok() {
        return Err("That account folder already exists".into());
    }
    std::fs::create_dir_all(accounts_root)
        .map_err(|error| format!("Could not create {}: {error}", accounts_root.display()))?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &path)
        .map_err(|error| format!("Could not link {}: {error}", path.display()))?;
    #[cfg(not(unix))]
    return Err("Linking an account folder needs macOS or Linux".into());
    #[cfg(unix)]
    Ok(AccountHome {
        id: id.into(),
        home: tilde(&target, home),
        role: "cx",
    })
}

fn locations(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let home = crate::dirs_home().ok_or("No home folder")?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("provider-accounts")
        .join("claude");
    Ok((PathBuf::from(home), root))
}

#[tauri::command(async)]
pub fn fork_account_homes(app: AppHandle) -> Result<AccountHomes, String> {
    let (home, root) = locations(&app)?;
    Ok(read_homes(&home, &root))
}

#[tauri::command(async)]
pub fn fork_add_cx_account(app: AppHandle, account_id: String) -> Result<AccountHome, String> {
    // The same id check the account folders use everywhere else.
    crate::harness::provider_account_path(&app, "claude", &account_id)?;
    let (home, root) = locations(&app)?;
    link_cx(&home, &root, &account_id)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monocode-acct-homes-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn labels_main_cx_and_other() {
        let home = temp("labels");
        let root = home.join("app/provider-accounts/claude");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(home.join(".claude-exec")).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::os::unix::fs::symlink(home.join(".claude-exec"), root.join("account-cx")).unwrap();
        std::os::unix::fs::symlink(home.join(".claude/"), root.join("account-main")).unwrap();
        std::fs::create_dir_all(root.join("account-own")).unwrap();
        std::os::unix::fs::symlink("../../../elsewhere", root.join("account-rel")).unwrap();
        std::fs::write(root.join("stray-file"), "x").unwrap();
        std::fs::create_dir_all(root.join("bad id")).unwrap();

        let homes = read_homes(&home, &root);
        let summary: Vec<(&str, &str, &str)> = homes
            .accounts
            .iter()
            .map(|a| (a.id.as_str(), a.home.as_str(), a.role))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("default", "~/.claude", "main"),
                ("account-cx", "~/.claude-exec", "cx"),
                ("account-main", "~/.claude", "main"),
                ("account-own", "~/app/provider-accounts/claude/account-own", "other"),
                ("account-rel", "~/elsewhere", "other"),
            ]
        );
        assert_eq!(homes.cx_home.as_deref(), Some("~/.claude-exec"));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn claude_cx_folder_counts_as_cx() {
        let home = temp("cx");
        let root = home.join("accounts");
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(home.join(".claude-cx"), root.join("a")).unwrap();
        let homes = read_homes(&home, &root);
        assert_eq!(homes.accounts[1].role, "cx");
        // The link target is missing, so there is nothing to offer adding.
        assert_eq!(homes.cx_home, None);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn missing_accounts_folder_lists_only_main() {
        let home = temp("empty");
        let homes = read_homes(&home, &home.join("nope"));
        assert_eq!(homes.accounts.len(), 1);
        assert_eq!(homes.accounts[0].role, "main");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn link_cx_creates_symlink_without_copying() {
        let home = temp("link");
        let root = home.join("app/provider-accounts/claude");
        assert!(link_cx(&home, &root, "account-1").is_err(), "no cx folder yet");
        std::fs::create_dir_all(home.join(".claude-exec")).unwrap();
        std::fs::write(home.join(".claude-exec/.credentials.json"), "secret").unwrap();
        let made = link_cx(&home, &root, "account-1").unwrap();
        assert_eq!(made.role, "cx");
        assert_eq!(made.home, "~/.claude-exec");
        let link = root.join("account-1");
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_link(&link).unwrap(), home.join(".claude-exec"));
        assert!(link_cx(&home, &root, "account-1").is_err(), "already exists");
        assert!(link_cx(&home, &root, "../x").is_err());
        assert!(link_cx(&home, &root, "default").is_err());
        assert_eq!(read_homes(&home, &root).accounts[1].role, "cx");
        std::fs::remove_dir_all(&home).unwrap();
    }
}
