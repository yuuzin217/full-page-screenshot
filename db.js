"use strict";

// 撮影画像はポップアップを閉じると消える blob URL では別タブに渡せないため、
// 拡張機能内の IndexedDB に一時保存して viewer ページと共有する。
const DB_NAME = "full-page-screenshot";
const DB_VERSION = 1;
const STORE = "images";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putImage(id, blob, filename) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ id, blob, filename, createdAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function getImage(id) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// 24時間より古い画像を掃除する（失敗しても撮影は止めない）
async function pruneOldImages() {
  try {
    const db = await openDb();
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const req = tx.objectStore(STORE).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          if (cursor.value.createdAt < cutoff) cursor.delete();
          cursor.continue();
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // 掃除の失敗は無視する
  }
}
