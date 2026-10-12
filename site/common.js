// 送信済みの記録（本物のサイトではサーバーに残る。練習用の画面ではブラウザに残す）
window.Sent = {
  all() {
    try { return JSON.parse(localStorage.getItem('scoutSent') || '{}'); } catch (e) { return {}; }
  },
  has(code) { return !!this.all()[code]; },
  add(code, rec) {
    const a = this.all();
    a[code] = rec;
    localStorage.setItem('scoutSent', JSON.stringify(a));
  },
};

window.findCandidate = (code) => window.CANDIDATES.find((c) => c.code === code);

// 検索: 言葉をスペースで区切り、どれか1つでも職務経歴書に含まれる人を出す
window.searchCandidates = (q) => {
  const words = String(q || '').split(/[\s　]+/).filter(Boolean);
  if (!words.length) return window.CANDIDATES.slice();
  return window.CANDIDATES.filter((c) => {
    const all = [c.title, c.job, ...Object.values(c.s)].join('\n');
    return words.some((w) => all.includes(w));
  });
};
