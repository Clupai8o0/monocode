use tauri::Manager;

mod account_identity;
// Fork: runs the Claude Code status line for the composer strip.
mod fork_statusline;
mod fork_extra_usage; // Fork: Muse, Antigravity and DeepSeek usage for the footer.
// Fork: the shared Docker stacks panel (vault stacks.py).
mod fork_stacks;
mod fork_lab; // Fork: home lab Remote Control scope and RDP files.
mod fork_session_move; // Fork: move a session and its work to another machine.
mod fork_poll_cache; // Fork: share short-lived helper reads across windows.
// Fork: who is editing which file (vault claims.py), for file tab and Explorer tags.
mod fork_claims;
// Fork: agent sessions MonoCode did not start ("Elsewhere"), read-only.
mod fork_external_sessions;
// Fork: the relay, so Claude sessions on other machines can message ours.
mod fork_relay;
mod fork_messages; // Fork: the message log between Claude sessions.
// Fork: the time zone agents and terminals the desktop starts see.
mod fork_tz;
mod fork_latex;
mod fork_office;
mod fork_shows; // Fork: cache files a remote machine shows on this computer.
mod fork_html; // Fork: isolated HTML file previews with bounded draft storage.
mod fork_code_run; // Fork: sandboxed code drills for the Games panel's Code tab.
// Fork: named workspaces, one OS window each, with their own saved layout.
mod fork_workspaces;
mod fork_cost; // Fork: API-equivalent cost from local transcripts.
mod fork_device; // Fork: a live emulator or simulator beside a session.
mod fork_turn_diff; // Fork: one turn's changes, and restoring from it.
mod fork_worktree_merge; // Fork: Merge back for a session's worktree.
mod fork_location; // Fork
mod fork_memory; // Fork: the Memory manager's per-session RAM report.
mod fork_account_homes; // Fork: which Claude login (main or cx) each account runs on.
// Fork: installs a staged personal build on quit, however MonoCode was opened.
#[cfg(target_os = "macos")]
mod fork_update;
mod artifacts;
mod automations;
mod azure_devops;
mod background_work;
mod chat_background;
mod checkpoint;
mod codex_mono_store;
mod control;
pub mod control_cli;
pub mod fork_mcp; // Fork: an MCP server for outside agents.
mod cursor_store;
mod devin_config;
mod devin_usage;
mod external_editor;
mod fs;
mod gitlab;
mod harness;
mod harness_updates;
mod inbox_media;
mod jira;
mod jsonc;
mod linear;
mod link_preview;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod macos_background;
mod mcp;
mod menu;
mod mobile_access;
mod mobile_router;
mod mono;
#[cfg(target_os = "macos")]
mod mono_chat;
mod mono_transcript;
mod notes;
mod notifications;
mod pasteboard;
mod pi_usage;
mod project_logo;
mod provider_session_transfer;
mod pty;
#[cfg(target_os = "macos")]
mod quick_composer;
mod rate_limits;
mod reminders;
mod remote;
mod remote_ssh;
mod resources;
mod search;
mod session_store;
mod skills;
pub mod ssh_askpass;
mod tool_detail;
#[cfg(target_os = "macos")]
mod trackpad_zoom;
#[cfg(target_os = "windows")]
mod tray;
mod window;
mod window_transfer;
#[cfg(windows)]
mod windows;
mod worktree_lifecycle;
mod worktrees;

// Phase 1 seam: spawn / kill harness children per MonoCode thread.
// Adapters own the protocol; this host only supervises processes.

/// Project directory for new sessions — prefer cwd, else home.
#[tauri::command]
fn default_cwd() -> String {
    if let Ok(cwd) = std::env::current_dir() {
        return fs::path_to_js(&cwd);
    }
    dirs_home()
        .map(|home| fs::path_to_js(std::path::Path::new(&home)))
        .unwrap_or_else(|| "~".into())
}

#[tauri::command]
fn home_dir() -> String {
    dirs_home()
        .map(|home| fs::path_to_js(std::path::Path::new(&home)))
        .unwrap_or_else(|| "~".into())
}

