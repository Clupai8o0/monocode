//! Fork: drive a shared iOS Simulator or Android emulator from beside a session.
//! The devices come from the vault's `stacks.py`; this only finds the ones that
//! are running, takes screenshots and passes touches through.
//!
//! Only emulators and simulators are ever listed or accepted. A real phone
//! plugged into this computer can't be reached from here.

use std::path::PathBuf;
use std::process::Command;

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};

/// Simulator touches are in points, screenshots in pixels. The shared iPhone is
/// a 3x device; `stacks.json` pins it, so this holds until that changes.
const IOS_SCALE: f64 = 3.0;
const MAX_TEXT_CHARS: usize = 1_000;
const MAX_COORDINATE: f64 = 20_000.0;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// `android:emulator-5554` or `ios:<udid>`.
    pub id: String,
    pub kind: String,
    pub name: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    Android(String),
    Ios(String),
}

/// Refuses anything but an emulator or a simulator's id, so a value from the
/// webview or an outside agent can't become an option or reach a real phone.
pub fn parse_device(id: &str) -> Result<Target, String> {
    let invalid = || "Not a running emulator or simulator".to_string();
    let (kind, value) = id.split_once(':').ok_or_else(invalid)?;
    match kind {
        "android" => {
            let port = value.strip_prefix("emulator-").ok_or_else(invalid)?;
            if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid());
            }
            Ok(Target::Android(value.to_string()))
        }
        "ios" => {
            let uuid =
                value.len() == 36 && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
            if !uuid {
                return Err(invalid());
            }
            Ok(Target::Ios(value.to_string()))
        }
        _ => Err(invalid()),
    }
}

/// The running emulators in `adb devices` output. Real phones are left out.
pub fn parse_adb_devices(text: &str) -> Vec<Device> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let serial = fields.next()?;
            (fields.next() == Some("device") && serial.starts_with("emulator-")).then(|| Device {
                id: format!("android:{serial}"),
                kind: "android".into(),
                name: serial.to_string(),
            })
        })
        .collect()
}

/// The booted simulators in `simctl list devices booted --json`.
pub fn parse_simctl_devices(text: &str) -> Vec<Device> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let Some(runtimes) = value.get("devices").and_then(Value::as_object) else {
        return Vec::new();
    };
    runtimes
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .filter(|device| device.get("state").and_then(Value::as_str) == Some("Booted"))
        .filter_map(|device| {
            let udid = device.get("udid")?.as_str()?;
            parse_device(&format!("ios:{udid}")).ok()?;
            Some(Device {
                id: format!("ios:{udid}"),
                kind: "ios".into(),
                name: device.get("name")?.as_str()?.to_string(),
            })
        })
        .collect()
}

type Plan = (&'static str, Vec<String>);

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_string()).collect()
}

fn coordinate(value: f64) -> Result<f64, String> {
    if !value.is_finite() || !(0.0..=MAX_COORDINATE).contains(&value) {
        return Err("That point is outside the screen".into());
    }
    Ok(value)
}

pub fn screenshot_plan(target: &Target) -> Plan {
    match target {
        Target::Android(serial) => (
            "adb",
            strings(&["-s", serial, "exec-out", "screencap", "-p"]),
        ),
        Target::Ios(udid) => (
            "xcrun",
            strings(&["simctl", "io", udid, "screenshot", "--type=png", "-"]),
        ),
    }
}

/// Points are in screenshot pixels on either platform.
pub fn tap_plan(target: &Target, x: f64, y: f64) -> Result<Plan, String> {
    let (x, y) = (coordinate(x)?, coordinate(y)?);
    Ok(match target {
        Target::Android(serial) => (
            "adb",
            strings(&[
                "-s",
                serial,
                "shell",
                "input",
                "tap",
                &format!("{}", x.round()),
                &format!("{}", y.round()),
            ]),
        ),
        Target::Ios(udid) => (
            "idb",
            strings(&[
                "ui",
                "tap",
                "--udid",
                udid,
                &format!("{}", (x / IOS_SCALE).round()),
                &format!("{}", (y / IOS_SCALE).round()),
            ]),
        ),
    })
}

