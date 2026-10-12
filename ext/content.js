// 対象サイトの画面の中で動く部分。裏（background.js）から言われたとおりに、
// 画面を読む・入力する・ボタンを押す。どこに何があるかは site.js の SITE を見る。
(() => {
  if (window.__scoutContent) return;
  window.__scoutContent = true;

  const PANEL_W = 400;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 右側の操作パネル ----
  let frame = null;
  function openPanel() {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.id = '__scout-panel';
    frame.src = chrome.runtime.getURL('panel.html');
    frame.title = 'スカウト送信の補助';
    frame.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'width:' + PANEL_W + 'px', 'height:100vh', 'border:0',
      'z-index:2147483647', 'background:#fff', 'box-shadow:-10px 0 28px rgba(0,0,0,.18)', 'color-scheme:light',
    ].join(';');
    document.documentElement.appendChild(frame);
    document.documentElement.style.marginRight = PANEL_W + 'px';
  }
  function closePanel() {
    if (frame) frame.remove();
    frame = null;
    document.documentElement.style.marginRight = '';
  }
  chrome.storage.local.get('panelOpen').then((v) => { if (v.panelOpen) openPanel(); });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.panelOpen) ch.panelOpen.newValue ? openPanel() : closePanel();
  });

  // ---- 読んでいる所の印 ----
  const MARK = '__scout-mark';
  const style = document.createElement('style');
  style.textContent = `.${MARK}{outline:3px solid #e8710a !important;outline-offset:2px;transition:outline-color .2s}`;
  document.documentElement.appendChild(style);
  function mark(el) {
    $$('.' + MARK).forEach((x) => x.classList.remove(MARK));
    if (el) el.classList.add(MARK);
  }

  async function click(el) {
    if (!el) throw new Error('押す場所が見つかりません');
    el.scrollIntoView({ block: 'nearest' });
    el.click();
  }

  // 入力欄に文字列をまとめて入れる
  async function type(el, text) {
    el.focus();
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function waitFor(sel, ms = 8000) {
    return new Promise((ok, ng) => {
      const t0 = Date.now();
      const tick = () => {
        const el = $(sel);
        if (el && !el.hidden && el.offsetParent !== null) return ok(el);
        if (Date.now() - t0 > ms) return ng(new Error('画面の反応がありません: ' + sel));
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  const S = self.SITE;

  const handlers = {
    ping: async () => ({ ok: true, path: location.pathname }),

    // 検索の言葉を入れて検索を押す（押すとページが移る）
    search: async ({ q }) => {
      const input = $(S.searchInput);
      mark(input);
      await type(input, q);
      mark($(S.searchButton));
      // 押すとページが移るので、返事を返してから押す
      setTimeout(() => $(S.searchButton).click(), 0);
      return { ok: true };
    },

    // 検索結果の一覧を読む
    rows: async () => {
      const rows = $$(S.resultRows).map((tr) => ({
        code: S.rowCode(tr),
        href: tr.querySelector(S.rowLink).href,
        sentMark: !!tr.querySelector(S.rowSentMark),
        title: tr.children[2] ? tr.children[2].textContent.trim() : '',
      }));
      return { ok: true, rows };
    },

    // 職務経歴書の項目を1つずつ開いて読む
    read: async ({ code }) => {
      const header = ($(S.header) || {}).textContent || '';
      const sections = {};
      const buttons = $$(S.sectionButtons);
      for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i];
        mark(b);
        b.click();
        await sleep(60);
        const name = $(S.sectionTitle).textContent.trim();
        const text = $(S.sectionText).textContent.trim();
        sections[name] = text === S.emptyText ? '' : text;
        chrome.runtime.sendMessage({ type: 'progress', code, n: i + 1, total: buttons.length });
      }
      mark(null);
      return { ok: true, header, sections };
    },

    // スカウトの送信欄を開いて件名と本文を入れる（送信はまだ押さない）
    fill: async ({ subject, body }) => {
      const open = $(S.openForm);
      if (!open || open.disabled) return { ok: false, error: 'この候補者には送信済みです' };
      mark(open);
      await click(open);
      const subj = await waitFor(S.subject);
      mark(subj);
      await type(subj, subject);
      const area = $(S.body);
      mark(area);
      await type(area, body);
      mark($(S.sendButton));
      $(S.sendButton).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return { ok: true };
    },

    // 送信を押す。担当者が送信欄で直していれば、直した文面が送られる
    submit: async () => {
      const subject = $(S.subject).value.trim();
      const body = $(S.body).value.trim();
      if (!subject || !body) return { ok: false, error: '件名か本文が空です' };
      mark($(S.sendButton));
      await click($(S.sendButton));
      await waitFor(S.sentMessage);
      mark(null);
      $(S.sentMessage).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return { ok: true, subject, body };
    },
  };

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    const h = msg && handlers[msg.cmd];
    if (!h) return false;
    h(msg).then(reply, (e) => reply({ ok: false, error: e.message }));
    return true;
  });
})();
