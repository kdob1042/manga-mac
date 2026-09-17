//! Source registrations select isolated existing workspace storage; no manuscript copies.
use super::backup;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub episode: String,
}
fn valid(entry: &Entry) -> Result<(), String> {
    let parts: Vec<_> = entry.repo.split('/').collect();
    if (entry.id != "primary" && !backup::uuid(&entry.id))
        || entry.name.trim().is_empty()
        || entry.name.len() > 200
        || parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
        || entry.episode.is_empty()
        || entry.episode.len() > 100
    {
        return Err("作品名・owner/repository・話IDを確認してください".into());
    }
    Ok(())
}
pub fn list(base: &Path) -> Result<Vec<Entry>, String> {
    let path = base.join("source-library.json");
    let entries: Vec<Entry> = if path.exists() {
        backup::read_json(&path)?
    } else {
        vec![]
    };
    let mut ids = std::collections::HashSet::new();
    for entry in &entries {
        valid(entry)?;
        if !ids.insert(&entry.id) {
            return Err("作品IDが重複しています".into());
        }
    }
    Ok(entries)
}
pub fn register(base: &Path, entry: Entry) -> Result<Vec<Entry>, String> {
    valid(&entry)?;
    let mut entries = list(base)?;
    if let Some(old) = entries.iter_mut().find(|e| e.id == entry.id) {
        if !old.repo.eq_ignore_ascii_case(&entry.repo) {
            return Err("既存作品の原稿元は変更できません。作品を追加してください".into());
        }
        *old = entry;
    } else {
        entries.push(entry);
    }
    backup::atomic_json(&base.join("source-library.json"), &entries)?;
    Ok(entries)
}
pub fn root(base: &Path, id: &str) -> Result<PathBuf, String> {
    if !backup::uuid(id) || !list(base)?.iter().any(|e| e.id == id) {
        return Err("未登録の作品です".into());
    }
    // macOS may expose the app-data/temp parent through an OS-managed link.
    // Trust its canonical location, but never links below the workspace boundary.
    let base = base.canonicalize().map_err(|e| e.to_string())?;
    let root = base.join("works").join(id);
    backup::regular(&root.join("manga.sqlite3"))?;
    if root.canonicalize().map_err(|e| e.to_string())? != root {
        return Err("作品フォルダのリンクを拒否しました".into());
    }
    Ok(root)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn separate_databases_preserve_original_on_a_b_a_reload() {
        let base = std::env::temp_dir().join(format!("manga-isolation-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let second = base.join("works").join(&id);
        std::fs::create_dir_all(&second).unwrap();
        register(
            &base,
            Entry {
                id: id.clone(),
                name: "B".into(),
                repo: "owner/b".into(),
                episode: "P02".into(),
            },
        )
        .unwrap();
        let mut a = rusqlite::Connection::open(base.join("manga.sqlite3")).unwrap();
        let mut b = rusqlite::Connection::open(second.join("manga.sqlite3")).unwrap();
        super::super::initialize(&a).unwrap();
        super::super::initialize(&b).unwrap();
        let original = super::super::tests::fixture();
        super::super::save(&mut a, &base, &original.to_string()).unwrap();
        let before = super::super::load(&a, &base).unwrap();
        let mut other = original.clone();
        other["title"] = serde_json::json!("作品B");
        super::super::save(&mut b, &second, &other.to_string()).unwrap();
        assert_eq!(root(&base, &id).unwrap(), second.canonicalize().unwrap());
        drop(a);
        drop(b);
        let reopened = rusqlite::Connection::open(base.join("manga.sqlite3")).unwrap();
        assert_eq!(super::super::load(&reopened, &base).unwrap(), before);
        assert_ne!(
            before,
            super::super::load(
                &rusqlite::Connection::open(second.join("manga.sqlite3")).unwrap(),
                &second
            )
            .unwrap()
        );
        std::fs::remove_dir_all(base).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn parent_alias_is_allowed_but_workspace_links_are_rejected() {
        use std::os::unix::fs::symlink;
        let temp = std::env::temp_dir().join(format!("manga-links-{}", uuid::Uuid::new_v4()));
        let base = temp.join("real");
        let alias = temp.join("alias");
        let id = uuid::Uuid::new_v4().to_string();
        let work = base.join("works").join(&id);
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("manga.sqlite3"), []).unwrap();
        register(
            &base,
            Entry {
                id: id.clone(),
                name: "work".into(),
                repo: "owner/work".into(),
                episode: "P01".into(),
            },
        )
        .unwrap();
        symlink(&base, &alias).unwrap();
        assert_eq!(root(&alias, &id).unwrap(), work.canonicalize().unwrap());
        let moved = temp.join("moved");
        std::fs::rename(&work, &moved).unwrap();
        symlink(&moved, &work).unwrap();
        assert!(root(&base, &id).is_err());
        std::fs::remove_file(&work).unwrap();
        std::fs::rename(&moved, &work).unwrap();
        let works = base.join("works");
        std::fs::rename(&works, &moved).unwrap();
        symlink(&moved, &works).unwrap();
        assert!(root(&base, &id).is_err());
        std::fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn registrations_preserve_primary_and_reject_bad_updates() {
        let base = std::env::temp_dir().join(format!("manga-sources-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let a = Entry {
            id: "primary".into(),
            name: "A".into(),
            repo: "owner/a".into(),
            episode: "P01".into(),
        };
        register(&base, a.clone()).unwrap();
        let b = Entry {
            id: uuid::Uuid::new_v4().to_string(),
            name: "B".into(),
            repo: "owner/b".into(),
            episode: "P02".into(),
        };
        register(&base, b.clone()).unwrap();
        let before = std::fs::read(base.join("source-library.json")).unwrap();
        let mut bad = a.clone();
        bad.repo = "owner/b".into();
        assert!(register(&base, bad).is_err());
        let mut bad = b.clone();
        bad.id = "../escape".into();
        assert!(register(&base, bad).is_err());
        assert_eq!(
            before,
            std::fs::read(base.join("source-library.json")).unwrap()
        );
        let mut changed = a;
        changed.episode = "P03".into();
        register(&base, changed).unwrap();
        assert_eq!(list(&base).unwrap()[1].episode, "P02");
        assert!(root(&base, &b.id).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
}
