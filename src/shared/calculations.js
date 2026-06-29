import { EPSILON, ORDER_SIDE, POSITION_SIDE } from './constants.js';

export function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function roundTo(value, decimals = 8) {
  const factor = 10 ** decimals;
  return Math.round((toNumber(value) + Number.EPSILON) * factor) / factor;
}

export function floorToStep(value, stepSize) {
  const step = toNumber(stepSize);
  if (step <= 0) return toNumber(value);
  return roundTo(Math.floor((toNumber(value) + EPSILON) / step) * step, decimalPlaces(step));
}

export function ceilToTick(value, tickSize) {
  const tick = toNumber(tickSize);
  if (tick <= 0) return toNumber(value);
  return roundTo(Math.ceil((toNumber(value) - EPSILON) / tick) * tick, decimalPlaces(tick));
}

export function roundToTick(value, tickSize) {
  const tick = toNumber(tickSize);
  if (tick <= 0) return roundTo(value);
  return roundTo(Math.round(toNumber(value) / tick) * tick, decimalPlaces(tick));
}

export function decimalPlaces(value) {
  const text = String(value);
  if (!text.includes('.')) return 0;
  return text.split('.')[1].replace(/0+$/, '').length;
}

export function calculateNotional(quantity, price) {
  return roundTo(toNumber(quantity) * toNumber(price));
}

export function calculateInitialMargin(notional, leverage) {
  const safeLeverage = Math.max(1, toNumber(leverage, 1));
  return roundTo(toNumber(notional) / safeLeverage);
}

export function calculateFee(notional, feeRate) {
  return roundTo(Math.abs(toNumber(notional)) * Math.max(0, toNumber(feeRate)));
}

export function positionSideFromOrderSide(orderSide) {
  return orderSide === ORDER_SIDE.SELL ? POSITION_SIDE.SHORT : POSITION_SIDE.LONG;
}

export function oppositeOrderSideForPosition(positionSide) {
  return positionSide === POSITION_SIDE.LONG ? ORDER_SIDE.SELL : ORDER_SIDE.BUY;
}

export function calculateUnrealizedPnl({ side, entryPrice, markPrice, size }) {
  const entry = toNumber(entryPrice);
  const mark = toNumber(markPrice);
  const quantity = toNumber(size);
  if (side === POSITION_SIDE.SHORT) {
    return roundTo((entry - mark) * quantity);
  }
  return roundTo((mark - entry) * quantity);
}

export function calculateRealizedPnl({ side, entryPrice, exitPrice, size }) {
  return calculateUnrealizedPnl({ side, entryPrice, markPrice: exitPrice, size });
}

export function calculateRoe(unrealizedPnl, margin) {
  const marginValue = toNumber(margin);
  if (marginValue <= 0) return 0;
  return roundTo((toNumber(unrealizedPnl) / marginValue) * 100, 4);
}

export function calculateMaintenanceMargin(notional, maintenanceMarginRate) {
  return roundTo(Math.abs(toNumber(notional)) * Math.max(0, toNumber(maintenanceMarginRate)));
}

export function calculateMarginRatio({ margin, unrealizedPnl, notional, maintenanceMarginRate }) {
  const equity = toNumber(margin) + toNumber(unrealizedPnl);
  const maintenance = calculateMaintenanceMargin(notional, maintenanceMarginRate);
  if (equity <= 0) return Infinity;
  return roundTo(maintenance / equity, 6);
}

export function calculateLiquidationPrice({
  side,
  entryPrice,
  leverage,
  maintenanceMarginRate,
  liquidationFeeRate = 0
}) {
  const entry = toNumber(entryPrice);
  const safeLeverage = Math.max(1, toNumber(leverage, 1));
  const maintenance = Math.max(0, toNumber(maintenanceMarginRate));
  const liquidationFee = Math.max(0, toNumber(liquidationFeeRate));

  if (side === POSITION_SIDE.SHORT) {
    return roundTo(Math.max(0.00000001, entry * (1 + 1 / safeLeverage - maintenance - liquidationFee)));
  }

  return roundTo(Math.max(0.00000001, entry * (1 - 1 / safeLeverage + maintenance + liquidationFee)));
}

export function shouldLiquidatePosition({ side, entryPrice, markPrice, leverage, maintenanceMarginRate, liquidationFeeRate }) {
  const liquidationPrice = calculateLiquidationPrice({
    side,
    entryPrice,
    leverage,
    maintenanceMarginRate,
    liquidationFeeRate
  });

  if (side === POSITION_SIDE.SHORT) {
    return toNumber(markPrice) >= liquidationPrice;
  }

  return toNumber(markPrice) <= liquidationPrice;
}

export function formatPercent(value) {
  return `${roundTo(value, 2).toFixed(2)}%`;
}

export function normalizeQuantity(quantity, stepSize) {
  return floorToStep(Math.max(0, toNumber(quantity)), stepSize);
}

export function normalizePrice(price, tickSize) {
  return roundToTick(Math.max(0, toNumber(price)), tickSize);
}

export function isCloseEnough(left, right, tolerance = 1e-6) {
  return Math.abs(toNumber(left) - toNumber(right)) <= tolerance;
}
