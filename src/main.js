// markdown-it の初期化
// html: false  -> 入力中に生のHTMLタグが混ざっても実行されないようにする(安全のため)
// linkify: true -> "https://..." のようなURLを自動でリンク化
// breaks: true  -> 文中の改行(Enter1回)をそのまま<br>として反映する
const md = window.markdownit({
  html: false,
  linkify: true,
  breaks: true
});

// ---------------------------------------------------------------
// Mermaid対応
// 参考(1次情報): https://mermaid.js.org/config/usage.html
//               https://mermaid-js-mermaid.mintlify.app/advanced/error-handling
// ---------------------------------------------------------------
window.mermaid.initialize({
  startOnLoad: false,       // 自動描画はせず、こちらで明示的にrenderを呼ぶ
  suppressErrorRendering: true // 構文エラー時にmermaid自身がDOMへエラー表示を挿入しないようにする(自前で表示するため)
});

// ```mermaid コードブロックを見つけたら、通常のコード表示(<pre><code>)ではなく
// 空のプレースホルダーdivを出力しておき、後でmermaid.renderの結果(SVG)を差し込む。
const defaultFenceRenderer =
  md.renderer.rules.fence ||
  function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };

let mermaidIdSeq = 0;      // レンダリングのたびにIDが被らないよう、リセットしない連番
let pendingMermaidBlocks = []; // 今回のrender()呼び出しで見つかったmermaidブロック

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info ? md.utils.unescapeAll(token.info).trim() : "";
  const lang = info.split(/\s+/)[0];

  if (lang === "mermaid") {
    const id = `mermaid-diagram-${mermaidIdSeq++}`;
    pendingMermaidBlocks.push({ id, code: token.content });
    return `<div class="mermaid-diagram" id="${id}">Rendering diagram...</div>\n`;
  }

  return defaultFenceRenderer(tokens, idx, options, env, self);
};

// ---------------------------------------------------------------
// ローカル画像をプレビューで表示するための renderer 上書き
//
// Markdown本文には「実際のファイルパス」(貼り付け直後は
// ~/.mdedit/images/... の絶対パス、保存後は文書と同じ場所からの
// 相対パス)がそのまま書かれている。これは普通のブラウザ機能では
// 表示できないので、Tauriの asset protocol (convertFileSrc) を
// 使って、表示するときだけ特別なURLに変換する。
// 参考(1次情報): https://v2.tauri.app/security/asset-protocol/
// ---------------------------------------------------------------
const defaultImageRenderer =
  md.renderer.rules.image ||
  function (tokens, idx, options, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const srcIdx = token.attrIndex("src");
  if (srcIdx >= 0) {
    token.attrs[srcIdx][1] = resolveImageSrc(token.attrs[srcIdx][1]);
  }
  return defaultImageRenderer(tokens, idx, options, env, self);
};

// http(s)/data: はそのまま。それ以外(ローカルパス)は絶対パスに解決してから
// convertFileSrc で asset:// のURLに変換する。
function resolveImageSrc(src) {
  if (/^(https?:|data:)/i.test(src)) {
    return src;
  }

  let absolute = src;
  const isAbsoluteWin = /^[a-zA-Z]:[\\/]/.test(src);
  const isAbsoluteUnix = src.startsWith("/");
  const isAbsolute = isAbsoluteWin || isAbsoluteUnix || src.startsWith("\\\\");

  if (!isAbsolute) {
    if (!currentPath) {
      // 保存前で、かつ相対パス指定 -> 解決しようがないのでそのまま返す
      return src;
    }
    const dir = currentPath.replace(/[\\/][^\\/]*$/, "");
    absolute = dir + "/" + src;
  }

  try {
    return window.__TAURI__.core.convertFileSrc(absolute);
  } catch (err) {
    return src;
  }
}

const editor = document.getElementById("editor");
const preview = document.getElementById("preview");
const statusBar = document.getElementById("status-bar");

// 現在開いている(保存先の)ファイルパス。まだ保存していなければ null。
let currentPath = null;
// 前回保存した内容と違うかどうか
let dirty = false;

async function render() {
  pendingMermaidBlocks = [];
  preview.innerHTML = md.render(editor.value);

  // 見つかったmermaidブロックを順番に描画する(同時並行にすると内部で
  // 使う一時IDが衝突する可能性があるため、あえて1つずつawaitする)
  for (const block of pendingMermaidBlocks) {
    const container = document.getElementById(block.id);
    if (!container) continue; // 描画し直されて既に無くなっている場合はスキップ

    if (!block.code.trim()) {
      container.textContent = "(Empty mermaid block)";
      container.classList.add("mermaid-error");
      continue;
    }

    try {
      const { svg } = await window.mermaid.render(block.id + "-svg", block.code);
      container.innerHTML = svg;
    } catch (err) {
      container.textContent = "Mermaid syntax error: " + (err && err.message ? err.message : String(err));
      container.classList.add("mermaid-error");
    }
  }
}

