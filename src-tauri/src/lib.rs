use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Files passed on the command line (double-clicked in Explorer) that the window hasn't picked up yet.
struct OpenFiles(Mutex<Vec<String>>);

fn file_args(args: &[String]) -> Vec<String> {
  args
    .iter()
    .skip(1)
    .filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_file())
    .cloned()
    .collect()
}

/// Undoes JavaScript's encodeURIComponent (paths travel in a request header).
fn percent_decode(s: &str) -> String {
  let b = s.as_bytes();
  let mut out = Vec::with_capacity(b.len());
  let mut i = 0;
  while i < b.len() {
    if b[i] == b'%' && i + 2 < b.len() {
      if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
        out.push(v);
        i += 3;
        continue;
      }
    }
    out.push(b[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn take_open_files(state: tauri::State<OpenFiles>) -> Vec<String> {
  std::mem::take(&mut *state.0.lock().unwrap())
}

#[tauri::command]
fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
  std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Writes the raw request body to the path in the `path` header, via a temporary file so a failed save
/// never leaves a half-written file behind.
#[tauri::command]
fn write_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
  let path = request
    .headers()
    .get("path")
    .and_then(|v| v.to_str().ok())
    .map(percent_decode)
    .ok_or("missing path")?;
  let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
    return Err("expected raw bytes".into());
  };
  let tmp = format!("{path}.saving");
  std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
  std::fs::rename(&tmp, &path).map_err(|e| {
    let _ = std::fs::remove_file(&tmp);
    e.to_string()
  })
}

/// Opens the project's release page in the default browser (only that page, so this can't launch anything else).
#[tauri::command]
fn open_release_page(url: String) -> Result<(), String> {
  if !url.starts_with("https://github.com/jmAMx/AMxPixl/releases") || url.contains(['"', ' ', '&', '|', '^']) {
    return Err("not a release page".into());
  }
  std::process::Command::new("explorer").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let args: Vec<String> = std::env::args().collect();
  tauri::Builder::default()
    // A second launch (double-clicking another file) hands its files to the open window instead.
    .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
      }
      let files = file_args(&argv);
      if !files.is_empty() {
        let _ = app.emit("open-files", files);
      }
    }))
    .plugin(tauri_plugin_dialog::init())
    .manage(OpenFiles(Mutex::new(file_args(&args))))
    .invoke_handler(tauri::generate_handler![take_open_files, read_file, write_file, open_release_page])
    .run(tauri::generate_context!())
    .expect("error while running AMxPixl");
}
