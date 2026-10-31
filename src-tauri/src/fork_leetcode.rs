//! Fork: reads LeetCode problems for the Games panel's Code tab.
//!
//! LeetCode's public GraphQL answers without a login. The webview cannot
//! call it (no CORS for our origin), so these few fixed queries run here.
//! The Code tab turns the answer into a drill (see leetcode.ts).

use std::io::Read;
use std::time::Duration;

const ENDPOINT: &str = "https://leetcode.com/graphql";
const MAX_BODY: u64 = 2 * 1024 * 1024;

const QUESTION: &str = "query q($slug: String!) { question(titleSlug: $slug) { \
questionFrontendId title titleSlug difficulty isPaidOnly content hints metaData \
exampleTestcaseList codeSnippets { langSlug code } topicTags { name } } }";
const DAILY: &str =
    "query { activeDailyCodingChallengeQuestion { date question { titleSlug } } }";
const RANDOM: &str = "query r($filters: QuestionListFilterInput) { \
randomQuestion(categorySlug: \"algorithms\", filters: $filters) { titleSlug isPaidOnly } }";
const NUMBER: &str = "query n($filters: QuestionListFilterInput) { \
questionList(categorySlug: \"\", limit: 20, skip: 0, filters: $filters) { \
data { questionFrontendId titleSlug isPaidOnly } } }";

/// A slug as LeetCode writes them: lowercase letters, digits and dashes.
fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn request(kind: &str, value: &str) -> Result<(&'static str, serde_json::Value), String> {
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
        _ => Err("Unknown LeetCode lookup.".into()),
    }
}

fn fetch(kind: &str, value: &str) -> Result<serde_json::Value, String> {
    let (query, variables) = request(kind, value)?;
    let response = ureq::post(ENDPOINT)
        .set("Content-Type", "application/json")
        .set("Referer", "https://leetcode.com")
        .set("User-Agent", "Mozilla/5.0 (Macintosh) MonoCode")
        .timeout(Duration::from_secs(20))
        .send_string(&serde_json::json!({ "query": query, "variables": variables }).to_string());
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
        assert!(request("question", "../x").is_err());
        assert!(request("random", "EXTREME").is_err());
        assert!(request("number", "12a").is_err());
        assert!(request("nope", "").is_err());
        assert!(request("number", "121").is_ok());
        assert!(request("daily", "").is_ok());
    }
}
