import { ORDER_SIDE, ORDER_STATUS, ORDER_TYPE } from '../shared/constants.js';
import { calculateFee, calculateNotional, oppositeOrderSideForPosition, roundTo } from '../shared/calculations.js';
import { assertApp } from '../lib/errors.js';
import { makeId, nowIso } from '../lib/id.js';
import { matchOrder } from '../engines/matchingEngine.js';
import { previewFillImpact, applyFillToPosition } from '../engines/positionEngine.js';
import { validateNewOrder } from '../engines/riskEngine.js';
import { requireSymbol } from './marketDataService.js';
import { chargeFromAvailable, chargeFromLocked, moveAvailableToLocked, moveLockedToAvailable } from './walletService.js';
import { pushNotification } from './notificationService.js';

function feeRateFor(order, symbol, liquidity) {
  if (liquidity === 'maker' && order.type === ORDER_TYPE.LIMIT) {
    return symbol.makerFeeRate;
  }
  return symbol.takerFeeRate;
}

function releaseOrderReserve(state, order, memo = 'Release order reserve') {
  const release = roundTo((order.reservedMargin ?? 0) + (order.reservedFee ?? 0));
  if (release > 0) {
    moveLockedToAvailable(state, {
      userId: order.userId,
      amount: release,
      type: 'order_reserve_release',
      referenceType: 'order',
      referenceId: order.id,
      memo
    });
  }
  order.reservedMargin = 0;
  order.reservedFee = 0;
}

function createConditionalCloseOrder(state, sourceOrder, type, stopPrice, quantity, reducePositionId = null) {
  if (!stopPrice || quantity <= 0) return null;
  const closeSide = sourceOrder.side === ORDER_SIDE.BUY ? ORDER_SIDE.SELL : ORDER_SIDE.BUY;
  const now = nowIso();
  const order = {
    id: makeId('ord'),
    userId: sourceOrder.userId,
    symbol: sourceOrder.symbol,
    side: closeSide,
    type,
    price: null,
    stopPrice,
    quantity,
    remainingQuantity: quantity,
    filledQuantity: 0,
    status: ORDER_STATUS.OPEN,
    reduceOnly: true,
    reducePositionId,
    postOnly: false,
    leverage: sourceOrder.leverage,
    marginMode: sourceOrder.marginMode,
    reservedMargin: 0,
    reservedFee: 0,
    parentOrderId: sourceOrder.id,
    avgFillPrice: null,
    createdAt: now,
    updatedAt: now
  };
  state.orders.push(order);
  return order;
}

function createAttachedOrders(state, sourceOrder, openedPositions) {
  if (sourceOrder.attachedCreated || !openedPositions?.length) return;
  for (const position of openedPositions) {
    createConditionalCloseOrder(state, sourceOrder, ORDER_TYPE.TAKE_PROFIT_MARKET, sourceOrder.takeProfitPrice, position.quantity, position.id);
    createConditionalCloseOrder(state, sourceOrder, ORDER_TYPE.STOP_MARKET, sourceOrder.stopLossPrice, position.quantity, position.id);
  }
  sourceOrder.attachedCreated = true;
}

export function placeOrder(state, user, input) {
  const normalized = validateNewOrder(state, user, input);
  const now = nowIso();

  if (normalized.totalReserve > 0) {
    moveAvailableToLocked(state, {
      userId: user.id,
      amount: normalized.totalReserve,
      type: 'order_reserve_lock',
      referenceType: 'order',
      referenceId: null,
      memo: 'Reserve margin and fee for order'
    });
  }

  const order = {
    id: makeId('ord'),
    userId: user.id,
    symbol: normalized.symbol,
    side: normalized.side,
    type: normalized.type,
    price: normalized.price,
    stopPrice: normalized.stopPrice,
    quantity: normalized.quantity,
    remainingQuantity: normalized.remainingQuantity,
    filledQuantity: 0,
    status: ORDER_STATUS.OPEN,
    reduceOnly: normalized.reduceOnly,
    reducePositionId: normalized.reducePositionId,
    postOnly: normalized.postOnly,
    leverage: normalized.leverage,
    marginMode: normalized.marginMode,
    reservedMargin: normalized.marginReserve,
    reservedFee: normalized.feeReserve,
    takeProfitPrice: normalized.takeProfitPrice,
    stopLossPrice: normalized.stopLossPrice,
    attachedCreated: false,
    avgFillPrice: null,
    createdAt: now,
    updatedAt: now
  };

  state.orders.push(order);
  processOrderFill(state, order);

  pushNotification(state, {
    userId: user.id,
    type: 'order',
    title: 'Order accepted',
    message: `${order.side} ${order.quantity} ${order.symbol} ${order.type}`,
    level: 'info',
    meta: { orderId: order.id }
  });

  return order;
}

