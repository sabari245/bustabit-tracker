// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMABUF renderer fails on many Linux setups (notably Nvidia)
    // with "Failed to create GBM buffer ... Invalid argument", leaving a blank
    // webview. Disabling it forces a software-composited path that renders
    // correctly. No effect on Windows/macOS.
    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    bustabit_tracker_lib::run()
}
