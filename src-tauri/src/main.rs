// このファイルの役割:
// 1. ネイティブメニュー(ファイル/編集)を作る
// 2. 「開く」「保存」「名前を付けて保存」をRust側で実装する
// 3. 貼り付けられた画像を ~/.mdedit/images に一時保存する
// 4. 保存時に、その一時保存した画像を文書と同じ場所へ移し、
//    Markdown本文のリンクを相対パスに書き換える(ポータビリティ確保)
//
// 参考(1次情報):
// - メニュー: https://v2.tauri.app/learn/window-menu/
// - ダイアログ: https://v2.tauri.app/plugin/dialog/
// - asset protocol: https://v2.tauri.app/security/asset-protocol/
// - path API (home_dir): https://v2.tauri.app/reference/javascript/api/namespacepath/
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose, Engine as _};
use regex::Regex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

// ---------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------

// 「開く」で読み込んだファイルの中身と、そのパスをフロントに返すための型
#[derive(Clone, serde::Serialize)]
struct OpenedFile {
    path: String,
    content: String,
}

// 「名前を付けて保存」の結果。保存時に画像リンクを書き換えるため、
// 書き換え後の本文もフロントに返す必要がある。
#[derive(Clone, serde::Serialize)]
struct SavedFile {
    path: String,
    content: String,
}

// ---------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------

// ~/.mdedit/images (画像の一時保存フォルダ) を返す。無ければ作る。
fn staging_images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join(".mdedit").join("images");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// 貼り付け画像用の一意なファイル名を作る
fn unique_filename(ext: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("paste-{}-{}.{}", now.as_secs(), now.subsec_nanos(), ext)
}

// Markdown本文中の "![alt](~/.mdedit/images/....)" 形式のリンクを見つけて、
// 実ファイルを保存先と同じ場所の "<ファイル名>.assets/" フォルダへ移し、
// リンクを相対パスに書き換える。
// 対象外のリンク(既に相対パス、http(s)、data:など)はそのまま残す。
fn migrate_pasted_images(
    app: &tauri::AppHandle,
    content: &str,
    save_path: &Path,
) -> Result<String, String> {
    let staging_dir = staging_images_dir(app)?;
    // 本文中のパスはフォワードスラッシュ("/")統一で保存しているため、
    // 比較用のプレフィックスも同じ形式にする。
    let staging_prefix = staging_dir.to_string_lossy().replace('\\', "/");

    let save_dir = save_path.parent().unwrap_or_else(|| Path::new("."));
    let file_stem = save_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".to_string());
    let assets_dir_name = format!("{}.assets", file_stem);
    let assets_dir = save_dir.join(&assets_dir_name);

    // シンプルな画像リンク "![alt](url)" のみを対象にする簡易版。
    let re = Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)").map_err(|e| e.to_string())?;

    let mut created_assets_dir = false;
    let mut io_error: Option<String> = None;

    let replaced = re.replace_all(content, |caps: &regex::Captures| {
        let alt = &caps[1];
        let url = &caps[2];

        if io_error.is_some() || !url.starts_with(&staging_prefix) {
            return caps[0].to_string();
        }

        if !created_assets_dir {
            if let Err(e) = fs::create_dir_all(&assets_dir) {
                io_error = Some(e.to_string());
                return caps[0].to_string();
            }
            created_assets_dir = true;
        }

        let src_path = PathBuf::from(url);
        let filename = match src_path.file_name() {
            Some(f) => f.to_owned(),
            None => return caps[0].to_string(),
        };
        let dest_path = assets_dir.join(&filename);

        if src_path.exists() {
            if let Err(e) = fs::copy(&src_path, &dest_path) {
                io_error = Some(e.to_string());
                return caps[0].to_string();
            }
            // 移動が終わったので一時フォルダ側は削除しておく(ゴミを残さない)
            let _ = fs::remove_file(&src_path);
        }

        format!(
            "![{}]({}/{})",
            alt,
            assets_dir_name,
            filename.to_string_lossy()
        )
    });

    if let Some(e) = io_error {
        return Err(e);
    }

    Ok(replaced.into_owned())
}

// ---------------------------------------------------------------
// フロントから呼ばれるコマンド
// ---------------------------------------------------------------

// 画像を ~/.mdedit/images に保存し、本文に書き込む用のパス(フォワードスラッシュ統一)を返す
#[tauri::command]
fn save_pasted_image(app: tauri::AppHandle, data_base64: String, mime: String) -> Result<String, String> {
    let ext = match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };

    let bytes = general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| e.to_string())?;

    let images_dir = staging_images_dir(&app)?;
    let filename = unique_filename(ext);
    let file_path = images_dir.join(&filename);
    fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;

    Ok(file_path.to_string_lossy().replace('\\', "/"))
}

