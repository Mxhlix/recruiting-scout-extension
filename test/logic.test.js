// ext/logic.js の単体テスト。AI は呼ばず、Gemini の返事の形をまねた値を渡す。
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../ext/logic.js');

const JOB = {
  company: '株式会社テスト',
  title: '業務自動化エンジニア',
  detail: '受発注の手作業を自動化する。現場に聞き取りながら作る。',
  must: 'Python 3年以上',
  want: '生成AIの開発経験',
  place: '東京都。リモートは週3日まで。',
  salary: '600万〜850万円',
  policy: '決まり文句は書かない。',
  subjectTpl: '{求人名}のご案内（{会社名}）',
  bodyTpl: '{宛名} 様\n{書き出し}\n{合う所}\n【仕事内容】\n{仕事の中身}\n【勤務地・働き方】\n{勤務地と働き方}\n【年収】\n{年収}\n{未定義}',
};

// Gemini の generateContent の返事の形
const gemini = (text, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
});
const good = { send: true, reason: '自動化の経験がある', opening: '業務の内容を書いてほしいとのことでしたので、具体的にお送りします。', fit: '受発注システムの自動化の経験が、この仕事にそのまま合います。' };

test('perSentence: 句点ごとに改行し、閉じかっこの前では切らない', () => {
  assert.equal(L.perSentence('一文目。二文目。'), '一文目。\n二文目。');
  assert.equal(L.perSentence('「はい。」と言った。次。'), '「はい。」と言った。\n次。');
  assert.equal(L.perSentence('改行が\n混ざる。文'), '改行が混ざる。\n文');
  assert.equal(L.perSentence(undefined), '');
});

test('slotProblem: 正しい2か所なら空文字', () => {
  assert.equal(L.slotProblem(good), '');
});

test('slotProblem: 空・長すぎ・ひな形の語を見つけて名前を返す', () => {
  assert.equal(L.slotProblem({ ...good, opening: '  ' }), 'opening が空');
  assert.equal(L.slotProblem({ ...good, fit: 'あ'.repeat(L.SLOT_LIMIT.fit + 1) }), 'fit が長すぎる');
  assert.equal(L.slotProblem({ ...good, fit: 'あ'.repeat(L.SLOT_LIMIT.fit) }), '');
  for (const ng of ['【', '】', '！', '!', '年収', '万円', '勤務地', '採用担当']) {
    assert.equal(L.slotProblem({ ...good, opening: 'ご連絡します' + ng + 'です。' }), 'opening にひな形の部分「' + ng + '」がある');
  }
  assert.match(L.slotProblem({ ...good, fit: 'C-3107 様' }), /fit にひな形の部分「様」がある/);
});

test('assemble: ひな形を埋め、知らない差し込みはそのまま残す', () => {
  const m = L.assemble(JOB, 'C-3107', good);
  assert.equal(m.subject, '業務自動化エンジニアのご案内（株式会社テスト）');
  assert.ok(m.body.startsWith('C-3107 様\n'));
  assert.ok(m.body.includes('受発注の手作業を自動化する。\n現場に聞き取りながら作る。'));
  assert.ok(m.body.includes('東京都。\nリモートは週3日まで。'));
  assert.ok(m.body.includes('600万〜850万円'));
  assert.ok(m.body.includes('{未定義}'));
  assert.deepEqual(m.parts, [L.perSentence(good.opening), L.perSentence(good.fit)]);
  for (const p of m.parts) assert.ok(m.body.includes(p));
});

test('assemble: 求人のひな形が空なら fallback のひな形を使う', () => {
  const m = L.assemble({ ...JOB, subjectTpl: '', bodyTpl: '' }, 'C-1', good, { subjectTpl: '件名 {会社名}', bodyTpl: '{宛名}' });
  assert.equal(m.subject, '件名 株式会社テスト');
  assert.equal(m.body, 'C-1');
});

test('buildPrompt: 求人と候補者の全項目を入れ、空の項目は（入力なし）にする', () => {
  const p = L.buildPrompt(JOB, { code: 'C-9', header: '30歳', sections: { '希望条件': '東京', '特記事項': '' } });
  assert.ok(p.includes('# 候補者 C-9（30歳）'));
  assert.ok(p.includes('【希望条件】\n東京'));
  assert.ok(p.includes('【特記事項】\n（入力なし）'));
  for (const v of [JOB.company, JOB.title, JOB.must, JOB.want, JOB.policy]) assert.ok(p.includes(v));
});

test('requestBody: JSON の4項目を必須にして頼む', () => {
  const b = L.requestBody(JOB, { code: 'C-9', header: '', sections: {} });
  assert.equal(b.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(b.generationConfig.responseSchema.required, ['send', 'reason', 'opening', 'fit']);
  assert.ok(b.contents[0].parts[0].text.includes('C-9'));
});

test('readJudge: 正しい返事をそのまま返す', async () => {
  assert.deepEqual(await L.readJudge(gemini(JSON.stringify(good))), good);
});

test('readJudge: 送らない判定なら2か所が空でも通す', async () => {
  const out = { send: false, reason: '転職を考えていない', opening: '', fit: '' };
  assert.deepEqual(await L.readJudge(gemini(JSON.stringify(out))), out);
});

test('readJudge: AI側のエラーは呼び直しの印を付けずに止める', async () => {
  const e = await L.readJudge(gemini('', 500)).catch((x) => x);
  assert.match(e.message, /（500）/);
  assert.notEqual(e.retry, true);
});

test('readJudge: 読めない返事・決まり違反は呼び直しの印を付ける', async () => {
  for (const res of [
    gemini('これはJSONではない'),
    { ok: true, status: 200, json: async () => ({ candidates: [] }) },
    gemini(JSON.stringify({ ...good, opening: '' })),
    gemini(JSON.stringify({ ...good, fit: '年収は800万円です。' })),
  ]) {
    const e = await L.readJudge(res).catch((x) => x);
    assert.ok(e instanceof Error);
    assert.equal(e.retry, true, e.message);
  }
});

test('readJudge: JSON として読めても判定の形でなければ呼び直しの印を付ける', async () => {
  for (const text of ['null', '[]', '"send"', JSON.stringify({ send: 'true', reason: '', opening: '', fit: '' })]) {
    const e = await L.readJudge(gemini(text)).catch((x) => x);
    assert.ok(e instanceof Error, text);
    assert.equal(e.retry, true, text);
  }
});
