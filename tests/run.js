/* カーコン工賃管理 自動テスト
   実行: node tests/run.js
   外部ライブラリ不要（Node標準機能のみ）。deploy.ps1から自動実行され、失敗するとデプロイが止まる。

   何を守っているか:
     1) 送信キュー … 工賃が「送ったつもりで消える」事故の再発防止（2026-08-03に実際に発生）
     2) 退行防止   … 今日直したバグが将来こっそり戻ってこないかの見張り
     3) 同期チェック … index/app/board の3ファイルで共通ロジックがズレていないか
     4) GAS計算    … 月の判定や称号など、集計の土台になる純粋な計算 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { REPO, readFile, extractInlineScripts, extractFunction, createFakeStorage, loadFunctions } = require('./harness');

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

  test('現場ボードと工賃入力タブが、互いの入力を見て二重登録を警告する', () => {
    const html = readFile('app.html');
    const helper = extractFunction(html, 'findExistingWageForNumber');
    assert.ok(helper, 'findExistingWageForNumber が無い（ボードとタブが互いを見ていない）');
    const submit = extractFunction(html, 'submitWage');
    assert.ok(/findExistingWageForNumber/.test(submit), '工賃入力タブがボード側の入力をチェックしていない');
    const save = extractFunction(html, 'bd_saveWageInput');
    assert.ok(/findExistingWageForNumber/.test(save), 'ボード側が工賃入力タブの入力をチェックしていない');
  });

  test('代理入力（他の人の名義で登録）が、自分の工賃合計に混ざらない', () => {
    const html = readFile('app.html');
    const save = extractFunction(html, 'bd_saveWageInput');
    assert.ok(/creditTo\s*===\s*me/.test(save),
      '代理入力の判定が無い、または壊れている（他人の工賃が自分のwageDataに混入する恐れ）');
    // wageData.push は「自分名義の時だけ」のブロック内にあるべき
    const pushIdx = save.indexOf('wageData.push');
    const guardIdx = save.lastIndexOf('creditTo===me', pushIdx);
    assert.ok(pushIdx > 0 && guardIdx > 0 && (pushIdx - guardIdx) < 150,
      'wageData.push が自分名義チェックの外にある（代理入力が自分の合計を汚染する）');
  });

  test('代理入力の名前選択欄は、普段の作業者には出さない（PC画面のみ）', () => {
    const html = readFile('app.html');
    const open = extractFunction(html, 'bd_openWageInput');
    assert.ok(/isPcScreen/.test(open),
      'PC画面かどうかの判定が無い（全員に選択欄が出てしまい、普段の作業者に余計な操作が増える）');
    const ifIdx = open.indexOf('if (isPcScreen)');
    const selectIdx = open.indexOf('bd-wage-name');
    assert.ok(ifIdx > 0 && selectIdx > ifIdx,
      '名前選択欄がisPcScreenの分岐の外にある（全員に出てしまう）');
  });

  test('使う機能（作業ボード・受付・工賃）を店舗ごとにON/OFFできる', () => {
    const html = readFile('app.html');
    assert.ok(html.includes('id="feature-use-board"'), '作業ボードのON/OFFスイッチが無い');
    assert.ok(html.includes('id="feature-use-front"'), 'フロント受付のON/OFFスイッチが無い');
    assert.ok(html.includes('id="feature-use-wage"'), '工賃入力のON/OFFスイッチが無い');

    const apply = extractFunction(html, 'applyFeatureToggles');
    assert.ok(/useBoard/.test(apply) && /data-tab="genba"/.test(apply), '作業ボードOFF時にタブを隠す処理が無い');
    assert.ok(/useWage/.test(apply) && /data-tab="input"/.test(apply), '工賃入力OFF時にタブを隠す処理が無い');

    const save = extractFunction(html, 'saveFeatureToggles');
    assert.ok(/useBoard/.test(save) && /useWage/.test(save), '保存時にuseBoard/useWageがサーバーへ送られていない');
  });

  test('GASのグループ設定に作業ボード・工賃のON/OFF列がある', () => {
    const gas = readFile('../koken-gas-clone/code.js');
    assert.ok(/作業ボード利用/.test(gas), 'GROUP_SETTINGS_COLSに作業ボード利用列が無い');
    assert.ok(/工賃利用/.test(gas), 'GROUP_SETTINGS_COLSに工賃利用列が無い');
    const get = extractFunction(gas, 'getGroupGoal');
    assert.ok(/useBoard/.test(get) && /useWage/.test(get), 'getGroupGoalがuseBoard/useWageを返していない');
    const set = extractFunction(gas, 'setGroupGoal');
    assert.ok(/useBoard/.test(set) && /useWage/.test(set), 'setGroupGoalがuseBoard/useWageを保存していない');
  });

  test('PC画面で開いたときだけ「アプリとして追加」ボタンが自動で出る（サービスワーカーも登録済み）', () => {
    const html = readFile('app.html');
    assert.ok(html.includes('id="pwa-install-btn"'), 'アプリ追加ボタンのHTMLが無い');
    assert.ok(/navigator\.serviceWorker\.register\(/.test(html), 'サービスワーカーを登録していない（Chromeのインストール要件を満たせない）');

    const update = extractFunction(html, 'updatePwaInstallButton');
    assert.ok(update, 'updatePwaInstallButtonが無い');
    assert.ok(/isPcScreen/.test(update) && /1100/.test(update), 'PC画面かどうかの判定が無い（スマホにも出てしまう）');
    assert.ok(/isStandalonePwa/.test(update), 'インストール済みかどうかを見ていない（インストール後も出続ける恐れ）');

    assert.ok(fs.existsSync(path.join(REPO, 'sw.js')), 'sw.js が無い（サービスワーカーの実体が無いと登録に失敗する）');
    const sw = readFile('sw.js');
    assert.ok(/addEventListener\(\s*['"]fetch['"]/.test(sw), 'sw.jsにfetchハンドラが無い（Chromeのインストール要件を満たせない）');
  });

  test('同名の関数が二重に定義されていない（直しても画面が変わらない事故の防止）', () => {
    // 2026/8/5: app.htmlに「末尾追記」時代の死んだ二重定義が700行たまっていた。
    // JavaScriptは同名関数の最後の1つだけが効くため、手前のコピーを直すと無反応になる。
    // 桁0の定義だけを数える（字下げされた関数は別関数の中のローカル関数で、同名でも衝突しない）。
    for (const f of ['index.html', 'app.html', 'board.html']) {
      const js = extractInlineScripts(readFile(f));
      const counts = {};
      for (const line of js.split(/\r?\n/)) {
        const m = line.match(/^function\s+([A-Za-z0-9_]+)\s*\(/);
        if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
      }
      const dupes = Object.entries(counts).filter(([, n]) => n > 1);
      assert.strictEqual(dupes.length, 0,
        f + ' に二重定義: ' + dupes.map(([n, c]) => n + '(' + c + '回)').join(', '));
    }
  });

  test('デプロイ前チェックが index.html だけでなく app.html も見ている', () => {
    const ps = readFile('deploy.ps1');
    assert.ok(/\$targets\s*=.*app\.html/.test(ps),
      'deploy.ps1の構文・重複チェックがapp.htmlを対象にしていない（app.htmlの不具合を素通しする）');
    assert.ok(/git add[^\r\n]*app\.html/.test(ps),
      'deploy.ps1のgit addにapp.htmlが無い（app.htmlを直してもpushされず、反映済みと誤表示される）');
  });

  test('現場ボードの工程マスが、現場で読める大きさを保っている', () => {
    // 2026/8/5計測: 9工程を横に並べると1マス36pxしかなく、工程名が10px・2行折返しで読めなかった。
    // 工程名をやめて番号(1文字)にしたので、二度と極小フォントに戻さないよう見張る。
    const html = readFile('app.html');
    const card = extractFunction(html, 'bd_workCardHtml');
    assert.ok(/class="hnum"/.test(card), '工程マスが番号表示(.hnum)になっていない');
    assert.ok(!/class="hname"/.test(card), '読めない工程名(.hname)が復活している');

    const m = html.match(/\.hnum\{[^}]*font-size:\s*([\d.]+)px/);
    assert.ok(m, '.hnum のフォント指定が見つからない');
    assert.ok(parseFloat(m[1]) >= 14, '工程番号が' + m[1] + 'px（14px未満は現場で読めない）');

    // 所要時間は1行に固定。折り返すと番号・担当の行がずれてガタつく
    const t = html.match(/\.htime\{[^}]*\}/);
    assert.ok(t && /white-space:\s*nowrap/.test(t[0]), '.htime に nowrap が無い（「120分」等で折り返して桁が崩れる）');
    assert.ok(/function\s+fmtMinShort/.test(html), '短い時間表記(fmtMinShort)が無い');

    // 工程マスを押して担当を選ぶ機能を消していないこと
    assert.ok(/openStageAssign/.test(card), '工程マスから担当を選ぶ機能が消えている');
  });

  test('PC画面で「作業中」の列が広く、カードが読める幅を保っている', () => {
    // 2026/8/5計測: 4列を等分していたため、車が集中する「作業中」のカードが1440px画面で
    // 幅207pxまで潰れていた（設計書の目標は360px）。作業中に2倍の幅を与えて343pxまで回復。
    const html = readFile('app.html');
    const m = html.match(/\.pcd-cols\{[^}]*grid-template-columns:\s*([^;]+);/);
    assert.ok(m, '.pcd-cols のグリッド指定が見つからない');
    assert.ok(/2fr/.test(m[1]), '作業中の列に広い幅が割り当てられていない（等分に戻ると207pxまで潰れる）: ' + m[1]);

    const apply = extractFunction(html, 'pcdApplyPanels');
    assert.ok(!/repeat\(/.test(apply),
      '列を等分するrepeat()が復活している（作業中だけ広くする指定が失われる）');
    assert.ok(/k==='work'\s*\?\s*'2fr'/.test(apply), '作業中の列を2倍にする分岐が無い');
  });

  test('カードの初期表示が、スマホは開く・PCはたたむで分かれている', () => {
    // 作業者は自分の車の「次へ」をすぐ押したい／店長は台数を一望したい、と要求が逆のため。
    const html = readFile('app.html');
    const fn = extractFunction(html, 'bd_workDefaultExpanded');
    assert.ok(fn, 'bd_workDefaultExpandedが無い');
    assert.ok(/innerWidth\s*<\s*1100/.test(fn),
      '画面幅で初期表示を分けていない（PCで展開のままだと4台中1.5台しか見えない）');
    assert.ok(/typeof\s+settings\.workStartExpanded\s*===\s*'boolean'/.test(fn),
      '設定で明示的に選んだ場合にそれを優先していない');
  });

  test('招待リンクの参加確認が、素のconfirm()ではなく専用モーダルになっている', () => {
    // index.htmlだけ直してapp.htmlが取り残されていた（2026/8/5に発見）ので両方を見る
    for (const f of ['index.html', 'app.html']) {
      const html = readFile(f);
      assert.ok(html.includes('id="invite-join-modal-overlay"'), f + ' に招待参加モーダルのHTMLが無い');
      const handle = extractFunction(html, 'handleInviteLink');
      assert.ok(handle, f + ' に handleInviteLink が無い');
      assert.ok(!/confirm\(/.test(handle), f + ' の招待確認に素のconfirm()が復活している（誤操作でキャンセルされやすい）');
      assert.ok(/openInviteJoinModal/.test(handle), f + ' の handleInviteLink がモーダルを開いていない');
      assert.ok(extractFunction(html, 'confirmInviteJoin'), f + ' に confirmInviteJoin が無い');
    }
  });

  test('招待リンクが、招待した人と同じ画面に着地する', () => {
    // app.htmlから招待しても '/?invite=' 固定で、相手は現場ボードの無いindex.htmlに飛んでいた（2026/8/5修正）
    for (const f of ['index.html', 'app.html']) {
      const html = readFile(f);
      assert.ok(!/['"]https:\/\/kenjiasano-dev\.github\.io\/koken-app\/\?invite=/.test(html),
        f + ' の招待リンクがURL固定に戻っている（app.htmlから招待した人がindex.htmlに飛ばされる）');
      assert.ok(/location\.origin\s*\+\s*location\.pathname\s*\+\s*'\?invite='/.test(html),
        f + ' の招待リンクが現在の画面基準になっていない');
    }
  });

  test('招待やコード参加で、自分の店舗名が未入力なら実店舗名で自動的に埋まる', () => {
    for (const f of ['index.html', 'app.html']) {
      const html = readFile(f);
      const confirmJoin = extractFunction(html, 'confirmInviteJoin');
      assert.ok(/userData\.store\s*=\s*_pendingInviteResolvedStore/.test(confirmJoin),
        f + ' の招待参加時に店舗名を自動で埋める処理が無い');
    }
    const joinGroupFn = extractFunction(readFile('index.html'), 'joinGroup');
    assert.ok(/resolveGroupName/.test(joinGroupFn),
      'コード手入力での参加時に店舗名を自動で埋める処理が無い');
  });

  test('初回のプロフィール登録は「名前」「店舗名」だけで完結する（都道府県等は詳細設定へ）', () => {
    const html = readFile('index.html');
    const profileStart = html.indexOf('<!-- Profile');
    const advancedStart = html.indexOf('id="advanced-settings-block"');
    assert.ok(profileStart > 0 && advancedStart > profileStart, 'プロフィールカード／詳細設定の位置が想定と違う');
    const profileCard = html.slice(profileStart, advancedStart);
    assert.ok(profileCard.includes('id="set-name"') && profileCard.includes('id="set-store"'),
      '最初のプロフィールカードに名前・店舗名が無い');
    assert.ok(!profileCard.includes('id="set-pref"') && !profileCard.includes('id="set-fiscal-start"'),
      '都道府県・年度開始月などの任意項目が、最初のプロフィールカードに残ったまま（詳細設定に退避できていない）');
    const advancedBlock = html.slice(advancedStart);
    assert.ok(advancedBlock.includes('id="set-pref"') && advancedBlock.includes('id="set-fiscal-start"'),
      '都道府県・年度開始月が詳細設定の中に見つからない');
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
    'setTheme', 'applyTheme', 'renderThemePicker', 'themePreviewHTML', 'themeDef',
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
   3.5) テーマ（暗い3・明るい3のバランス）
   ============================================================ */
