import { ASSET, LEDGER_ACCOUNT, WALLET_TYPES } from '../shared/constants.js';
import { roundTo } from '../shared/calculations.js';
import { assertApp } from '../lib/errors.js';
import { nowIso } from '../lib/id.js';
import { postJournal, systemLine, walletLine } from './ledgerService.js';

export function walletId(userId, type, asset = ASSET) {
  return `${userId}:${type}:${asset}`;
}

export function getWallet(state, userId, type = WALLET_TYPES.FUTURES, asset = ASSET) {
  return state.wallets.find((wallet) => wallet.userId === userId && wallet.type === type && wallet.asset === asset);
}

export function requireWallet(state, userId, type = WALLET_TYPES.FUTURES, asset = ASSET) {
  const wallet = getWallet(state, userId, type, asset);
  assertApp(wallet, 404, 'Wallet not found', 'WALLET_NOT_FOUND');
  return wallet;
}

export function createDefaultWallets(state, userId) {
  for (const type of [WALLET_TYPES.SPOT, WALLET_TYPES.FUTURES]) {
    if (!getWallet(state, userId, type, ASSET)) {
      const createdAt = nowIso();
      state.wallets.push({
        id: walletId(userId, type, ASSET),
        userId,
        type,
        asset: ASSET,
        available: 0,
        locked: 0,
        equity: 0,
        createdAt,
        updatedAt: createdAt
      });
    }
  }
}

export function listWallets(state, userId) {
  return state.wallets.filter((wallet) => wallet.userId === userId);
}

export function topUp(state, { userId, walletType = WALLET_TYPES.FUTURES, amount, actorId = 'system', reason = 'Virtual top-up' }) {
  const wallet = requireWallet(state, userId, walletType, ASSET);
  const safeAmount = roundTo(amount);
  assertApp(safeAmount > 0, 400, 'Top-up amount must be positive', 'AMOUNT_INVALID');

  const entry = postJournal(state, {
    type: 'virtual_top_up',
    referenceType: 'virtual_balance_adjustment',
    referenceId: null,
    description: reason,
    createdBy: actorId,
    lines: [
      walletLine(wallet, 'available', 'debit', safeAmount, reason),
      systemLine(LEDGER_ACCOUNT.SYSTEM_DEMO, 'credit', safeAmount, reason)
    ]
  });

  state.virtualBalanceAdjustments.push({
    id: entry.id,
    userId,
    actorId,
    asset: ASSET,
    walletType,
    amount: safeAmount,
    status: 'applied',
    reason,
    riskFlags: [],
    createdAt: entry.createdAt
  });

  return entry;
}

export function reduceAvailableBalance(state, { userId, walletType = WALLET_TYPES.FUTURES, amount, actorId = 'system', reason = 'Virtual balance reduction' }) {
  const wallet = requireWallet(state, userId, walletType, ASSET);
  const safeAmount = roundTo(amount);
  assertApp(safeAmount > 0, 400, 'Reduction amount must be positive', 'AMOUNT_INVALID');
  assertApp(wallet.available >= safeAmount, 400, 'Available balance is insufficient', 'INSUFFICIENT_AVAILABLE');

  const entry = postJournal(state, {
    type: 'virtual_balance_reduction',
    referenceType: 'virtual_balance_adjustment',
    referenceId: null,
    description: reason,
    createdBy: actorId,
    lines: [
      walletLine(wallet, 'available', 'credit', safeAmount, reason),
      systemLine(LEDGER_ACCOUNT.SYSTEM_DEMO, 'debit', safeAmount, reason)
    ]
  });

  state.virtualBalanceAdjustments.push({
    id: entry.id,
    userId,
    actorId,
    asset: ASSET,
    walletType,
    amount: -safeAmount,
    status: 'applied',
    reason,
    riskFlags: [],
    createdAt: entry.createdAt
  });

  return entry;
}

export function transfer(state, { userId, fromWalletType, toWalletType, amount }) {
  const source = requireWallet(state, userId, fromWalletType, ASSET);
  const target = requireWallet(state, userId, toWalletType, ASSET);
  const safeAmount = roundTo(amount);
  assertApp(source.type !== target.type, 400, 'Source and destination wallets must be different', 'TRANSFER_SAME_WALLET');
  assertApp(safeAmount > 0, 400, 'Transfer amount must be positive', 'AMOUNT_INVALID');
  assertApp(source.available >= safeAmount, 400, 'Available balance is insufficient', 'INSUFFICIENT_AVAILABLE');

  return postJournal(state, {
    type: 'wallet_transfer',
    referenceType: 'wallet_transfer',
    referenceId: null,
    description: `Transfer ${safeAmount} ${ASSET} from ${source.type} to ${target.type}`,
    createdBy: userId,
    lines: [
      walletLine(source, 'available', 'credit', safeAmount, 'Transfer out'),
      walletLine(target, 'available', 'debit', safeAmount, 'Transfer in')
    ]
  });
}

export function moveAvailableToLocked(state, { userId, amount, type = 'margin_lock', referenceType = 'order', referenceId = null, memo = 'Lock margin' }) {
  const wallet = requireWallet(state, userId, WALLET_TYPES.FUTURES, ASSET);
  const safeAmount = roundTo(amount);
  if (safeAmount <= 0) return null;
  assertApp(wallet.available >= safeAmount, 400, 'Available balance is insufficient', 'INSUFFICIENT_AVAILABLE');

  return postJournal(state, {
    type,
    referenceType,
    referenceId,
    description: memo,
    createdBy: userId,
    lines: [
      walletLine(wallet, 'available', 'credit', safeAmount, memo),
      walletLine(wallet, 'locked', 'debit', safeAmount, memo)
    ]
  });
}

