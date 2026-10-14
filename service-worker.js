const CACHE = "field-area-note-v14-1";
const VERSION = CACHE.replace("field-area-note-v", "").replace("-", "."); // 例 "13.4"。ページの版と違えば、ページが更新のお知らせを出す
const APP_SHELL = ["./", "./index.html", "./styles.css?v=14.1", "./mobile-input.css?v=14.1", "./features.css?v=14.1", "./numbers.js?v=14.1", "./app.js?v=14.1", "./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-180.png"];
// cache: "reload" … ブラウザの HTTP キャッシュ（GitHub Pages は約10分）を通さず、公開中の最新ファイルを入れる
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" })))).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("field-area-note-") && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  // 有効になったら、開いているページに版を知らせる（古い版のページなら「新しい版があります」を出す）
  .then(() => self.clients.matchAll({ type: "window" })).then((clients) => clients.forEach((c) => c.postMessage({ type: "version", version: VERSION })))));
// ページから版を尋ねられたら答える（起動時・画面に戻ったときの確認用）
self.addEventListener("message", (event) => { if (event.data?.type === "version?") event.source?.postMessage({ type: "version", version: VERSION }); });
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    // 複製はページに返す前に作る（返した後だと本体が読まれていて複製できない）。書き込みは waitUntil で最後まで待つ
    if (response.ok && new URL(event.request.url).origin === self.location.origin) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
    }
    return response;
  }).catch(() => caches.match("./index.html"))));
});
