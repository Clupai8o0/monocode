//! Fork feature: the owner's paused model route prefixes, read-only.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::dirs_home;

const PAUSED_ROUTES: &str =
    "Documents/Obsidian/brain/30-resources/_meta/claude-shared/paused-routes.json";

#[tauri::command]
pub async fn fork_paused_routes() -> Result<Value, String> {
    let Some(home) = dirs_home() else {
        return Ok(json!({}));
    };
    let path = PathBuf::from(home).join(PAUSED_ROUTES);
    let text = std::fs::read_to_string(path).unwrap_or_default();
    Ok(parse_paused(&text))
}

fn parse_paused(text: &str) -> Value {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return json!({});
    };
    let Some(paused) = value.get("paused").and_then(Value::as_object) else {
        return json!({});
    };
    Value::Object(
        paused
            .iter()
            .filter(|(_, reason)| reason.is_string())
            .map(|(route, reason)| (route.clone(), reason.clone()))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_paused_routes() {
        assert_eq!(
            parse_paused(
                r#"{"_about":"Owner switches","paused":{"agy:gemini":"paused by the owner","codex":"maintenance"}}"#
            ),
            json!({"agy:gemini": "paused by the owner", "codex": "maintenance"})
        );
    }

    #[test]
    fn missing_paused_returns_empty_object() {
        assert_eq!(parse_paused(r#"{"_about":"Owner switches"}"#), json!({}));
    }

    #[test]
    fn bad_json_returns_empty_object() {
        for text in ["", "not JSON", r#"{"paused": {"#] {
            assert_eq!(parse_paused(text), json!({}));
        }
    }

    #[test]
    fn non_object_paused_returns_empty_object() {
        for text in [
            r#"{"paused":null}"#,
            r#"{"paused":[]}"#,
            r#"{"paused":"agy:gemini"}"#,
            r#"{"paused":false}"#,
            r#"{"paused":42}"#,
            "[]",
            "null",
        ] {
            assert_eq!(parse_paused(text), json!({}));
        }
    }

    #[test]
    fn drops_non_string_reasons() {
        assert_eq!(
            parse_paused(
                r#"{"paused":{"agy:gemini":"paused","number":1,"bool":true,"null":null,"array":[],"object":{}}}"#
            ),
            json!({"agy:gemini": "paused"})
        );
    }
}
