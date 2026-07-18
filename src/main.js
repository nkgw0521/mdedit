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
//
// パスの解決は「今アクティブなタブの保存先」を基準にするため、
// activeTab() を参照する(タブ機能に対応)。
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

function resolveImageSrc(src) {
  if (/^(https?:|data:)/i.test(src)) {
    return src;
  }

  // markdown-itはパース時にURLを正規化する際、日本語などの非ASCII文字を
  // 自動でパーセントエンコード(%E6%97%A5...のような形式)してしまう仕様がある。
  // ここでのsrcは実際のファイルパスとして扱いたいので、先に元の文字列へ戻す。
  // 参考(1次情報): https://github.com/nanyuantingfeng/markdown-it-disable-url-encode
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch (err) {
    decoded = src; // 正しくデコードできない場合はそのまま使う
  }

  let absolute = decoded;
  const isAbsoluteWin = /^[a-zA-Z]:[\\/]/.test(decoded);
  const isAbsoluteUnix = decoded.startsWith("/");
  const isAbsolute = isAbsoluteWin || isAbsoluteUnix || decoded.startsWith("\\\\");

  if (!isAbsolute) {
    const tab = activeTab();
    if (!tab || !tab.path) {
      // 保存前で、かつ相対パス指定 -> 解決しようがないのでそのまま返す
      return src;
    }
    const dir = tab.path.replace(/[\\/][^\\/]*$/, "");
    absolute = dir + "/" + decoded;
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
const tabBar = document.getElementById("tab-bar");
const paneEditor = document.getElementById("pane-editor");
const splitDivider = document.getElementById("split-divider");
const splitContainer = document.querySelector(".split-container");

// ---------------------------------------------------------------
// 中央の分割線をドラッグして、編集/プレビューの幅を変えられるようにする
// ---------------------------------------------------------------
let isDraggingSplit = false;

splitDivider.addEventListener("mousedown", (e) => {
  isDraggingSplit = true;
  splitDivider.classList.add("dragging");
  document.body.classList.add("split-resizing");
  e.preventDefault();
});

window.addEventListener("mousemove", (e) => {
  if (!isDraggingSplit) return;
  const rect = splitContainer.getBoundingClientRect();
  const minWidth = 200; // 左右とも、これより狭くはしない
  const maxWidth = rect.width - minWidth - splitDivider.offsetWidth;
  let newWidth = e.clientX - rect.left;
  newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
  paneEditor.style.width = newWidth + "px";
});

window.addEventListener("mouseup", () => {
  if (!isDraggingSplit) return;
  isDraggingSplit = false;
  splitDivider.classList.remove("dragging");
  document.body.classList.remove("split-resizing");
});

// ---------------------------------------------------------------
// タブのデータモデル
//
// tabs: { id, path, content, dirty, draftPath }[]
//   id        : タブごとの一意なID(下書きファイル名にも使う)
//   path      : 保存先の実ファイルパス(未保存ならnull)
//   content   : 現在の本文
//   dirty     : 最後に保存した内容と違うか
//   draftPath : 前回終了時に一時保存した下書きファイルのパス(無ければnull)
// ---------------------------------------------------------------
let tabs = [];
let activeIndex = -1;

const SAMPLE_CONTENT =
  "# Sample\n\nType **Markdown** here and the preview will show up on the right.\n\n" +
  "- List item 1\n- List item 2\n\n> Blockquotes are supported too.\n\n" +
  "You can paste screenshots and other images directly into this text area (Ctrl+V).\n\n" +
  "## Mermaid example\n\n```mermaid\nflowchart LR\n    A[Start] --> B{Condition}\n" +
  "    B -->|Yes| C[Step A]\n    B -->|No| D[Step B]\n    C --> E[End]\n    D --> E\n```\n";

function newTabId() {
  return "tab-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function createTab({ path = null, content = "", dirty = false, draftPath = null } = {}) {
  const tab = { id: newTabId(), path, content, dirty, draftPath, undoStack: [], redoStack: [] };
  tabs.push(tab);
  return tab;
}

function activeTab() {
  return tabs[activeIndex] || null;
}

// パス文字列をフォワードスラッシュへ統一する。
// 画像パスの組み立て(resolveImageSrc)で区切り文字が混在すると
// パスが壊れるため、tab.pathを設定する箇所では必ずこれを通す。
function normalizePath(p) {
  return p ? p.replace(/\\/g, "/") : p;
}

function tabDisplayName(tab) {
  const base = tab.path ? tab.path.replace(/^.*[\\/]/, "") : "Untitled";
  return tab.dirty ? base + " *" : base;
}

let draggedTabIndex = null;

function renderTabBar() {
  tabBar.innerHTML = "";

  tabs.forEach((tab, index) => {
    const el = document.createElement("div");
    el.className = "tab" + (index === activeIndex ? " tab-active" : "");
    el.title = tab.path || "Untitled";
    el.draggable = true;

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tabDisplayName(tab);
    el.appendChild(label);

    const closeBtn = document.createElement("button");
    closeBtn.className = "tab-close";
    closeBtn.type = "button";
    closeBtn.textContent = "\u00d7";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(index);
    });
    el.appendChild(closeBtn);

    el.addEventListener("click", () => switchToTab(index));

    // ---- ドラッグ&ドロップでの並び替え ----
    el.addEventListener("dragstart", (e) => {
      draggedTabIndex = index;
      el.classList.add("tab-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index)); // 一部環境で必要
      }
    });

    el.addEventListener("dragend", () => {
      draggedTabIndex = null;
      el.classList.remove("tab-dragging");
    });

    el.addEventListener("dragover", (e) => {
      // ドロップを許可するために既定動作を止める必要がある
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    });

    el.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation(); // タブバー本体側のドロップ処理(末尾移動)と二重に動かないようにする
      if (draggedTabIndex === null || draggedTabIndex === index) return;
      reorderTabs(draggedTabIndex, index);
      draggedTabIndex = null;
    });

    tabBar.appendChild(el);
  });

  const newTabBtn = document.createElement("button");
  newTabBtn.className = "tab-new";
  newTabBtn.type = "button";
  newTabBtn.textContent = "+";
  newTabBtn.title = "New tab (Ctrl+N)";
  newTabBtn.addEventListener("click", () => doNew());
  tabBar.appendChild(newTabBtn);
}

