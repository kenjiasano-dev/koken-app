// カーコン現場コントロール(app.html)専用の最小サービスワーカー。
// 目的はキャッシュではなく、Chromeの「アプリとして追加」対象になるための要件（fetchハンドラを持つSW）を満たすこと。
// GitHub PagesがHTML/JSに10分のキャッシュ(Cache-Control: max-age=600)を付けており、
// 素の fetch(event.request) だとブラウザの通常キャッシュに乗ってしまい、デプロイ直後でも
// 古い版が返り続ける不具合があった(2026-08-24発覚)。cache:'reload' でHTTPキャッシュを
// 無視し、必ずネットワークから取り直すようにする(APP_VERSIONによる自己更新の仕組みと矛盾しない)。
// 新しいSWを、既存タブが開きっぱなしでもすぐに有効化する(通常は全タブを閉じるまで待たされる)。
// 「閉じて開き直しただけ」でも最新のSWに切り替わるようにするため。
self.addEventListener('install', function(event) {
  self.skipWaiting();
});
self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(event) {
  event.respondWith(fetch(new Request(event.request, { cache: 'reload' })));
});
