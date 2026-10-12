// 裏で順番を回す部分。検索 → 一人ずつ読む → AIが判定 → 送る → 履歴に残す。
// 画面の操作は content.js に頼み、ここは順番と記録と AI の呼び出しだけを持つ。

importScripts('logic.js');
const { assemble: assembleWith, requestBody, readJudge } = self.ScoutLogic;
const assemble = (job, code, out) => assembleWith(job, code, out, DEFAULTS.job);

const DEFAULTS = {
  job: {
    company: '株式会社サンプル物流',
    title: '生成AIを使った業務自動化エンジニア',
    detail: '物流センターの受発注・在庫・請求の手作業を、生成AIとPythonで自動化する。現場の担当者に聞き取りながら、小さく作って回す。',
    must: 'Pythonでの開発経験3年以上。業務システムか社内ツールの開発経験。',
    want: '生成AI（LLM）を使った開発経験。現場への聞き取りの経験。',
    place: '東京都江東区。リモートは週3日まで。',
    salary: '600万〜850万円',
    policy: '経歴をほめる決まり文句は書かない。候補者が書いた希望や頼みごとに答えることを先に書く。大げさな言い方（確信・非常に・最適など）と「！」は使わない。',
    // 送る文面のひな形。{書き出し} と {合う所} だけをAIが候補者ごとに書き、ほかはこのまま送る
    subjectTpl: '{求人名}のご案内（{会社名}）',
    bodyTpl: [
      '{宛名} 様', '',
      '{会社名}の採用担当です。',
      '{書き出し}', '',
      '{求人名}の募集についてご連絡しました。',
      '{合う所}', '',
      '【仕事内容】', '{仕事の中身}', '',
      '【勤務地・働き方】', '{勤務地と働き方}', '',
      '【年収】', '{年収}', '',
      'ご興味があれば、このメッセージへの返信でお知らせください。',
      'まずは30分ほどオンラインでお話しできればと思います。', '',
      '{会社名} 採用担当',
    ].join('\n'),
  },
  settings: {
    q: 'Python 生成AI 業務改善',
    dailyCap: 30, dailyReadCap: 150,
    model: 'gemini-3.6-flash',
  },
  run: { status: 'idle', items: [], message: '' },
  history: [],
  sentToday: { date: '', n: 0 },
  readToday: { date: '', n: 0 },
  panelOpen: false,
};

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const add = {};
  for (const k of Object.keys(DEFAULTS)) if (cur[k] === undefined) add[k] = DEFAULTS[k];
  await chrome.storage.local.set(add);
});

// ---- パネルの開け閉め（ツールバーのボタン） ----
async function togglePanel() {
  const { panelOpen } = await chrome.storage.local.get('panelOpen');
  await chrome.storage.local.set({ panelOpen: !panelOpen });
}
chrome.action.onClicked.addListener(() => togglePanel());
self.togglePanel = togglePanel;

// ---- 小さな道具 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toLocaleDateString('sv-SE');
const get = async (k) => (await chrome.storage.local.get(k))[k];
let stopRequested = false;

async function patchRun(fn) {
  const run = await get('run');
  fn(run);
  await chrome.storage.local.set({ run });
  return run;
}
async function patchItem(code, fields) {
  return patchRun((run) => {
    const it = run.items.find((x) => x.code === code);
    if (it) Object.assign(it, fields);
  });
}

// タブを開き直して、画面側の準備ができるまで待つ
async function waitContent(tabId, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { cmd: 'ping' });
      if (r && r.ok) return r;
    } catch (e) { /* 読み込み中 */ }
    await sleep(250);
  }
  throw new Error('画面が開きませんでした');
}
async function go(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await sleep(400);
  return waitContent(tabId);
}
async function ask(tabId, msg) {
  const r = await chrome.tabs.sendMessage(tabId, msg);
  if (!r || !r.ok) throw new Error((r && r.error) || '画面の操作に失敗しました');
  return r;
}

async function judge(job, cand) {
  const apiKey = await get('apiKey');
  if (!apiKey) throw new Error('AIのキーが設定されていません');
  const model = ((await get('settings')) || {}).model || 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  // AI側が混んでいるとき・回数の上限に当たったとき（429・503）は、10秒・20秒・30秒と空けて呼び直す
  // 返事の形が崩れていたとき（文面が空など）は、1回だけ呼び直す
  for (let attempt = 0; ; attempt++) {
    let res;
    for (let i = 0; i < 4; i++) {
      res = await callOnce(url, job, cand);
      if (res.status !== 429 && res.status !== 503) break;
      await sleep(10000 * (i + 1));
    }
    try {
      return await readJudge(res);
    } catch (e) {
      if (attempt >= 1 || e.retry !== true) throw e;
    }
  }
}

function callOnce(url, job, cand) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody(job, cand)),
  });
}

// ---- 待ち ----
// 送る前の確認で、パネルから届く「送る」「見送る」を待つ
const decisions = new Map();
async function waitDecision(code) {
  while (!stopRequested) {
    if (decisions.has(code)) return decisions.get(code);
    await sleep(300);
  }
  return 'stop';
}