export function processOrderFill(state, order) {
  if (![ORDER_STATUS.OPEN, ORDER_STATUS.PARTIALLY_FILLED].includes(order.status)) return order;

  const symbol = requireSymbol(state, order.symbol);
  const execution = matchOrder(order, symbol);
  if (!execution) return order;

  const impact = previewFillImpact(state, order, execution.quantity, execution.price);
  if (!order.reduceOnly && impact.marginNeeded > order.reservedMargin) {
    const additionalMargin = roundTo(impact.marginNeeded - order.reservedMargin);
    moveAvailableToLocked(state, {
      userId: order.userId,
      amount: additionalMargin,
      type: 'order_additional_margin_lock',
      referenceType: 'order',
      referenceId: order.id,
      memo: 'Additional margin for moved market price'
    });
    order.reservedMargin = roundTo(order.reservedMargin + additionalMargin);
  }

  const stats = applyFillToPosition(state, {
    order,
    quantity: execution.quantity,
    fillPrice: execution.price
  });

  const notional = calculateNotional(execution.quantity, execution.price);
  const fee = calculateFee(notional, feeRateFor(order, symbol, execution.liquidity));

  const lockedFee = Math.min(order.reservedFee ?? 0, fee);
  if (lockedFee > 0) {
    chargeFromLocked(state, {
      userId: order.userId,
      amount: lockedFee,
      referenceId: order.id,
      memo: 'Trade fee'
    });
    order.reservedFee = roundTo(order.reservedFee - lockedFee);
  }
  const feeRemainder = roundTo(fee - lockedFee);
  if (feeRemainder > 0) {
    chargeFromAvailable(state, {
      userId: order.userId,
      amount: feeRemainder,
      referenceId: order.id,
      memo: 'Trade fee remainder'
    });
  }

  if (!order.reduceOnly) {
    order.reservedMargin = roundTo(order.reservedMargin - stats.marginUsed);
  }

  const trade = {
    id: makeId('trd'),
    orderId: order.id,
    userId: order.userId,
    symbol: order.symbol,
    side: order.side,
    price: execution.price,
    quantity: execution.quantity,
    notional,
    fee,
    liquidity: execution.liquidity,
    realizedPnl: stats.realizedPnl,
    openedQty: stats.openedQty,
    closedQty: stats.closedQty,
    createdAt: nowIso()
  };
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, 2000);

  order.filledQuantity = roundTo(order.filledQuantity + execution.quantity);
  order.remainingQuantity = roundTo(Math.max(0, order.quantity - order.filledQuantity));
  order.avgFillPrice = order.avgFillPrice
    ? roundTo(((order.avgFillPrice * (order.filledQuantity - execution.quantity)) + (execution.price * execution.quantity)) / order.filledQuantity)
    : execution.price;
  order.updatedAt = nowIso();

  if (order.remainingQuantity <= 0) {
    order.remainingQuantity = 0;
    order.status = ORDER_STATUS.FILLED;
    releaseOrderReserve(state, order, 'Release unused order reserve');
    createAttachedOrders(state, order, stats.openedPositions);
  } else {
    order.status = ORDER_STATUS.PARTIALLY_FILLED;
  }

  pushNotification(state, {
    userId: order.userId,
    type: 'fill',
    title: 'Order filled',
    message: `${order.side} ${execution.quantity} ${order.symbol} at ${execution.price}`,
    level: 'success',
    meta: { orderId: order.id, tradeId: trade.id }
  });

  return order;
}

export function processOpenOrders(state) {
  const openOrders = state.orders
    .filter((order) => [ORDER_STATUS.OPEN, ORDER_STATUS.PARTIALLY_FILLED].includes(order.status))
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));

  for (const order of openOrders) {
    processOrderFill(state, order);
  }
}

export function cancelOrder(state, user, orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  assertApp(order, 404, 'Order not found', 'ORDER_NOT_FOUND');
  assertApp(order.userId === user.id || user.role === 'admin', 403, 'Cannot cancel this order', 'ORDER_FORBIDDEN');
  assertApp([ORDER_STATUS.OPEN, ORDER_STATUS.PARTIALLY_FILLED].includes(order.status), 400, 'Order cannot be canceled', 'ORDER_NOT_CANCELABLE');

  releaseOrderReserve(state, order, 'Cancel order reserve release');
  order.status = ORDER_STATUS.CANCELED;
  order.updatedAt = nowIso();
  pushNotification(state, {
    userId: order.userId,
    type: 'order',
    title: 'Order canceled',
    message: `${order.symbol} order was canceled.`,
    level: 'warning',
    meta: { orderId: order.id }
  });
  return order;
}

export function closePosition(state, user, positionId) {
  const position = state.positions.find((item) => item.id === positionId);
  assertApp(position, 404, 'Position not found', 'POSITION_NOT_FOUND');
  assertApp(position.userId === user.id || user.role === 'admin', 403, 'Cannot close this position', 'POSITION_FORBIDDEN');
  assertApp(position.status === 'OPEN' && position.size > 0, 400, 'Position is not open', 'POSITION_NOT_OPEN');

  return placeOrder(state, user, {
    symbol: position.symbol,
    side: oppositeOrderSideForPosition(position.side),
    type: ORDER_TYPE.MARKET,
    quantity: position.size,
    leverage: position.leverage,
    marginMode: position.marginMode,
    reduceOnly: true,
    reducePositionId: position.id
  });
}
