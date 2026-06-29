import { roundTo } from '../shared/calculations.js';
import { publicUser } from './authService.js';
import { getMarketSnapshot } from './marketDataService.js';
import { listNotifications } from './notificationService.js';
import { listOpenPositions } from '../engines/positionEngine.js';
import { listWallets } from './walletService.js';

function userLedgerEntries(state, userId, limit = 80) {
  return state.ledgerEntries
    .filter((entry) => entry.lines.some((line) => line.userId === userId))
    .slice(-limit)
    .reverse();
}

function sumSince(items, dateField, sinceMs, mapper) {
  return items
    .filter((item) => new Date(item[dateField]).getTime() >= sinceMs)
    .reduce((sum, item) => sum + mapper(item), 0);
}

function buildPnlSummary(state, userId) {
  const now = Date.now();
  const windows = {
    day: now - 24 * 60 * 60 * 1000,
    week: now - 7 * 24 * 60 * 60 * 1000,
    month: now - 30 * 24 * 60 * 60 * 1000
  };
  const trades = state.trades.filter((trade) => trade.userId === userId);
  const funding = state.fundingRecords.filter((record) => record.userId === userId);
  const positions = listOpenPositions(state, userId);
  const unrealized = positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);

  const result = {};
  for (const [name, since] of Object.entries(windows)) {
    const realized = sumSince(trades, 'createdAt', since, (trade) => trade.realizedPnl - trade.fee);
    const fundingPnl = sumSince(funding, 'createdAt', since, (record) => record.amount);
    result[name] = {
      realized: roundTo(realized),
      funding: roundTo(fundingPnl),
      unrealized: roundTo(unrealized),
      total: roundTo(realized + fundingPnl + unrealized)
    };
  }

  return result;
}

export async function buildUserSnapshot(state, user, options = {}) {
  const symbol = options.symbol ?? state.symbols[0]?.symbol ?? 'BTCUSDT';
  const timeframe = options.timeframe ?? '1m';
  const userOrders = state.orders.filter((order) => order.userId === user.id);
  const userTrades = state.trades.filter((trade) => trade.userId === user.id);
  const market = await getMarketSnapshot(state, symbol, timeframe);

  return {
    user: publicUser(user),
    serverTime: new Date().toISOString(),
    symbols: state.symbols,
    selectedSymbol: symbol,
    market,
    wallets: listWallets(state, user.id),
    positions: listOpenPositions(state, user.id),
    openOrders: userOrders.filter((order) => ['OPEN', 'PARTIALLY_FILLED'].includes(order.status)),
    orders: userOrders.slice(-120).reverse(),
    trades: userTrades.slice(0, 120),
    fundingRecords: state.fundingRecords.filter((record) => record.userId === user.id).slice(0, 80),
    liquidationRecords: state.liquidationRecords.filter((record) => record.userId === user.id).slice(0, 50),
    ledgerEntries: userLedgerEntries(state, user.id),
    notifications: listNotifications(state, user.id),
    pnl: buildPnlSummary(state, user.id)
  };
}