pub(crate) struct PasswdIdentity {
    pub home: String,
    pub user: String,
    pub shell: String,
}

pub(crate) fn dirs_home() -> Option<String> {
    #[cfg(windows)]
    let keys = ["USERPROFILE", "HOME"];
    #[cfg(not(windows))]
    let keys = ["HOME", "USERPROFILE"];
    for key in keys {
        if let Some(home) = std::env::var_os(key) {
            let home = home.to_string_lossy().into_owned();
            if !home.is_empty() {
                return Some(home);
            }
        }
    }
    match (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        (Ok(drive), Ok(path)) if !drive.is_empty() && !path.is_empty() => {
            Some(format!("{drive}{path}"))
        }
        _ => passwd_identity().map(|id| id.home),
    }
}

/// Hide the console window that Windows allocates for GUI-spawned children.
pub(crate) fn hide_window_console(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(WINDOWS_BACKGROUND_CREATION_FLAGS);
    }
    let _ = cmd;
}

#[cfg(windows)]
const WINDOWS_BACKGROUND_CREATION_FLAGS: u32 = 0x0800_0000; // CREATE_NO_WINDOW

#[cfg(all(test, windows))]
mod background_command_tests {
    use super::*;

    #[test]
    fn background_commands_keep_piped_output_and_exit_status() {
        assert_eq!(WINDOWS_BACKGROUND_CREATION_FLAGS, 0x0800_0000);

        let mut cmd = std::process::Command::new("cmd.exe");
        cmd.args(["/D", "/C", "(echo stdout)&(echo stderr 1>&2)&exit /b 7"]);
        hide_window_console(&mut cmd);

        let output = cmd.output().expect("background command should run");
        assert_eq!(output.status.code(), Some(7));
        assert!(String::from_utf8_lossy(&output.stdout).contains("stdout"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("stderr"));
    }
}

/// Finder-launched .app bundles often omit HOME/USER/SHELL. Fall back to the
/// passwd database so harness CLIs still find `~/.fx` and the login keychain.
pub(crate) fn passwd_identity() -> Option<PasswdIdentity> {
    #[cfg(unix)]
    {
        let uid = unsafe { libc::getuid() };
        let mut buf = vec![0u8; 4096];
        let mut pwd = unsafe { std::mem::zeroed::<libc::passwd>() };
        let mut result = std::ptr::null_mut::<libc::passwd>();
        let rc = unsafe {
            libc::getpwuid_r(
                uid,
                &mut pwd,
                buf.as_mut_ptr() as *mut libc::c_char,
                buf.len(),
                &mut result,
            )
        };
        if rc != 0 || result.is_null() {
            return None;
        }
        unsafe {
            let user = std::ffi::CStr::from_ptr(pwd.pw_name)
                .to_string_lossy()
                .into_owned();
            let home = std::ffi::CStr::from_ptr(pwd.pw_dir)
                .to_string_lossy()
                .into_owned();
            let shell = std::ffi::CStr::from_ptr(pwd.pw_shell)
                .to_string_lossy()
                .into_owned();
            if user.is_empty() || home.is_empty() {
                return None;
            }
            Some(PasswdIdentity { home, user, shell })
        }
    }
    #[cfg(not(unix))]
    {
        None
    }
}

#[tauri::command]
fn set_traffic_lights_visible(
    #[allow(unused_variables)] window: tauri::WebviewWindow,
    #[allow(unused_variables)] visible: bool,
) {
    #[cfg(target_os = "macos")]
    macos::set_visible(&window, visible);
}

#[tauri::command]
fn set_window_background_blur(
    #[allow(unused_variables)] window: tauri::WebviewWindow,
    #[allow(unused_variables)] radius: u8,
) {
    #[cfg(target_os = "macos")]
    macos::set_background_blur_radius(&window, radius);
}

#[tauri::command]
fn set_dock_badge(
    #[allow(unused_variables)] window: tauri::WebviewWindow,
    #[allow(unused_variables)] count: u32,
) {
    #[cfg(target_os = "macos")]
    macos::set_window_badge(&window, count);
}

#[tauri::command]
fn set_trackpad_zoom_enabled(
    #[allow(unused_variables)] window: tauri::WebviewWindow,
    #[allow(unused_variables)] enabled: bool,
) {
    #[cfg(target_os = "macos")]
    trackpad_zoom::set_enabled(&window, enabled);
}

// Async so the window is built off the main thread. Building it from a sync
// command deadlocks WebView2 on Windows and leaves the new window blank.
#[tauri::command]
async fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    window::open_new_window(&app)
}

