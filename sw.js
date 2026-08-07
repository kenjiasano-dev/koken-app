// カーコン現場コントロール(app.html)専用の最小サービスワーカー。
// 目的はキャッシュではなく、Chromeの「アプリとして追加」対象になるための要件（fetchハンドラを持つSW）を満たすこと。
// 何もキャッシュせず、常にネットワークへ素通しする（APP_VERSIONによる更新の仕組みと衝突させないため）。
self.addEventListener('fetch', function(event) {
  event.respondWith(fetch(event.request));
});
