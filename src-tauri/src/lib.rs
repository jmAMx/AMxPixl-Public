use std::sync::Mutex;
use tauri::{Emitter, Manager};

mod meters;

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

/// Writes a file so it's never left half-written: into a temporary file first, made to reach the disk (not just
/// Windows' memory, which a power cut would lose), then swapped into place in one step. An abrupt end at any
/// point leaves either the old file or the new one.
fn write_safely(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
  use std::io::Write;
  let tmp = std::path::PathBuf::from(format!("{}.saving", path.display()));
  let written = (|| {
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()
  })();
  written.and_then(|_| std::fs::rename(&tmp, path)).inspect_err(|_| {
    let _ = std::fs::remove_file(&tmp);
  })
}

/// Writes the raw request body to the path in the `path` header (see write_safely).
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
  write_safely(std::path::Path::new(&path), bytes).map_err(|e| e.to_string())
}

// ---------- crash recovery ----------
// Unsaved work is copied to plain files in the app's data folder ("recovery", a folder per image), rather than the
// web view's own storage, which an abrupt end (a crash, a power cut, ending the task) can damage, just when the
// copies are needed.

fn recovery_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  app.path().app_data_dir().map(|d| d.join("recovery")).map_err(|e| e.to_string())
}

/// Only plain names (letters, digits, - and _ and a dot), so nothing can reach outside the recovery folder.
fn plain(name: &str) -> Result<&str, String> {
  let ok = !name.is_empty() && name.len() < 200 && !name.starts_with('.')
    && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
  if ok { Ok(name) } else { Err(format!("not a plain name: {name}")) }
}

/// Writes one file of an image's recovery copy (the `uid` and `name` headers say which), safely.
#[tauri::command]
fn recovery_write(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
  let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string).ok_or(format!("missing {k}"));
  let (uid, name) = (header("uid")?, header("name")?);
  let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw bytes".into()) };
  let dir = recovery_dir(&app)?.join(plain(&uid)?);
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  write_safely(&dir.join(plain(&name)?), bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn recovery_read(app: tauri::AppHandle, uid: String, name: String) -> Result<tauri::ipc::Response, String> {
  let path = recovery_dir(&app)?.join(plain(&uid)?).join(plain(&name)?);
  std::fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// The images with a recovery copy (those whose record was written), or the files in one image's copy.
#[tauri::command]
fn recovery_list(app: tauri::AppHandle, uid: Option<String>) -> Result<Vec<String>, String> {
  let base = recovery_dir(&app)?;
  let dir = match &uid { Some(u) => base.join(plain(u)?), None => base };
  let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
  let mut out = Vec::new();
  for e in rd.flatten() {
    let name = e.file_name().to_string_lossy().into_owned();
    if uid.is_some() {
      if !name.ends_with(".saving") { out.push(name); }
    } else if e.path().join("record.json").is_file() {
      out.push(name);
    }
  }
  Ok(out)
}

/// Deletes one file of an image's recovery copy, or (without a name) the whole copy.
#[tauri::command]
fn recovery_delete(app: tauri::AppHandle, uid: String, name: Option<String>) -> Result<(), String> {
  let dir = recovery_dir(&app)?.join(plain(&uid)?);
  let r = match name {
    Some(n) => std::fs::remove_file(dir.join(plain(&n)?)),
    None => std::fs::remove_dir_all(&dir),
  };
  match r {
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
    _ => Ok(()),
  }
}

/// Installed fonts as Windows lists them (for turning text into outlines): ("Segoe UI Bold (TrueType)", file path),
/// for all users and this user. Read from the registry with reg.exe, without flashing a console window.
#[tauri::command]
fn font_files() -> Vec<(String, String)> {
  let mut out = Vec::new();
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
    for key in [
      "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
      "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
    ] {
      let Ok(o) = std::process::Command::new("reg").args(["query", key]).creation_flags(0x0800_0000).output() else { continue };
      for line in String::from_utf8_lossy(&o.stdout).lines() {
        // "    Segoe UI Bold (TrueType)    REG_SZ    segoeuib.ttf"
        let Some((name, file)) = line.trim_start().split_once("    REG_SZ    ") else { continue };
        let file = file.trim();
        let path = if file.contains(':') || file.starts_with('\\') { file.to_string() } else { format!("{windir}\\Fonts\\{file}") };
        out.push((name.trim().to_string(), path));
      }
    }
  }
  out
}

/// settings.json in the app's config folder: a copy of everything Pixl remembers (looks, recent files, preferences),
/// kept outside the web view's storage so app updates can't lose it.
fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  app.path().app_config_dir().map(|d| d.join("settings.json")).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_settings(app: tauri::AppHandle) -> Result<String, String> {
  match std::fs::read_to_string(settings_path(&app)?) {
    Ok(s) => Ok(s),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
    Err(e) => Err(e.to_string()),
  }
}

#[tauri::command]
fn write_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
  let path = settings_path(&app)?;
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  write_safely(&path, json.as_bytes()).map_err(|e| e.to_string())
}

/// The status bar's readouts: [GPU Pixl %, GPU PC %, CPU Pixl %, CPU PC %, memory Pixl MB, memory PC %], each null
/// if it can't be read, or null altogether until the first reading. See meters.rs.
#[tauri::command]
fn meters() -> Option<meters::Reading> {
  meters::read()
}

/// Opens the project's release page in the default browser (only that page, so this can't launch anything else).
#[tauri::command]
fn open_release_page(url: String) -> Result<(), String> {
  // GitHub links don't care about case, so neither does this check (the API may hand back either spelling).
  if !url.to_ascii_lowercase().starts_with("https://github.com/jmamx/amxpixl-public/releases") || url.contains(['"', ' ', '&', '|', '^']) {
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
    // The title bar shows the version ("AMxPixl 0.6.3"), taken from package.json at build time.
    .setup(|app| {
      if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title(&format!("AMxPixl {}", app.package_info().version));
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![take_open_files, read_file, write_file, read_settings, write_settings, font_files, open_release_page, meters,
      recovery_write, recovery_read, recovery_list, recovery_delete])
    .run(tauri::generate_context!())
    .expect("error while running AMxPixl");
}
