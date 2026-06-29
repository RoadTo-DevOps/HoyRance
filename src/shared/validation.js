import { ORDER_SIDE, ORDER_TYPE, MARGIN_MODE } from './constants.js';

export function requiredString(input, field) {
  const value = String(input?.[field] ?? '').trim();
  if (!value) {
    throw new Error(`${field} is required`);
  }
  return value;
}

export function optionalString(input, field, fallback = '') {
  return String(input?.[field] ?? fallback).trim();
}

export function requiredNumber(input, field, options = {}) {
  const value = Number(input?.[field]);
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${field} must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${field} must be at most ${options.max}`);
  }
  return value;
}

export function optionalNumber(input, field, fallback = null) {
  if (input?.[field] === undefined || input?.[field] === null || input?.[field] === '') {
    return fallback;
  }
  const value = Number(input[field]);
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

export function enumValue(input, field, values, fallback = null) {
  const value = input?.[field] ?? fallback;
  if (!Object.values(values).includes(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

export function normalizeOrderInput(input) {
  return {
    symbol: requiredString(input, 'symbol').toUpperCase(),
    side: enumValue(input, 'side', ORDER_SIDE),
    type: enumValue(input, 'type', ORDER_TYPE),
    quantity: requiredNumber(input, 'quantity', { min: 0.00000001 }),
    price: optionalNumber(input, 'price'),
    stopPrice: optionalNumber(input, 'stopPrice'),
    leverage: requiredNumber(input, 'leverage', { min: 1, max: 125 }),
    marginMode: enumValue(input, 'marginMode', MARGIN_MODE, MARGIN_MODE.ISOLATED),
    reduceOnly: Boolean(input?.reduceOnly),
    postOnly: Boolean(input?.postOnly),
    reducePositionId: optionalString(input, 'reducePositionId') || null,
    takeProfitPrice: optionalNumber(input, 'takeProfitPrice'),
    stopLossPrice: optionalNumber(input, 'stopLossPrice')
  };
}