export function moveLockedToAvailable(state, { userId, amount, type = 'margin_release', referenceType = 'position', referenceId = null, memo = 'Release margin' }) {
  const wallet = requireWallet(state, userId, WALLET_TYPES.FUTURES, ASSET);
  const safeAmount = roundTo(amount);
  if (safeAmount <= 0) return null;
  assertApp(wallet.locked >= safeAmount, 400, 'Locked balance is insufficient', 'INSUFFICIENT_LOCKED');

  return postJournal(state, {
    type,
    referenceType,
    referenceId,
    description: memo,
    createdBy: userId,
    lines: [
      walletLine(wallet, 'locked', 'credit', safeAmount, memo),
      walletLine(wallet, 'available', 'debit', safeAmount, memo)
    ]
  });
}

export function chargeFromLocked(state, { userId, amount, account = LEDGER_ACCOUNT.SYSTEM_FEE, type = 'fee', referenceType = 'trade', referenceId = null, memo = 'Fee charged from locked balance' }) {
  const wallet = requireWallet(state, userId, WALLET_TYPES.FUTURES, ASSET);
  const safeAmount = roundTo(amount);
  if (safeAmount <= 0) return null;
  assertApp(wallet.locked >= safeAmount, 400, 'Locked balance is insufficient', 'INSUFFICIENT_LOCKED');

  return postJournal(state, {
    type,
    referenceType,
    referenceId,
    description: memo,
    createdBy: userId,
    lines: [
      walletLine(wallet, 'locked', 'credit', safeAmount, memo),
      systemLine(account, 'debit', safeAmount, memo)
    ]
  });
}

export function chargeFromAvailable(state, { userId, amount, account = LEDGER_ACCOUNT.SYSTEM_FEE, type = 'fee', referenceType = 'trade', referenceId = null, memo = 'Fee charged from available balance' }) {
  const wallet = requireWallet(state, userId, WALLET_TYPES.FUTURES, ASSET);
  const safeAmount = roundTo(amount);
  if (safeAmount <= 0) return null;
  assertApp(wallet.available >= safeAmount, 400, 'Available balance is insufficient', 'INSUFFICIENT_AVAILABLE');

  return postJournal(state, {
    type,
    referenceType,
    referenceId,
    description: memo,
    createdBy: userId,
    lines: [
      walletLine(wallet, 'available', 'credit', safeAmount, memo),
      systemLine(account, 'debit', safeAmount, memo)
    ]
  });
}

export function postRealizedPnl(state, { userId, amount, referenceType = 'trade', referenceId = null, memo = 'Realized PnL' }) {
  const wallet = requireWallet(state, userId, WALLET_TYPES.FUTURES, ASSET);
  const safeAmount = roundTo(amount);
  if (safeAmount === 0) return null;

  const lines = safeAmount > 0
    ? [
      walletLine(wallet, 'available', 'debit', safeAmount, memo),
      systemLine(LEDGER_ACCOUNT.SYSTEM_PNL, 'credit', safeAmount, memo)
    ]
    : [
      walletLine(wallet, 'available', 'credit', Math.abs(safeAmount), memo),
      systemLine(LEDGER_ACCOUNT.SYSTEM_PNL, 'debit', Math.abs(safeAmount), memo)
    ];

  return postJournal(state, {
    type: 'realized_pnl',
    referenceType,
    referenceId,
    description: memo,
    createdBy: userId,
    lines
  });
}

export function postFunding(state, { userId, amount, referenceId, memo = 'Funding payment' }) {
  const wallet = requireWallet(state, userId, WALLET_TYPES.FUTURES, ASSET);
  const safeAmount = roundTo(amount);
  if (safeAmount === 0) return null;

  const lines = safeAmount > 0
    ? [
      walletLine(wallet, 'available', 'debit', safeAmount, memo),
      systemLine(LEDGER_ACCOUNT.SYSTEM_FUNDING, 'credit', safeAmount, memo)
    ]
    : [
      walletLine(wallet, 'available', 'credit', Math.abs(safeAmount), memo),
      systemLine(LEDGER_ACCOUNT.SYSTEM_FUNDING, 'debit', Math.abs(safeAmount), memo)
    ];

  return postJournal(state, {
    type: 'funding',
    referenceType: 'funding',
    referenceId,
    description: memo,
    createdBy: userId,
    lines
  });
}

export function settleLiquidation(state, { userId, margin, refund, referenceId, memo = 'Liquidation settlement' }) {
  const wallet = requireWallet(state, userId, WALLET_TYPES.FUTURES, ASSET);
  const safeMargin = roundTo(margin);
  const safeRefund = roundTo(Math.max(0, Math.min(refund, safeMargin)));
  assertApp(wallet.locked >= safeMargin, 400, 'Locked balance is insufficient', 'INSUFFICIENT_LOCKED');

  const lines = [
    walletLine(wallet, 'locked', 'credit', safeMargin, memo),
    systemLine(LEDGER_ACCOUNT.SYSTEM_LIQUIDATION, 'debit', safeMargin, memo)
  ];

  if (safeRefund > 0) {
    lines.push(
      walletLine(wallet, 'available', 'debit', safeRefund, 'Liquidation refund'),
      systemLine(LEDGER_ACCOUNT.SYSTEM_LIQUIDATION, 'credit', safeRefund, 'Liquidation refund')
    );
  }

  return postJournal(state, {
    type: 'liquidation_settlement',
    referenceType: 'liquidation',
    referenceId,
    description: memo,
    createdBy: userId,
    lines
  });
}