pub fn swipe_plan(target: &Target, from: (f64, f64), to: (f64, f64)) -> Result<Plan, String> {
    let (x1, y1) = (coordinate(from.0)?, coordinate(from.1)?);
    let (x2, y2) = (coordinate(to.0)?, coordinate(to.1)?);
    Ok(match target {
        Target::Android(serial) => {
            let mut args = strings(&["-s", serial, "shell", "input", "swipe"]);
            for value in [x1, y1, x2, y2] {
                args.push(format!("{}", value.round()));
            }
            ("adb", args)
        }
        Target::Ios(udid) => {
            let mut args = strings(&["ui", "swipe", "--udid", udid]);
            for value in [x1, y1, x2, y2] {
                args.push(format!("{}", (value / IOS_SCALE).round()));
            }
            ("idb", args)
        }
    })
}

/// `adb shell` runs its words through the device's shell, so the text goes in
/// single quotes. `input text` reads `%s` as a space and leaves any other `%`
/// alone, so a literal `%s` has to go in two calls: `%`, then `s`.
fn android_text_parts(text: &str) -> Vec<String> {
    let pieces: Vec<&str> = text.split("%s").collect();
    let last = pieces.len() - 1;
    pieces
        .iter()
        .enumerate()
        .flat_map(|(index, piece)| {
            let start = if index == 0 { "" } else { "s" };
            let end = if index == last { "" } else { "%" };
            let part = format!("{start}{piece}{end}");
            (!part.is_empty()).then_some(part)
        })
        .map(|part| {
            let escaped = part.replace(' ', "%s").replace('\'', "'\\''");
            format!("'{escaped}'")
        })
        .collect()
}

/// More than one plan only on Android, for the case above.
pub fn text_plans(target: &Target, text: &str) -> Result<Vec<Plan>, String> {
    if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
        return Err("Send between 1 and 1,000 characters".into());
    }
    if text.chars().any(char::is_control) {
        return Err("Text can't include line breaks or control characters".into());
    }
    Ok(match target {
        Target::Android(serial) => android_text_parts(text)
            .into_iter()
            .map(|part| {
                (
                    "adb",
                    strings(&["-s", serial, "shell", "input", "text", &part]),
                )
            })
            .collect(),
        Target::Ios(udid) => vec![("idb", strings(&["ui", "text", "--udid", udid, "--", text]))],
    })
}

fn search_path() -> String {
    let mut path = crate::harness::cached_gui_search_path();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for extra in ["Library/Android/sdk/platform-tools", ".local/bin"] {
            path.push(':');
            path.push_str(&home.join(extra).to_string_lossy());
        }
    }
    path
}

fn run((program, args): Plan) -> Result<Vec<u8>, String> {
    let mut command = Command::new(program);
    crate::hide_window_console(&mut command);
    let output = command
        .args(&args)
        .env("PATH", search_path())
        .output()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => format!("{program} isn't installed on this computer"),
            _ => error.to_string(),
        })?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

pub fn list_devices() -> Vec<Device> {
    let mut devices = Vec::new();
    if let Ok(text) = run(("adb", strings(&["devices"]))) {
        devices.extend(parse_adb_devices(&String::from_utf8_lossy(&text)));
    }
    if let Ok(text) = run((
        "xcrun",
        strings(&["simctl", "list", "devices", "booted", "--json"]),
    )) {
        devices.extend(parse_simctl_devices(&String::from_utf8_lossy(&text)));
    }
    devices
}

