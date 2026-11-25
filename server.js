// 로또 예측 웹사이트 서버 (외부 패키지 없음, Node 18+)
// - public/ 정적 파일 제공
// - /api/draws : 과거 당첨번호 (data/all.json 캐시, 새 회차가 나왔을 것으로 예상되면 자동 갱신)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data', 'all.json');
const SOURCE_URL = 'https://smok95.github.io/lotto/results/all.json';
const FIRST_DRAW = Date.UTC(2002, 11, 7, 11, 45); // 1회 추첨: 2002-12-07 20:45 KST
const WEEK = 7 * 24 * 3600 * 1000;
const RETRY_MS = 10 * 60 * 1000;

let draws = [];
let lastAttempt = 0;
let lastError = null;

function loadCache() {
  try {
    draws = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`캐시 로드: ${draws.length}회차`);
  } catch {
    draws = [];
  }
}

// 현재 시각 기준으로 발표되었어야 할 최신 회차 (추첨 후 1시간 여유)
function expectedLatest(now = Date.now()) {
  return Math.floor((now - FIRST_DRAW - 3600 * 1000) / WEEK) + 1;
}

async function refresh(force = false) {
  const latest = draws.length ? draws[draws.length - 1].draw_no : 0;
  if (!force && latest >= expectedLatest()) return;
  if (!force && Date.now() - lastAttempt < RETRY_MS) return;
  lastAttempt = Date.now();
  try {
    const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length || !Array.isArray(data[0].numbers)) throw new Error('데이터 형식 오류');
    data.sort((a, b) => a.draw_no - b.draw_no);
    if (data.length >= draws.length) {
      draws = data;
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(data));
      console.log(`데이터 갱신: ${data.length}회차 (최신 ${data[data.length - 1].draw_no}회)`);
    }
    lastError = null;
  } catch (e) {
    lastError = String(e.message || e);
    console.warn('데이터 갱신 실패:', lastError);
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/draws') {
    await refresh(url.searchParams.get('refresh') === '1');
    const slim = draws.map((d) => ({ draw_no: d.draw_no, numbers: d.numbers, bonus_no: d.bonus_no, date: d.date, prize1: d.divisions?.[0]?.prize, winners1: d.divisions?.[0]?.winners }));
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ draws: slim, expectedLatest: expectedLatest(), error: lastError }));
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

loadCache();
refresh();
setInterval(refresh, 60 * 60 * 1000); // 1시간마다 새 회차 확인
server.listen(PORT, () => console.log(`로또 예측 사이트: http://localhost:${PORT}`));
