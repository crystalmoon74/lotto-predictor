/*
 * 로또 6/45 예측 모델 (앙상블 가중치 + 조합 필터링)
 *
 * 1) 번호별 점수 = 장기 빈도 + 최근 가중 빈도(지수 감쇠) + 미출현 간격(Overdue) + 직전 회차 이월 보정
 * 2) 번호 점수에 비례한 가중 샘플링으로 후보 조합 다수 생성 (회차 번호를 시드로 사용 → 같은 주에는 같은 결과)
 * 3) 과거 당첨 조합 분포로 학습한 필터(합계 범위, 홀짝, 고저, 연속번호, 끝수 등)로 걸러냄
 * 4) 조합 점수 = 번호 점수 합 + 동반 출현(pair) 점수 + 분포 적합도 → 서로 겹침이 적은 상위 5개 선택
 *
 * 주의: 로또 추첨은 독립 시행이며 어떤 모델도 당첨 확률을 높여 주지 않습니다. 재미/참고용입니다.
 */
(function (root) {
  'use strict';

  const N = 45;
  const PICK = 6;

  const DEFAULT_WEIGHTS = {
    longFreq: 0.25,   // 전체 기간 출현 빈도
    recentFreq: 0.35, // 최근 회차 지수 감쇠 빈도
    overdue: 0.25,    // 평균 출현 간격 대비 미출현 기간
    carry: 0.15,      // 직전 회차 번호의 이월 경향
  };

  // ---------- 유틸 ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function normalize(arr) {
    let min = Infinity, max = -Infinity;
    for (let i = 1; i <= N; i++) { min = Math.min(min, arr[i]); max = Math.max(max, arr[i]); }
    const out = new Array(N + 1).fill(0);
    const span = max - min || 1;
    for (let i = 1; i <= N; i++) out[i] = (arr[i] - min) / span;
    return out;
  }

  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function comboFeatures(c) {
    const s = c.slice().sort((a, b) => a - b);
    let sum = 0, odd = 0, low = 0, consecutive = 0;
    const ends = new Set();
    const decades = new Set();
    for (let i = 0; i < s.length; i++) {
      sum += s[i];
      if (s[i] % 2) odd++;
      if (s[i] <= 22) low++;
      if (i && s[i] - s[i - 1] === 1) consecutive++;
      ends.add(s[i] % 10);
      decades.add(Math.floor((s[i] - 1) / 10));
    }
    return { sum, odd, low, consecutive, endDigits: ends.size, decades: decades.size, ac: acValue(s) };
  }

  // AC값(산술 복잡도): 서로 다른 차이값 개수 - 5
  function acValue(s) {
    const diffs = new Set();
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) diffs.add(s[j] - s[i]);
    return diffs.size - (PICK - 1);
  }

  // ---------- 학습 ----------
  function train(draws, weights) {
    const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
    const T = draws.length;

    const longCnt = new Array(N + 1).fill(0);
    const recent = new Array(N + 1).fill(0);
    const lastSeen = new Array(N + 1).fill(-1);
    const pair = Array.from({ length: N + 1 }, () => new Array(N + 1).fill(0));
    const halfLife = 26; // 약 반년
    const decay = Math.pow(0.5, 1 / halfLife);

    for (let t = 0; t < T; t++) {
      const nums = draws[t].numbers;
      const age = T - 1 - t;
      const wt = Math.pow(decay, age);
      for (const n of nums) {
        longCnt[n]++;
        recent[n] += wt;
        lastSeen[n] = t;
      }
      for (let i = 0; i < nums.length; i++)
        for (let j = i + 1; j < nums.length; j++) { pair[nums[i]][nums[j]]++; pair[nums[j]][nums[i]]++; }
    }

    // 미출현 간격: 기대 간격(45/6=7.5회) 대비 얼마나 오래 안 나왔는지 (로그 스케일, 상한)
    const expectedGap = N / PICK;
    const overdue = new Array(N + 1).fill(0);
    for (let n = 1; n <= N; n++) {
      const gap = lastSeen[n] < 0 ? T : T - 1 - lastSeen[n];
      overdue[n] = Math.min(Math.log1p(gap / expectedGap), 2);
    }

    // 직전 회차 이월: 과거 데이터에서 이월된 번호 수의 평균 비율을 반영
    const carry = new Array(N + 1).fill(0);
    if (T) for (const n of draws[T - 1].numbers) carry[n] = 1;

    const f = {
      longFreq: normalize(longCnt),
      recentFreq: normalize(recent),
      overdue: normalize(overdue),
      carry,
    };
    const score = new Array(N + 1).fill(0);
    for (let n = 1; n <= N; n++) {
      score[n] = w.longFreq * f.longFreq[n] + w.recentFreq * f.recentFreq[n] + w.overdue * f.overdue[n] + w.carry * f.carry[n];
    }

    // 동반 출현 정규화 (기대값 대비 비율)
    const expectedPair = T * (PICK * (PICK - 1)) / (N * (N - 1));
    const pairLift = Array.from({ length: N + 1 }, () => new Array(N + 1).fill(0));
    for (let i = 1; i <= N; i++)
      for (let j = 1; j <= N; j++) if (i !== j) pairLift[i][j] = expectedPair ? pair[i][j] / expectedPair - 1 : 0;

    // 과거 당첨 조합 분포 → 필터 범위
    const feats = draws.map((d) => comboFeatures(d.numbers));
    const sums = feats.map((x) => x.sum).sort((a, b) => a - b);
    const acs = feats.map((x) => x.ac).sort((a, b) => a - b);
    const filters = {
      sumMin: Math.round(quantile(sums, 0.1)),
      sumMax: Math.round(quantile(sums, 0.9)),
      sumMean: sums.reduce((a, b) => a + b, 0) / (sums.length || 1),
      acMin: Math.round(quantile(acs, 0.1)),
    };

    const pastSet = new Set(draws.map((d) => d.numbers.slice().sort((a, b) => a - b).join(',')));

    return {
      weights: w,
      features: f,
      score,
      longCnt,
      lastSeen,
      pairLift,
      filters,
      pastSet,
      lastNumbers: T ? draws[T - 1].numbers.slice() : [],
      trainedOn: T,
    };
  }

  // ---------- 조합 생성 ----------
  function passesFilters(c, model) {
    const f = comboFeatures(c);
    const F = model.filters;
    if (f.sum < F.sumMin || f.sum > F.sumMax) return false;
    if (f.odd === 0 || f.odd === 6) return false;
    if (f.low === 0 || f.low === 6) return false;
    if (f.consecutive > 2) return false;
    if (f.endDigits < 4) return false;
    if (f.decades < 3) return false;
    if (f.ac < F.acMin) return false;
    const carried = c.filter((n) => model.lastNumbers.includes(n)).length;
    if (carried > 2) return false;
    if (model.pastSet.has(c.slice().sort((a, b) => a - b).join(','))) return false;
    return true;
  }

  function comboScore(c, model) {
    let s = 0;
    for (const n of c) s += model.score[n];
    let p = 0;
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) p += model.pairLift[c[i]][c[j]];
    const f = comboFeatures(c);
    const sumFit = 1 - Math.min(Math.abs(f.sum - model.filters.sumMean) / 60, 1);
    const oddFit = f.odd === 3 ? 1 : f.odd === 2 || f.odd === 4 ? 0.8 : 0.4;
    return s / PICK + 0.05 * (p / 15) + 0.1 * sumFit + 0.1 * oddFit;
  }

  function weightedPick(rand, weights, exclude) {
    let total = 0;
    for (let n = 1; n <= N; n++) if (!exclude.has(n)) total += weights[n];
    let r = rand() * total;
    for (let n = 1; n <= N; n++) {
      if (exclude.has(n)) continue;
      r -= weights[n];
      if (r <= 0) return n;
    }
    for (let n = N; n >= 1; n--) if (!exclude.has(n)) return n;
    return 1;
  }

  function predict(model, opts) {
    const o = Object.assign({ sets: 5, candidates: 6000, seed: 1, maxOverlap: 2, temperature: 2.2 }, opts || {});
    const rand = mulberry32(o.seed * 2654435761);
    // 점수를 확률 가중치로 변환 (temperature가 클수록 고득점 번호 선호)
    const weights = new Array(N + 1).fill(0);
    for (let n = 1; n <= N; n++) weights[n] = Math.exp(o.temperature * model.score[n]);

    const cands = [];
    const seen = new Set();
    let tries = 0;
    while (cands.length < o.candidates && tries < o.candidates * 20) {
      tries++;
      const chosen = new Set();
      while (chosen.size < PICK) chosen.add(weightedPick(rand, weights, chosen));
      const c = Array.from(chosen).sort((a, b) => a - b);
      const key = c.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      if (!passesFilters(c, model)) continue;
      cands.push({ numbers: c, score: comboScore(c, model) });
    }
    cands.sort((a, b) => b.score - a.score);

    const picked = [];
    for (const cand of cands) {
      if (picked.every((p) => p.numbers.filter((n) => cand.numbers.includes(n)).length <= o.maxOverlap)) {
        picked.push(cand);
        if (picked.length === o.sets) break;
      }
    }
    return picked.map((p) => Object.assign({}, p, { features: comboFeatures(p.numbers) }));
  }

  // ---------- 백테스트 ----------
  // 최근 `weeks`개 회차 각각에 대해 그 이전 데이터만으로 학습 → 5세트 예측 → 실제 결과와 비교
  function backtest(draws, weeks, opts) {
    const rows = [];
    const start = Math.max(50, draws.length - weeks);
    for (let t = start; t < draws.length; t++) {
      const m = train(draws.slice(0, t));
      const sets = predict(m, Object.assign({ seed: draws[t].draw_no }, opts || {}));
      const actual = draws[t].numbers;
      const matches = sets.map((s) => s.numbers.filter((n) => actual.includes(n)).length);
      rows.push({ draw_no: draws[t].draw_no, actual, matches, best: Math.max(...matches) });
    }
    const totalSets = rows.length * 5;
    const avg = rows.reduce((a, r) => a + r.matches.reduce((x, y) => x + y, 0), 0) / (totalSets || 1);
    const dist = [0, 0, 0, 0, 0, 0, 0];
    rows.forEach((r) => r.matches.forEach((k) => dist[k]++));
    return { rows, avgMatch: avg, randomExpected: (PICK * PICK) / N, dist, totalSets };
  }

  const api = { train, predict, backtest, comboFeatures, N, PICK, DEFAULT_WEIGHTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LottoModel = api;
})(typeof self !== 'undefined' ? self : this);
