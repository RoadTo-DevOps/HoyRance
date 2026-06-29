import { ASSET, EPSILON, LEDGER_ACCOUNT } from '../shared/constants.js';
import { isCloseEnough, roundTo } from '../shared/calculations.js';
import { AppError, assertApp } from '../lib/errors.js';
import { makeId, nowIso } from '../lib/id.js';

function getWallet(state, walletId) {
  return state.wallets.find((wallet) => wallet.id === walletId);
}

function bucketDelta(line) {
  return line.direction === 'debit' ? line.amount : -line.amount;
}

function validateLines(lines) {
  assertApp(Array.isArray(lines) && lines.length >= 2, 400, 'Ledger entry must have at least two lines', 'LEDGER_LINES_INVALID');

  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    assertApp(line.asset === ASSET, 400, 'Only USDT ledger entries are supported in this demo', 'ASSET_UNSUPPORTED');
    assertApp(line.amount > 0, 400, 'Ledger amount must be positive', 'LEDGER_AMOUNT_INVALID');
    assertApp(['debit', 'credit'].includes(line.direction), 400, 'Ledger direction is invalid', 'LEDGER_DIRECTION_INVALID');
    if (line.direction === 'debit') debit += line.amount;
    if (line.direction === 'credit') credit += line.amount;
  }

  assertApp(isCloseEnough(debit, credit), 400, 'Ledger entry is not balanced', 'LEDGER_NOT_BALANCED', { debit, credit });
}

function validateWalletDeltas(state, lines) {
  const deltas = new Map();

  for (const line of lines) {
    if (!line.walletId) continue;
    const key = `${line.walletId}|${line.bucket}`;
    deltas.set(key, roundTo((deltas.get(key) ?? 0) + bucketDelta(line)));
  }

  for (const [key, delta] of deltas.entries()) {
    const [walletId, bucket] = key.split('|');
    const wallet = getWallet(state, walletId);
    assertApp(wallet, 404, 'Wallet not found', 'WALLET_NOT_FOUND');
    assertApp(['available', 'locked'].includes(bucket), 400, 'Wallet bucket is invalid', 'WALLET_BUCKET_INVALID');
    const nextValue = roundTo(wallet[bucket] + delta);
    assertApp(nextValue >= -EPSILON, 400, 'Wallet balance would become negative', 'WALLET_BALANCE_NEGATIVE', {
      walletId,
      bucket,
      current: wallet[bucket],
      delta
    });
  }
}

function applyLines(state, lines) {
  for (const line of lines) {
    if (!line.walletId) continue;
    const wallet = getWallet(state, line.walletId);
    const delta = bucketDelta(line);
    wallet[line.bucket] = roundTo(wallet[line.bucket] + delta);
    wallet.equity = roundTo(wallet.available + wallet.locked);
    wallet.updatedAt = nowIso();
  }
}

export function postJournal(state, input) {
  const createdAt = nowIso();
  const lines = input.lines.map((line) => ({
    account: line.account,
    walletId: line.walletId ?? null,
    userId: line.userId ?? null,
    bucket: line.bucket ?? null,
    asset: line.asset ?? ASSET,
    direction: line.direction,
    amount: roundTo(line.amount),
    memo: line.memo ?? ''
  }));

  validateLines(lines);
  validateWalletDeltas(state, lines);

  const entry = {
    id: makeId('led'),
    transactionId: makeId('txn'),
    type: input.type,
    referenceType: input.referenceType ?? 'manual',
    referenceId: input.referenceId ?? null,
    description: input.description ?? '',
    createdBy: input.createdBy ?? 'system',
    createdAt,
    lines
  };

  state.ledgerEntries.push(entry);
  applyLines(state, lines);
  return entry;
}

export function systemLine(account, direction, amount, memo = '') {
  return {
    account,
    walletId: null,
    userId: null,
    bucket: null,
    asset: ASSET,
    direction,
    amount,
    memo
  };
}

export function walletLine(wallet, bucket, direction, amount, memo = '') {
  if (!wallet) throw new AppError(404, 'Wallet not found', 'WALLET_NOT_FOUND');
  return {
    account: LEDGER_ACCOUNT.USER_WALLET,
    walletId: wallet.id,
    userId: wallet.userId,
    bucket,
    asset: wallet.asset,
    direction,
    amount,
    memo
  };
}
