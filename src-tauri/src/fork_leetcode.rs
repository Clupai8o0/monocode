//! Fork: reads LeetCode problems for the Games panel's Code tab.
//!
//! LeetCode's public GraphQL answers without a login. The webview cannot
//! call it (no CORS for our origin), so these few fixed queries run here.
//! The Code tab turns the answer into a drill (see leetcode.ts).
//!
//! A connected account signs the same queries with the user's LeetCode
//! session, kept in the system keychain and never handed to the webview, so
//! their solved list and submissions load too. The session comes from a
//! private sign-in window (`fork_leetcode_connect`) or is pasted in.

use std::io::Read;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const ENDPOINT: &str = "https://leetcode.com/graphql";
const MAX_BODY: u64 = 2 * 1024 * 1024;

const QUESTION: &str = "query q($slug: String!) { question(titleSlug: $slug) { \
questionFrontendId title titleSlug difficulty isPaidOnly content hints metaData \
exampleTestcaseList codeSnippets { langSlug code } topicTags { name } status } }";
const DAILY: &str =
    "query { activeDailyCodingChallengeQuestion { date question { titleSlug } } }";
const RANDOM: &str = "query r($filters: QuestionListFilterInput) { \
randomQuestion(categorySlug: \"algorithms\", filters: $filters) { titleSlug isPaidOnly } }";
const NUMBER: &str = "query n($filters: QuestionListFilterInput) { \
questionList(categorySlug: \"\", limit: 20, skip: 0, filters: $filters) { \
data { questionFrontendId titleSlug isPaidOnly } } }";

const ME: &str = "query { userStatus { username isSignedIn } }";
const PROGRESS: &str = "query p($filters: UserProgressQuestionListInput) { \
userProgressQuestionList(filters: $filters) { totalNum questions { titleSlug title \
frontendId questionStatus lastSubmittedAt numSubmitted difficulty lastResult \
topicTags { name } } } }";
const RECENT: &str = "query r($offset: Int!) { submissionList(offset: $offset, limit: 20) { \
hasNext submissions { id title titleSlug statusDisplay lang timestamp } } }";
const PROFILE: &str = "query u($username: String!) { matchedUser(username: $username) { \
username submitStatsGlobal { acSubmissionNum { difficulty count } } \
tagProblemCounts { advanced { tagName problemsSolved } intermediate { tagName problemsSolved } \
fundamental { tagName problemsSolved } } } }";
const SUBMISSIONS: &str = "query s($slug: String!) { questionSubmissionList(offset: 0, \
limit: 20, questionSlug: $slug) { submissions { id title titleSlug statusDisplay lang \
timestamp runtime memory } } }";
const SUBMISSION: &str = "query d($id: Int!) { submissionDetails(submissionId: $id) { \
code timestamp statusCode lang { name } question { titleSlug } } }";

const KEYCHAIN_SERVICE: &str = "monocode.fork.leetcode";
const KEYCHAIN_USER: &str = "account";
const LOGIN_LABEL: &str = "fork-leetcode-login";
const LOGIN_URL: &str = "https://leetcode.com/accounts/login/";
const ACCOUNT_EVENT: &str = "monocode:fork-leetcode-account";
const REJECTED: &str = "LeetCode did not accept that session.";
const LOGIN_WAIT: Duration = Duration::from_secs(15 * 60);

/// The signed-in session. Only Rust ever sees `session` and `csrf`.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Account {
    session: String,
    csrf: String,
    username: String,
}

/// A slug as LeetCode writes them: lowercase letters, digits and dashes.
fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn digits(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && value.chars().all(|c| c.is_ascii_digit())
}

/// Lookups that only make sense signed in.
fn needs_account(kind: &str) -> bool {
    matches!(kind, "progress" | "recent" | "profile" | "submissions" | "submission")
}

