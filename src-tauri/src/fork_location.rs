//! Fork feature: alerts ring only at saved places. At home, or any place the
//! user adds, banners play their sound as before; anywhere else they still
//! show but stay silent. Places live in
//! `~/.local/state/monocode-fork/places.json`, outside the repo, because they
//! hold the user's addresses. CoreLocation gives the fix (Wi-Fi positioning on
//! a Mac) and CLGeocoder turns an address into a point.

use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const EVENT: &str = "fork_location";
const NAME_MAX: usize = 40;
const ADDRESS_MAX: usize = 200;
const PLACES_MAX: usize = 20;
const RADIUS_DEFAULT_M: f64 = 150.0;
const RADIUS_MIN_M: f64 = 50.0;
const RADIUS_MAX_M: f64 = 2_000.0;
/// Up to this much of a fix's own error is forgiven at a place's edge.
const ACCURACY_SLACK_MAX_M: f64 = 100.0;
/// A fix older than this no longer says where the Mac is.
const FIX_STALE: Duration = Duration::from_secs(15 * 60);
/// How often a fresh fix is asked for.
const POLL: Duration = Duration::from_secs(3 * 60);
/// Adding "where I am now" waits this long for a first fix.
const FIX_WAIT: Duration = Duration::from_secs(10);
const PLACE_CHANGED: &str = "place changed";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Ring only at a saved place.
    #[default]
    Places,
    /// Always ring (upstream's behaviour).
    Always,
    /// Never ring.
    Never,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Place {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
    #[serde(default = "radius_default")]
    pub radius: f64,
}

