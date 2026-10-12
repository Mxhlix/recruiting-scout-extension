// 右側の操作パネル。表示は chrome.storage の中身をそのまま映す。
// 開始・停止は裏（background.js）に頼むだけで、順番はここで持たない。
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STAGE = {
  wait: ['待ち', 'st-wait'],
  reading: ['読み取り中', 'st-busy'],
  judging: ['AIが判定中', 'st-busy'],
  filling: ['文面を入力中', 'st-busy'],
  review: ['確認待ち', 'st-review'],
  sending: ['送信中', 'st-busy'],
  sent: ['送信', 'st-sent'],
  skipped: ['見送り', 'st-skip'],
  held: ['保留', 'st-skip'],
  error: ['止めた', 'st-err'],
};

let data = {};

// ---- タブ ----
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'v-' + b.dataset.tab; });
}));
$('#close').addEventListener('click', () => chrome.storage.local.set({ panelOpen: false }));

// ---- 実行 ----
$('#start').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'start' }));
$('#stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stop' }));
$('#items').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  b.parentElement.querySelectorAll('button').forEach((x) => { x.disabled = true; });
  chrome.runtime.sendMessage({ type: 'decide', code: b.dataset.code, act: b.dataset.act });
});

// 本文のうちAIが書いた部分に色をつける（ほかはひな形の文）
function markParts(body, parts) {
  let html = esc(body);
  for (const p of parts || []) {
    if (p) html = html.split(esc(p)).join(`<mark class="ai">${esc(p)}</mark>`);
  }
  return html;
}

function renderRun() {
  const { settings = {}, run = {}, sentToday = {}, readToday = {} } = data;
  const todayStr = new Date().toLocaleDateString('sv-SE');
  $('#s-q').textContent = settings.q || '';
  $('#s-today').textContent = `送信 ${sentToday.date === todayStr ? sentToday.n : 0} / ${settings.dailyCap} 通 ／ 開いた ${readToday.date === todayStr ? readToday.n : 0} / ${settings.dailyReadCap} 人`;

  const running = run.status === 'running';
  $('#start').disabled = running;
  $('#stop').disabled = !running;
  $('#start').textContent = run.status && run.status !== 'idle' && !running ? 'もう一度開始' : '開始';

  const msg = $('#msg');
  msg.hidden = !run.message;
  msg.className = 'msg' + (run.status === 'error' ? ' err' : run.status === 'done' ? ' ok' : '');
  msg.textContent = run.message;

  const ol = $('#items');
  ol.innerHTML = (run.items || []).map((it) => {
    const [label, cls] = STAGE[it.stage] || STAGE.wait;
    const prog = it.stage === 'reading' && it.total ? `（${it.n || 0}/${it.total}項目）` : '';
    let detail = '';
    if (it.reason && it.stage !== 'wait') detail += `<div class="why">${esc(it.reason)}</div>`;
    if (it.body && ['filling', 'review', 'sending', 'sent'].includes(it.stage)) {
      detail += `<div class="mail"><div class="subj">${esc(it.subject)}</div><div class="txt">${markParts(it.body, it.parts)}</div></div>`;
    }
    if (it.stage === 'review') {
      detail += `<div class="note-r">色のついた2か所がAIの書いた部分です。ほかはひな形のままです。<br>ページの送信欄で文面を直してから送ることもできます。</div>
        <div class="decide"><button class="primary" data-act="send" data-code="${esc(it.code)}">送る</button>
        <button class="line" data-act="skip" data-code="${esc(it.code)}">見送る</button></div>`;
    }
    return `<li class="item ${cls}" data-code="${esc(it.code)}">
      <div class="line1"><span class="code">${esc(it.code)}</span><span class="badge">${label}${prog}</span></div>
      <div class="ttl">${esc(it.title)}</div>${detail}</li>`;
  }).join('');
  const active = ol.querySelector('.st-review') || ol.querySelector('.st-busy') || [...ol.querySelectorAll('.item')].pop();
  if (running && active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---- 求人と条件 ----
const form = $('#jobform');
function fillForm() {
  for (const el of form.elements) {
    if (!el.name || document.activeElement === el) continue;
    const [a, b] = el.name.split('.');
    const v = b ? (data[a] || {})[b] : data[a];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v == null ? '' : v;
  }
}
let savedTimer = 0;
form.addEventListener('change', async (e) => {
  const el = e.target;
  const [a, b] = el.name.split('.');
  let v = el.type === 'number' ? Number(el.value) : el.type === 'checkbox' ? el.checked : el.value;
  if (b) {
    const obj = Object.assign({}, data[a], { [b]: v });
    await chrome.storage.local.set({ [a]: obj });
  } else {
    await chrome.storage.local.set({ [a]: v });
  }
  $('#saved').hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('#saved').hidden = true; }, 1500);
});

// ---- 履歴 ----
const fmt = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
function renderHist() {
  const h = (data.history || []).slice().reverse();
  $('#h-count').textContent = `${h.length} 件`;
  $('#h-rows').innerHTML = h.map((r) => `<tr class="${r.result === '送信' ? 'r-sent' : 'r-skip'}">
    <td>${fmt(r.at)}</td><td>${esc(r.code)}</td><td>${esc(r.result)}</td><td>${esc(r.reason)}</td></tr>`).join('');
}
$('#csv').addEventListener('click', () => {
  const cols = ['日時', '候補者', '現職', '結果', '理由', '件名', '本文'];
  const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const lines = [cols.map(q).join(',')].concat((data.history || []).map((r) =>
    [new Date(r.at).toLocaleString('ja-JP'), r.code, r.title, r.result, r.reason, r.subject, r.body].map(q).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `スカウト履歴_${new Date().toLocaleDateString('sv-SE')}.csv`;
  a.click();
});

// ---- 読み込みと更新 ----
async function load() {
  data = await chrome.storage.local.get(null);
  renderRun(); fillForm(); renderHist();
}
chrome.storage.onChanged.addListener(load);
load();
