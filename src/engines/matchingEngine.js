import { ORDER_SIDE, ORDER_STATUS, ORDER_TYPE } from '../shared/constants.js';
import { calculateNotional, normalizeQuantity, roundTo, roundToTick } from '../shared/calculations.js';

function spreadPrice(symbol, side) {
  if (side === ORDER_SIDE.BUY) {
    return roundToTick(symbol.markPrice + symbol.tickSize, symbol.tickSize);
  }
  return roundToTick(symbol.markPrice - symbol.tickSize, symbol.tickSize);
}

function isTriggered(order, symbol) {
  if (order.type === ORDER_TYPE.MARKET) return true;

  if (order.type === ORDER_TYPE.LIMIT) {
    if (order.side === ORDER_SIDE.BUY) return order.price >= symbol.markPrice;
    return order.price <= symbol.markPrice;
  }

  if (order.type === ORDER_TYPE.STOP_MARKET) {
    if (order.side === ORDER_SIDE.BUY) return symbol.markPrice >= order.stopPrice;
    return symbol.markPrice <= order.stopPrice;
  }

  if (order.type === ORDER_TYPE.TAKE_PROFIT_MARKET) {
    if (order.side === ORDER_SIDE.BUY) return symbol.markPrice <= order.stopPrice;
    return symbol.markPrice >= order.stopPrice;
  }

  return false;
}

function executionPrice(order, symbol) {
  if (order.type === ORDER_TYPE.LIMIT) {
    return order.price;
  }
  return spreadPrice(symbol, order.side);
}

function executionQuantity(order, symbol, price) {
  const remaining = order.remainingQuantity;
  const notional = calculateNotional(remaining, price);

  if (order.type === ORDER_TYPE.LIMIT && order.status === ORDER_STATUS.OPEN && notional > 100000) {
    return normalizeQuantity(remaining * 0.5, symbol.stepSize);
  }

  return normalizeQuantity(remaining, symbol.stepSize);
}

export function matchOrder(order, symbol) {
  if (![ORDER_STATUS.OPEN, ORDER_STATUS.PARTIALLY_FILLED].includes(order.status)) return null;
  if (!isTriggered(order, symbol)) return null;

  const price = executionPrice(order, symbol);
  const quantity = executionQuantity(order, symbol, price);
  if (quantity <= 0) return null;

  return {
    price,
    quantity,
    notional: roundTo(price * quantity),
    liquidity: order.type === ORDER_TYPE.LIMIT ? 'maker' : 'taker'
  };
}
