// 백테스트는 계산량이 많아 화면이 멈추지 않도록 Web Worker에서 실행
importScripts('model.js');
self.onmessage = (e) => {
  const { draws, weeks, weights } = e.data;
  self.postMessage(self.LottoModel.backtest(draws, weeks, weights));
};