fn request(
    kind: &str,
    value: &str,
    username: Option<&str>,
) -> Result<(&'static str, serde_json::Value), String> {
    match kind {
        "question" => {
            if !valid_slug(value) {
                return Err("That is not a LeetCode problem name.".into());
            }
            Ok((QUESTION, serde_json::json!({ "slug": value })))
        }
        "daily" => Ok((DAILY, serde_json::json!({}))),
        "random" => {
            let difficulty: &str = match value {
                "EASY" | "MEDIUM" | "HARD" => value,
                _ => return Err("Pick easy, medium or hard.".into()),
            };
            Ok((
                RANDOM,
                serde_json::json!({ "filters": { "difficulty": difficulty } }),
            ))
        }
        "number" => {
            if value.is_empty() || value.len() > 6 || !value.chars().all(|c| c.is_ascii_digit()) {
                return Err("That is not a LeetCode problem number.".into());
            }
            Ok((
                NUMBER,
                serde_json::json!({ "filters": { "searchKeywords": value } }),
            ))
        }
        "progress" => {
            if !digits(value, 5) {
                return Err("Bad LeetCode page.".into());
            }
            let skip: u64 = value.parse().map_err(|_| "Bad LeetCode page.")?;
            Ok((
                PROGRESS,
                serde_json::json!({ "filters": { "skip": skip, "limit": 100 } }),
            ))
        }
        "recent" => {
            if !digits(value, 5) {
                return Err("Bad LeetCode page.".into());
            }
            let offset: u64 = value.parse().map_err(|_| "Bad LeetCode page.")?;
            Ok((RECENT, serde_json::json!({ "offset": offset })))
        }
        "profile" => match username {
            Some(name) if !name.is_empty() => {
                Ok((PROFILE, serde_json::json!({ "username": name })))
            }
            _ => Err("Connect LeetCode first.".into()),
        },
        "submissions" => {
            if !valid_slug(value) {
                return Err("That is not a LeetCode problem name.".into());
            }
            Ok((SUBMISSIONS, serde_json::json!({ "slug": value })))
        }
        "submission" => {
            if !digits(value, 12) {
                return Err("That is not a LeetCode submission.".into());
            }
            let id: u64 = value.parse().map_err(|_| "That is not a LeetCode submission.")?;
            Ok((SUBMISSION, serde_json::json!({ "id": id })))
        }
        _ => Err("Unknown LeetCode lookup.".into()),
    }
}

fn read_account() -> Option<Account> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).ok()?;
    let text = entry.get_password().ok()?;
    serde_json::from_str(&text).ok()
}

fn write_account(account: &Account) -> Result<(), String> {
    let text = serde_json::to_string(account).map_err(|e| e.to_string())?;
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .and_then(|entry| entry.set_password(&text))
        .map_err(|_| "Could not save the LeetCode sign-in to the keychain.".to_string())
}

fn clear_account() -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the LeetCode sign-in from the keychain.".into()),
    }
}

/// Cookie values go into a header, so nothing that could end it may pass.
fn cookie_safe(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value.chars().all(|c| c.is_ascii_graphic() && c != ';' && c != ',')
}

fn post(
    query: &str,
    variables: serde_json::Value,
    account: Option<(&str, &str)>,
) -> Result<serde_json::Value, String> {
    let mut call = ureq::post(ENDPOINT)
        .set("Content-Type", "application/json")
        .set("Referer", "https://leetcode.com/")
        .set("User-Agent", "Mozilla/5.0 (Macintosh) MonoCode")
        .timeout(Duration::from_secs(20));
    if let Some((session, csrf)) = account {
        call = call
            .set(
                "Cookie",
                &format!("LEETCODE_SESSION={session}; csrftoken={csrf}"),
            )
            .set("x-csrftoken", csrf)
            .set("Origin", "https://leetcode.com");
    }
    let response =
        call.send_string(&serde_json::json!({ "query": query, "variables": variables }).to_string());
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(code, _)) => {
            return Err(format!("LeetCode answered HTTP {code}. Try again soon."));
        }
        Err(_) => return Err("Could not reach LeetCode. Check the connection.".into()),
    };
    let mut body = String::new();
    response
        .into_reader()
        .take(MAX_BODY)
        .read_to_string(&mut body)
        .map_err(|_| "LeetCode's answer could not be read.".to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "LeetCode's answer was not what the Code tab expects.".to_string())?;
    match parsed.get("data") {
        Some(data) if !data.is_null() => Ok(data.clone()),
        _ => Err("LeetCode did not send the problem.".into()),
    }
}

fn fetch(kind: &str, value: &str) -> Result<serde_json::Value, String> {
    let account = read_account();
    if needs_account(kind) && account.is_none() {
        return Err("Connect LeetCode first.".into());
    }
    let (query, variables) = request(kind, value, account.as_ref().map(|a| a.username.as_str()))?;
    let data = post(
        query,
        variables,
        account.as_ref().map(|a| (a.session.as_str(), a.csrf.as_str())),
    )?;
    Ok(data)
}

/// Checks a session with LeetCode and gives back its username.
fn verify(session: &str, csrf: &str) -> Result<String, String> {
    if !cookie_safe(session) || !cookie_safe(csrf) {
        return Err("That does not look like a LeetCode session.".into());
    }
    let data = post(ME, serde_json::json!({}), Some((session, csrf)))?;
    let status = &data["userStatus"];
    match (status["isSignedIn"].as_bool(), status["username"].as_str()) {
        (Some(true), Some(name)) if !name.is_empty() => Ok(name.to_string()),
        _ => Err(format!("{REJECTED} Sign in again.")),
    }
}

fn connect_with(session: &str, csrf: &str) -> Result<String, String> {
    let username = verify(session, csrf)?;
    write_account(&Account {
        session: session.to_string(),
        csrf: csrf.to_string(),
        username: username.clone(),
    })?;
    Ok(username)
}

#[derive(Clone, serde::Serialize)]
struct AccountEvent {
    username: Option<String>,
    error: Option<String>,
}

