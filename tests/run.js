/* カーコン工賃管理 自動テスト
   実行: node tests/run.js
   外部ライブラリ不要（Node標準機能のみ）。deploy.ps1から自動実行され、失敗するとデプロイが止まる。

   何を守っているか:
     1) 送信キュー … 工賃が「送ったつもりで消える」事故の再発防止（2026-08-03に実際に発生）
     2) 退行防止   … 今日直したバグが将来こっそり戻ってこないかの見張り
     3) 同期チェック … index/app/board の3ファイルで共通ロジックがズレていないか
     4) GAS計算    … 月の判定や称号など、集計の土台になる純粋な計算 */
const assert = require('assert');
const { readFile, extractInlineScripts, extractFunction, createFakeStorage, loadFunctions } = require('./harness');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; console.log('  OK   ' + name); },
                    e => { failed++; failures.push({ name, e }); console.log('  NG   ' + name + '\n         → ' + e.message); });
    }
    passed++; console.log('  OK   ' + name);
  } catch (e) {
    failed++; failures.push({ name, e });
    console.log('  NG   ' + name + '\n         → ' + e.message);
  }
  return Promise.resolve();
}

function section(title) { console.log('\n' + title); }

/* ============================================================
   1) 送信キューの動作テスト
   ============================================================ */
function buildQueue(htmlName, fetchImpl) {
  const storage = createFakeStorage();
  const toasts = [];
  const sandbox = loadFunctions(readFile(htmlName), [
    '_loadQueue', '_saveQueue', '_dequeueFirst', '_updateFirst',
    '_gasCanReadResponse', '_markGasReadable',
    'loadFailedLog', '_recordFailure', 'clearFailedLog', 'retryFailedLog', 'flushQueue',
  ], {
    consts: ['GAS_QUEUE_KEY', 'GAS_FAILED_KEY', 'GAS_CAN_READ_KEY', 'GAS_MAX_TRIES'],
    prelude: `
      const GAS_URL = 'https://example.test/exec';
      let _gasFlushing = false;
      let _gasWasOffline = false;
      function showToast(m){ toasts.push(m); }
    `,
    context: { localStorage: storage, fetch: fetchImpl, toasts },
  });
  return { sandbox, storage, toasts };
}

const respond = body => async () => ({ text: async () => body });
const OK = respond(JSON.stringify({ success: true }));
const ERR = respond(JSON.stringify({ error: 'busy' }));
const BROKEN = respond('<!DOCTYPE html><html>404</html>');
const OFFLINE = async () => { throw new Error('network down'); };

