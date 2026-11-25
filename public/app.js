(function () {
  'use strict';
  const M = window.LottoModel;
  const $ = (id) => document.getElementById(id);
  const W_LABELS = { longFreq: '장기 빈도', recentFreq: '최근 빈도', overdue: '미출현 간격', carry: '직전 이월' };

  let draws = [];
  let model = null;
  let weights = Object.assign({}, M.DEFAULT_WEIGHTS);
  let reroll = 0;
  let currentSets = [];
  let chartMode = 'score';

  const colorClass = (n) => 'c' + (n <= 10 ? 1 : n <= 20 ? 2 : n <= 30 ? 3 : n <= 40 ? 4 : 5);
  const ballVar = (n) => `var(--b${colorClass(n).slice(1)})`;
  const ball = (n, extra = '') => `<span class="ball ${colorClass(n)} ${extra}">${n}</span>`;

  // 현재 시각 기준 발표되었어야 할 최신 회차 (1회: 2002-12-07 20:45 KST, 추첨 후 1시간 여유)
  const expectedLatest = () => Math.floor((Date.now() - Date.UTC(2002, 11, 7, 11, 45) - 3600e3) / (7 * 864e5)) + 1;
  const LIVE_URL = 'https://smok95.github.io/lotto/results/all.json';

  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  const slim = (arr) => arr
    .map((d) => ({ draw_no: d.draw_no, numbers: d.numbers, bonus_no: d.bonus_no, date: d.date, prize1: d.prize1 ?? d.divisions?.[0]?.prize, winners1: d.winners1 ?? d.divisions?.[0]?.winners }))
    .sort((a, b) => a.draw_no - b.draw_no);

  // 1) 로컬 Node 서버(/api/draws) → 2) 사이트에 포함된 data/all.json → 3) 최신 회차가 빠져 있으면 원본에서 직접 받기
  async function load() {
    let meta = { error: null };
    try {
      try {
        const json = await getJSON('api/draws');
        draws = json.draws; meta = json;
      } catch {
        draws = slim(await getJSON('data/all.json'));
      }
      if (!draws.length || draws[draws.length - 1].draw_no < expectedLatest()) {
        try {
          const live = slim(await getJSON(LIVE_URL));
          if (live.length >= draws.length) draws = live;
        } catch {
          meta.error = 'live';
        }
      }
      if (!draws.length) throw new Error('데이터가 비어 있습니다');
      init(meta);
    } catch (e) {
      $('dataMeta').textContent = '데이터를 불러오지 못했습니다: ' + e.message;
    }
  }

  function targetInfo() {
    const last = draws[draws.length - 1];
    const lastDate = new Date(last.date); // UTC 자정 = 추첨 날짜
    const next = new Date(Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth(), lastDate.getUTCDate() + 7, 11, 35)); // 20:35 KST
    return { drawNo: last.draw_no + 1, date: next, last };
  }

  function init(meta) {
    const t = targetInfo();
    $('targetDraw').textContent = t.drawNo;
    $('targetDate').textContent = `${t.date.getUTCFullYear()}.${String(t.date.getUTCMonth() + 1).padStart(2, '0')}.${String(t.date.getUTCDate()).padStart(2, '0')} (토) 20:35`;
    $('dataMeta').textContent = `1회 ~ ${t.last.draw_no}회 (총 ${draws.length}회차) 당첨번호로 학습` + (meta.error ? ' · 최신 데이터 갱신 실패, 캐시 사용 중' : '');
    tickCountdown(t.date);
    setInterval(() => tickCountdown(t.date), 1000);

    renderLast(t.last);
    renderWeights();
    run();
  }

  function tickCountdown(target) {
    const ms = target - Date.now();
    if (ms <= 0) { $('countdown').textContent = '추첨 완료 — 결과 반영 대기 중'; return; }
    const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4), s = Math.floor((ms % 6e4) / 1e3);
    $('countdown').textContent = `추첨까지 ${d}일 ${h}시간 ${m}분 ${s}초`;
  }

  function run() {
    const t = targetInfo();
    model = M.train(draws, weights);
    currentSets = M.predict(model, { seed: t.drawNo + reroll * 100003 });
    renderSets();
    renderChart();
    renderLastCheck();
    scheduleBacktest();
    $('seedHint').textContent = reroll
      ? `대안 조합 #${reroll} — 같은 모델에서 다른 시드로 뽑았습니다.`
      : `이번 주(${t.drawNo}회) 기본 추천입니다. 같은 주에는 언제 열어도 같은 번호가 나옵니다.`;
  }

  function renderSets() {
    $('sets').innerHTML = currentSets.map((s, i) => {
      const f = s.features;
      return `<li class="set">
        <span class="label">${'ABCDE'[i]}</span>
        <div class="balls">${s.numbers.map((n) => ball(n)).join('')}</div>
        <div class="stats">합계 ${f.sum} · 홀짝 ${f.odd}:${6 - f.odd} · 저고 ${f.low}:${6 - f.low}<br>모델 점수 ${(s.score * 100).toFixed(1)}</div>
      </li>`;
    }).join('');
  }

  function renderLast(last) {
    const d = new Date(last.date);
    $('lastResult').innerHTML = `
      <p class="hint">${last.draw_no}회 · ${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}</p>
      <div class="balls" style="margin-top:8px">${last.numbers.map((n) => ball(n)).join('')}<span class="plus">+</span>${ball(last.bonus_no)}</div>
      ${last.prize1 ? `<p class="hint">1등 ${last.winners1}명 · 1인당 ${Math.round(last.prize1 / 1e8 * 10) / 10}억 원</p>` : ''}`;
  }

  // 지난 회차에 (현재 가중치의) 모델이 추천했을 번호와 비교
  function renderLastCheck() {
    const last = draws[draws.length - 1];
    const prev = M.train(draws.slice(0, -1), weights);
    const sets = M.predict(prev, { seed: last.draw_no }); // 백테스트와 같은 시드 → 표의 마지막 행과 일치
    const total = sets.reduce((a, s) => a + s.numbers.filter((n) => last.numbers.includes(n)).length, 0);
    $('lastCheck').innerHTML = `<p class="hint" style="margin:0 0 4px">현재 가중치의 모델이 ${last.draw_no}회에 추천했을 번호 · 총 ${total}개 일치 (세트당 ${(total / sets.length).toFixed(1)}개)</p>` + sets.map((s, i) => {
      const hits = s.numbers.filter((n) => last.numbers.includes(n)).length;
      return `<div class="row"><b style="width:14px;color:var(--muted)">${'ABCDE'[i]}</b>
        <div class="balls">${s.numbers.map((n) => ball(n, 'sm ' + (last.numbers.includes(n) ? '' : 'miss'))).join('')}</div>
        <span class="tag ${hits >= 3 ? 'good' : ''}">${hits}개 일치</span></div>`;
    }).join('');
  }

  function renderWeights() {
    $('weights').innerHTML = Object.keys(W_LABELS).map((k) => `
      <label>${W_LABELS[k]}<input type="range" min="0" max="1" step="0.05" value="${weights[k]}" data-k="${k}"><output>${weights[k].toFixed(2)}</output></label>`).join('');
    $('weights').querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => {
      weights[inp.dataset.k] = parseFloat(inp.value);
      inp.nextElementSibling.textContent = weights[inp.dataset.k].toFixed(2);
      run();
    }));
  }

  function renderChart() {
    const vals = chartMode === 'score' ? model.score : model.features[chartMode];
    let max = 0;
    for (let n = 1; n <= 45; n++) max = Math.max(max, vals[n]);
    const picked = new Set(currentSets.flatMap((s) => s.numbers));
    const T = draws.length;
    let html = '';
    for (let n = 1; n <= 45; n++) {
      const h = max ? (vals[n] / max) * 100 : 0;
      const gap = T - 1 - model.lastSeen[n];
      html += `<div class="bar ${picked.has(n) ? 'pick' : ''}" style="height:${Math.max(h, 1)}%;background:${ballVar(n)}" data-n="${n}"
        data-tip="${n}번 · 점수 ${(model.score[n] * 100).toFixed(1)} · 누적 ${model.longCnt[n]}회 · ${gap}회째 미출현"></div>`;
    }
    $('chart').innerHTML = html;
    if (!$('chart').nextElementSibling.classList.contains('axis')) {
      const ax = document.createElement('div');
      ax.className = 'axis';
      ax.innerHTML = Array.from({ length: 45 }, (_, i) => `<span>${i + 1}</span>`).join('');
      $('chart').after(ax);
    }
  }

  // 가중치 변경 시 슬라이더를 멈춘 뒤 백테스트를 다시 계산 (진행 중인 계산은 취소)
  let btTimer = null;
  let btWorker = null;
  function scheduleBacktest() {
    clearTimeout(btTimer);
    if (btWorker) { btWorker.terminate(); btWorker = null; }
    const box = $('backtest');
    if (box.querySelector('.kpis')) box.style.opacity = 0.45;
    btTimer = setTimeout(renderBacktest, 350);
  }

  function renderBacktest() {
    const w = Object.assign({}, weights);
    const done = (bt) => { $('backtest').style.opacity = 1; showBacktest(bt); };
    try {
      const worker = (btWorker = new Worker('backtest-worker.js'));
      worker.onmessage = (e) => { if (btWorker === worker) { done(e.data); btWorker = null; } worker.terminate(); };
      worker.onerror = () => done(M.backtest(draws, 52, w));
      worker.postMessage({ draws, weeks: 52, weights: w });
    } catch {
      done(M.backtest(draws, 52, w));
    }
  }

  function showBacktest(bt) {
    const maxD = Math.max(...bt.dist);
    const lift = ((bt.avgMatch / bt.randomExpected - 1) * 100).toFixed(1);
    const rows = bt.rows.slice(-10).reverse();
    $('backtest').innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="v">${bt.avgMatch.toFixed(2)}개</div><div class="k">세트당 평균 일치 개수 (모델)</div></div>
        <div class="kpi"><div class="v">${bt.randomExpected.toFixed(2)}개</div><div class="k">무작위 선택 시 기대값 (36/45)</div></div>
        <div class="kpi"><div class="v">${lift > 0 ? '+' : ''}${lift}%</div><div class="k">무작위 대비 차이 · 표본 ${bt.totalSets}세트</div></div>
      </div>
      <p class="hint">일치 개수별 세트 수</p>
      <div class="dist" style="margin-top:22px">${bt.dist.map((c) => `<div style="height:${maxD ? (c / maxD) * 100 : 0}%"><span>${c}</span></div>`).join('')}</div>
      <div class="distx">${bt.dist.map((_, i) => `<span>${i}개</span>`).join('')}</div>
      <div class="tablewrap"><table>
        <thead><tr><th>회차</th><th>당첨번호</th><th>세트별 일치 (A~E)</th><th>최고</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${r.draw_no}</td><td><div class="balls">${r.actual.map((n) => ball(n, 'sm')).join('')}</div></td><td>${r.matches.join(' · ')}</td><td><span class="tag ${r.best >= 3 ? 'good' : ''}">${r.best}개</span></td></tr>`).join('')}</tbody>
      </table></div>
      <p class="hint">5등(3개 일치) 이상은 ${bt.dist[3] + bt.dist[4] + bt.dist[5] + bt.dist[6]}세트였습니다. 이 정도 차이는 표본 크기를 감안하면 우연의 범위 안에 있습니다.</p>`;
  }

  // ---------- 이벤트 ----------
  $('btnReroll').addEventListener('click', () => { reroll++; run(); });
  $('btnResetW').addEventListener('click', () => { weights = Object.assign({}, M.DEFAULT_WEIGHTS); reroll = 0; renderWeights(); run(); });
  $('btnCopy').addEventListener('click', async () => {
    const text = `${targetInfo().drawNo}회 추천 번호\n` + currentSets.map((s, i) => `${'ABCDE'[i]}: ${s.numbers.join(', ')}`).join('\n');
    try { await navigator.clipboard.writeText(text); $('btnCopy').textContent = '복사됨!'; }
    catch { $('btnCopy').textContent = '복사 실패'; }
    setTimeout(() => ($('btnCopy').textContent = '번호 복사'), 1500);
  });
  $('chartMode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    chartMode = b.dataset.mode;
    $('chartMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderChart();
  });
  const tip = $('tooltip');
  $('chart').addEventListener('mousemove', (e) => {
    const bar = e.target.closest('.bar');
    if (!bar) { tip.hidden = true; return; }
    const card = $('chart').closest('.card').getBoundingClientRect();
    tip.textContent = bar.dataset.tip;
    tip.hidden = false;
    const x = Math.min(e.clientX - card.left + 12, card.width - tip.offsetWidth - 8);
    tip.style.left = x + 'px';
    tip.style.top = (e.clientY - card.top - 36) + 'px';
  });
  $('chart').addEventListener('mouseleave', () => (tip.hidden = true));

  load();
})();
