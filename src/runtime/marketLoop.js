import { tickMarket } from '../services/marketDataService.js';
import { processOpenOrders } from '../services/orderService.js';
import { scanLiquidations } from '../engines/liquidationEngine.js';
import { applyDueFunding } from '../services/fundingService.js';

export function startMarketLoop(store, intervalMs = 5000) {
  const timer = setInterval(() => {
    store.transact(async (state) => {
      await tickMarket(state);
      processOpenOrders(state);
      scanLiquidations(state);
      applyDueFunding(state);
      return { ok: true };
    }).catch((error) => {
      console.error('Market loop failed:', error);
    });
  }, intervalMs);

  timer.unref?.();
  return timer;
}