async function queueSuite(htmlName) {
  section('【送信キュー】' + htmlName + ' — 工賃が静かに消えないこと');
  const item = () => ({ action: 'addWage', amount: 120000, date: '2026-08-01', entryId: 'e' + Math.random() });

  await test('保存できたら、キューから消える', async () => {
    const { sandbox, storage } = buildQueue(htmlName, OK);
    storage.setItem('gasSendQueue', JSON.stringify([item()]));
    await sandbox.flushQueue();
    assert.strictEqual(sandbox._loadQueue().length, 0, 'キューに残ってしまった');
    assert.strictEqual(sandbox.loadFailedLog().length, 0);
  });

  await test('サーバーがエラーを返したら、消さずに残して再送を待つ', async () => {
    const { sandbox, storage } = buildQueue(htmlName, ERR);
    storage.setItem('gasSendQueue', JSON.stringify([item()]));
    await sandbox.flushQueue();
    const q = sandbox._loadQueue();
    assert.strictEqual(q.length, 1, 'エラーなのに消えてしまった（これが今日のデータ消失バグ）');
    assert.strictEqual(q[0]._try, 1);
  });

  await test('3回だめなら記録に残し、キューは詰まらせない', async () => {
    const { sandbox, storage } = buildQueue(htmlName, ERR);
    storage.setItem('gasSendQueue', JSON.stringify([item()]));
    await sandbox.flushQueue(); await sandbox.flushQueue(); await sandbox.flushQueue();
    assert.strictEqual(sandbox._loadQueue().length, 0, 'キューが詰まっている');
    assert.strictEqual(sandbox.loadFailedLog().length, 1, '失われたのに記録されていない');
  });

  await test('応答が壊れていても、読めた実績があれば再送する', async () => {
    const { sandbox, storage } = buildQueue(htmlName, BROKEN);
    storage.setItem('gasCanReadResponse', '1');
    storage.setItem('gasSendQueue', JSON.stringify([item()]));
    await sandbox.flushQueue();
    assert.strictEqual(sandbox._loadQueue().length, 1, '壊れた応答で消してしまった');
  });

  await test('応答を読めない端末では、無駄な再送をしない', async () => {
    let calls = 0;
    const { sandbox, storage } = buildQueue(htmlName, async () => { calls++; return { text: async () => '<!DOCTYPE html>' }; });
    storage.setItem('gasSendQueue', JSON.stringify([item()]));
    await sandbox.flushQueue();
    assert.strictEqual(calls, 1, '再送してサーバーに負荷をかけている');
    assert.strictEqual(sandbox._loadQueue().length, 0);
  });

  await test('オフラインでは回数を消費せず、そのまま待つ', async () => {
    const { sandbox, storage } = buildQueue(htmlName, OFFLINE);
    storage.setItem('gasSendQueue', JSON.stringify([item()]));
    await sandbox.flushQueue();
    const q = sandbox._loadQueue();
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0]._try, undefined, 'オフラインで再送回数を消費している');
  });

  await test('送信中に別の入力が入っても、両方きちんと送られる', async () => {
    let first = true;
    const sent = [];
    const { sandbox, storage } = buildQueue(htmlName, async (url, opt) => {
      sent.push(JSON.parse(opt.body).entryId);
      if (first) {   // 1件目を送っている最中に、利用者が次の工賃を入力した状況
        first = false;
        const q = JSON.parse(storage.getItem('gasSendQueue') || '[]');
        q.push({ action: 'addWage', amount: 50000, date: '2026-08-01', entryId: 'later' });
        storage.setItem('gasSendQueue', JSON.stringify(q));
      }
      return { text: async () => JSON.stringify({ success: true }) };
    });
    storage.setItem('gasSendQueue', JSON.stringify([{ action: 'addWage', amount: 120000, date: '2026-08-01', entryId: 'first' }]));
    await sandbox.flushQueue();
    assert.deepStrictEqual(sent, ['first', 'later'], '送信中に追加された分を取りこぼした');
    assert.strictEqual(sandbox._loadQueue().length, 0);
    assert.strictEqual(sandbox.loadFailedLog().length, 0);
  });

  await test('保存できなかった分は、あとから再送できる', async () => {
    const { sandbox, storage } = buildQueue(htmlName, ERR);
    storage.setItem('gasSendQueue', JSON.stringify([item()]));
    await sandbox.flushQueue(); await sandbox.flushQueue(); await sandbox.flushQueue();
    assert.strictEqual(sandbox.loadFailedLog().length, 1);
    sandbox.fetch = OK;                       // 通信が回復した状況
    await sandbox.retryFailedLog();
    assert.strictEqual(sandbox.loadFailedLog().length, 0, '再送しても記録が残ったまま');
    assert.strictEqual(sandbox._loadQueue().length, 0);
  });
}

/* ============================================================
   2) 退行防止チェック（今日直したバグが戻ってこないか）
   ============================================================ */
function regressionSuite() {
  section('【退行防止】直したバグが戻っていないこと');

  test('送信に no-cors を使っていない（応答を必ず確認する）', () => {
    for (const f of ['index.html', 'app.html', 'board.html']) {
      const html = readFile(f);
      const live = html.match(/fetch\([^)]*no-cors/g) || [];
      assert.strictEqual(live.length, 0, f + ' で応答を見ない送信が復活している');
    }
  });

  test('工賃の重複判定が、日付と金額だけで消さない', () => {
    const gas = readFile('../koken-gas-clone/code.js');
    const addWage = extractFunction(gas, 'addWage');
    assert.ok(addWage, 'addWageが見つからない');
    assert.ok(!/by:\s*'composite'/.test(addWage),
      '同じ日・同じ金額というだけで別の入力を消す判定が復活している');
    assert.ok(/entryId/.test(addWage), 'entryIdによる重複防止が消えている');
  });

  test('見積りにも重複防止がある', () => {
    const gas = readFile('../koken-gas-clone/code.js');
    const addEstimate = extractFunction(gas, 'addEstimate');
    assert.ok(addEstimate, 'addEstimateが見つからない');
    assert.ok(/entryId/.test(addEstimate) && /skipped/.test(addEstimate),
      '見積りの重複防止が消えている（通信リトライで二重登録される）');
  });

  test('GASのコードに秘密情報が直書きされていない', () => {
    const gas = readFile('../koken-gas-clone/code.js');
    assert.ok(!/CHANNEL_ACCESS_TOKEN\s*=\s*'[A-Za-z0-9+/=]{40,}'/.test(gas),
      'LINEトークンがコードに直書きされている（gitに秘密が入る）');
    assert.ok(/function\s+getChannelToken/.test(gas),
      'スクリプトプロパティから読む仕組みが消えている');
  });

  test('保存できなかったデータの受け皿が用意されている', () => {
    for (const f of ['index.html', 'app.html']) {
      const html = readFile(f);
      assert.ok(html.includes('failed-log-card'), f + ' に保存失敗の表示欄がない');
      assert.ok(/function\s+renderFailedLogCard/.test(html), f + ' に表示処理がない');
    }
  });
}

