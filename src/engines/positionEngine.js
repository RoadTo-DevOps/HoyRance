import { ORDER_SIDE, POSITION_SIDE, POSITION_STATUS } from '../shared/constants.js';
import {
  calculateInitialMargin,
  calculateLiquidationPrice,
  calculateMarginRatio,
  calculateNotional,
  calculateRealizedPnl,
  calculateRoe,
  calculateUnrealizedPnl,
  positionSideFromOrderSide,
  roundTo
} from '../shared/calculations.js';
import { assertApp } from '../lib/errors.js';
import { makeId, nowIso } from '../lib/id.js';
import { getSymbol } from '../services/marketDataService.js';
import { moveLockedToAvailable, postRealizedPnl, settleLiquidation } from '../services/walletService.js';

export function getOpenPosition(state, userId, symbolName) {
  return state.positions.find((position) => position.userId === userId && position.symbol === symbolName && position.status === POSITION_STATUS.OPEN);
}

function listOpenPositionLots(state, userId, symbolName, side = null) {
  return state.positions
    .filter((position) => (
      position.userId === userId
      && position.symbol === symbolName
      && position.status === POSITION_STATUS.OPEN
      && (!side || position.side === side)
    ))
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
}

export function enrichPosition(position, symbol) {
  const markPrice = symbol.markPrice;
  const notional = calculateNotional(position.size, markPrice);
  const unrealizedPnl = calculateUnrealizedPnl({
    side: position.side,
    entryPrice: position.entryPrice,
    markPrice,
    size: position.size
  });
  const marginRatio = calculateMarginRatio({
    margin: position.margin,
    unrealizedPnl,
    notional,
    maintenanceMarginRate: symbol.maintenanceMarginRate
  });
  const liquidationPrice = calculateLiquidationPrice({
    side: position.side,
    entryPrice: position.entryPrice,
    leverage: position.leverage,
    maintenanceMarginRate: symbol.maintenanceMarginRate,
    liquidationFeeRate: symbol.liquidationFeeRate
  });

  return {
    ...position,
    markPrice,
    notional,
    unrealizedPnl,
    roe: calculateRoe(unrealizedPnl, position.margin),
    liquidationPrice,
    marginRatio
  };
}

export function listOpenPositions(state, userId = null) {
  return state.positions
    .filter((position) => position.status === POSITION_STATUS.OPEN && (!userId || position.userId === userId))
    .map((position) => enrichPosition(position, getSymbol(state, position.symbol)));
}

function closeExistingPosition(state, position, quantity, fillPrice, orderId) {
  const closeQty = Math.min(position.size, quantity);
  if (closeQty <= 0) {
    return { closedQty: 0, realizedPnl: 0, releasedMargin: 0 };
  }

  const proportion = closeQty / position.size;
  const releasedMargin = roundTo(position.margin * proportion);
  const realizedPnl = calculateRealizedPnl({
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: fillPrice,
    size: closeQty
  });

  moveLockedToAvailable(state, {
    userId: position.userId,
    amount: releasedMargin,
    referenceType: 'position',
    referenceId: position.id,
    memo: 'Release position margin'
  });
  postRealizedPnl(state, {
    userId: position.userId,
    amount: realizedPnl,
    referenceId: orderId,
    memo: 'Realized PnL from position reduction'
  });

  position.size = roundTo(position.size - closeQty);
  position.margin = roundTo(position.margin - releasedMargin);
  position.realizedPnl = roundTo(position.realizedPnl + realizedPnl);
  position.updatedAt = nowIso();

  if (position.size <= 0) {
    position.size = 0;
    position.margin = 0;
    position.status = POSITION_STATUS.CLOSED;
    position.closedAt = nowIso();
    position.exitPrice = fillPrice;
  }

  return { closedQty: closeQty, realizedPnl, releasedMargin };
}

function openPositionLot(state, { userId, symbol, side, quantity, fillPrice, leverage, marginMode, orderId }) {
  const marginUsed = calculateInitialMargin(calculateNotional(quantity, fillPrice), leverage);
  const liquidationPrice = calculateLiquidationPrice({
    side,
    entryPrice: fillPrice,
    leverage,
    maintenanceMarginRate: symbol.maintenanceMarginRate,
    liquidationFeeRate: symbol.liquidationFeeRate
  });

  const now = nowIso();
  const position = {
    id: makeId('pos'),
    userId,
    symbol: symbol.symbol,
    side,
    size: quantity,
    entryPrice: fillPrice,
    markPrice: symbol.markPrice,
    margin: marginUsed,
    leverage,
    marginMode,
    liquidationPrice,
    realizedPnl: 0,
    status: POSITION_STATUS.OPEN,
    openedOrderId: orderId,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    exitPrice: null
  };
  state.positions.push(position);
  return { position, openedQty: quantity, marginUsed };
}