// ファイルを開くダイアログを出し、選ばれたファイルを読み込む
#[tauri::command]
fn open_file_dialog(app: tauri::AppHandle) -> Result<Option<OpenedFile>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown / Text", &["md", "markdown", "txt"])
        .add_filter("All Files", &["*"])
        .blocking_pick_file();

    let Some(file_path) = picked else {
        return Ok(None);
    };

    let path_buf: PathBuf = file_path.into_path().map_err(|e| e.to_string())?;
    let content = fs::read_to_string(&path_buf).map_err(|e| e.to_string())?;

    Ok(Some(OpenedFile {
        path: path_buf.to_string_lossy().to_string(),
        content,
    }))
}

// すでにパスが分かっているファイルへ上書き保存する(画像の移行込み)
#[tauri::command]
fn save_file_to_path(app: tauri::AppHandle, path: String, content: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    let migrated = migrate_pasted_images(&app, &content, &path_buf)?;
    fs::write(&path_buf, &migrated).map_err(|e| e.to_string())?;
    Ok(migrated)
}

// 「名前を付けて保存」ダイアログを出して保存する(画像の移行込み)
#[tauri::command]
fn save_file_dialog(app: tauri::AppHandle, content: String) -> Result<Option<SavedFile>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .add_filter("Text", &["txt"])
        .set_file_name("untitled.md")
        .blocking_save_file();

    let Some(file_path) = picked else {
        return Ok(None);
    };

    let path_buf: PathBuf = file_path.into_path().map_err(|e| e.to_string())?;
    let migrated = migrate_pasted_images(&app, &content, &path_buf)?;
    fs::write(&path_buf, &migrated).map_err(|e| e.to_string())?;

    Ok(Some(SavedFile {
        path: path_buf.to_string_lossy().to_string(),
        content: migrated,
    }))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_file_dialog,
            save_file_to_path,
            save_file_dialog,
            save_pasted_image
        ])
        .setup(|app| {
            // ---- "File" menu ----
            let new_item = MenuItemBuilder::new("New")
                .id("new")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let open_item = MenuItemBuilder::new("Open...")
                .id("open")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let save_item = MenuItemBuilder::new("Save")
                .id("save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?;
            let save_as_item = MenuItemBuilder::new("Save As...")
                .id("save_as")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?;
            let select_all_item = MenuItemBuilder::new("Select All")
                .id("select_all")
                .accelerator("CmdOrCtrl+A")
                .build(app)?;
            // 標準項目(OSやライブラリ側の既定動作)も、既定のテキストに頼らず
            // 明示的に英語を指定しておく(環境によって表示言語が変わらないように)
            let quit_item = PredefinedMenuItem::quit(app, Some("Quit"))?;
            let undo_item = PredefinedMenuItem::undo(app, Some("Undo"))?;
            let redo_item = PredefinedMenuItem::redo(app, Some("Redo"))?;
            let cut_item = PredefinedMenuItem::cut(app, Some("Cut"))?;
            let copy_item = PredefinedMenuItem::copy(app, Some("Copy"))?;
            let paste_item = PredefinedMenuItem::paste(app, Some("Paste"))?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_item)
                .item(&open_item)
                .separator()
                .item(&save_item)
                .item(&save_as_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // ---- "Edit" menu ----
            // 「すべて選択」だけは、OS標準のものだと画面全体が対象になって
            // しまう(編集エリアの外まで選択される)ため、自前の項目にして
            // 「編集エリアの中身だけ」を選択するようフロント側に指示する。
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&undo_item)
                .item(&redo_item)
                .separator()
                .item(&cut_item)
                .item(&copy_item)
                .item(&paste_item)
                .separator()
                .item(&select_all_item)
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&file_menu, &edit_menu])
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(move |app_handle, event| match event.id().0.as_str() {
                "new" => {
                    let _ = app_handle.emit("menu-new", ());
                }
                "open" => {
                    let _ = app_handle.emit("menu-open", ());
                }
                "save" => {
                    let _ = app_handle.emit("menu-save", ());
                }
                "save_as" => {
                    let _ = app_handle.emit("menu-save-as", ());
                }
                "select_all" => {
                    let _ = app_handle.emit("menu-select-all", ());
                }
                _ => {}
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