// タブバー自体(タブとタブの隙間や、最後のタブより右側の余白)にドロップされた場合は、
// 「末尾へ移動」として扱う。個々のタブのdrop処理はstopPropagation()しているので、
// ここに届くのはタブの上ではない場所へドロップされたときだけ。
tabBar.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
});

tabBar.addEventListener("drop", (e) => {
  e.preventDefault();
  if (draggedTabIndex === null) return;
  moveTabToEnd(draggedTabIndex);
  draggedTabIndex = null;
});

function moveTabToEnd(index) {
  if (!tabs[index]) return;
  const activeId = activeTab() ? activeTab().id : null;

  const [moved] = tabs.splice(index, 1);
  tabs.push(moved);

  if (activeId !== null) {
    const idx = tabs.findIndex((t) => t.id === activeId);
    if (idx !== -1) activeIndex = idx;
  }

  renderTabBar();
}

// タブをfromIndexからtoIndexの位置へ移動する。
// アクティブなタブがずれても正しく追従するよう、
// インデックスの計算ではなくタブのidで追跡し直す。
function reorderTabs(fromIndex, toIndex) {
  if (fromIndex === toIndex || !tabs[fromIndex] || !tabs[toIndex]) return;

  const activeId = activeTab() ? activeTab().id : null;

  const [moved] = tabs.splice(fromIndex, 1);
  const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
  tabs.splice(insertIndex, 0, moved);

  if (activeId !== null) {
    const idx = tabs.findIndex((t) => t.id === activeId);
    if (idx !== -1) activeIndex = idx;
  }

  renderTabBar();
}