fn radius_default() -> f64 {
    RADIUS_DEFAULT_M
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
struct Config {
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    places: Vec<Place>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Fix {
    lat: f64,
    lon: f64,
    accuracy: f64,
    at: SystemTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Permission {
    Prompt,
    Granted,
    Denied,
    /// Location Services are off for the whole Mac.
    Off,
    /// Not asked yet in this run.
    Unknown,
}

impl Permission {
    fn as_str(self) -> &'static str {
        match self {
            Permission::Prompt => "prompt",
            Permission::Granted => "granted",
            Permission::Denied => "denied",
            Permission::Off => "off",
            Permission::Unknown => "unknown",
        }
    }
}

struct Inner {
    config: Config,
    fix: Option<Fix>,
    permission: Permission,
    error: Option<String>,
}

static STATE: LazyLock<Mutex<Inner>> = LazyLock::new(|| {
    Mutex::new(Inner {
        config: load_config(),
        fix: None,
        permission: Permission::Unknown,
        error: None,
    })
});

fn config_path() -> Option<PathBuf> {
    Some(PathBuf::from(crate::dirs_home()?).join(".local/state/monocode-fork/places.json"))
}

/// No file means the feature was never set up: ring as upstream does.
fn load_config() -> Config {
    let Some(path) = config_path() else {
        return Config {
            mode: Mode::Always,
            places: Vec::new(),
        };
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => parse_config(&text),
        Err(_) => Config {
            mode: Mode::Always,
            places: Vec::new(),
        },
    }
}

/// A broken file keeps upstream's ringing rather than going silent.
fn parse_config(text: &str) -> Config {
    serde_json::from_str::<Config>(text)
        .map(|mut config| {
            config.places.truncate(PLACES_MAX);
            for place in &mut config.places {
                place.radius = clamp_radius(place.radius);
            }
            config
        })
        .unwrap_or(Config {
            mode: Mode::Always,
            places: Vec::new(),
        })
}

fn save_config(config: &Config) -> Result<(), String> {
    let path = config_path().ok_or("no home folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Changes the config on a copy and keeps it only once it is saved, so memory
/// never drifts from the file.
fn update_config<T>(change: impl FnOnce(&mut Config) -> Result<T, String>) -> Result<T, String> {
    let mut inner = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let mut next = inner.config.clone();
    let out = change(&mut next)?;
    save_config(&next)?;
    inner.config = next;
    Ok(out)
}

fn clamp_radius(radius: f64) -> f64 {
    if radius.is_finite() {
        radius.clamp(RADIUS_MIN_M, RADIUS_MAX_M)
    } else {
        RADIUS_DEFAULT_M
    }
}

/// Great-circle distance in metres.
fn distance_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_M: f64 = 6_371_000.0;
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = (lat2 - lat1).to_radians();
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * EARTH_M * a.sqrt().asin()
}

fn fresh(fix: Option<Fix>, now: SystemTime) -> Option<Fix> {
    let fix = fix?;
    let age = now.duration_since(fix.at).unwrap_or_default();
    (age <= FIX_STALE).then_some(fix)
}

/// The nearest saved place the fix is inside, if any.
fn place_at(places: &[Place], fix: Fix) -> Option<&Place> {
    let slack = fix.accuracy.clamp(0.0, ACCURACY_SLACK_MAX_M);
    places
        .iter()
        .filter_map(|place| {
            let d = distance_m(fix.lat, fix.lon, place.lat?, place.lon?);
            (d <= place.radius + slack).then_some((d, place))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, place)| place)
}

#[derive(Debug, PartialEq)]
struct Decision {
    ring: bool,
    place: Option<String>,
    reason: &'static str,
}

fn decide(config: &Config, fix: Option<Fix>, now: SystemTime) -> Decision {
    let quiet = |reason| Decision {
        ring: false,
        place: None,
        reason,
    };
    match config.mode {
        Mode::Always => Decision {
            ring: true,
            place: None,
            reason: "always",
        },
        Mode::Never => quiet("never"),
        Mode::Places => {
            if !config.places.iter().any(|p| p.lat.is_some() && p.lon.is_some()) {
                return quiet("noPlaces");
            }
            let Some(fix) = fresh(fix, now) else {
                return quiet("noFix");
            };
            match place_at(&config.places, fix) {
                Some(place) => Decision {
                    ring: true,
                    place: Some(place.name.clone()),
                    reason: "atPlace",
                },
                None => quiet("away"),
            }
        }
    }
}

/// Fork hook for `show_notification`: may this alert make a sound?
pub fn ring_allowed() -> bool {
    let inner = STATE.lock().unwrap_or_else(|e| e.into_inner());
    decide(&inner.config, inner.fix, SystemTime::now()).ring
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaceView {
    name: String,
    address: Option<String>,
    radius: f64,
    located: bool,
    /// Metres from the last fresh fix.
    distance: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    mode: Mode,
    ring: bool,
    place: Option<String>,
    /// always | never | noPlaces | noFix | away | atPlace
    reason: &'static str,
    permission: &'static str,
    fix_age_secs: Option<u64>,
    accuracy: Option<f64>,
    places: Vec<PlaceView>,
    error: Option<String>,
}

fn status_of(inner: &Inner, now: SystemTime) -> Status {
    let decision = decide(&inner.config, inner.fix, now);
    let fix = fresh(inner.fix, now);
    Status {
        mode: inner.config.mode,
        ring: decision.ring,
        place: decision.place,
        reason: decision.reason,
        permission: inner.permission.as_str(),
        fix_age_secs: inner
            .fix
            .and_then(|f| now.duration_since(f.at).ok())
            .map(|d| d.as_secs()),
        accuracy: fix.map(|f| f.accuracy),
        places: inner
            .config
            .places
            .iter()
            .map(|p| PlaceView {
                name: p.name.clone(),
                address: p.address.clone(),
                radius: p.radius,
                located: p.lat.is_some() && p.lon.is_some(),
                distance: match (fix, p.lat, p.lon) {
                    (Some(f), Some(lat), Some(lon)) => Some(distance_m(f.lat, f.lon, lat, lon)),
                    _ => None,
                },
            })
            .collect(),
        error: inner.error.clone(),
    }
}

fn status() -> Status {
    let inner = STATE.lock().unwrap_or_else(|e| e.into_inner());
    status_of(&inner, SystemTime::now())
}

fn emit(app: &AppHandle) {
    let _ = app.emit(EVENT, status());
}

fn wants_location() -> bool {
    let inner = STATE.lock().unwrap_or_else(|e| e.into_inner());
    inner.config.mode == Mode::Places && !inner.config.places.is_empty()
}

fn record_fix(app: &AppHandle, lat: f64, lon: f64, accuracy: f64) {
    if !lat.is_finite() || !lon.is_finite() || accuracy < 0.0 {
        return;
    }
    {
        let mut inner = STATE.lock().unwrap_or_else(|e| e.into_inner());
        // A late update after permission was taken back doesn't count.
        if inner.permission != Permission::Granted {
            return;
        }
        inner.fix = Some(Fix {
            lat,
            lon,
            accuracy,
            at: SystemTime::now(),
        });
        inner.error = None;
    }
    emit(app);
}

fn record_permission(app: &AppHandle, permission: Permission) {
    {
        let mut inner = STATE.lock().unwrap_or_else(|e| e.into_inner());
        if inner.permission == permission {
            return;
        }
        inner.permission = permission;
        // A fix from before permission was taken back no longer counts.
        if permission != Permission::Granted {
            inner.fix = None;
        }
    }
    emit(app);
}

fn record_error(app: &AppHandle, error: String) {
    STATE.lock().unwrap_or_else(|e| e.into_inner()).error = Some(error);
    emit(app);
}

/// Runs at Ready, on the main thread.
pub fn start(app: &AppHandle) {
    if wants_location() {
        platform::start(app);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        locate_missing(&app).await;
    });
}

/// Turns saved addresses with no point yet into one (first run, or a hand
/// edited file).
async fn locate_missing(app: &AppHandle) {
    let pending: Vec<(String, String)> = {
        let inner = STATE.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .config
            .places
            .iter()
            .filter(|p| p.lat.is_none() || p.lon.is_none())
            .filter_map(|p| Some((p.name.clone(), p.address.clone()?)))
            .collect()
    };
    if pending.is_empty() {
        return;
    }
    for (name, address) in pending {
        match platform::geocode(app, address.clone()).await {
            Ok((lat, lon)) => {
                // Only onto the same, still unlocated place: it may have been
                // replaced or removed while the lookup ran.
                let saved = update_config(|config| {
                    let place = config
                        .places
                        .iter_mut()
                        .find(|p| {
                            p.name == name
                                && p.address.as_deref() == Some(address.as_str())
                                && (p.lat.is_none() || p.lon.is_none())
                        })
                        .ok_or(PLACE_CHANGED)?;
                    place.lat = Some(lat);
                    place.lon = Some(lon);
                    Ok(())
                });
                if let Err(err) = saved.as_ref().map_err(String::as_str) {
                    if err != PLACE_CHANGED {
                        STATE.lock().unwrap_or_else(|e| e.into_inner()).error =
                            Some(format!("Couldn't save {name}: {err}"));
                    }
                }
            }
            Err(err) => {
                STATE.lock().unwrap_or_else(|e| e.into_inner()).error =
                    Some(format!("Couldn't find {name}: {err}"));
            }
        }
    }
    emit(app);
}

#[tauri::command]
pub fn fork_location_status() -> Status {
    status()
}

#[tauri::command]
pub fn fork_location_set_mode(app: AppHandle, mode: Mode) -> Result<Status, String> {
    update_config(|config| {
        config.mode = mode;
        Ok(())
    })?;
    if wants_location() {
        platform::start(&app);
    }
    emit(&app);
    Ok(status())
}

fn clean_name(name: &str) -> Result<String, String> {
    let name: String = name.trim().chars().take(NAME_MAX).collect();
    if name.is_empty() {
        return Err("Give the place a name".into());
    }
    Ok(name)
}

/// Adds a place, or replaces the one with the same name. With an address it is
/// looked up; without one it is where the Mac is now.
#[tauri::command]
pub async fn fork_place_add(
    app: AppHandle,
    name: String,
    address: Option<String>,
    radius: Option<f64>,
) -> Result<Status, String> {
    let name = clean_name(&name)?;
    let address = address
        .map(|a| a.trim().chars().take(ADDRESS_MAX).collect::<String>())
        .filter(|a| !a.is_empty());
    let (lat, lon) = match &address {
        Some(address) => platform::geocode(&app, address.clone()).await?,
        None => current_point(&app).await?,
    };
    let place = Place {
        name: name.clone(),
        address,
        lat: Some(lat),
        lon: Some(lon),
        radius: clamp_radius(radius.unwrap_or(RADIUS_DEFAULT_M)),
    };
    update_config(|config| {
        let places = &mut config.places;
        match places
            .iter()
            .position(|p| p.name.eq_ignore_ascii_case(&name))
        {
            Some(i) => places[i] = place,
            None if places.len() >= PLACES_MAX => {
                return Err(format!("At most {PLACES_MAX} places"));
            }
            None => places.push(place),
        }
        Ok(())
    })?;
    STATE.lock().unwrap_or_else(|e| e.into_inner()).error = None;
    if wants_location() {
        platform::start(&app);
    }
    emit(&app);
    Ok(status())
}

async fn current_point(app: &AppHandle) -> Result<(f64, f64), String> {
    platform::start(app);
    let deadline = std::time::Instant::now() + FIX_WAIT;
    loop {
        {
            let inner = STATE.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(fix) = fresh(inner.fix, SystemTime::now()) {
                return Ok((fix.lat, fix.lon));
            }
            if matches!(inner.permission, Permission::Denied | Permission::Off) {
                return Err("Location is off for MonoCode. Allow it in System Settings.".into());
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err("No location yet. Try again in a moment, or type an address.".into());
        }
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(Duration::from_millis(500))
        })
        .await;
    }
}

#[tauri::command]
pub fn fork_place_remove(app: AppHandle, name: String) -> Result<Status, String> {
    update_config(|config| {
        config.places.retain(|p| p.name != name);
        Ok(())
    })?;
    emit(&app);
    Ok(status())
}

#[tauri::command(async)]
pub fn fork_location_open_settings() -> Result<(), String> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices")
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
#[allow(deprecated)] // CLGeocoder and CLPlacemark: MapKit's replacements need macOS 26.
mod platform {
    use std::cell::RefCell;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker};
    use objc2_core_location::{
        kCLLocationAccuracyHundredMeters, CLAuthorizationStatus, CLGeocoder, CLLocation,
        CLLocationManager, CLLocationManagerDelegate, CLPlacemark,
    };
    use objc2_foundation::{NSArray, NSError, NSString};
    use tauri::AppHandle;

    use super::Permission;

    const GEOCODE_TIMEOUT: Duration = Duration::from_secs(15);
    /// kCLErrorLocationUnknown: no fix yet, it keeps trying.
    const ERROR_LOCATION_UNKNOWN: isize = 0;

    struct DelegateIvars {
        app: AppHandle,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "MonoCodeForkLocationDelegate"]
        #[ivars = DelegateIvars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl CLLocationManagerDelegate for Delegate {
            #[unsafe(method(locationManager:didUpdateLocations:))]
            fn did_update(&self, _manager: &CLLocationManager, locations: &NSArray<CLLocation>) {
                if let Some(location) = locations.lastObject() {
                    let point = unsafe { location.coordinate() };
                    let accuracy = unsafe { location.horizontalAccuracy() };
                    super::record_fix(&self.ivars().app, point.latitude, point.longitude, accuracy);
                }
            }

            #[unsafe(method(locationManager:didFailWithError:))]
            fn did_fail(&self, _manager: &CLLocationManager, error: &NSError) {
                if error.code() != ERROR_LOCATION_UNKNOWN {
                    super::record_error(
                        &self.ivars().app,
                        error.localizedDescription().to_string(),
                    );
                }
            }

            #[unsafe(method(locationManagerDidChangeAuthorization:))]
            fn did_change_authorization(&self, manager: &CLLocationManager) {
                let permission = map_permission(manager);
                super::record_permission(&self.ivars().app, permission);
                if permission == Permission::Granted {
                    unsafe { manager.requestLocation() };
                }
            }
        }
    );

    fn map_permission(manager: &CLLocationManager) -> Permission {
        if !unsafe { CLLocationManager::locationServicesEnabled_class() } {
            return Permission::Off;
        }
        let status = unsafe { manager.authorizationStatus() };
        if status == CLAuthorizationStatus::NotDetermined {
            Permission::Prompt
        } else if status == CLAuthorizationStatus::AuthorizedAlways
            || status == CLAuthorizationStatus::AuthorizedWhenInUse
        {
            Permission::Granted
        } else {
            Permission::Denied
        }
    }

    thread_local! {
        static MANAGER: RefCell<Option<(Retained<CLLocationManager>, Retained<Delegate>)>> =
            const { RefCell::new(None) };
    }

    static POLLING: AtomicBool = AtomicBool::new(false);

    /// Creates the manager once (asking for permission the first time), then
    /// asks for a fresh fix. Safe to call from any thread.
    pub(super) fn start(app: &AppHandle) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || start_on_main(&handle));
        if !POLLING.swap(true, Ordering::SeqCst) {
            let app = app.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(super::POLL);
                if super::wants_location() {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || start_on_main(&handle));
                }
            });
        }
    }

    fn start_on_main(app: &AppHandle) {
        if MainThreadMarker::new().is_none() {
            return;
        }
        MANAGER.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot.is_none() {
                let delegate = Delegate::alloc().set_ivars(DelegateIvars { app: app.clone() });
                let delegate: Retained<Delegate> = unsafe { msg_send![super(delegate), init] };
                let manager = unsafe { CLLocationManager::new() };
                unsafe {
                    manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
                    manager.setDesiredAccuracy(kCLLocationAccuracyHundredMeters);
                }
                *slot = Some((manager, delegate));
            }
            let (manager, _) = slot.as_ref().expect("set above");
            let permission = map_permission(manager);
            super::record_permission(app, permission);
            match permission {
                Permission::Prompt => unsafe { manager.requestWhenInUseAuthorization() },
                Permission::Granted => unsafe { manager.requestLocation() },
                _ => {}
            }
        });
    }

    fn start_geocode(app: &AppHandle, address: String) -> mpsc::Receiver<Result<(f64, f64), String>> {
        let (tx, rx) = mpsc::channel();
        let sent = app.run_on_main_thread(move || {
            let geocoder = unsafe { CLGeocoder::new() };
            // The block keeps the geocoder alive until it answers.
            let keep = geocoder.clone();
            let handler = RcBlock::new(
                move |marks: *mut NSArray<CLPlacemark>, error: *mut NSError| {
                    let _ = &keep;
                    let point = NonNull::new(marks)
                        .and_then(|marks| unsafe { marks.as_ref() }.firstObject())
                        .and_then(|mark| unsafe { mark.location() })
                        .map(|location| unsafe { location.coordinate() });
                    let result = match point {
                        Some(point) => Ok((point.latitude, point.longitude)),
                        None => Err(match NonNull::new(error) {
                            Some(error) => unsafe { error.as_ref() }
                                .localizedDescription()
                                .to_string(),
                            None => "no match for that address".into(),
                        }),
                    };
                    let _ = tx.send(result);
                },
            );
            unsafe {
                geocoder.geocodeAddressString_inRegion_completionHandler(
                    &NSString::from_str(&address),
                    None,
                    RcBlock::as_ptr(&handler),
                );
            }
        });
        if sent.is_err() {
            let (tx, rx) = mpsc::channel();
            let _ = tx.send(Err("app is closing".into()));
            return rx;
        }
        rx
    }

    pub(super) async fn geocode(app: &AppHandle, address: String) -> Result<(f64, f64), String> {
        let rx = start_geocode(app, address);
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(GEOCODE_TIMEOUT).ok())
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| Err("address lookup timed out".into()))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use objc2::runtime::AnyProtocol;
        use objc2::{sel, ClassType};

        #[test]
        fn fork_location_delegate_registers_protocol_methods() {
            let cls = Delegate::class();
            let proto = AnyProtocol::get(c"CLLocationManagerDelegate").expect("protocol loaded");
            assert!(cls.conforms_to(proto));
            assert!(cls.responds_to(sel!(locationManager:didUpdateLocations:)));
            assert!(cls.responds_to(sel!(locationManager:didFailWithError:)));
            assert!(cls.responds_to(sel!(locationManagerDidChangeAuthorization:)));
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use tauri::AppHandle;

    pub(super) fn start(_app: &AppHandle) {}

    pub(super) async fn geocode(_app: &AppHandle, _address: String) -> Result<(f64, f64), String> {
        Err("address lookup needs macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(name: &str, lat: f64, lon: f64, radius: f64) -> Place {
        Place {
            name: name.into(),
            address: None,
            lat: Some(lat),
            lon: Some(lon),
            radius,
        }
    }

    fn fix(lat: f64, lon: f64, accuracy: f64, age_secs: u64) -> Fix {
        Fix {
            lat,
            lon,
            accuracy,
            at: SystemTime::now() - Duration::from_secs(age_secs),
        }
    }

    fn places(list: Vec<Place>) -> Config {
        Config {
            mode: Mode::Places,
            places: list,
        }
    }

    #[test]
    fn fork_location_distance_is_in_metres() {
        // 0.001 degrees of latitude is about 111 m anywhere.
        let d = distance_m(-37.8, 145.1, -37.801, 145.1);
        assert!((d - 111.2).abs() < 1.0, "{d}");
        assert_eq!(distance_m(-37.8, 145.1, -37.8, 145.1), 0.0);
    }

    #[test]
    fn fork_location_rings_only_inside_a_place() {
        let config = places(vec![place("Home", -37.8, 145.1, 150.0)]);
        let now = SystemTime::now();
        let home = decide(&config, Some(fix(-37.8005, 145.1, 30.0, 0)), now);
        assert_eq!(home.ring, true);
        assert_eq!(home.place.as_deref(), Some("Home"));
        let away = decide(&config, Some(fix(-37.81, 145.1, 30.0, 0)), now);
        assert_eq!((away.ring, away.reason), (false, "away"));
    }

    #[test]
    fn fork_location_forgives_some_fix_error_at_the_edge() {
        let config = places(vec![place("Home", -37.8, 145.1, 100.0)]);
        let now = SystemTime::now();
        // About 167 m out: inside with 80 m of error, outside with 10 m.
        assert!(decide(&config, Some(fix(-37.8015, 145.1, 80.0, 0)), now).ring);
        assert!(!decide(&config, Some(fix(-37.8015, 145.1, 10.0, 0)), now).ring);
        // A 5 km error is only forgiven up to the cap.
        assert!(!decide(&config, Some(fix(-37.81, 145.1, 5_000.0, 0)), now).ring);
    }

    #[test]
    fn fork_location_stale_or_missing_fix_is_silent() {
        let config = places(vec![place("Home", -37.8, 145.1, 150.0)]);
        let now = SystemTime::now();
        assert_eq!(decide(&config, None, now).reason, "noFix");
        let old = fix(-37.8, 145.1, 30.0, FIX_STALE.as_secs() + 60);
        assert_eq!(decide(&config, Some(old), now).reason, "noFix");
    }

    #[test]
    fn fork_location_modes_override_places() {
        let mut config = places(vec![place("Home", -37.8, 145.1, 150.0)]);
        let now = SystemTime::now();
        config.mode = Mode::Always;
        assert!(decide(&config, None, now).ring);
        config.mode = Mode::Never;
        assert!(!decide(&config, Some(fix(-37.8, 145.1, 10.0, 0)), now).ring);
    }

    #[test]
    fn fork_location_unlocated_places_count_as_none() {
        let mut home = place("Home", 0.0, 0.0, 150.0);
        home.lat = None;
        let config = places(vec![home]);
        assert_eq!(decide(&config, None, SystemTime::now()).reason, "noPlaces");
    }

    #[test]
    fn fork_location_picks_the_nearest_matching_place() {
        let config = places(vec![
            place("Street", -37.8, 145.1, 2_000.0),
            place("Home", -37.8003, 145.1, 100.0),
        ]);
        let got = decide(&config, Some(fix(-37.8003, 145.1, 20.0, 0)), SystemTime::now());
        assert_eq!(got.place.as_deref(), Some("Home"));
    }

    #[test]
    fn fork_location_config_parses_and_falls_back() {
        let config = parse_config(
            r#"{"places":[{"name":"Home","address":"1 Main St","radius":5}]}"#,
        );
        assert_eq!(config.mode, Mode::Places);
        assert_eq!(config.places[0].radius, RADIUS_MIN_M);
        assert_eq!(config.places[0].lat, None);
        assert_eq!(parse_config("not json").mode, Mode::Always);
        let round = serde_json::to_string(&config).unwrap();
        assert!(round.contains("\"mode\":\"places\""), "{round}");
    }
}
