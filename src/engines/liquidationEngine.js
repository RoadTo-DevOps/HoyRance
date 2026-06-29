import { POSITION_STATUS } from '../shared/constants.js';
import { shouldLiquidatePosition } from '../shared/calculations.js';
import { getSymbol } from '../services/marketDataService.js';
import { liquidatePosition } from './positionEngine.js';
import { pushNotification } from '../services/notificationService.js';

export function scanLiquidations(state) {
  const openPositions = state.positions.filter((position) => position.status === POSITION_STATUS.OPEN);
  const records = [];

  for (const position of openPositions) {
    const symbol = getSymbol(state, position.symbol);
    if (!symbol) continue;
    const shouldLiquidate = shouldLiquidatePosition({
      side: position.side,
      entryPrice: position.entryPrice,
      markPrice: symbol.markPrice,
      leverage: position.leverage,
      maintenanceMarginRate: symbol.maintenanceMarginRate,
      liquidationFeeRate: symbol.liquidationFeeRate
    });

    if (shouldLiquidate) {
      const record = liquidatePosition(state, position, symbol);
      records.push(record);
      pushNotification(state, {
        userId: position.userId,
        type: 'liquidation',
        title: 'Position liquidated',
        message: `${record.symbol} ${record.side} was liquidated at mark ${record.markPrice}`,
        level: 'danger',
        meta: { liquidationId: record.id, positionId: position.id }
      });
    }
  }

  return records;
}