function themeSuite() {
  section('【テーマ】暗い3・明るい3が揃っていること');
  for (const f of ['index.html', 'app.html']) {
    const src = extractInlineScripts(readFile(f));
    const sandbox = loadFunctions('<script>' + src + '</script>', ['themeDef'], { consts: ['THEMES', 'LEGACY_THEMES'] });
    const themes = sandbox.THEMES;

    test(f + ': 暗い画面が3つ、明るい画面が3つ', () => {
      const dark = themes.filter(t => t.mode === 'dark');
      const light = themes.filter(t => t.mode === 'light');
      assert.strictEqual(dark.length, 3, '暗いテーマが3つではない（' + dark.length + '個）');
      assert.strictEqual(light.length, 3, '明るいテーマが3つではない（' + light.length + '個）');
    });

    test(f + ': 各テーマに必要な色がすべて揃っている', () => {
      for (const t of themes) {
        for (const key of ['key', 'label', 'mode', 'accent', 'btnText', 'bg', 'card', 'text', 'sub', 'border', 'grad']) {
          assert.ok(t[key], t.key + ' の ' + key + ' が未設定');
        }
      }
    });

    test(f + ': 全テーマのCSSが定義されている', () => {
      const html = readFile(f);
      for (const t of themes) {
        if (t.key === 'samurai') continue;   // samuraiは:rootの既定値なので個別指定不要
        assert.ok(html.includes('[data-theme="' + t.key + '"]'), t.key + ' のCSSが無い');
      }
    });

    test(f + ': 明るいテーマで外側の背景が黒く残らない', () => {
      const html = readFile(f);
      for (const t of themes.filter(x => x.mode === 'light')) {
        const block = html.slice(html.indexOf('[data-theme="' + t.key + '"]'));
        assert.ok(/--outer-bg/.test(block.slice(0, 400)), t.key + ' に --outer-bg が無い（PCで黒帯が出る）');
      }
    });

    test(f + ': 明るいテーマで現場ボードの色（--card2等）も明るく上書きされている', () => {
      const html = readFile(f);
      if (!html.includes('進捗ボード由来')) return;   // ボードを持たないファイル(index.html)は対象外
      for (const t of themes.filter(x => x.mode === 'light')) {
        const block = html.slice(html.indexOf('[data-theme="' + t.key + '"]'));
        assert.ok(/--card2/.test(block.slice(0, 700)),
          t.key + ' はボードの色(--card2等)を上書きしておらず、現場タブだけ暗いまま残る');
      }
    });

    test(f + ': 以前のテーマを選んでいた人の画面が壊れない', () => {
      assert.ok(sandbox.themeDef('crimson').grad, '廃止したcrimsonの配色が失われている');
      assert.ok(sandbox.themeDef('存在しない名前').grad, '未知の値でも既定テーマに落ちるべき');
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
  themeSuite();
  gasSuite();

  console.log('\n' + '─'.repeat(50));
  console.log(failed === 0 ? `すべて成功 (${passed}件)` : `失敗 ${failed}件 / 成功 ${passed}件`);
  if (failed > 0) {
    console.log('\n失敗した内容:');
    failures.forEach(f => console.log('  ・' + f.name + '\n      ' + f.e.message));
  }
  process.exit(failed === 0 ? 0 : 1);
})();