function switchToTab(index) {
  if (index === activeIndex || !tabs[index]) return;
  activeIndex = index;
  editor.value = activeTab().content;
  renderTabBar();
  updateStatusBar();
  render();
}

// 次/前のタブへ切り替える(Ctrl+Tab / Ctrl+Shift+Tab用)
function switchToAdjacentTab(direction) {
  if (tabs.length < 2) return;
  const nextIndex = (activeIndex + direction + tabs.length) % tabs.length;
  switchToTab(nextIndex);
}

// 不要になった下書きファイルを削除する(保存済みになった/明示的に閉じられた場合)
async function deleteDraftForTab(tab) {
  if (tab.draftPath) {
    try {
      await window.__TAURI__.core.invoke("delete_draft", { path: tab.draftPath });
    } catch (err) {
      // 削除に失敗しても致命的ではないので無視する
    }
    tab.draftPath = null;
  }
}

// タブを閉じる(タブバーのxボタン、および将来的にショートカット等から呼ぶ)
async function closeTab(index) {
  const tab = tabs[index];
  if (!tab) return;

  if (tab.dirty && !confirm(`"${tabDisplayName(tab)}" has unsaved changes. Close anyway?`)) {
    return;
  }

  await deleteDraftForTab(tab);
  tabs.splice(index, 1);

  if (tabs.length === 0) {
    createTab({ content: "" });
    activeIndex = 0;
  } else if (activeIndex >= tabs.length) {
    activeIndex = tabs.length - 1;
  } else if (index < activeIndex) {
    activeIndex -= 1;
  }

  editor.value = activeTab().content;
  renderTabBar();
  updateStatusBar();
  render();
}

// ---- 「新規」: 新しいタブを追加する ----
function doNew() {
  createTab({ content: "" });
  activeIndex = tabs.length - 1;
  editor.value = "";
  renderTabBar();
  updateStatusBar();
  render();
}

// ---- 指定したパスのファイル(複数可)を開く。既に同じパスのタブが
//      あればそちらへ切り替える。Explorer等からのファイル起動、および
//      「開く」ダイアログの両方から使う共通処理。 ----
async function openFilesFromPaths(paths) {
  let lastOpenedIndex = null;

  for (const rawPath of paths) {
    const normalizedPath = normalizePath(rawPath);
    const existingIndex = tabs.findIndex((t) => t.path === normalizedPath);
    if (existingIndex !== -1) {
      lastOpenedIndex = existingIndex;
      continue;
    }

    try {
      const content = await window.__TAURI__.core.invoke("read_text_file", { path: rawPath });
      createTab({ path: normalizedPath, content, dirty: false });
      lastOpenedIndex = tabs.length - 1;
    } catch (err) {
      alert("Failed to open file: " + rawPath + "\n" + err);
    }
  }

  if (lastOpenedIndex !== null) {
    activeIndex = lastOpenedIndex;
    editor.value = activeTab().content;
    renderTabBar();
    updateStatusBar();
    render();
  }
}

// ---- 「開く」: すでに同じパスのタブが開いていればそこへ切り替え、
//      無ければ新しいタブを作って読み込む ----
async function doOpen() {
  try {
    const result = await window.__TAURI__.core.invoke("open_file_dialog");
    if (!result) return;
    await openFilesFromPaths([result.path]);
  } catch (err) {
    alert("Failed to open file: " + err);
  }
}

// ---- 「保存」/「名前を付けて保存」(アクティブなタブが対象) ----
async function doSave() {
  const tab = activeTab();
  if (!tab) return;
  if (!tab.path) {
    return doSaveAs();
  }
  try {
    const migratedContent = await window.__TAURI__.core.invoke("save_file_to_path", {
      path: tab.path,
      content: tab.content
    });
    tab.content = migratedContent;
    tab.dirty = false;
    editor.value = tab.content;
    await deleteDraftForTab(tab);
    renderTabBar();
    updateStatusBar();
    render();
  } catch (err) {
    alert("Failed to save file: " + err);
  }
}

