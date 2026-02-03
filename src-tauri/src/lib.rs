mod converter;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::<f64> {
                    width: 1000.0,
                    height: 830.0,
                }));
                let _ = win.set_resizable(false);
                let _ = win.center();

                let _ = win.set_effects(Some(
                    tauri::window::EffectsBuilder::new()
                        .effect(tauri::window::Effect::UnderWindowBackground)
                        .state(tauri::window::EffectState::Active)
                        .radius(22.0)
                        .build(),
                ));

                let _ = win.show();
                let _ = win.set_focus();
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            converter::scan_frame_files,
            converter::convert_sequence_frames,
            converter::pause_conversion,
            converter::resume_conversion,
            converter::cancel_conversion
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
