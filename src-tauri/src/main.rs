// このファイルの役割:
// 1. ネイティブメニュー(ファイル/編集)を作る
// 2. 「開く」「保存」「名前を付けて保存」をRust側で実装する
// 3. 貼り付けられた画像を ~/.mdedit/images に一時保存する
// 4. 保存時に、その一時保存した画像を文書と同じ場所へ移し、
//    Markdown本文のリンクを相対パスに書き換える(ポータビリティ確保)
// 5. 複数タブのセッション情報(~/.mdedit/session.json)と、
//    未保存タブの下書き(~/.mdedit/drafts/)の読み書き
//
// 参考(1次情報):
// - メニュー: https://v2.tauri.app/learn/window-menu/
// - ダイアログ: https://v2.tauri.app/plugin/dialog/
// - asset protocol: https://v2.tauri.app/security/asset-protocol/
// - path API (home_dir): https://v2.tauri.app/reference/javascript/api/namespacepath/
// - ウィンドウを閉じる前の処理: https://v2.tauri.app/reference/javascript/api/namespacewindow/
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

// ~/.mdedit (アプリの設定・一時データ置き場) を返す
fn mdedit_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".mdedit"))
}

// ~/.mdedit/images (画像の一時保存フォルダ) を返す。無ければ作る。
fn staging_images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = mdedit_dir(app)?.join("images");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// ~/.mdedit/drafts (未保存タブの下書き置き場) を返す。無ければ作る。
fn drafts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = mdedit_dir(app)?.join("drafts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// ~/.mdedit/session.json (開いているタブ一覧の記録) のパスを返す
fn session_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = mdedit_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
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

        if !src_path.exists() {
            return caps[0].to_string();
        }

        if let Err(e) = fs::copy(&src_path, &dest_path) {
            io_error = Some(e.to_string());
            return caps[0].to_string();
        }
        // 移動が終わったので一時フォルダ側は削除しておく(ゴミを残さない)
        let _ = fs::remove_file(&src_path);

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
async fn open_file_dialog(app: tauri::AppHandle) -> Result<Option<OpenedFile>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app
        .dialog()
        .file()
        .add_filter("Markdown / Text", &["md", "markdown", "txt"])
        .add_filter("All Files", &["*"])
        .pick_file(move |picked| {
            let _ = tx.blocking_send(picked);
        });

    let picked = rx
        .recv()
        .await
        .ok_or_else(|| "File dialog was closed unexpectedly".to_string())?;

    let Some(file_path) = picked else {
        return Ok(None);
    };

    let path_buf: PathBuf = file_path.into_path().map_err(|e| e.to_string())?;
    let content_path = path_buf.clone();
    let content = tauri::async_runtime::spawn_blocking(move || fs::read_to_string(&content_path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    Ok(Some(OpenedFile {
        path: path_buf.to_string_lossy().replace('\\', "/"),
        content,
    }))
}

// すでにパスが分かっているファイルへ上書き保存する(画像の移行込み)
#[tauri::command]
async fn save_file_to_path(app: tauri::AppHandle, path: String, content: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path_buf = PathBuf::from(&path);
        let migrated = migrate_pasted_images(&app, &content, &path_buf)?;
        fs::write(&path_buf, &migrated).map_err(|e| e.to_string())?;
        Ok(migrated)
    })
    .await
    .map_err(|e| e.to_string())?
}

// 「名前を付けて保存」ダイアログを出して保存する(画像の移行込み)
#[tauri::command]
async fn save_file_dialog(app: tauri::AppHandle, content: String) -> Result<Option<SavedFile>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app
        .dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .add_filter("Text", &["txt"])
        .set_file_name("untitled.md")
        .save_file(move |picked| {
            let _ = tx.blocking_send(picked);
        });

    let picked = rx
        .recv()
        .await
        .ok_or_else(|| "File dialog was closed unexpectedly".to_string())?;

    let Some(file_path) = picked else {
        return Ok(None);
    };

    let path_buf: PathBuf = file_path.into_path().map_err(|e| e.to_string())?;
    let saved_path = path_buf.clone();
    let migrated = tauri::async_runtime::spawn_blocking(move || {
        let migrated = migrate_pasted_images(&app, &content, &saved_path)?;
        fs::write(&saved_path, &migrated).map_err(|e| e.to_string())?;
        Ok::<String, String>(migrated)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(Some(SavedFile {
        path: path_buf.to_string_lossy().replace('\\', "/"),
        content: migrated,
    }))
}

// HTMLとしてエクスポートする(画像は既にbase64で埋め込まれた自己完結な内容を渡す想定)
#[tauri::command]
async fn export_html_dialog(
    app: tauri::AppHandle,
    content: String,
    default_name: String,
) -> Result<Option<String>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app
        .dialog()
        .file()
        .add_filter("HTML", &["html", "htm"])
        .set_file_name(&default_name)
        .save_file(move |picked| {
            let _ = tx.blocking_send(picked);
        });

    let picked = rx
        .recv()
        .await
        .ok_or_else(|| "File dialog was closed unexpectedly".to_string())?;

    let Some(file_path) = picked else {
        return Ok(None);
    };

    let path_buf: PathBuf = file_path.into_path().map_err(|e| e.to_string())?;
    let export_path = path_buf.clone();
    tauri::async_runtime::spawn_blocking(move || fs::write(&export_path, content))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    Ok(Some(path_buf.to_string_lossy().to_string()))
}

