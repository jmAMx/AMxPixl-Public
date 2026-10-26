fn main() {
  // Re-embed the icon in the .exe whenever it changes (otherwise a cached build keeps the old one).
  println!("cargo:rerun-if-changed=icons/icon.ico");
  println!("cargo:rerun-if-changed=tauri.conf.json");
  tauri_build::build()
}
