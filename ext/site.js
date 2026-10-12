// 対象サイトの画面の「どこに何があるか」。サイトごとに違うのはこのファイルだけにする。
// いまは練習用の候補者画面（http://localhost:8974）に合わせてある。
// 本番のサイトに合わせるときは、ここの指定と manifest.json の対象のアドレスを書き換える。
self.SITE = {
  name: '練習用の候補者画面',
  listPath: '/index.html',

  // 候補者検索
  searchInput: '#q',
  searchButton: '#go',
  resultRows: '#rows tr.row',
  rowCode: (tr) => tr.dataset.code,
  rowLink: 'td.code a',
  rowSentMark: '.sent',

  // 職務経歴書
  header: '#meta',
  sectionButtons: '#menu button',
  sectionTitle: '#pane h2',
  sectionText: '#pane .text',
  emptyText: '入力されていません',

  // スカウトの送信
  openForm: '#open',
  subject: '#subject',
  body: '#message',
  sendButton: '#send',
  sentMessage: '#done',
};
