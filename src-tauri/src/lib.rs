mod commands;
mod session;

use std::time::Duration;

use session::AppState;
use tauri::Manager;

/// 窗口在前端调 `show_window` 之前一直隐藏（先用主题画好第一帧，避免冷启动闪白）。
/// 万一前端崩在启动阶段、命令永远不来，到点必须把窗口放出来——一个看不见的程序
/// 比白底闪一下糟得多。这个超时是兜底，不是正常路径。
const SHOW_WINDOW_FALLBACK: Duration = Duration::from_secs(5);

/// 兜底显示前尽量把原生标题栏也按配置上色。
///
/// 只能修到这层：这时前端没跑起来，页面里的 `data-theme` 停在 index.html 的初始值，
/// 内容区的配色改不动了。能保证的是"标题栏不会再跟用户设置相反"。
fn apply_config_theme(window: &tauri::WebviewWindow) {
    let theme = match passlet_core::config::load().theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        // 跟随系统：什么都不设，让标题栏继续跟系统走。
        // 不要把它写成 window.theme() 再设回去——那等于把"跟随"钉死在兜底那一刻的值。
        _ => return,
    };
    let _ = window.set_theme(theme);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(SHOW_WINDOW_FALLBACK).await;
                if let Some(window) = handle.get_webview_window("main") {
                    // 查不到可见性时按"还没显示"处理：兜底的唯一目的是把窗口放出来，
                    // 在最不确定的分支上选择不显示，等于把兜底本身废掉。
                    if !window.is_visible().unwrap_or(false) {
                        apply_config_theme(&window);
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::show_window,
            commands::bootstrap,
            commands::lock,
            commands::set_view,
            commands::apply_theme,
            commands::list_entries,
            commands::get_secret,
            commands::copy_secret,
            commands::copy_text,
            commands::copy_generated,
            commands::list_generators,
            commands::add_entry,
            commands::update_entry,
            commands::delete_entry,
            commands::get_config,
            commands::save_config,
            commands::vault_location,
            commands::pick_vault_dir,
            commands::switch_vault_dir,
            commands::create_vault_here,
            commands::master_status,
            commands::set_master_env,
            commands::clear_master_env,
            commands::export_vault,
            commands::pick_import_file,
            commands::import_from,
            commands::change_master,
        ])
        .run(tauri::generate_context!())
        .expect("Passlet 启动失败");
}
