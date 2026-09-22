use std::process::Command;
fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
fn main() {
    let sha = git(&["rev-parse", "HEAD"])
        .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()));
    let source = if sha.is_some() {
        "git-worktree"
    } else {
        "unknown"
    };
    let dirty = git(&["status", "--porcelain", "--untracked-files=normal"]).map(|s| !s.is_empty());
    println!(
        "cargo:rustc-env=MANGA_BUILD_GIT_SHA={}",
        sha.as_deref().unwrap_or("unknown")
    );
    println!("cargo:rustc-env=MANGA_BUILD_SOURCE={source}");
    if let Some(dirty) = dirty {
        println!("cargo:rustc-env=MANGA_BUILD_DIRTY={dirty}");
    }
    for file in [
        "../.git/HEAD",
        "../.git/index",
        "build.rs",
        "src",
        "../src",
        "tauri.conf.json",
    ] {
        println!("cargo:rerun-if-changed={file}");
    }
    tauri_build::build();
}