fn should_request_quit(code: Option<i32>) -> bool {
    code.is_some() || cfg!(any(target_os = "linux", target_os = "windows"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(all(debug_assertions, target_os = "macos"))]
    {
        let version = context.package_info().version.to_string();
        let bundle_version = context
            .config()
            .bundle
            .macos
            .bundle_version
            .as_deref()
            .unwrap_or(&version);
        macos::ensure_dev_bundle(&version, bundle_version);
    }
    #[cfg(target_os = "macos")]
    macos::register_spellcheck_default();
    #[cfg(windows)]
    windows::initialize().expect("Failed to initialize Windows process safety");
    let builder = tauri::Builder::default();
    // Closing to the tray leaves the process running without a taskbar entry,
    // so a second launch must reopen it instead of starting another instance.
    // Registered first so the duplicate exits before any setup runs.
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        let _ = window::show_hidden_or_open_new(app);
    }));
    let app = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(window::is_workspace_window)
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol(artifacts::HTML_SCHEME, |ctx, request, responder| {
            // Fork: bounded off-thread reads keep image/video previews from blocking windows.
            if request.uri().path().starts_with("/file-preview/") {
                fork_html::serve_async(ctx.app_handle().clone(), request, responder);
            } else {
                responder.respond(artifacts::serve_html(ctx.app_handle(), &request));
            }
        })
        .manage(harness::HarnessHost::new())
        .manage(pty::PtyHost::new())
        .manage(remote::RemoteConnections::default())
        .manage(window_transfer::WindowTransferState::new())
        .manage(fork_html::HtmlPreviews::default())
        .setup(|app| {
            harness::reap_orphaned_harness_processes();
            session_store::init(app.handle())?;
            control::init(app.handle())?;
            mobile_access::init(app.handle())?;
            reminders::init(app.handle());
            checkpoint::init(app.handle())?;
            menu::install(app.handle())?;
            fork_workspaces::init(app.handle()); // Fork
            #[cfg(unix)]
            fork_relay::start(app.handle()); // Fork
            #[cfg(target_os = "windows")]
            tray::install(app.handle())?;
            #[cfg(target_os = "macos")]
            {
                quick_composer::init(app.handle())?;
                mono_chat::init(app.handle())?;
                macos::install_dock_menu(app.handle());
                if let Some(window) = app.get_webview_window("main") {
                    macos::install(&window);
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                    let _ = window.set_shadow(true);
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::dispatch(app, event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            mobile_access::mobile_status,
            mobile_access::mobile_configure,
            mobile_access::mobile_invite,
            mobile_access::mobile_cancel_invite,
            mobile_access::mobile_revoke,
            mobile_access::mobile_publish,
            mobile_access::mobile_reply,
            mobile_access::mobile_push,
            remote::remote_machines,
            remote::remote_connect,
            remote::remote_disconnect,
            remote::remote_request,
            remote::remote_ssh_begin,
            remote::remote_ssh_reconnect,
            remote::remote_ssh_poll,
            remote::remote_ssh_answer,
            remote::remote_ssh_cancel,
            control::control_enable,
            control::control_disable,
            control::control_reply,
            control::control_save,
            control::control_load,
            control::control_scopes,
            control::control_write_path,
            control::control_attach_worker,
            control::control_authorize_turn,
            control::control_turn_finished,
            control::app_cli_path,
            default_cwd,
            home_dir,
            notifications::notification_permission,
            notifications::request_notification_permission,
            notifications::show_notification,
            notifications::open_notification_settings,
            reminders::reminder_list,
            reminders::reminder_set,
            reminders::reminder_clear,
            reminders::reminder_configure,
            reminders::reminder_take_open,
            reminders::reminder_register_window,
            reminders::reminder_open,
            automations::automations_list,
            automations::automations_upsert,
            automations::automations_delete,
            automations::automation_runs_list,
            automations::automation_runs_recover,
            automations::automation_run_now,
            automations::automations_claim_due,
            automations::automations_claim_event,
            automations::automation_run_update,
            external_editor::list_external_editors,
            external_editor::open_in_external_editor,
            fs::resolve_project_location,
            fs::open_path_with_default_app,
            fs::list_dir,
            fs::list_project_files,
            fs::git_diff_stats,
            fs::git_diff_index,
            fs::git_diff_files,
            fs::git_file_diff,
            fs::git_history,
            fs::git_commit_files,
            fs::git_commit_file_diff,
            fs::git_stage_file,
            fs::git_stage_contents,
            fs::git_unstage_file,
            fs::git_discard_file,
            fs::git_discard_all,
            fs::git_stage_all,
            fs::git_unstage_all,
            fs::git_commit,
            fs::git_locate_files,
            fs::git_head_message,
            fs::git_staged_context,
            fs::git_push,
            fs::git_pull,
            fs::git_sync,
            fs::git_range_context,
            fs::git_pr_status,
            fs::git_pr_create,
            fs::git_github_status,
            fs::github_monocode_star_status,
            fs::github_star_monocode,
            fs::git_github_repo,
            fs::git_github_repositories,
            fs::git_github_work_item,
            fs::git_github_work_items,
            fs::git_github_work_item_details,
            fs::git_github_work_item_thread,
            fs::git_github_work_item_comment,
            fs::git_github_pr_action,
            fs::git_github_pr_diff,
            fs::git_github_pr_checks,
            fs::git_github_check_details,
            inbox_media::fetch_inbox_media,
            gitlab::gitlab_status,
            gitlab::gitlab_set_config,
            gitlab::gitlab_repo,
            gitlab::gitlab_list_work_items,
            gitlab::gitlab_list_todos,
            gitlab::gitlab_work_item_details,
            gitlab::gitlab_work_item_thread,
            gitlab::gitlab_work_item_comment,
            gitlab::gitlab_mr_diff,
            azure_devops::azure_devops_status,
            azure_devops::azure_devops_set_config,
            azure_devops::azure_devops_repo,
            azure_devops::azure_devops_list_work_items,
            azure_devops::azure_devops_list_todos,
            azure_devops::azure_devops_work_item_details,
            azure_devops::azure_devops_work_item_thread,
            azure_devops::azure_devops_work_item_comment,
            azure_devops::azure_devops_mr_diff,
            linear::linear_status,
            linear::linear_set_token,
            linear::linear_list_teams,
            linear::linear_list_issues,
            linear::linear_issue_details,
            linear::linear_issue_thread,
            linear::linear_issue_comment,
            jira::jira_status,
            jira::jira_set_config,
            jira::jira_list_projects,
            jira::jira_list_issues,
            jira::jira_issue_details,
            jira::jira_issue_thread,
            jira::jira_issue_comment,
            link_preview::fetch_link_preview,
            fs::git_branches,
            fs::git_checkout,
            fs::git_create_branch,
            fs::git_stash,
            worktrees::git_worktrees,
            worktrees::git_worktree_create,
            worktrees::git_orchestration_worktree_create,
            worktrees::git_worktree_rename_branch,
            worktrees::git_worktree_check_remove,
            worktrees::git_worktree_remove,
            worktrees::git_orchestration_worktree_remove,
            worktrees::git_orchestration_branch_remove,
            fs::create_path,
            fs::rename_path,
            fs::delete_path,
            fs::copy_path,
            fs::move_path,
            fs::reveal_path,
            pasteboard::clipboard_file_paths,
            pasteboard::clipboard_image,
            pasteboard::copy_file_to_clipboard,
            fs::clone_repo,
            fs::read_file_preview,
            fs::stat_files,
            fs::inspect_paths,
            fs::read_file_base64,
            fs::read_binary_file,
            fs::read_project_image,
            fs::allow_video_stream,
            fs::write_attachment,
            fs::save_generated_image,
            fs::delete_generated_images,
            fs::read_text_file,
            fs::mobile_list_dir,
            fs::mobile_read_text_file,
            fs::omp_session_interjections,
            fs::omp_active_assistant_texts,
            fs::claude_shell_commands,
            fs::write_text_file,
            skills::list_skills,
            search::search_project,
            search::cancel_project_search,
            cursor_store::cursor_tool_calls,
            cursor_store::cursor_subagent_runs,
            harness::harness_resolve_cursor,
            harness::harness_resolve_codex,
            harness::harness_resolve_opencode,
            harness::harness_resolve_configured,
            harness::harness_runtime_binary_paths,
            harness::harness_resolve_claude,
            harness::claude_mcp_list,
            mcp::mcp_discover,
            mcp::mcp_add,
            harness::claude_mcp_add,
            harness::claude_mcp_remove,
            harness::mcp_provider_login,
            harness::harness_resolve_omp,
            harness::harness_resolve_pi,
            harness::harness_resolve_fx,
            harness::harness_resolve_grok,
            harness::harness_resolve_hermes,
            harness::harness_resolve_deepseek,
            harness::harness_resolve_vivobook,
            harness::harness_resolve_devin,
            harness::harness_resolve_antigravity,
            harness::harness_free_port,
            harness::harness_spawn,
            codex_mono_store::codex_mono_store_prepare,
            codex_mono_store::codex_mono_store_copy,
            codex_mono_store::codex_mono_store_restore_agent_state,
            provider_session_transfer::provider_session_transfer,
            harness::harness_write,
            harness::harness_kill,
            harness::harness_kill_all,
            harness::harness_http,
            harness::harness_sse_open,
            harness::harness_sse_close,
            harness::harness_exec,
            harness_updates::harness_latest_version,
            harness_updates::harness_update_check_claim,
            harness_updates::harness_update,
            harness::provider_account_remove,
            account_identity::provider_account_identity,
            pi_usage::fetch_pi_usage,
            rate_limits::fetch_claude_usage,
            rate_limits::fetch_opencode_go_usage,
            devin_usage::fetch_devin_usage,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_status,
            pty::pty_kill,
            pty::pty_kill_all,
            session_store::session_upsert,
            session_store::session_list_by_project,
            session_store::session_rebase_project,
            session_store::session_list_linked,
            session_store::session_search,
            session_store::cancel_session_search,
            session_store::session_get,
            session_store::session_tool_detail,
            mono_transcript::mono_session_get,
            mono_transcript::mono_session_page,
            mono_transcript::mono_session_upsert,
            mono_transcript::mono_session_find,
            session_store::session_delete,
            session_store::session_set_archived,
            session_store::session_set_pinned,
            session_store::session_set_linked_work_item,
            session_store::session_set_in_flight,
            session_store::session_list_in_flight,
            session_store::session_take_in_flight,
            session_store::workspace_set_snapshot,
            session_store::workspace_get_snapshot,
            notes::notes_list,
            notes::notes_get,
            notes::notes_upsert,
            artifacts::artifacts_list,
            artifacts::artifacts_get,
            artifacts::artifacts_upsert,
            artifacts::artifacts_delete,
            notes::notes_delete,
            notes::notes_save_image,
            notes::notes_image_path,
            mono::mono_load,
            mono::mono_read,
            mono::mono_save,
            checkpoint::session_checkpoint_ensure,
            checkpoint::session_checkpoint_begin_turn,
            checkpoint::session_checkpoint_finish_turn,
            checkpoint::session_checkpoint_prepare,
            checkpoint::session_checkpoint_capture,
            checkpoint::session_checkpoint_status,
            checkpoint::session_checkpoint_apply,
            checkpoint::session_checkpoint_cleanup_safe,
            checkpoint::session_checkpoint_forget,
            checkpoint::session_checkpoint_file_diff,
            checkpoint::session_checkpoint_undo,
            checkpoint::session_checkpoint_keep,
            checkpoint::fork_turn_changes,         // Fork
            checkpoint::fork_turn_file_diff,       // Fork
            checkpoint::fork_turn_restore_preview, // Fork
            checkpoint::fork_turn_restore,         // Fork
            set_traffic_lights_visible,
            set_window_background_blur,
            set_dock_badge,
            set_trackpad_zoom_enabled,
            #[cfg(target_os = "macos")]
            menu::keybindings_set_overrides,
            #[cfg(target_os = "macos")]
            menu::autosave_set_enabled,
            open_new_window,
            window::hide_window,
            window::destroy_window,
            window::quit_poll_reply,
            window::quit_decision,
            window::quit_ready,
            window::set_window_glass_enabled,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_set_enabled,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_prepare,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_fit,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_submit,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_take,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_ack,
            #[cfg(target_os = "macos")]
            quick_composer::screenshots::quick_composer_release_capture,
            #[cfg(target_os = "macos")]
            quick_composer::quick_composer_capture,
            #[cfg(target_os = "macos")]
            quick_composer::git_popup::quick_git_open,
            #[cfg(target_os = "macos")]
            quick_composer::git_popup::quick_git_state,
            #[cfg(target_os = "macos")]
            quick_composer::git_popup::quick_git_fit,
            #[cfg(target_os = "macos")]
            quick_composer::git_popup::quick_git_complete,
            #[cfg(target_os = "macos")]
            quick_composer::git_popup::quick_composer_dismiss,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_sync,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_publish,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_state,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_ready,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_action,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_take,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_accept,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_reply,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_keep_alive,
            #[cfg(target_os = "macos")]
            mono_chat::mono_chat_switch,
            #[cfg(target_os = "macos")]
            mono_chat::mono_menu_bar_set_visible,
            window_transfer::stage_window_transfer,
            window_transfer::take_window_transfer,
            chat_background::save_chat_background,
            resources::resource_usage,
            resources::resource_processes,
            resources::resource_stop_tool,
            chat_background::remove_chat_background,
            chat_background::save_project_chat_background,
            chat_background::remove_project_chat_background,
            project_logo::save_project_logo,
            project_logo::remove_project_logo,
            project_logo::forget_logo_file,
            fork_statusline::fork_statusline, // Fork
            fork_extra_usage::fork_extra_usage, // Fork
            fork_stacks::fork_stacks_list,    // Fork
            fork_stacks::fork_stacks_stop,    // Fork
            fork_session_move::fork_session_move, // Fork
            fork_lab::fork_lab_rc_status,     // Fork
            fork_lab::fork_lab_rc_apply,      // Fork
            fork_lab::fork_lab_open_rdp,      // Fork
            fork_memory::fork_memory_report, // Fork
            fork_claims::fork_claims_list,    // Fork
            fork_external_sessions::fork_external_sessions_list, // Fork
            fork_external_sessions::fork_external_sessions_read, // Fork
            fork_relay::fork_relay_status,
            fork_relay::fork_relay_traffic,    // Fork
            fork_messages::fork_message_log,   // Fork    // Fork
            fork_tz::fork_agent_tz_get,       // Fork
            fork_tz::fork_agent_tz_set,       // Fork
            fork_latex::fork_latex_compile,   // Fork
            fork_office::fork_office_convert, // Fork
            fork_html::fork_html_preview_create, // Fork
            fork_html::fork_html_preview_remove, // Fork
            fork_code_run::fork_code_run,        // Fork
            fork_shows::fork_shows_cache_write, // Fork
            fork_shows::fork_shows_cache_prune, // Fork
            fork_shows::fork_shows_cache_root,  // Fork
            fork_cost::fork_cost_report, // Fork
            fork_device::fork_device_list,       // Fork
            fork_device::fork_device_screenshot, // Fork
            fork_device::fork_device_tap,        // Fork
            fork_device::fork_device_swipe,      // Fork
            fork_device::fork_device_type,       // Fork
            fork_mcp::fork_mcp_clients,       // Fork
            fork_mcp::fork_mcp_create_client, // Fork
            fork_mcp::fork_mcp_revoke_client, // Fork
            fork_mcp::fork_mcp_log,           // Fork
            fork_worktree_merge::fork_worktree_merge_status, // Fork
            fork_worktree_merge::fork_worktree_merge_back,   // Fork
            fork_worktree_merge::fork_worktree_delete_merged_branch, // Fork
            fork_workspaces::fork_workspace_list,           // Fork
            fork_workspaces::fork_workspace_create,         // Fork
            fork_workspaces::fork_workspace_open,           // Fork
            fork_workspaces::fork_workspace_rename,         // Fork
            fork_workspaces::fork_workspace_delete,         // Fork
            fork_workspaces::fork_workspace_current,        // Fork
            fork_workspaces::fork_workspace_save,           // Fork
            fork_workspaces::fork_workspace_load,           // Fork
            fork_workspaces::fork_workspace_set_in_flight,  // Fork
            fork_workspaces::fork_workspace_list_in_flight, // Fork
            fork_workspaces::fork_window_sessions_set,      // Fork
            fork_workspaces::fork_claim_session,            // Fork
            fork_workspaces::fork_workspace_chrome,         // Fork
            fork_account_homes::fork_account_homes,         // Fork
            fork_account_homes::fork_add_cx_account,        // Fork
            fork_location::fork_location_status,            // Fork
            fork_location::fork_location_set_mode,          // Fork
            fork_location::fork_place_add,                  // Fork
            fork_location::fork_place_remove,               // Fork
            fork_location::fork_location_open_settings,     // Fork
        ])
        .build(context)
        .expect("error while building MonoCode");

    app.run(|handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            // A visible floating panel must not make a hidden workspace
            // unreachable from the Dock.
            if !window::workspace_windows(handle)
                .iter()
                .any(|window| window.is_visible().unwrap_or(false))
            {
                let _ = window::show_hidden_or_open_new(handle);
            }
        }
        tauri::RunEvent::Ready => {
            #[cfg(target_os = "macos")]
            {
                macos::request_badge_authorization();
                notifications::install_delegate(handle);
                #[cfg(debug_assertions)]
                macos::prefer_bundle_dock_icon();
            }
            fork_workspaces::reopen(handle); // Fork
            fork_location::start(handle); // Fork
            #[cfg(target_os = "macos")]
            fork_update::start(); // Fork
            window::ensure_launch_window_visible(handle);
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            window::forget_quit_window(handle, &label);
            fork_workspaces::window_destroyed(handle, &label); // Fork
            handle.state::<fork_html::HtmlPreviews>().remove_window(&label); // Fork
            let other_window = window::workspace_windows(handle)
                .iter()
                .any(|window| window.label() != label);
            control::window_closed(handle, &label);
            #[cfg(target_os = "macos")]
            mono_chat::window_closed(handle, &label);
            if !other_window {
                reap_harness_children(handle);
            }
        }
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if window::allow_exit() {
                return;
            }
            api.prevent_exit();
            // Last window destroyed (red button). Stay in the dock on macOS;
            // ⌘Q is a separate menu handler and arrives with an exit code.
            // Linux and Windows have no dock, so the last close is a quit.
            if !should_request_quit(code) {
                return;
            }
            window::request_quit(handle);
        }
        tauri::RunEvent::Exit => {
            #[cfg(target_os = "macos")]
            fork_update::on_quit(); // Fork
            #[cfg(unix)]
            fork_relay::stop(); // Fork
            handle.state::<remote::RemoteConnections>().shutdown();
            reap_harness_children(handle);
        }
        _ => {}
    });
}

fn reap_harness_children(handle: &tauri::AppHandle) {
    if let Some(host) = handle.try_state::<harness::HarnessHost>() {
        host.kill_all();
    }
    if let Some(host) = handle.try_state::<pty::PtyHost>() {
        host.kill_all();
    }
}

#[cfg(test)]
mod tests {
    use super::should_request_quit;

    #[test]
    fn explicit_exit_requests_quit() {
        assert!(should_request_quit(Some(0)));
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn last_window_close_requests_quit_without_dock() {
        assert!(should_request_quit(None));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn last_window_close_stays_alive_with_dock() {
        assert!(!should_request_quit(None));
    }
}