/// Waits for the sign-in window to hold a session, then keeps it and closes
/// the window. Closing the window first, or 15 minutes, ends the wait.
fn watch_login(app: AppHandle) {
    let url: tauri::Url = match LOGIN_URL.parse() {
        Ok(url) => url,
        Err(_) => return,
    };
    let started = Instant::now();
    let mut rejected: Option<String> = None;
    while started.elapsed() < LOGIN_WAIT {
        std::thread::sleep(Duration::from_millis(1200));
        let Some(window) = app.get_webview_window(LOGIN_LABEL) else {
            return;
        };
        let Ok(cookies) = window.cookies_for_url(url.clone()) else {
            continue;
        };
        let find = |name: &str| {
            cookies
                .iter()
                .find(|cookie| cookie.name() == name)
                .map(|cookie| cookie.value().to_string())
        };
        let (Some(session), Some(csrf)) = (find("LEETCODE_SESSION"), find("csrftoken")) else {
            continue;
        };
        // A session LeetCode already turned down is not asked about again;
        // one that failed on the network is tried again on the next tick.
        if rejected.as_deref() == Some(session.as_str()) {
            continue;
        }
        match connect_with(&session, &csrf) {
            Ok(username) => {
                let _ = app.emit(
                    ACCOUNT_EVENT,
                    AccountEvent { username: Some(username), error: None },
                );
                let _ = window.close();
                return;
            }
            Err(error) if error.contains("keychain") => {
                let _ = app.emit(ACCOUNT_EVENT, AccountEvent { username: None, error: Some(error) });
                let _ = window.close();
                return;
            }
            Err(error) if error.starts_with(REJECTED) => rejected = Some(session),
            Err(_) => std::thread::sleep(Duration::from_secs(3)),
        }
    }
    if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
        let _ = window.close();
    }
}

/// Opens LeetCode's sign-in page in a private window. The account arrives
/// later as an `monocode:fork-leetcode-account` event.
#[tauri::command]
pub async fn fork_leetcode_connect(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
        let _ = window.set_focus();
        return Ok(());
    }
    let url: tauri::Url = LOGIN_URL.parse().map_err(|_| "Bad LeetCode address.".to_string())?;
    // Private: nothing of the sign-in stays in the app's own browser store,
    // and the page gets no app commands (capabilities cover local pages only).
    WebviewWindowBuilder::new(&app, LOGIN_LABEL, WebviewUrl::External(url))
        .title("Sign in to LeetCode")
        .inner_size(520.0, 760.0)
        .incognito(true)
        .build()
        .map_err(|error| format!("Could not open LeetCode's sign-in: {error}"))?;
    std::thread::spawn(move || watch_login(app));
    Ok(())
}

/// The fallback: a LEETCODE_SESSION and csrftoken copied from a browser.
#[tauri::command]
pub async fn fork_leetcode_connect_paste(session: String, csrf: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || connect_with(session.trim(), csrf.trim()))
        .await
        .map_err(|error: tauri::Error| error.to_string())?
}

/// The connected username, or null. Reads the keychain only.
#[tauri::command]
pub async fn fork_leetcode_account() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| read_account().map(|account| account.username))
        .await
        .map_err(|error: tauri::Error| error.to_string())
}

#[tauri::command]
pub async fn fork_leetcode_disconnect() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(clear_account)
        .await
        .map_err(|error: tauri::Error| error.to_string())?
}

/// `kind` is question (value: slug), daily, random (value: EASY, MEDIUM or
/// HARD) or number (value: the problem number). Gives back GraphQL's `data`.
#[tauri::command]
pub async fn fork_leetcode_fetch(kind: String, value: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || fetch(&kind, &value))
        .await
        .map_err(|error: tauri::Error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_checked() {
        assert!(valid_slug("two-sum"));
        assert!(valid_slug("3sum"));
        assert!(!valid_slug(""));
        assert!(!valid_slug("Two-Sum"));
        assert!(!valid_slug("two sum"));
        assert!(!valid_slug("a\"b"));
    }

    #[test]
    fn requests_reject_bad_input() {
        assert!(request("question", "../x", None).is_err());
        assert!(request("random", "EXTREME", None).is_err());
        assert!(request("number", "12a", None).is_err());
        assert!(request("nope", "", None).is_err());
        assert!(request("number", "121", None).is_ok());
        assert!(request("daily", "", None).is_ok());
        assert!(request("progress", "-1", None).is_err());
        assert!(request("progress", "200", None).is_ok());
        assert!(request("submission", "12x", None).is_err());
        assert!(request("submissions", "Two Sum", None).is_err());
        assert!(request("profile", "", None).is_err());
        assert!(request("profile", "", Some("sam")).is_ok());
        assert!(needs_account("recent"));
        assert!(!needs_account("question"));
    }

    #[test]
    fn cookies_cannot_break_the_header() {
        assert!(cookie_safe("eyJhbGciOi.abc-_"));
        assert!(!cookie_safe(""));
        assert!(!cookie_safe("a; b=c"));
        assert!(!cookie_safe("a\r\nX: y"));
        assert!(!cookie_safe("a b"));
    }
}
