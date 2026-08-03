/* テスト用の共通道具
   HTMLに埋め込まれたJavaScriptから、テストしたい関数だけを取り出して
   ブラウザの代わりになる最小限の環境で動かすための仕組み。
   （このアプリはビルド無しの単一HTMLなので、普通のテスト手法が使えないための工夫）
   外部ライブラリは一切使わない＝インストール不要でそのまま動く。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');

function readFile(name) {
  return fs.readFileSync(path.join(REPO, name), 'utf8');
}

/* HTMLから<script>の中身だけを連結して取り出す（外部読み込みのscriptは除く） */
function extractInlineScripts(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out.join('\n;\n');
}

/* ソースから関数1つ分を、波括弧の対応を数えて正確に切り出す */
function extractFunction(source, name) {
  let i = source.indexOf('function ' + name + '(');
  if (i < 0) return null;
  if (source.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let j = source.indexOf('{', i);
  let depth = 0;
  for (; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return source.slice(i, j);
}

/* `const NAME = ...;` を1行取り出す */
function extractConst(source, name) {
  const m = source.match(new RegExp('const\\s+' + name + '\\s*=\\s*[^;]+;'));
  return m ? m[0] : null;
}

/* localStorage の代わり（テストごとに作り直せる） */
function createFakeStorage() {
  const store = new Map();
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    clear: () => store.clear(),
    _size: () => store.size,
  };
}

/* 指定した関数群を切り出して、隔離した環境で実行できる状態にして返す */
function loadFunctions(html, names, { consts = [], prelude = '', context = {} } = {}) {
  const src = extractInlineScripts(html);
  const parts = [];

  for (const c of consts) {
    const code = extractConst(src, c);
    if (!code) throw new Error('定数が見つかりません: ' + c);
    parts.push(code);
  }
  for (const n of names) {
    const code = extractFunction(src, n);
    if (!code) throw new Error('関数が見つかりません: ' + n);
    parts.push(code);
  }

  const sandbox = Object.assign({
    console,
    JSON,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Promise,
    setTimeout,
    URLSearchParams,
    Error,
  }, context);
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(prelude + '\n' + parts.join('\n'), sandbox, { filename: 'extracted.js' });
  // const/let で宣言した値は sandbox のプロパティにならないため、テストから読めるよう取り出しておく
  // （function 宣言は自動でプロパティになるので対象外）
  for (const c of consts) {
    try { sandbox[c] = vm.runInContext(c, sandbox); } catch (e) { /* 参照できない値は無視 */ }
  }
  return sandbox;
}

module.exports = { REPO, readFile, extractInlineScripts, extractFunction, extractConst, createFakeStorage, loadFunctions };
