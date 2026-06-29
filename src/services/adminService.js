import { USER_ROLES, USER_STATUS, WALLET_TYPES } from '../shared/constants.js';
import { roundTo } from '../shared/calculations.js';
import { assertApp } from '../lib/errors.js';
import { makeId, nowIso } from '../lib/id.js';
import { listOpenPositions } from '../engines/positionEngine.js';
import { reduceAvailableBalance, topUp } from './walletService.js';

export function assertAdmin(user) {
  assertApp(user.role === USER_ROLES.ADMIN, 403, 'Admin role is required', 'ADMIN_REQUIRED');
}

export function auditAdminAction(state, { actorId, action, target = null, payload = {}, ip = '' }) {
  const log = {
    id: makeId('aud'),
    actorId,
    action,
    target,
    payload,
    ip,
    createdAt: nowIso()
  };
  state.adminAuditLogs.unshift(log);
  state.adminAuditLogs = state.adminAuditLogs.slice(0, 1000);
  return log;
}

export function getAdminOverview(state) {
  const positions = listOpenPositions(state);
  const openInterest = positions.reduce((sum, position) => sum + position.notional, 0);
  const netExposure = positions.reduce((sum, position) => sum + (position.side === 'LONG' ? position.notional : -position.notional), 0);
  const unrealizedPnl = positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);

  return {
    users: state.users.length,
    activeUsers: state.users.filter((user) => user.status === USER_STATUS.ACTIVE).length,
    openOrders: state.orders.filter((order) => ['OPEN', 'PARTIALLY_FILLED'].includes(order.status)).length,
    openPositions: positions.length,
    openInterest: roundTo(openInterest),
    netExposure: roundTo(netExposure),
    unrealizedPnl: roundTo(unrealizedPnl),
    liquidationQueue: positions.filter((position) => position.marginRatio >= 0.85).length,
    symbols: state.symbols
  };
}

export function listUsersForAdmin(state) {
  return state.users.map(({ passwordHash, twoFactorSecret, ...user }) => ({
    ...user,
    wallets: state.wallets.filter((wallet) => wallet.userId === user.id)
  }));
}

export function updateUserControls(state, { actorId, userId, status, tradingLocked, maxLeverageOverride }) {
  const user = state.users.find((item) => item.id === userId);
  assertApp(user, 404, 'User not found', 'USER_NOT_FOUND');

  if (status !== undefined) {
    assertApp(Object.values(USER_STATUS).includes(status), 400, 'User status is invalid', 'USER_STATUS_INVALID');
    user.status = status;
  }
  if (tradingLocked !== undefined) {
    user.tradingLocked = Boolean(tradingLocked);
  }
  if (maxLeverageOverride !== undefined) {
    user.maxLeverageOverride = maxLeverageOverride === null ? null : Number(maxLeverageOverride);
  }
  user.updatedAt = nowIso();

  auditAdminAction(state, {
    actorId,
    action: 'update_user_controls',
    target: userId,
    payload: { status, tradingLocked, maxLeverageOverride }
  });

  return user;
}

export function adjustUserBalance(state, { actorId, userId, walletType = WALLET_TYPES.FUTURES, amount, reason = 'Admin balance adjustment' }) {
  const safeAmount = roundTo(Number(amount));
  assertApp(Number.isFinite(safeAmount) && safeAmount !== 0, 400, 'Adjustment amount is invalid', 'AMOUNT_INVALID');

  const entry = safeAmount > 0
    ? topUp(state, { userId, walletType, amount: safeAmount, actorId, reason })
    : reduceAvailableBalance(state, { userId, walletType, amount: Math.abs(safeAmount), actorId, reason });

  auditAdminAction(state, {
    actorId,
    action: 'adjust_user_balance',
    target: userId,
    payload: { walletType, amount: safeAmount, reason }
  });

  return entry;
}

export function updateSymbolConfig(state, { actorId, symbolName, patch }) {
  const symbol = state.symbols.find((item) => item.symbol === String(symbolName).toUpperCase());
  assertApp(symbol, 404, 'Symbol not found', 'SYMBOL_NOT_FOUND');

  const allowed = [
    'status',
    'tickSize',
    'stepSize',
    'minNotional',
    'maxLeverage',
    'maxOrderNotional',
    'maintenanceMarginRate',
    'liquidationFeeRate',
    'makerFeeRate',
    'takerFeeRate',
    'fundingRate',
    'fundingIntervalMinutes'
  ];

  for (const key of allowed) {
    if (patch[key] !== undefined && patch[key] !== '') {
      symbol[key] = key === 'status' ? String(patch[key]) : Number(patch[key]);
    }
  }
  symbol.updatedAt = nowIso();

  auditAdminAction(state, {
    actorId,
    action: 'update_symbol_config',
    target: symbol.symbol,
    payload: patch
  });

  return symbol;
}
