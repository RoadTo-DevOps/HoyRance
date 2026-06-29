import { POSITION_SIDE } from '../shared/constants.js';
import { calculateNotional, roundTo } from '../shared/calculations.js';
import { makeId, nowIso } from '../lib/id.js';
import { postFunding } from './walletService.js';
import { pushNotification } from './notificationService.js';

export function applyDueFunding(state) {
  const now = Date.now();
  const records = [];

  for (const symbol of state.symbols) {
    if (new Date(symbol.nextFundingAt).getTime() > now) continue;

    const positions = state.positions.filter((position) => position.status === 'OPEN' && position.symbol === symbol.symbol);
    for (const position of positions) {
      const notional = calculateNotional(position.size, symbol.markPrice);
      const signedAmount = position.side === POSITION_SIDE.LONG
        ? -roundTo(notional * symbol.fundingRate)
        : roundTo(notional * symbol.fundingRate);
      const recordId = makeId('fnd');

      postFunding(state, {
        userId: position.userId,
        amount: signedAmount,
        referenceId: recordId,
        memo: `Funding ${symbol.symbol}`
      });

      const record = {
        id: recordId,
        userId: position.userId,
        symbol: symbol.symbol,
        positionId: position.id,
        rate: symbol.fundingRate,
        notional,
        amount: signedAmount,
        createdAt: nowIso()
      };
      state.fundingRecords.unshift(record);
      records.push(record);
      pushNotification(state, {
        userId: position.userId,
        type: 'funding',
        title: 'Funding applied',
        message: `${symbol.symbol} funding ${signedAmount >= 0 ? '+' : ''}${signedAmount} USDT`,
        level: signedAmount >= 0 ? 'success' : 'warning',
        meta: { fundingId: record.id }
      });
    }

    symbol.nextFundingAt = new Date(now + symbol.fundingIntervalMinutes * 60_000).toISOString();
  }

  state.fundingRecords = state.fundingRecords.slice(0, 1000);
  return records;
}