/// A PNG as base64; nothing is written to disk.
pub fn screenshot(device: &str) -> Result<String, String> {
    let bytes = run(screenshot_plan(&parse_device(device)?))?;
    if !bytes.starts_with(b"\x89PNG") {
        return Err("The device didn't return a screenshot".into());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

pub fn tap(device: &str, x: f64, y: f64) -> Result<(), String> {
    run(tap_plan(&parse_device(device)?, x, y)?).map(|_| ())
}

pub fn swipe(device: &str, from: (f64, f64), to: (f64, f64)) -> Result<(), String> {
    run(swipe_plan(&parse_device(device)?, from, to)?).map(|_| ())
}

pub fn type_text(device: &str, text: &str) -> Result<(), String> {
    for plan in text_plans(&parse_device(device)?, text)? {
        run(plan)?;
    }
    Ok(())
}

pub fn is_device_action(action: &str) -> bool {
    action.starts_with("device.")
}

/// An outside agent's `device.*` call, run here with no need to wake the app.
pub fn handle_action(action: &str, input: &Value) -> Result<Value, String> {
    let device = || {
        input
            .get("device")
            .and_then(Value::as_str)
            .ok_or_else(|| "Name a device from device_list".to_string())
    };
    let number = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_f64)
            .ok_or_else(|| format!("{key} must be a number"))
    };
    match action {
        "device.list" => Ok(json!({ "devices": list_devices() })),
        "device.screenshot" => Ok(json!({ "png": screenshot(device()?)? })),
        "device.tap" => {
            tap(device()?, number("x")?, number("y")?)?;
            Ok(json!({ "tapped": true }))
        }
        "device.swipe" => {
            swipe(
                device()?,
                (number("fromX")?, number("fromY")?),
                (number("toX")?, number("toY")?),
            )?;
            Ok(json!({ "swiped": true }))
        }
        "device.type" => {
            let text = input
                .get("text")
                .and_then(Value::as_str)
                .ok_or("text is required")?;
            type_text(device()?, text)?;
            Ok(json!({ "typed": true }))
        }
        _ => Err("Unknown device action".into()),
    }
}

// fork-device-app-wiring-start
#[tauri::command(async)]
pub fn fork_device_list() -> Vec<Device> {
    list_devices()
}

#[tauri::command(async)]
pub fn fork_device_screenshot(device: String) -> Result<String, String> {
    screenshot(&device)
}

#[tauri::command(async)]
pub fn fork_device_tap(device: String, x: f64, y: f64) -> Result<(), String> {
    tap(&device, x, y)
}

#[tauri::command(async)]
pub fn fork_device_swipe(
    device: String,
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
) -> Result<(), String> {
    swipe(&device, (from_x, from_y), (to_x, to_y))
}

#[tauri::command(async)]
pub fn fork_device_type(device: String, text: String) -> Result<(), String> {
    type_text(&device, &text)
}
// fork-device-app-wiring-end

#[cfg(test)]
mod tests {
    use super::*;

    const UDID: &str = "A1B2C3D4-0000-1111-2222-333344445555";

