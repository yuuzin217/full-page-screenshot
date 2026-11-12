"use strict";

const filenameEl = document.getElementById("filename");
const dimensionsEl = document.getElementById("dimensions");
const errorEl = document.getElementById("error");
const imgEl = document.getElementById("shot");
const downloadBtn = document.getElementById("downloadBtn");

let currentUrl = null;
let currentFilename = "screenshot.png";

async function init() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) {
    errorEl.textContent = "画像の指定がありません。拡張のアイコンから撮影し直してください。";
    filenameEl.textContent = "";
    return;
  }
  const record = await getImage(id);
  if (!record) {
    errorEl.textContent = "画像が見つかりませんでした（保存から24時間以上経つと自動で消えます）。撮影し直してください。";
    filenameEl.textContent = "";
    return;
  }
  currentFilename = record.filename;
  filenameEl.textContent = record.filename;
  currentUrl = URL.createObjectURL(record.blob);
  imgEl.addEventListener("load", () => {
    dimensionsEl.textContent = `${imgEl.naturalWidth} × ${imgEl.naturalHeight}px`;
  });
  imgEl.src = currentUrl;
  downloadBtn.disabled = false;
}

downloadBtn.addEventListener("click", () => {
  if (!currentUrl) return;
  const a = document.createElement("a");
  a.href = currentUrl;
  a.download = currentFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

init().catch((e) => {
  errorEl.textContent = `読み込みに失敗しました：${e.message || e}`;
});
