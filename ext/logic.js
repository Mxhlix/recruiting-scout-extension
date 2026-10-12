// AI の判定と文面の組み立てのうち、画面にもブラウザにも触らない部分。
// 拡張機能では background.js が importScripts で読み、テストでは Node から require する。
(function (root) {
// ---- AI の判定 ----
function buildPrompt(job, cand) {
  const sec = Object.entries(cand.sections)
    .map(([k, v]) => `【${k}】\n${v || '（入力なし）'}`).join('\n\n');
  return `あなたは採用担当者の代わりに、スカウトを送る相手を選び、文面を書く係です。

# 求人
会社名: ${job.company}
求人名: ${job.title}
仕事の中身: ${job.detail}
必須の条件: ${job.must}
歓迎する経験: ${job.want}
勤務地と働き方: ${job.place}
年収: ${job.salary}

# 候補者 ${cand.code}（${cand.header}）
${sec}

# 送るかどうかの決め方
- 候補者が書いた希望（職種・勤務地・働き方・年収）と求人が合わなければ送らない。
- 候補者が「スカウトは控えて」「転職を考えていない」などと書いていれば送らない。
- 必須の条件を満たしていなければ送らない。
- 迷うときは送らない。
- reason には、決めた理由を候補者の書いた言葉を使って40字以内で書く。

# 送る場合に書くもの
文面は会社が決めたひな形で組み立てる。宛名・名乗り・求人の紹介・仕事内容・勤務地・年収・締め・署名はひな形にあるので書かない。
書くのは次の2か所だけ。
- opening: 名乗りのすぐ後に入る書き出し。候補者が書いた希望や頼みごとに答える。希望や頼みごとが書かれていなければ、職務経歴書のどこを読んで連絡したかを書く。お礼や「数ある求人の中から」のような決まり文句は書かない。2文以内・100字以内。
- fit: 候補者の経験のどこが、この求人の仕事に合うか。職務経歴書に書かれた事実だけを使う。2文以内・120字以内。

# 2か所の決まり
- ${job.policy}
- 候補者が文面について頼みごとを書いていれば、必ずそのとおりにする。
- 求人に書かれていないこと（会社の実績・数字・待遇）を作らない。候補者の経歴に無いことを書かない。
- 年収・勤務地・働き方には触れない（ひな形に書いてある）。候補者の希望に「対応できます」「合います」と約束しない。
- 宛名・挨拶・署名・【】の見出し・改行を入れない。
- 送らない場合は opening と fit を空の文字にする。`;
}

// ---- 文面の組み立て ----
// 句点ごとに改行する。改行の位置をAIに任せず、ここで決める
const perSentence = (s) => String(s || '').replace(/\s*\n\s*/g, '').replace(/。(?![」』）)]|$)/g, '。\n').trim();

// AIが書いた2か所に、ひな形にある部分が紛れていないかを確かめる
const SLOT_LIMIT = { opening: 130, fit: 150 };
const SLOT_NG = /【|】|！|!|年収|万円|勤務地|採用担当|様[。\s]*$/;
function slotProblem(out) {
  for (const k of ['opening', 'fit']) {
    const v = String(out[k] || '');
    if (!v.trim()) return k + ' が空';
    if (v.length > SLOT_LIMIT[k]) return k + ' が長すぎる';
    const m = v.match(SLOT_NG);
    if (m) return k + ' にひな形の部分「' + m[0] + '」がある';
  }
  return '';
}

// fallback は、求人の設定でひな形が空のときに使うひな形（既定の求人）
function assemble(job, code, out, fallback = {}) {
  const tplOf = (k) => job[k] || fallback[k];
  const opening = perSentence(out.opening);
  const fit = perSentence(out.fit);
  const vals = {
    '宛名': code, '会社名': job.company, '求人名': job.title,
    '仕事の中身': perSentence(job.detail), '勤務地と働き方': perSentence(job.place), '年収': job.salary,
    '書き出し': opening, '合う所': fit,
  };
  const fillIn = (tpl) => tpl.replace(/\{([^{}]+)\}/g, (all, k) => (k in vals ? vals[k] : all));
  return { subject: fillIn(tplOf('subjectTpl')), body: fillIn(tplOf('bodyTpl')), parts: [opening, fit] };
}

// Gemini に送る中身。返事の形（JSON の4項目）をここで指定する
function requestBody(job, cand) {
  return {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(job, cand) }] }],
    generationConfig: {
      temperature: 0,
      thinkingConfig: { thinkingLevel: 'low' },
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          send: { type: 'BOOLEAN' },
          reason: { type: 'STRING' },
          opening: { type: 'STRING' },
          fit: { type: 'STRING' },
        },
        required: ['send', 'reason', 'opening', 'fit'],
      },
    },
  };
}

async function readJudge(res) {
  if (!res.ok) throw new Error('AIの判定に失敗しました（' + res.status + '）');
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  let out;
  const bad = (m) => Object.assign(new Error(m), { retry: true });
  try { out = JSON.parse(text); } catch (e) { throw bad('AIの返事を読めませんでした'); }
  if (!out || typeof out !== 'object' || typeof out.send !== 'boolean') throw bad('AIの返事が判定の形になっていませんでした');
  if (out.send) {
    const p = slotProblem(out);
    if (p) throw bad('AIの書いた部分がひな形の決まりに合いませんでした（' + p + '）');
  }
  return out;
}

const api = { buildPrompt, perSentence, SLOT_LIMIT, SLOT_NG, slotProblem, assemble, requestBody, readJudge };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
root.ScoutLogic = api;
})(typeof self !== 'undefined' ? self : globalThis);