    #[test]
    fn only_accepts_emulators_and_simulators() {
        assert_eq!(
            parse_device("android:emulator-5554").unwrap(),
            Target::Android("emulator-5554".into())
        );
        assert_eq!(
            parse_device(&format!("ios:{UDID}")).unwrap(),
            Target::Ios(UDID.into())
        );
        for bad in [
            "android:R58N123ABC",
            "android:emulator-",
            "android:emulator-55;reboot",
            "android:-s",
            "ios:booted",
            "ios:--help",
            "ios:A1B2C3D4-0000-1111-2222-33334444555;",
            "emulator-5554",
            "windows:x",
            "",
        ] {
            assert!(parse_device(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn lists_emulators_and_leaves_out_real_phones() {
        let text = "List of devices attached\nemulator-5554\tdevice\nR58N123ABC\tdevice\nemulator-5556\toffline\n";
        let devices = parse_adb_devices(text);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "android:emulator-5554");
    }

    #[test]
    fn lists_booted_simulators() {
        let text = json!({ "devices": { "iOS-26": [
            { "udid": UDID, "name": "iPhone 17 Pro", "state": "Booted" },
            { "udid": "A1B2C3D4-0000-1111-2222-333344445556", "name": "Off", "state": "Shutdown" },
            { "udid": "bad", "name": "Odd", "state": "Booted" },
        ] } })
        .to_string();
        let devices = parse_simctl_devices(&text);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "iPhone 17 Pro");
        assert!(parse_simctl_devices("not json").is_empty());
    }

    #[test]
    fn plans_screenshots() {
        let (program, args) = screenshot_plan(&Target::Android("emulator-5554".into()));
        assert_eq!(program, "adb");
        assert_eq!(args, ["-s", "emulator-5554", "exec-out", "screencap", "-p"]);
        let (program, args) = screenshot_plan(&Target::Ios(UDID.into()));
        assert_eq!(program, "xcrun");
        assert_eq!(args.last().unwrap(), "-");
    }

    #[test]
    fn taps_in_pixels_on_android_and_points_on_ios() {
        let (_, android) = tap_plan(&Target::Android("emulator-1".into()), 300.4, 900.6).unwrap();
        assert_eq!(&android[android.len() - 2..], ["300", "901"]);
        let (program, ios) = tap_plan(&Target::Ios(UDID.into()), 300.0, 900.0).unwrap();
        assert_eq!(program, "idb");
        assert_eq!(&ios[ios.len() - 2..], ["100", "300"]);
    }

    #[test]
    fn refuses_points_off_any_screen() {
        let target = Target::Android("emulator-1".into());
        assert!(tap_plan(&target, -1.0, 5.0).is_err());
        assert!(tap_plan(&target, f64::NAN, 5.0).is_err());
        assert!(tap_plan(&target, 5.0, f64::INFINITY).is_err());
        assert!(swipe_plan(&target, (0.0, 0.0), (1e9, 0.0)).is_err());
    }

    #[test]
    fn swipes_with_both_ends() {
        let (_, args) = swipe_plan(
            &Target::Android("emulator-1".into()),
            (1.0, 2.0),
            (3.0, 4.0),
        )
        .unwrap();
        assert_eq!(&args[args.len() - 4..], ["1", "2", "3", "4"]);
    }

    fn android_parts(text: &str) -> Vec<String> {
        text_plans(&Target::Android("emulator-1".into()), text)
            .unwrap()
            .into_iter()
            .map(|(_, args)| args.last().unwrap().clone())
            .collect()
    }

    #[test]
    fn keeps_typed_text_out_of_the_device_shell() {
        assert_eq!(
            android_parts("it's $(reboot) ok"),
            ["'it'\\''s%s$(reboot)%sok'"]
        );
    }

    #[test]
    fn leaves_a_plain_percent_as_it_is() {
        assert_eq!(android_parts("100%"), ["'100%'"]);
        assert_eq!(android_parts("100% ok"), ["'100%%sok'"]);
    }

    #[test]
    fn sends_a_literal_percent_s_in_two_calls() {
        assert_eq!(android_parts("a%sb"), ["'a%'", "'sb'"]);
        assert_eq!(android_parts("%s"), ["'%'", "'s'"]);
        assert_eq!(android_parts("%s%s"), ["'%'", "'s%'", "'s'"]);
    }

    #[test]
    fn stops_text_starting_like_an_option_on_ios() {
        let plans = text_plans(&Target::Ios(UDID.into()), "--help").unwrap();
        assert_eq!(&plans[0].1[plans[0].1.len() - 2..], ["--", "--help"]);
    }

    #[test]
    fn refuses_empty_long_or_multi_line_text() {
        let target = Target::Android("emulator-1".into());
        assert!(text_plans(&target, "").is_err());
        assert!(text_plans(&target, "a\nb").is_err());
        assert!(text_plans(&target, &"x".repeat(1_001)).is_err());
    }

    #[test]
    fn actions_need_a_valid_device_and_numbers() {
        assert!(handle_action("device.tap", &json!({ "x": 1, "y": 1 })).is_err());
        assert!(handle_action(
            "device.tap",
            &json!({ "device": "android:R58", "x": 1, "y": 1 })
        )
        .is_err());
        assert!(handle_action(
            "device.tap",
            &json!({ "device": "android:emulator-1", "x": "1", "y": 1 })
        )
        .is_err());
        assert!(handle_action("device.delete", &json!({})).is_err());
    }
}
