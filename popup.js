"use strict";

const fullBtn = document.getElementById("fullBtn");
const visibleBtn = document.getElementById("visibleBtn");
const statusEl = document.getElementById("status");
const openTabOpt = document.getElementById("openTabOpt");
const downloadOpt = document.getElementById("downloadOpt");

// チェック状態を保存し、次回も引き継ぐ
async function loadOptions() {
  try {
    const saved = await chrome.storage.local.get(["openTab", "download"]);
    if (typeof saved.openTab === "boolean") openTabOpt.checked = saved.openTab;
    if (typeof saved.download === "boolean") downloadOpt.checked = saved.download;
  } catch {
    // 読めなくても既定値で動く
  }
}
function saveOptions() {
  chrome.storage.local
    .set({ openTab: openTabOpt.checked, download: downloadOpt.checked })
    .catch(() => {});
}
openTabOpt.addEventListener("change", saveOptions);
downloadOpt.addEventListener("change", saveOptions);
loadOptions();
pruneOldImages();

// Chrome の画像サイズ上限（px）。これを超えると真っ白になるため、
// 超長ページでは自動で縮小して上限内に収める。
const MAX_SIZE = 16384;

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function setBusy(busy) {
  fullBtn.disabled = busy;
  visibleBtn.disabled = busy;
}

function debuggerSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

function debuggerAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function debuggerDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const chunks = [];
  const chunkSize = 0x8000;
  for (let i = 0; i < binary.length; i += chunkSize) {
    const slice = binary.slice(i, i + chunkSize);
    const bytes = new Uint8Array(slice.length);
    for (let j = 0; j < slice.length; j++) bytes[j] = slice.charCodeAt(j);
    chunks.push(bytes);
  }
  return new Blob(chunks, { type: mime });
}

function makeFilename(tab) {
  const title = (tab.title || "page")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 60);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${title || "screenshot"}_${stamp}.png`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// 撮影後の後処理。ダウンロードを先に済ませ、別タブ表示を最後にする
// （タブを開くとフォーカスが移り、ポップアップが閉じてしまうため）。
function makeId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function finishCapture(blob, filename, scaled) {
  const wantTab = openTabOpt.checked;
  const wantDownload = downloadOpt.checked;
  if (!wantTab && !wantDownload) {
    setStatus("撮影はできましたが、「別タブで開く」と「ダウンロード」の両方がオフです。どちらかオンにしてください。", "error");
    return;
  }
  if (wantDownload) downloadBlob(blob, filename);
  if (wantTab) {
    const id = makeId();
    await putImage(id, blob, filename);
    await chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?id=${encodeURIComponent(id)}`) });
  }
  const actions = [wantDownload && "ダウンロード", wantTab && "別タブで表示"].filter(Boolean).join("＋");
  setStatus(
    (scaled ? "保存しました。とても長いページのため、上限サイズに合わせて縮小しています。" : `保存しました ✅ ${actions}`),
    "ok"
  );
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("対象のタブが見つかりませんでした。");
  if (!tab.url || /^(chrome|edge|about|chrome-extension|devtools):/.test(tab.url)) {
    throw new Error("このページ（ブラウザ内部のページ）では撮影できません。");
  }
  if (tab.url.startsWith("https://chromewebstore.google.com") ||
      tab.url.startsWith("https://chrome.google.com/webstore")) {
    throw new Error("Chrome ウェブストアのページでは撮影できません（Chrome の制限です）。");
  }
  return tab;
}

async function captureFullPage() {
  const tab = await getActiveTab();
  setStatus("ページ全体の大きさを測っています…");
  let attached = false;
  try {
    await debuggerAttach(tab.id);
    attached = true;
    await debuggerSend(tab.id, "Page.enable");

    const metrics = await debuggerSend(tab.id, "Page.getLayoutMetrics");
    const size = metrics.cssContentSize || metrics.contentSize;
    if (!size) throw new Error("ページの大きさを取得できませんでした。");
    const width = Math.ceil(size.width);
    const height = Math.ceil(size.height);
    if (width <= 0 || height <= 0) throw new Error("ページの大きさが不正です。");

    let scale = 1;
    if (width > MAX_SIZE || height > MAX_SIZE) {
      scale = Math.min(MAX_SIZE / width, MAX_SIZE / height);
    }

    setStatus(`撮影しています…（${width} × ${height}px）`);
    const result = await debuggerSend(tab.id, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      fromSurface: true,
      clip: { x: 0, y: 0, width, height, scale },
    });
    if (!result || !result.data) throw new Error("画像データを取得できませんでした。");

    const blob = base64ToBlob(result.data, "image/png");
    await finishCapture(blob, makeFilename(tab), scale < 1);
  } finally {
    if (attached) await debuggerDetach(tab.id);
  }
}

async function captureVisible() {
  const tab = await getActiveTab();
  setStatus("表示中の画面を撮影しています…");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const blob = await (await fetch(dataUrl)).blob();
  await finishCapture(blob, makeFilename(tab), false);
}

async function run(fn) {
  setBusy(true);
  try {
    await fn();
  } catch (e) {
    setStatus(`失敗しました：${e.message || e}`, "error");
  } finally {
    setBusy(false);
  }
}

fullBtn.addEventListener("click", () => run(captureFullPage));
visibleBtn.addEventListener("click", () => run(captureVisible));