async function doSaveAs() {
  const tab = activeTab();
  if (!tab) return;
  try {
    const saved = await window.__TAURI__.core.invoke("save_file_dialog", { content: tab.content });
    if (saved) {
      tab.path = normalizePath(saved.path);
      tab.content = saved.content;
      tab.dirty = false;
      editor.value = tab.content;
      await deleteDraftForTab(tab);
      renderTabBar();
      updateStatusBar();
      render();
    }
  } catch (err) {
    alert("Failed to save file: " + err);
  }
}

// ---- 「すべて選択」: 編集エリアの中身だけを選択する(画面全体は対象にしない) ----
function doSelectAll() {
  editor.focus();
  editor.select();
}

// ---------------------------------------------------------------
// Undo / Redo
//
// OS標準のUndo/Redoメニュー項目は、Select Allと同様に編集エリアへ
// 正しく効かないことがあるため、タブごとに自前でスナップショット
// (直前の内容)を積んでおき、Undo/Redoで復元する方式にしている。
// キー入力ではなく「入力が一段落するたび」(500ms止まったら)に1つ
// 積むことで、1文字ずつ戻るのではなく、ある程度まとまった単位で
// 元に戻せるようにしている。
// ---------------------------------------------------------------
let undoDebounceTimer = null;

function pushUndoSnapshot(tab) {
  const last = tab.undoStack[tab.undoStack.length - 1];
  if (last === tab.content) return; // 前回から変化が無いなら積まない
  tab.undoStack.push(tab.content);
  if (tab.undoStack.length > 200) tab.undoStack.shift(); // 際限なく増えないよう上限を設ける
  tab.redoStack.length = 0; // 新しい編集をしたら、それより前のredo履歴は無効
}

function doUndo() {
  const tab = activeTab();
  if (!tab || tab.undoStack.length === 0) return;
  tab.redoStack.push(tab.content);
  tab.content = tab.undoStack.pop();
  tab.dirty = true;
  editor.value = tab.content;
  renderTabBar();
  updateStatusBar();
  render();
}

function doRedo() {
  const tab = activeTab();
  if (!tab || tab.redoStack.length === 0) return;
  tab.undoStack.push(tab.content);
  tab.content = tab.redoStack.pop();
  tab.dirty = true;
  editor.value = tab.content;
  renderTabBar();
  updateStatusBar();
  render();
}

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
  const tab = activeTab();
  if (!tab) {
    statusBar.textContent = "No file open";
    return;
  }
  const name = tab.path ? tab.path : "Untitled";
  statusBar.textContent = tab.dirty ? `${name} *` : name;
}

// 一時的にステータスバーへメッセージを表示し、しばらくしたら通常表示に戻す
function flashStatus(message) {
  statusBar.textContent = message;
  setTimeout(updateStatusBar, 2500);
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
// HTML / PDF エクスポート(アクティブなタブの内容が対象)
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
      console.error("Failed to inline an image for export:", err);
    }
  }
}

function exportBaseName() {
  const tab = activeTab();
  if (!tab || !tab.path) return "untitled";
  const fileName = tab.path.replace(/^.*[\\/]/, "");
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
    table { border-collapse: collapse; margin: 12px 0; }
    th, td { border: 1px solid #ccc; padding: 6px 10px; }
    th { background: #f5f5f5; font-weight: 600; }
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

// ---- 編集内容をタブへ反映 + プレビュー更新(debounce付き) ----
editor.addEventListener("input", () => {
  const tab = activeTab();
  if (tab) {
    if (!undoDebounceTimer) {
      pushUndoSnapshot(tab); // このひとまとまりの入力の最初のキーで、直前の内容を1つ積む
    }
    clearTimeout(undoDebounceTimer);
    undoDebounceTimer = setTimeout(() => {
      undoDebounceTimer = null;
    }, 500);

    tab.content = editor.value;
    tab.dirty = true;
  }
  renderTabBar();
  updateStatusBar();
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
        const tab = activeTab();
        if (tab) {
          pushUndoSnapshot(tab);
        }
        insertAtCursor(editor, `![](${path})\n`);
        if (tab) {
          tab.content = editor.value;
          tab.dirty = true;
        }
        renderTabBar();
        updateStatusBar();
        render();
      } catch (err) {
        alert("Failed to save image: " + err);
      }
      break; // 1回の貼り付けで複数画像が来た場合は、今回は先頭の1枚のみ対応
    }
  }
});