/* ============================================================
   3) 3ファイルの同期チェック
   ============================================================ */
function paritySuite() {
  section('【同期】index.html と app.html で共通ロジックがズレていないこと');
  const idx = extractInlineScripts(readFile('index.html'));
  const app = extractInlineScripts(readFile('app.html'));
  const shared = [
    'flushQueue', '_loadQueue', '_saveQueue', '_dequeueFirst', '_updateFirst',
    'loadFailedLog', '_recordFailure', 'clearFailedLog', 'retryFailedLog', 'renderFailedLogCard',
    'postToGAS', 'fetchFromGAS',
    'renderCategoryBudget', 'renderStoreYearTrend', 'renderStoreMonthMembers',
  ];
  for (const name of shared) {
    test('両方で同じ: ' + name, () => {
      const a = extractFunction(idx, name);
      const b = extractFunction(app, name);
      assert.ok(a, 'index.html に ' + name + ' が無い');
      assert.ok(b, 'app.html に ' + name + ' が無い');
      assert.strictEqual(a, b, '片方だけ直して、もう片方が古いままになっている');
    });
  }
}

/* ============================================================
   4) GASの計算ロジック
   ============================================================ */
function gasSuite() {
  section('【GAS】集計の土台になる計算');
  const gas = readFile('../koken-gas-clone/code.js');
  const sandbox = loadFunctions('<script>' + gas + '</script>', ['toMonthStr', 'getRankByManyen'], {
    consts: ['RANKS'],
    prelude: 'const Utilities = { formatDate: (d,tz,f) => d.toISOString().slice(0,7) };',
  });

  test('日付から「何月分か」を正しく取り出す', () => {
    assert.strictEqual(sandbox.toMonthStr('2026-08-03'), '2026-08');
    assert.strictEqual(sandbox.toMonthStr('2026-12-31'), '2026-12');
    assert.strictEqual(sandbox.toMonthStr(''), '', '空なら空を返すべき');
  });

  test('月末・年またぎでも前後の月に混ざらない', () => {
    assert.strictEqual(sandbox.toMonthStr('2026-07-31'), '2026-07');
    assert.strictEqual(sandbox.toMonthStr('2026-08-01'), '2026-08');
    assert.strictEqual(sandbox.toMonthStr('2027-01-01'), '2027-01');
  });

  test('称号が金額の境目で正しく変わる', () => {
    assert.strictEqual(sandbox.getRankByManyen(0).name, '無名の者');
    assert.strictEqual(sandbox.getRankByManyen(59).name, '無名の者');
    assert.strictEqual(sandbox.getRankByManyen(60).name, '足軽');
    assert.strictEqual(sandbox.getRankByManyen(100).name, '武将');
    assert.strictEqual(sandbox.getRankByManyen(150).name, '征夷大将軍');
    assert.strictEqual(sandbox.getRankByManyen(9999).name, '征夷大将軍');
  });
}

/* ============================================================ */
(async () => {
  console.log('カーコン工賃管理 自動テスト');
  await queueSuite('index.html');
  await queueSuite('app.html');
  regressionSuite();
  paritySuite();
  gasSuite();

  console.log('\n' + '─'.repeat(50));
  console.log(failed === 0 ? `すべて成功 (${passed}件)` : `失敗 ${failed}件 / 成功 ${passed}件`);
  if (failed > 0) {
    console.log('\n失敗した内容:');
    failures.forEach(f => console.log('  ・' + f.name + '\n      ' + f.e.message));
  }
  process.exit(failed === 0 ? 0 : 1);
})();
