// 拡張機能を入れた Chromium で、練習用の候補者画面（site/）を通しで動かす。
// 検索 → 職務経歴書を読む → AI が判定 → 送信欄に入力 → 確認 → 送信 まで。
// AI（Gemini）は呼ばない。service worker の fetch を、決めた返事を返す偽物に差し替える。
//   SHOT=docs/screen.png を付けて動かすと、確認待ちの画面を保存する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const serve = require('../serve');

const EXT = path.join(__dirname, '..', 'ext');
const PORT = serve.PORT; // manifest.json の対象アドレスと同じ番号にする
const ORIGIN = 'http://localhost:' + PORT;
const TIMEOUT = 180000;

let srv;
test.before(async () => { srv = await serve.start(PORT); });
test.after(() => srv && srv.close());

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-e2e-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, locale: 'ja-JP', viewport: { width: 1220, height: 686 },
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--lang=ja'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  // 拡張機能の初期値が入るまで待つ
  await sw.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      if ((await chrome.storage.local.get('settings')).settings) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('初期値が入りませんでした');
  });
  const close = async () => { await ctx.close(); fs.rmSync(profile, { recursive: true, force: true }); };
  return { ctx, sw, close };
}

// 偽の AI。候補者の番号ごとに返事を決める。replies[code] が無い人には send:true を返す。
// replies[code] が文字列なら、そのまま返事の本文にする（壊れた返事を試すため）。
async function installFakeAi(sw, replies) {
  await sw.evaluate((replies) => {
    self.__aiCalls = [];
    self.fetch = async (url, init) => {
      const prompt = JSON.parse(init.body).contents[0].parts[0].text;
      const code = (prompt.match(/# 候補者 (C-\d+)/) || [])[1];
      self.__aiCalls.push({ url: String(url), code });
      const r = replies[code];
      const text = typeof r === 'string' ? r : JSON.stringify(r || {
        send: true,
        reason: '生成AIの経験がある',
        opening: '職務経歴書の職務要約を読んでご連絡しました。',
        fit: code + ' さんの業務を自動化した経験が、この仕事に合います。',
      });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
  }, replies);
}

async function setup(sw, page, { replies, siteSent = {} }) {
  await page.goto(ORIGIN + '/index.html');
  await page.evaluate((s) => localStorage.setItem('scoutSent', JSON.stringify(s)), siteSent);
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      apiKey: 'test-key-not-real',
      settings: { ...settings, q: '生成AI' },
      panelOpen: true,
    });
  });
  await installFakeAi(sw, replies);
  await page.reload();
  await page.waitForSelector('iframe#__scout-panel');
  return page.frameLocator('iframe#__scout-panel');
}

// 実行が終わるまで見張る。確認待ちになったら decide(code) の答え（send / skip）を押す
async function runToEnd(sw, page, frame, decide = () => 'send') {
  await frame.locator('#start').click();
  const t0 = Date.now();
  const decided = new Set();
  let shot = false;
  for (;;) {
    await page.waitForTimeout(400);
    const run = await sw.evaluate(async () => (await chrome.storage.local.get('run')).run);
    if (run.status !== 'running' && run.status !== 'idle') return run;
    const rv = run.items.find((x) => x.stage === 'review' && !decided.has(x.code));
    if (rv) {
      const btn = frame.locator(`button[data-act="${decide(rv.code)}"][data-code="${rv.code}"]`);
      await btn.waitFor();
      if (process.env.SHOT && !shot) {
        shot = true;
        await page.waitForTimeout(600);
        await page.screenshot({ path: process.env.SHOT });
      }
      decided.add(rv.code);
      await btn.click();
    }
    if (Date.now() - t0 > TIMEOUT - 20000) throw new Error('時間内に終わりませんでした: ' + JSON.stringify(run));
  }
}