// ------------------------------------------------------------
// メニュー(ファイル/編集)との連携、セッションの保存/復元
// window.__TAURI__ は index.html 読み込み完了(load)より前だと
// 未定義になることがあるため、load イベントの中で初期化する。
// 参考(1次情報): https://github.com/tauri-apps/tauri/issues/12990
// ------------------------------------------------------------
window.addEventListener("load", async () => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  await restoreSessionOrDefault();
  editor.value = activeTab() ? activeTab().content : "";
  renderTabBar();
  updateStatusBar();
  await render();

  // Explorer等からファイルをダブルクリックして起動した場合、その
  // ファイルパスをRust側で一時的に保持しているので、ここで取り出して開く。
  // (セッション復元より後に行うことで、タブとして追加される)
  try {
    const launchFiles = await invoke("take_launch_files");
    if (launchFiles && launchFiles.length > 0) {
      await openFilesFromPaths(launchFiles);
    }
  } catch (err) {
    console.error("Failed to open launch files:", err);
  }

  // アプリが既に起動している状態で、別の.mdファイルをダブルクリック
  // した場合はこちらに届く(Rust側の2重起動防止プラグイン経由)
  listen("open-files", (event) => openFilesFromPaths(event.payload));

  listen("menu-new", () => doNew());
  listen("menu-open", () => doOpen());
  listen("menu-save", () => doSave());
  listen("menu-save-as", () => doSaveAs());
  listen("menu-export-html", () => doExportHtml());
  listen("menu-export-pdf", () => doExportPdf());
  listen("menu-select-all", () => doSelectAll());
  listen("menu-undo", () => doUndo());
  listen("menu-redo", () => doRedo());

  // ---------------------------------------------------------------
  // キーボードショートカットの直接検知
  //
  // ネイティブメニューのアクセラレータ(accelerator)は、環境によっては
  // クリックは動くのにキー入力からは反応しないことがある既知の問題が
  // あるため(参考: https://github.com/tauri-apps/tauri/issues/6365)、
  // メニュー側の設定に頼らず、こちらでも直接キー入力を検知して同じ処理を
  // 呼び出す。
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
    } else if (key === "tab") {
      e.preventDefault();
      switchToAdjacentTab(e.shiftKey ? -1 : 1);
    } else if (key === "z" && e.shiftKey) {
      e.preventDefault();
      doRedo(); // Ctrl+Shift+Z を Redo の別名として扱う(慣習に合わせて)
    } else if (key === "z") {
      e.preventDefault();
      doUndo();
    } else if (key === "y") {
      e.preventDefault();
      doRedo();
    }
  });

  // ---------------------------------------------------------------
  // セッションの保存(終了時)
  //
  // ウィンドウが閉じられる直前にこの処理が呼ばれる。ここで
  //   - 未保存(dirty)または保存先未定のタブの内容を下書きとして
  //     ~/.mdedit/drafts/ に書き出す
  //   - 開いていたタブの一覧(パスと下書きパス)を
  //     ~/.mdedit/session.json に書き出す
  // ことで、次回起動時に元通り復元できるようにする。
  //
  // 参考(1次情報): https://v2.tauri.app/reference/javascript/api/namespacewindow/
  // ここでは event.preventDefault() を呼ばないので、この処理が終わった後は
  // 通常通りウィンドウが閉じる(先に確認したTauri公式ドキュメントの挙動)。
  // ---------------------------------------------------------------
  async function saveSessionForExit() {
    const current = activeTab();
    if (current) current.content = editor.value;

    const sessionTabs = [];
    for (const tab of tabs) {
      const needsDraft = tab.dirty || !tab.path;

      if (needsDraft && tab.content.length > 0) {
        try {
          tab.draftPath = await invoke("write_draft", { draftId: tab.id, content: tab.content });
        } catch (err) {
          // 下書きの保存に失敗しても、パスだけは記録して次を続ける
        }
      } else if (!needsDraft) {
        await deleteDraftForTab(tab);
      }

      sessionTabs.push({ path: tab.path, draftPath: tab.draftPath });
    }

    try {
      await invoke("save_session", {
        sessionJson: JSON.stringify({ tabs: sessionTabs, activeIndex })
      });
    } catch (err) {
      // セッションの保存に失敗しても、アプリを閉じられなくなるのは避けたいので無視する
    }
  }

  try {
    const { getCurrentWindow } = window.__TAURI__.window;
    const currentWindow = getCurrentWindow();

    await currentWindow.onCloseRequested(async () => {
      console.log("[mdedit] close-requested handler fired");
      // 何らかの理由でセッション保存処理が失敗/ハングしても、
      // ウィンドウが二度と閉じられなくなる事態だけは避けたいので、
      // タイムアウト付きで実行し、最後に必ず destroy() で強制的に閉じる。
      // (公式ドキュメントによれば close() はcloseRequestedイベントを
      //  再度発生させるだけで、確実に閉じるには destroy() が必要)
      // 参考(1次情報): https://v2.tauri.app/reference/javascript/api/namespacewindow/
      try {
        await Promise.race([
          saveSessionForExit(),
          new Promise((resolve) => setTimeout(resolve, 3000))
        ]);
        console.log("[mdedit] session save finished (or timed out)");
      } catch (err) {
        console.error("[mdedit] Failed to save session on exit:", err);
      } finally {
        try {
          console.log("[mdedit] calling destroy()");
          await currentWindow.destroy();
          console.log("[mdedit] destroy() resolved");
        } catch (err) {
          console.error("[mdedit] Failed to destroy window:", err);
        }
      }
    });
    console.log("[mdedit] close handler registered");
  } catch (err) {
    console.error("[mdedit] Failed to register close handler:", err);
  }

  // ---------------------------------------------------------------
  // 起動時のセッション復元
  //
  // ~/.mdedit/session.json が無い(初回起動)場合はサンプルを1つ表示する。
  // ある場合は、各タブについて下書き(draftPath)があればそれを優先して
  // 読み込み(= 未保存の内容を復元)、無ければ保存済みファイル(path)を
  // 読み込む。
  // ---------------------------------------------------------------
  async function restoreSessionOrDefault() {
    let sessionRaw = null;
    try {
      sessionRaw = await invoke("load_session");
    } catch (err) {
      sessionRaw = null;
    }

    let session = null;
    if (sessionRaw) {
      try {
        session = JSON.parse(sessionRaw);
      } catch (err) {
        session = null;
      }
    }

    if (!session || !Array.isArray(session.tabs) || session.tabs.length === 0) {
      createTab({ content: SAMPLE_CONTENT });
      activeIndex = 0;
      return;
    }

    for (const entry of session.tabs) {
      let content = "";
      let dirty = false;

      try {
        if (entry.draftPath) {
          content = await invoke("read_text_file", { path: entry.draftPath });
          dirty = true; // 下書きから復元したものは「未保存」のままにしておく
        } else if (entry.path) {
          content = await invoke("read_text_file", { path: entry.path });
        }
      } catch (err) {
        content = ""; // 元ファイル/下書きが見つからない場合は空で復元する
      }

      const tab = createTab({ path: normalizePath(entry.path) || null, content, dirty });
      tab.draftPath = entry.draftPath || null;
    }

    const restoredIndex = Number.isInteger(session.activeIndex) ? session.activeIndex : 0;
    activeIndex = Math.min(Math.max(restoredIndex, 0), tabs.length - 1);
  }
});