function updateStatusBar() {
  const name = currentPath ? currentPath : "Untitled";
  statusBar.textContent = dirty ? `${name} *` : name;
}

// 一時的にステータスバーへメッセージを表示し、しばらくしたら通常表示に戻す
function flashStatus(message) {
  statusBar.textContent = message;
  setTimeout(updateStatusBar, 2500);
}

function markDirty() {
  dirty = true;
  updateStatusBar();
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  const cursor = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = cursor;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

let renderDebounceTimer = null;

// ---------------------------------------------------------------
// HTML / PDF エクスポート
//
// プレビュー(preview.innerHTML)は、この時点で既に
// Markdown -> HTML変換 と Mermaid -> SVG変換が完了した状態なので、
// それをそのまま書き出しの元にする。
// 画像はasset://のURLになっているので、エクスポート後もどこでも
// 見られるようbase64(data:)に変換してから埋め込む。
// ---------------------------------------------------------------

async function inlineImagesForExport(container) {
  const imgs = container.querySelectorAll("img");
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:")) continue;
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      const dataUrl = await blobToDataUrl(blob);
      img.setAttribute("src", dataUrl);
    } catch (err) {
      // 1枚読み込めなくても、エクスポート全体は止めない
      console.error("Failed to inline an image for export:", err);
    }
  }
}

function exportBaseName() {
  if (!currentPath) return "untitled";
  const fileName = currentPath.replace(/^.*[\\/]/, "");
  return fileName.replace(/\.[^.]+$/, "") || "untitled";
}

async function buildExportContainer() {
  const container = document.createElement("div");
  container.innerHTML = preview.innerHTML;
  await inlineImagesForExport(container);
  return container;
}

function exportDocumentCss() {
  return `
    body {
      font-family: -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic", sans-serif;
      line-height: 1.7;
      max-width: 900px;
      margin: 0 auto;
      padding: 24px;
      color: #222;
    }
    img, svg { max-width: 100%; }
    pre { background: #f5f5f5; padding: 10px; overflow-x: auto; }
    code { background: #f5f5f5; padding: 2px 4px; }
    blockquote { border-left: 4px solid #ccc; margin: 0; padding-left: 12px; color: #555; }
  `;
}

async function doExportHtml() {
  try {
    const container = await buildExportContainer();
    const title = exportBaseName();
    const doc =
      "<!DOCTYPE html>\n" +
      '<html lang="en">\n' +
      "<head>\n" +
      '<meta charset="UTF-8">\n' +
      `<title>${title}</title>\n` +
      `<style>${exportDocumentCss()}</style>\n` +
      "</head>\n" +
      "<body>\n" +
      container.innerHTML +
      "\n</body>\n</html>\n";

    const { invoke } = window.__TAURI__.core;
    const savedPath = await invoke("export_html_dialog", {
      content: doc,
      defaultName: `${title}.html`
    });
    if (savedPath) {
      flashStatus(`Exported: ${savedPath}`);
    }
  } catch (err) {
    alert("Failed to export HTML: " + err);
  }
}

async function doExportPdf() {
  try {
    const container = await buildExportContainer();
    const printContainer = document.getElementById("print-container");
    printContainer.innerHTML = "";
    printContainer.appendChild(container);
    // OS標準の印刷ダイアログを開く。PDFとして保存するには、
    // ユーザーが出力先で「PDFに保存」等を選ぶ必要がある
    // (Tauriには現時点でこれを自動化する公式APIが無いため)。
    window.print();
  } catch (err) {
    alert("Failed to prepare PDF export: " + err);
  }
}

// 印刷ダイアログが閉じたら、印刷専用コンテナの中身を掃除しておく
window.addEventListener("afterprint", () => {
  const printContainer = document.getElementById("print-container");
  if (printContainer) printContainer.innerHTML = "";
});

editor.addEventListener("input", () => {
  markDirty();
  clearTimeout(renderDebounceTimer);
  renderDebounceTimer = setTimeout(render, 250);
});

