// 練習用の候補者画面（site/）を http://localhost:8974 で配信する。
//   node serve.js            … 単体で起動（プレビュー用）
//   require('./serve').start() … 録画・試験スクリプトから起動
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8974;
const ROOT = path.join(__dirname, 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function start(port = PORT) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const f = path.join(ROOT, path.normalize(p));
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((ok) => srv.listen(port, () => ok(srv)));
}

module.exports = { start, PORT };
if (require.main === module) start().then(() => console.log('http://localhost:' + PORT));
