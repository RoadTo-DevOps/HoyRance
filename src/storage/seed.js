import { ASSET, DEFAULT_SYMBOLS, TIMEFRAMES, USER_ROLES, USER_STATUS, WALLET_TYPES } from '../shared/constants.js';
import { roundToTick } from '../shared/calculations.js';
import { makeId, nowIso } from '../lib/id.js';
import { hashPassword } from '../lib/passwords.js';

function makeUser({ email, password, role, demoTier = 'standard' }) {
  const createdAt = nowIso();
  return {
    id: makeId('usr'),
    email,
    phone: '',
    passwordHash: hashPassword(password),
    twoFactorEnabled: false,
    twoFactorSecret: null,
    status: USER_STATUS.ACTIVE,
    tradingLocked: false,
    role,
    demoTier,
    maxLeverageOverride: null,
    createdAt,
    updatedAt: createdAt,
    lastLoginAt: null,
    devices: []
  };
}

function makeWallet(userId, type, available = 0, locked = 0) {
  const createdAt = nowIso();
  return {
    id: `${userId}:${type}:${ASSET}`,
    userId,
    type,
    asset: ASSET,
    available,
    locked,
    equity: available + locked,
    createdAt,
    updatedAt: createdAt
  };
}

function makeLedgerEntry({ walletId, userId, amount, type, description }) {
  const id = makeId('led');
  const createdAt = nowIso();
  return {
    id,
    transactionId: id,
    type,
    referenceType: 'seed',
    referenceId: 'initial_seed',
    description,
    createdBy: 'system',
    createdAt,
    lines: [
      {
        account: 'USER_WALLET',
        walletId,
        userId,
        bucket: 'available',
        asset: ASSET,
        direction: 'debit',
        amount
      },
      {
        account: 'SYSTEM_DEMO',
        walletId: null,
        userId: null,
        bucket: null,
        asset: ASSET,
        direction: 'credit',
        amount
      }
    ]
  };
}

function generateCandles(initialPrice, tickSize, timeframeSeconds, count = 220) {
  const now = Date.now();
  const candles = [];
  let close = initialPrice;
  const start = now - count * timeframeSeconds * 1000;

  for (let index = 0; index < count; index += 1) {
    const openTime = start + index * timeframeSeconds * 1000;
    const wave = Math.sin(index / 11) * initialPrice * 0.0018;
    const drift = (index % 9 - 4) * initialPrice * 0.00008;
    const open = close;
    close = Math.max(tickSize, roundToTick(open + wave + drift, tickSize));
    const high = roundToTick(Math.max(open, close) + initialPrice * 0.0015, tickSize);
    const low = roundToTick(Math.max(tickSize, Math.min(open, close) - initialPrice * 0.0015), tickSize);

    candles.push({
      openTime,
      closeTime: openTime + timeframeSeconds * 1000 - 1,
      open,
      high,
      low,
      close,
      volume: Math.round(100 + Math.abs(Math.sin(index / 5)) * 800)
    });
  }

  return candles;
}

function makeSymbol(config) {
  const now = nowIso();
  return {
    ...config,
    status: 'TRADING',
    markPrice: config.initialPrice,
    indexPrice: config.initialPrice,
    lastPrice: config.initialPrice,
    volume24h: Math.round(config.initialPrice * 12),
    openInterest: 0,
    nextFundingAt: new Date(Date.now() + config.fundingIntervalMinutes * 60_000).toISOString(),
    createdAt: now,
    updatedAt: now
  };
}

function makeMarket(symbols) {
  const candles = {};
  const recentTrades = {};

  for (const symbol of symbols) {
    candles[symbol.symbol] = {};
    for (const [timeframe, seconds] of Object.entries(TIMEFRAMES)) {
      candles[symbol.symbol][timeframe] = generateCandles(symbol.initialPrice, symbol.tickSize, seconds);
    }
    recentTrades[symbol.symbol] = [];
  }

  return { candles, recentTrades };
}

export function seedDatabase() {
  const user = makeUser({
    email: 'demo@bainan.test',
    password: 'demo1234',
    role: USER_ROLES.USER
  });
  const admin = makeUser({
    email: 'admin@bainan.test',
    password: 'admin1234',
    role: USER_ROLES.ADMIN,
    demoTier: 'operator'
  });

  const symbols = DEFAULT_SYMBOLS.map(makeSymbol);
  const userSpot = makeWallet(user.id, WALLET_TYPES.SPOT, 5000, 0);
  const userFutures = makeWallet(user.id, WALLET_TYPES.FUTURES, 100000, 0);
  const adminSpot = makeWallet(admin.id, WALLET_TYPES.SPOT, 0, 0);
  const adminFutures = makeWallet(admin.id, WALLET_TYPES.FUTURES, 0, 0);

  return {
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    users: [user, admin],
    sessions: [],
    wallets: [userSpot, userFutures, adminSpot, adminFutures],
    ledgerEntries: [
      makeLedgerEntry({
        walletId: userSpot.id,
        userId: user.id,
        amount: userSpot.available,
        type: 'seed_spot_balance',
        description: 'Initial spot demo balance'
      }),
      makeLedgerEntry({
        walletId: userFutures.id,
        userId: user.id,
        amount: userFutures.available,
        type: 'seed_futures_balance',
        description: 'Initial futures demo balance'
      })
    ],
    symbols,
    orders: [],
    trades: [],
    positions: [],
    fundingRecords: [],
    virtualBalanceAdjustments: [],
    adminAuditLogs: [],
    notifications: [],
    liquidationRecords: [],
    market: makeMarket(symbols)
  };
}