test('判定どおりに送る・見送る。担当者の見送りと送信済みの人には送らない', { timeout: TIMEOUT }, async () => {
  const { ctx, sw, close } = await launch();
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    const frame = await setup(sw, page, {
      // C-1840 は前に送信済み。C-5012・C-2653 は AI が見送る。C-4410 は担当者が見送る
      siteSent: { 'C-1840': { at: '2026-01-01T00:00:00Z', subject: '前回', body: '前回' } },
      replies: {
        'C-5012': { send: false, reason: '転職を考えていないと書いている', opening: '', fit: '' },
        'C-2653': { send: false, reason: '希望の勤務地が合わない', opening: '', fit: '' },
      },
    });
    const run = await runToEnd(sw, page, frame, (code) => (code === 'C-4410' ? 'skip' : 'send'));

    assert.equal(run.status, 'done', run.message);
    const stage = Object.fromEntries(run.items.map((x) => [x.code, x.stage]));
    assert.deepEqual(stage, {
      'C-2288': 'sent', 'C-4410': 'skipped', 'C-2653': 'skipped',
      'C-5012': 'skipped', 'C-1840': 'skipped', 'C-2731': 'sent',
    });
    const reason = Object.fromEntries(run.items.map((x) => [x.code, x.reason]));
    assert.equal(reason['C-5012'], '転職を考えていないと書いている');
    assert.equal(reason['C-4410'], '担当者が見送りました');
    assert.equal(reason['C-1840'], '前に送信済みのため読みません');

    // 送信済みの人の職務経歴書は開かず、AI にも渡さない
    const calls = await sw.evaluate(() => self.__aiCalls);
    assert.deepEqual(calls.map((c) => c.code).sort(), ['C-2288', 'C-2653', 'C-2731', 'C-4410', 'C-5012']);
    assert.ok(calls.every((c) => c.url.startsWith('https://generativelanguage.googleapis.com/')));

    // サイト側に送信が残っているのは、送ると決めた2人と前からの1人だけ
    await page.goto(ORIGIN + '/index.html');
    const siteSent = await page.evaluate(() => JSON.parse(localStorage.getItem('scoutSent') || '{}'));
    assert.deepEqual(Object.keys(siteSent).sort(), ['C-1840', 'C-2288', 'C-2731']);

    // 送った文面は、ひな形の文と AI が書いた2か所の両方を含む
    const body = siteSent['C-2288'].body;
    assert.ok(body.startsWith('C-2288 様'));
    assert.ok(body.includes('【仕事内容】'));
    assert.ok(body.includes('職務経歴書の職務要約を読んでご連絡しました。'));
    assert.ok(body.includes('C-2288 さんの業務を自動化した経験が、この仕事に合います。'));

    // 履歴にも同じ文面と結果が残る
    const hist = await sw.evaluate(async () => (await chrome.storage.local.get('history')).history);
    const sent = hist.filter((h) => h.result === '送信').map((h) => h.code).sort();
    assert.deepEqual(sent, ['C-2288', 'C-2731']);
    assert.equal(hist.find((h) => h.code === 'C-2288').body, body);
  } finally {
    await close();
  }
});

test('AI の返事が2回続けて読めなければ、送らずに止める', { timeout: TIMEOUT }, async () => {
  const { ctx, sw, close } = await launch();
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    const frame = await setup(sw, page, { replies: { 'C-2288': 'これはJSONではない' } });
    const run = await runToEnd(sw, page, frame);

    assert.equal(run.status, 'error');
    assert.match(run.message, /AIの返事を読めませんでした。送らずに止めました/);
    assert.equal(run.items.find((x) => x.code === 'C-2288').stage, 'error');
    assert.ok(run.items.filter((x) => x.code !== 'C-2288').every((x) => x.stage === 'wait'));
    // 呼び直しは1回だけ
    const calls = await sw.evaluate(() => self.__aiCalls);
    assert.deepEqual(calls.map((c) => c.code), ['C-2288', 'C-2288']);

    await page.goto(ORIGIN + '/index.html');
    const siteSent = await page.evaluate(() => JSON.parse(localStorage.getItem('scoutSent') || '{}'));
    assert.deepEqual(siteSent, {});
  } finally {
    await close();
  }
});
