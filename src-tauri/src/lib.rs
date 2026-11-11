mod commands;
mod session;

use session::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::lock,
            commands::set_view,
            commands::apply_theme,
            commands::list_entries,
            commands::get_secret,
            commands::copy_secret,
            commands::copy_text,
            commands::add_entry,
            commands::update_entry,
            commands::delete_entry,
            commands::get_config,
            commands::save_config,
            commands::vault_path_display,
            commands::export_vault,
            commands::pick_import_file,
            commands::import_from,
            commands::change_master,
        ])
        .run(tauri::generate_context!())
        .expect("Passlet 启动失败");
}