// ---- 本体 ----
async function run(tabId) {
  stopRequested = false;
  const job = await get('job');
  const settings = await get('settings');
  const origin = new URL((await chrome.tabs.get(tabId)).url).origin;
  let history = (await get('history')) || [];
  const sentBefore = new Set(history.filter((h) => h.result === '送信').map((h) => h.code));
  let sentToday = await get('sentToday');
  if (!sentToday || sentToday.date !== today()) sentToday = { date: today(), n: 0 };
  let readToday = await get('readToday');
  if (!readToday || readToday.date !== today()) readToday = { date: today(), n: 0 };
  decisions.clear();

  await chrome.storage.local.set({ run: { status: 'running', items: [], message: '候補者を検索しています' } });

  const addHistory = async (rec) => {
    history = [...history, { at: new Date().toISOString(), ...rec }];
    await chrome.storage.local.set({ history });
  };

  try {
    await go(tabId, origin + self.SITE_LIST_PATH);
    await ask(tabId, { cmd: 'search', q: settings.q });
    await sleep(1200);
    await waitContent(tabId);
    const { rows } = await ask(tabId, { cmd: 'rows' });
    await patchRun((r) => {
      r.message = `該当 ${rows.length} 人を順に読みます`;
      r.items = rows.map((x) => ({ code: x.code, title: x.title, href: x.href, stage: 'wait' }));
    });

    for (const row of rows) {
      if (stopRequested) break;
      if (sentBefore.has(row.code) || row.sentMark) {
        await patchItem(row.code, { stage: 'skipped', reason: '前に送信済みのため読みません' });
        continue;
      }
      if (readToday.n >= settings.dailyReadCap) {
        await patchItem(row.code, { stage: 'held', reason: `本日開く上限（${settings.dailyReadCap}人）に達したため開いていません` });
        continue;
      }
      await patchItem(row.code, { stage: 'reading', n: 0, total: 10 });
      await patchRun((r) => { r.message = `${row.code} の職務経歴書を読んでいます`; });
      await go(tabId, row.href);
      readToday = { date: today(), n: readToday.n + 1 };
      await chrome.storage.local.set({ readToday });
      const cand = await ask(tabId, { cmd: 'read', code: row.code });

      await patchItem(row.code, { stage: 'judging' });
      await patchRun((r) => { r.message = `${row.code} に送るかをAIが判定しています`; });
      const out = await judge(job, { code: row.code, header: cand.header, sections: cand.sections });

      if (!out.send) {
        await patchItem(row.code, { stage: 'skipped', reason: out.reason });
        await addHistory({ code: row.code, title: row.title, result: '見送り', reason: out.reason });
        continue;
      }
      if (sentToday.n >= settings.dailyCap) {
        await patchItem(row.code, { stage: 'held', reason: `本日の上限（${settings.dailyCap}通）に達したため送っていません` });
        continue;
      }

      // ひな形に2か所を差し込んで組み立て、送信欄に入力する（送信はまだ押さない）
      const mail = assemble(job, row.code, out);
      await patchItem(row.code, { stage: 'filling', reason: out.reason, subject: mail.subject, body: mail.body, parts: mail.parts });
      await patchRun((r) => { r.message = `${row.code} の送信欄に文面を入れています`; });
      await ask(tabId, { cmd: 'fill', subject: mail.subject, body: mail.body });

      // 送る前の確認: 担当者が「送る」か「見送る」を押すまで待つ。確認なしで送る道は作らない
      await patchItem(row.code, { stage: 'review' });
      await patchRun((r) => { r.message = `${row.code} の文面を確かめて「送る」か「見送る」を押してください`; });
      const act = await waitDecision(row.code);
      if (act === 'stop') break;
      if (act === 'skip') {
        await patchItem(row.code, { stage: 'skipped', reason: '担当者が見送りました' });
        await addHistory({ code: row.code, title: row.title, result: '見送り', reason: '担当者が見送り（AIの判定: ' + out.reason + '）' });
        continue;
      }
      await patchItem(row.code, { stage: 'sending' });
      await patchRun((r) => { r.message = `${row.code} にスカウトを送っています`; });
      const sentMail = await ask(tabId, { cmd: 'submit' });
      sentToday = { date: today(), n: sentToday.n + 1 };
      await chrome.storage.local.set({ sentToday });
      // 担当者がページの送信欄で文面を直した場合も、実際に送った文面を残す
      await patchItem(row.code, { stage: 'sent', subject: sentMail.subject, body: sentMail.body });
      await addHistory({ code: row.code, title: row.title, result: '送信', reason: out.reason, subject: sentMail.subject, body: sentMail.body, parts: mail.parts });
      await sleep(1500);
    }

    await go(tabId, origin + self.SITE_LIST_PATH + '?q=' + encodeURIComponent(settings.q));
    const r = await get('run');
    const sent = r.items.filter((x) => x.stage === 'sent').length;
    const skipped = r.items.filter((x) => x.stage === 'skipped').length;
    await patchRun((x) => {
      x.status = stopRequested ? 'stopped' : 'done';
      x.message = (stopRequested ? '途中で止めました。' : '終わりました。') + `送信 ${sent} 人・見送り ${skipped} 人`;
    });
  } catch (e) {
    // 途中で失敗したら、その先は送らずに止める
    await patchRun((r) => {
      r.status = 'error';
      r.message = e.message + '。送らずに止めました';
      for (const it of r.items) if (['reading', 'judging', 'filling', 'review', 'sending'].includes(it.stage)) it.stage = 'error';
    });
  }
}

self.SITE_LIST_PATH = '/index.html';

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'progress') {
    patchItem(msg.code, { n: msg.n, total: msg.total });
  } else if (msg.type === 'start') {
    get('run').then((r) => {
      if (r && r.status === 'running') return reply({ ok: false });
      run(msg.tabId || (sender.tab && sender.tab.id));
      reply({ ok: true });
    });
    return true;
  } else if (msg.type === 'decide') {
    decisions.set(msg.code, msg.act);
    reply({ ok: true });
  } else if (msg.type === 'stop') {
    stopRequested = true;
    reply({ ok: true });
  } else if (msg.type === 'reset') {
    chrome.storage.local.set({ run: DEFAULTS.run }).then(() => reply({ ok: true }));
    return true;
  }
  return false;
});
