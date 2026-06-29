import { MARGIN_MODE, ORDER_SIDE, ORDER_TYPE, USER_STATUS, WALLET_TYPES } from '../shared/constants.js';
import {
  calculateFee,
  calculateInitialMargin,
  calculateNotional,
  normalizePrice,
  normalizeQuantity,
  positionSideFromOrderSide,
  roundTo
} from '../shared/calculations.js';
import { normalizeOrderInput } from '../shared/validation.js';
import { AppError, assertApp } from '../lib/errors.js';
import { requireSymbol } from '../services/marketDataService.js';
import { requireWallet } from '../services/walletService.js';

function parseOrderInput(input) {
  try {
    return normalizeOrderInput(input);
  } catch (error) {
    throw new AppError(400, error.message, 'ORDER_INVALID');
  }
}

function getReferencePrice(order, symbol) {
  if (order.type === ORDER_TYPE.LIMIT) return order.price;
  if (order.type === ORDER_TYPE.STOP_MARKET || order.type === ORDER_TYPE.TAKE_PROFIT_MARKET) return order.stopPrice;
  return symbol.markPrice;
}

function listReduciblePositions(state, userId, symbolName, orderSide) {
  const targetSide = positionSideFromOrderSide(orderSide);
  return state.positions
    .filter((position) => (
      position.userId === userId
      && position.symbol === symbolName
      && position.status === 'OPEN'
      && position.side !== targetSide
    ))
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
}

export function validateNewOrder(state, user, input) {
  assertApp(user.status === USER_STATUS.ACTIVE, 403, 'Account is not active', 'ACCOUNT_NOT_ACTIVE');
  assertApp(!user.tradingLocked, 403, 'Trading is locked for this account', 'TRADING_LOCKED');

  const parsed = parseOrderInput(input);
  const symbol = requireSymbol(state, parsed.symbol);

  assertApp(parsed.side === ORDER_SIDE.BUY || parsed.side === ORDER_SIDE.SELL, 400, 'Order side is invalid', 'ORDER_SIDE_INVALID');
  assertApp(parsed.marginMode === MARGIN_MODE.ISOLATED || parsed.marginMode === MARGIN_MODE.CROSS, 400, 'Margin mode is invalid', 'MARGIN_MODE_INVALID');
  assertApp(parsed.leverage <= (user.maxLeverageOverride ?? symbol.maxLeverage), 400, 'Leverage exceeds allowed maximum', 'LEVERAGE_TOO_HIGH');
  assertApp(!parsed.postOnly || parsed.type === ORDER_TYPE.LIMIT, 400, 'Post-only can only be used with limit orders', 'POST_ONLY_INVALID');

  const quantity = normalizeQuantity(parsed.quantity, symbol.stepSize);
  assertApp(quantity > 0, 400, 'Quantity is below step size', 'QUANTITY_TOO_SMALL');

  if (parsed.type === ORDER_TYPE.LIMIT) {
    assertApp(parsed.price > 0, 400, 'Limit price is required', 'PRICE_REQUIRED');
    parsed.price = normalizePrice(parsed.price, symbol.tickSize);
  }
  if (parsed.type === ORDER_TYPE.STOP_MARKET || parsed.type === ORDER_TYPE.TAKE_PROFIT_MARKET) {
    assertApp(parsed.stopPrice > 0, 400, 'Stop price is required', 'STOP_PRICE_REQUIRED');
    parsed.stopPrice = normalizePrice(parsed.stopPrice, symbol.tickSize);
  }

  const referencePrice = getReferencePrice(parsed, symbol);
  const notional = calculateNotional(quantity, referencePrice);
  assertApp(notional >= symbol.minNotional, 400, 'Order notional is below symbol minimum', 'MIN_NOTIONAL');
  assertApp(notional <= symbol.maxOrderNotional, 400, 'Order notional exceeds symbol maximum', 'MAX_ORDER_NOTIONAL');

  if (parsed.reduceOnly) {
    const reduciblePositions = parsed.reducePositionId
      ? state.positions.filter((position) => (
        position.id === parsed.reducePositionId
        && position.userId === user.id
        && position.symbol === symbol.symbol
        && position.status === 'OPEN'
        && position.side !== positionSideFromOrderSide(parsed.side)
      ))
      : listReduciblePositions(state, user.id, symbol.symbol, parsed.side);
    const reducibleSize = reduciblePositions.reduce((sum, position) => sum + position.size, 0);
    assertApp(reduciblePositions.length > 0, 400, 'No open position to reduce', 'NO_POSITION_TO_REDUCE');
    assertApp(quantity <= reducibleSize + 1e-8, 400, 'Reduce-only quantity exceeds open position size', 'REDUCE_ONLY_SIZE_TOO_LARGE', {
      requested: quantity,
      reducible: reducibleSize
    });
  }

  const feeReserve = calculateFee(notional, symbol.takerFeeRate);
  const marginReserve = parsed.reduceOnly ? 0 : calculateInitialMargin(notional, parsed.leverage);
  const totalReserve = roundTo(marginReserve + feeReserve);

  if (!parsed.reduceOnly) {
    const wallet = requireWallet(state, user.id, WALLET_TYPES.FUTURES);
    assertApp(wallet.available >= totalReserve, 400, 'Available futures balance is insufficient', 'INSUFFICIENT_MARGIN', {
      required: totalReserve,
      available: wallet.available
    });
  }

  if (parsed.postOnly && parsed.type === ORDER_TYPE.LIMIT) {
    const wouldCross = parsed.side === ORDER_SIDE.BUY
      ? parsed.price >= symbol.markPrice
      : parsed.price <= symbol.markPrice;
    assertApp(!wouldCross, 400, 'Post-only order would immediately match', 'POST_ONLY_WOULD_MATCH');
  }

  return {
    ...parsed,
    quantity,
    remainingQuantity: quantity,
    referencePrice,
    notional,
    marginReserve,
    feeReserve,
    totalReserve
  };
}