export function previewFillImpact(state, order, quantity, fillPrice) {
  let closeQty = 0;
  let openQty = order.reduceOnly ? 0 : quantity;

  if (order.reduceOnly) {
    const targetSide = positionSideFromOrderSide(order.side);
    const positions = order.reducePositionId
      ? listOpenPositionLots(state, order.userId, order.symbol).filter((position) => position.id === order.reducePositionId && position.side !== targetSide)
      : listOpenPositionLots(state, order.userId, order.symbol).filter((position) => position.side !== targetSide);
    let remaining = quantity;
    for (const position of positions) {
      if (remaining <= 0) break;
      const qty = Math.min(position.size, remaining);
      closeQty = roundTo(closeQty + qty);
      remaining = roundTo(remaining - qty);
    }
  }

  return {
    closeQty,
    openQty,
    marginNeeded: order.reduceOnly ? 0 : calculateInitialMargin(calculateNotional(openQty, fillPrice), order.leverage)
  };
}

export function applyFillToPosition(state, { order, quantity, fillPrice }) {
  const symbol = getSymbol(state, order.symbol);
  assertApp(symbol, 404, 'Symbol not found', 'SYMBOL_NOT_FOUND');
  const targetSide = positionSideFromOrderSide(order.side);
  let remaining = quantity;
  let realizedPnl = 0;
  let releasedMargin = 0;
  let closedQty = 0;
  let openedQty = 0;
  let marginUsed = 0;
  const openedPositions = [];

  if (order.reduceOnly) {
    const positions = order.reducePositionId
      ? listOpenPositionLots(state, order.userId, order.symbol).filter((position) => position.id === order.reducePositionId && position.side !== targetSide)
      : listOpenPositionLots(state, order.userId, order.symbol).filter((position) => position.side !== targetSide);

    for (const position of positions) {
      if (remaining <= 0) break;
      const closeResult = closeExistingPosition(state, position, remaining, fillPrice, order.id);
      remaining = roundTo(remaining - closeResult.closedQty);
      realizedPnl = roundTo(realizedPnl + closeResult.realizedPnl);
      releasedMargin = roundTo(releasedMargin + closeResult.releasedMargin);
      closedQty = roundTo(closedQty + closeResult.closedQty);
    }

    assertApp(remaining <= 0, 400, 'Reduce-only order cannot increase exposure', 'REDUCE_ONLY_EXPOSURE');
  }

  if (remaining > 0) {
    assertApp(!order.reduceOnly, 400, 'Reduce-only order cannot increase exposure', 'REDUCE_ONLY_EXPOSURE');
    const openResult = openPositionLot(state, {
      userId: order.userId,
      symbol,
      side: targetSide,
      quantity: remaining,
      fillPrice,
      leverage: order.leverage,
      marginMode: order.marginMode,
      orderId: order.id
    });
    openedQty = roundTo(openedQty + openResult.openedQty);
    marginUsed = roundTo(marginUsed + openResult.marginUsed);
    openedPositions.push({
      id: openResult.position.id,
      quantity: openResult.openedQty
    });
  }

  return {
    closedQty,
    openedQty,
    realizedPnl,
    releasedMargin,
    marginUsed,
    openedPositions,
    side: targetSide
  };
}

export function liquidatePosition(state, position, symbol) {
  const enriched = enrichPosition(position, symbol);
  const liquidationId = makeId('liq');
  const liquidationFee = roundTo(enriched.notional * symbol.liquidationFeeRate);
  const refund = Math.max(0, roundTo(position.margin + enriched.unrealizedPnl - liquidationFee));

  settleLiquidation(state, {
    userId: position.userId,
    margin: position.margin,
    refund,
    referenceId: liquidationId,
    memo: 'Liquidation settlement'
  });

  position.status = POSITION_STATUS.LIQUIDATED;
  position.exitPrice = symbol.markPrice;
  position.realizedPnl = roundTo(position.realizedPnl + enriched.unrealizedPnl);
  position.margin = 0;
  position.size = 0;
  position.closedAt = nowIso();
  position.updatedAt = position.closedAt;

  const record = {
    id: liquidationId,
    userId: position.userId,
    positionId: position.id,
    symbol: position.symbol,
    side: position.side,
    markPrice: symbol.markPrice,
    entryPrice: position.entryPrice,
    realizedPnl: enriched.unrealizedPnl,
    liquidationFee,
    refund,
    createdAt: nowIso()
  };
  state.liquidationRecords.unshift(record);
  state.liquidationRecords = state.liquidationRecords.slice(0, 500);
  return record;
}