// パスを指定してテキストファイルを読む(タブ復元時、下書きや保存済みファイルの読み込みに使う汎用コマンド)
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

// 未保存タブの内容を ~/.mdedit/drafts/<draft_id>.md に書き出す(終了時の一時保存用)
#[tauri::command]
fn write_draft(app: tauri::AppHandle, draft_id: String, content: String) -> Result<String, String> {
    let dir = drafts_dir(&app)?;
    // draft_id はJS側で生成したIDを想定しているが、念のためファイル名として
    // 危険な文字(パス区切り文字など)は除去しておく
    let safe_id: String = draft_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let file_path = dir.join(format!("{}.md", safe_id));
    fs::write(&file_path, content).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().replace('\\', "/"))
}

// 不要になった下書きファイルを削除する(既に無い場合もエラーにしない)
#[tauri::command]
fn delete_draft(path: String) -> Result<(), String> {
    match fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// 開いているタブの一覧(セッション)を ~/.mdedit/session.json に保存する
#[tauri::command]
fn save_session(app: tauri::AppHandle, session_json: String) -> Result<(), String> {
    let path = session_file_path(&app)?;
    fs::write(&path, session_json).map_err(|e| e.to_string())
}

// 前回終了時のセッションを読み込む。ファイルが無ければ None を返す(初回起動など)。
#[tauri::command]
fn load_session(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = session_file_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(content))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_file_dialog,
            save_file_to_path,
            save_file_dialog,
            save_pasted_image,
            export_html_dialog,
            read_text_file,
            write_draft,
            delete_draft,
            save_session,
            load_session
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
            let export_html_item = MenuItemBuilder::new("Export as HTML...")
                .id("export_html")
                .build(app)?;
            let export_pdf_item = MenuItemBuilder::new("Export as PDF...")
                .id("export_pdf")
                .build(app)?;
            let select_all_item = MenuItemBuilder::new("Select All")
                .id("select_all")
                .accelerator("CmdOrCtrl+A")
                .build(app)?;
            // 標準項目(OSやライブラリ側の既定動作)も、既定のテキストに頼らず
            // 明示的に英語を指定しておく(環境によって表示言語が変わらないように)
            let quit_item = PredefinedMenuItem::quit(app, Some("Quit"))?;
            let cut_item = PredefinedMenuItem::cut(app, Some("Cut"))?;
            let copy_item = PredefinedMenuItem::copy(app, Some("Copy"))?;
            let paste_item = PredefinedMenuItem::paste(app, Some("Paste"))?;
            // Undo/Redoは、OS標準のものだと編集エリアに正しく効かないことがある
            // (Select Allで判明したのと同じ種類の問題)ため、自前の項目にして
            // フロント側で実装したundo/redoスタックを操作する。
            let undo_item = MenuItemBuilder::new("Undo")
                .id("undo")
                .accelerator("CmdOrCtrl+Z")
                .build(app)?;
            let redo_item = MenuItemBuilder::new("Redo")
                .id("redo")
                .accelerator("CmdOrCtrl+Y")
                .build(app)?;

            let file_menu = SubmenuBuilder::new(app, "&File")
                .item(&new_item)
                .item(&open_item)
                .separator()
                .item(&save_item)
                .item(&save_as_item)
                .separator()
                .item(&export_html_item)
                .item(&export_pdf_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // ---- "Edit" menu ----
            // 「すべて選択」だけは、OS標準のものだと画面全体が対象になって
            // しまう(編集エリアの外まで選択される)ため、自前の項目にして
            // 「編集エリアの中身だけ」を選択するようフロント側に指示する。
            let edit_menu = SubmenuBuilder::new(app, "&Edit")
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
                "export_html" => {
                    let _ = app_handle.emit("menu-export-html", ());
                }
                "export_pdf" => {
                    let _ = app_handle.emit("menu-export-pdf", ());
                }
                "undo" => {
                    let _ = app_handle.emit("menu-undo", ());
                }
                "redo" => {
                    let _ = app_handle.emit("menu-redo", ());
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
