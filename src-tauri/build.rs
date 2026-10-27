fn main() {
  // Re-embed the icon and version in the .exe whenever they change (otherwise a cached build keeps the old ones).
  // The version comes from package.json (tauri.conf.json points at it).
  println!("cargo:rerun-if-changed=icons/icon.ico");
  println!("cargo:rerun-if-changed=tauri.conf.json");
  println!("cargo:rerun-if-changed=../package.json");
  tauri_build::build()
}
