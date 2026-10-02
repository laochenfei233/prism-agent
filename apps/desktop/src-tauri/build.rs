// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
fn main() {
    for asset in [
        "icons/icon.ico",
        "icons/icon.icns",
        "icons/icon.png",
        "icons/installer-header.bmp",
        "icons/installer-sidebar.bmp",
        "installer-hooks.nsh",
    ] {
        println!("cargo:rerun-if-changed={asset}");
    }
    tauri_build::build()
}