// ---- 画像の貼り付け ----
// クリップボードに画像が入っている場合はテキストとしてではなく、
// invoke("save_pasted_image", ...) でファイルとして保存し、
// 本文には ![](パス) だけを挿入する。
editor.addEventListener("paste", async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();

      const blob = item.getAsFile();
      const dataUrl = await blobToDataUrl(blob);
      const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
      if (!match) continue;
      const [, mime, base64Data] = match;

      try {
        const { invoke } = window.__TAURI__.core;
        const path = await invoke("save_pasted_image", { dataBase64: base64Data, mime });
        insertAtCursor(editor, `![](${path})\n`);
        render();
        markDirty();
      } catch (err) {
        alert("Failed to save image: " + err);
      }
      break; // 1回の貼り付けで複数画像が来た場合は、今回は先頭の1枚のみ対応
    }
  }
});

// 起動時のサンプル表示
editor.value = "# Sample\n\nType **Markdown** here and the preview will show up on the right.\n\n- List item 1\n- List item 2\n\n> Blockquotes are supported too.\n\nYou can paste screenshots and other images directly into this text area (Ctrl+V).\n\n## Mermaid example\n\n```mermaid\nflowchart LR\n    A[Start] --> B{Condition}\n    B -->|Yes| C[Step A]\n    B -->|No| D[Step B]\n    C --> E[End]\n    D --> E\n```\n";
render();
updateStatusBar();

// ------------------------------------------------------------
// メニュー(ファイル/編集)との連携
// window.__TAURI__ は index.html 読み込み完了(load)より前だと
// 未定義になることがあるため、load イベントの中で初期化する。
// 参考(1次情報): https://github.com/tauri-apps/tauri/issues/12990
// ------------------------------------------------------------
window.addEventListener("load", () => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // 「新規」: 今の内容を消して真っ白な状態にする
  function doNew() {
    if (dirty && !confirm("You have unsaved changes. Create a new file anyway?")) {
      return;
    }
    editor.value = "";
    currentPath = null;
    dirty = false;
    render();
    updateStatusBar();
  }

  // 「開く」: ダイアログでファイルを選び、内容をエディタに読み込む
  async function doOpen() {
    try {
      const result = await invoke("open_file_dialog");
      if (result) {
        editor.value = result.content;
        currentPath = result.path;
        dirty = false;
        render();
        updateStatusBar();
      }
    } catch (err) {
      alert("Failed to open file: " + err);
    }
  }

  listen("menu-new", () => doNew());
  listen("menu-open", () => doOpen());
  listen("menu-save", () => doSave());
  listen("menu-save-as", () => doSaveAs());
  listen("menu-export-html", () => doExportHtml());
  listen("menu-export-pdf", () => doExportPdf());

  // 「すべて選択」: 編集エリアの中身だけを選択する(画面全体は対象にしない)
  function doSelectAll() {
    editor.focus();
    editor.select();
  }
  listen("menu-select-all", () => doSelectAll());

  // 保存すると、貼り付けた画像が文書と同じ場所へ移動され、
  // 本文中のリンクも書き換えられる。その書き換え後の内容を
  // Rust側から受け取り、エディタの表示にも反映する。
  async function doSave() {
    if (!currentPath) {
      return doSaveAs();
    }
    try {
      const migratedContent = await invoke("save_file_to_path", {
        path: currentPath,
        content: editor.value
      });
      editor.value = migratedContent;
      dirty = false;
      render();
      updateStatusBar();
    } catch (err) {
      alert("Failed to save file: " + err);
    }
  }

  async function doSaveAs() {
    try {
      const saved = await invoke("save_file_dialog", { content: editor.value });
      if (saved) {
        currentPath = saved.path;
        editor.value = saved.content;
        dirty = false;
        render();
        updateStatusBar();
      }
    } catch (err) {
      alert("Failed to save file: " + err);
    }
  }

  // ---------------------------------------------------------------
  // キーボードショートカットの直接検知
  //
  // ネイティブメニューのアクセラレータ(accelerator)は、環境によっては
  // クリックは動くのにキー入力からは反応しないことがある既知の問題が
  // あるため(参考: https://github.com/tauri-apps/tauri/issues/6365)、
  // メニュー側の設定に頼らず、こちらでも直接キー入力を検知して同じ処理を
  // 呼び出す。もしメニュー側のショートカットが正常に動く環境であっても、
  // 同じ処理を呼ぶだけなので二重に実行される以外の実害はない想定。
  // ---------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();

    if (key === "s" && e.shiftKey) {
      e.preventDefault();
      doSaveAs();
    } else if (key === "s") {
      e.preventDefault();
      doSave();
    } else if (key === "n") {
      e.preventDefault();
      doNew();
    } else if (key === "o") {
      e.preventDefault();
      doOpen();
    } else if (key === "a") {
      e.preventDefault();
      doSelectAll();
    }
  });
});
