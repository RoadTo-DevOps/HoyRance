import { ORDER_SIDE, TIMEFRAMES } from '../shared/constants.js';
import { roundTo, roundToTick } from '../shared/calculations.js';
import { AppError, assertApp } from '../lib/errors.js';
import { makeId } from '../lib/id.js';

const BINANCE_FUTURES_BASE_URL = process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com';
const ALLOW_SIMULATED_MARKET = false;
const KLINE_SYNC_INTERVAL_MS = 60_000;
const LIVE_PRICE_MAX_AGE_MS = 20_000;
const LIVE_TICK_INTERVAL_MS = 5_000;
const TICKER_24H_SYNC_INTERVAL_MS = 10_000;
const BINANCE_INTERVALS = Object.freeze({
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d'
});

export function getSymbol(state, symbolName) {
  return state.symbols.find((symbol) => symbol.symbol === String(symbolName ?? '').toUpperCase());
}

export function requireSymbol(state, symbolName) {
  const symbol = getSymbol(state, symbolName);
  assertApp(symbol, 404, 'Symbol not found', 'SYMBOL_NOT_FOUND');
  assertApp(symbol.status === 'TRADING', 400, 'Symbol is not trading', 'SYMBOL_NOT_TRADING');
  return symbol;
}

function appendCandle(candles, timeframeSeconds, price, volume, nowMs) {
  const bucket = Math.floor(nowMs / (timeframeSeconds * 1000)) * timeframeSeconds * 1000;
  const last = candles[candles.length - 1];

  if (last && last.openTime === bucket) {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
    last.volume = roundTo(last.volume + volume, 4);
    return;
  }

  candles.push({
    openTime: bucket,
    closeTime: bucket + timeframeSeconds * 1000 - 1,
    open: price,
    high: price,
    low: price,
    close: price,
    volume
  });

  if (candles.length > 400) {
    candles.splice(0, candles.length - 400);
  }
}

function ensureMarketCollections(state, symbolName) {
  if (!state.market) state.market = { candles: {}, recentTrades: {} };
  if (!state.market.candles[symbolName]) state.market.candles[symbolName] = {};
  if (!state.market.recentTrades[symbolName]) state.market.recentTrades[symbolName] = [];
  if (!state.market.klineSyncedAt) state.market.klineSyncedAt = {};
  for (const timeframe of Object.keys(TIMEFRAMES)) {
    if (!state.market.candles[symbolName][timeframe]) state.market.candles[symbolName][timeframe] = [];
  }
}

function randomWalk(symbol) {
  const baseMove = symbol.markPrice * (0.00025 + Math.random() * 0.00075);
  const direction = Math.random() > 0.5 ? 1 : -1;
  const pullToIndex = (symbol.indexPrice - symbol.markPrice) * 0.08;
  return roundToTick(Math.max(symbol.tickSize, symbol.markPrice + direction * baseMove + pullToIndex), symbol.tickSize);
}

async function fetchBinanceJson(pathname, searchParams = {}) {
  const url = new URL(pathname, BINANCE_FUTURES_BASE_URL);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(6000)
  });
  if (!response.ok) {
    throw new Error(`Binance API ${response.status} for ${pathname}`);
  }
  return response.json();
}

function toMap(items, key = 'symbol') {
  return new Map(items.map((item) => [item[key], item]));
}

function toCandle(row) {
  return {
    openTime: Number(row[0]),
    closeTime: Number(row[6]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5])
  };
}

async function syncBinanceKlineForTimeframe(state, symbol, timeframe) {
  const now = Date.now();
  ensureMarketCollections(state, symbol.symbol);
  const binanceInterval = BINANCE_INTERVALS[timeframe];
  if (!binanceInterval) return;
  const key = `${symbol.symbol}:${timeframe}`;
  const lastSyncedAt = state.market.klineSyncedAt[key] ?? 0;
  if (now - lastSyncedAt < KLINE_SYNC_INTERVAL_MS) return;

  const rows = await fetchBinanceJson('/fapi/v1/klines', {
    symbol: symbol.symbol,
    interval: binanceInterval,
    limit: '240'
  });
  state.market.candles[symbol.symbol][timeframe] = rows.map(toCandle);
  state.market.klineSyncedAt[key] = now;
}

async function tickBinanceMarket(state) {
  const symbols = state.symbols.map((symbol) => symbol.symbol);
  const symbolsParam = JSON.stringify(symbols);
  const [prices, premiumIndexes] = await Promise.all([
    fetchBinanceJson('/fapi/v1/ticker/price', { symbols: symbolsParam }),
    fetchBinanceJson('/fapi/v1/premiumIndex')
  ]);
  const priceMap = toMap(Array.isArray(prices) ? prices : [prices]);
  const premiumMap = toMap(Array.isArray(premiumIndexes) ? premiumIndexes : [premiumIndexes]);
  const nowMs = Date.now();

  if (!state.market.tickers24hBySymbol) state.market.tickers24hBySymbol = {};
  if (!state.market.lastTicker24hSyncAt || nowMs - new Date(state.market.lastTicker24hSyncAt).getTime() > TICKER_24H_SYNC_INTERVAL_MS) {
    try {
      const tickers24h = await Promise.all(symbols.map((symbolName) => fetchBinanceJson('/fapi/v1/ticker/24hr', { symbol: symbolName })));
      state.market.tickers24hBySymbol = Object.fromEntries(tickers24h.map((ticker) => [ticker.symbol, ticker]));
      state.market.lastTicker24hSyncAt = new Date(nowMs).toISOString();
      state.market.lastStatsError = null;
    } catch (error) {
      state.market.lastStatsError = error.message;
      state.market.lastStatsErrorAt = new Date(nowMs).toISOString();
    }
  }

  for (const symbol of state.symbols) {
    ensureMarketCollections(state, symbol.symbol);
    const priceTicker = priceMap.get(symbol.symbol);
    const premium = premiumMap.get(symbol.symbol);
    const ticker24h = state.market.tickers24hBySymbol[symbol.symbol];
    if (!priceTicker && !premium) continue;

    const previous = symbol.markPrice;
    const lastPrice = Number(priceTicker?.price ?? premium?.markPrice ?? previous);
    const markPrice = Number(premium?.markPrice ?? lastPrice);
    const indexPrice = Number(premium?.indexPrice ?? markPrice);
    const fundingRate = Number(premium?.lastFundingRate ?? symbol.fundingRate);
    const highPrice = Number(ticker24h?.highPrice ?? symbol.highPrice24h ?? markPrice);
    const lowPrice = Number(ticker24h?.lowPrice ?? symbol.lowPrice24h ?? markPrice);
    const volume24h = Number(ticker24h?.volume ?? symbol.volume24h);
    const priceChangePercent = Number(ticker24h?.priceChangePercent ?? symbol.priceChangePercent ?? 0);

    symbol.lastPrice = roundToTick(lastPrice, symbol.tickSize);
    symbol.indexPrice = roundToTick(indexPrice, symbol.tickSize);
    symbol.markPrice = roundToTick(markPrice, symbol.tickSize);
    symbol.priceChange = roundTo(symbol.markPrice - previous);
    symbol.priceChangePercent = roundTo(priceChangePercent, 4);
    symbol.highPrice24h = roundToTick(highPrice, symbol.tickSize);
    symbol.lowPrice24h = roundToTick(lowPrice, symbol.tickSize);
    symbol.volume24h = roundTo(volume24h);
    symbol.fundingRate = Number.isFinite(fundingRate) ? fundingRate : symbol.fundingRate;
    if (premium?.nextFundingTime) {
      symbol.nextFundingAt = new Date(Number(premium.nextFundingTime)).toISOString();
    }
    symbol.updatedAt = new Date(nowMs).toISOString();

    for (const [timeframe, seconds] of Object.entries(TIMEFRAMES)) {
      appendCandle(state.market.candles[symbol.symbol][timeframe], seconds, symbol.markPrice, Math.max(1, volume24h / 86400), nowMs);
    }

    state.market.recentTrades[symbol.symbol].unshift({
      id: makeId('mtr'),
      symbol: symbol.symbol,
      side: symbol.priceChange >= 0 ? ORDER_SIDE.BUY : ORDER_SIDE.SELL,
      price: symbol.markPrice,
      quantity: roundTo(Math.max(0.001, volume24h / 1_000_000), 4),
      createdAt: new Date(nowMs).toISOString()
    });
    state.market.recentTrades[symbol.symbol] = state.market.recentTrades[symbol.symbol].slice(0, 40);
  }

  state.market.source = 'binance';
  state.market.lastLiveSyncAt = new Date(nowMs).toISOString();
  state.market.lastLiveError = null;
  state.market.lastLiveErrorAt = null;
}

function tickSimulatedMarket(state) {
  const nowMs = Date.now();

  for (const symbol of state.symbols) {
    ensureMarketCollections(state, symbol.symbol);
    const previous = symbol.markPrice;
    const lastPrice = randomWalk(symbol);
    const indexNoise = (Math.random() - 0.5) * symbol.tickSize * 8;
    const indexPrice = roundToTick(Math.max(symbol.tickSize, lastPrice + indexNoise), symbol.tickSize);
    const markPrice = roundToTick(lastPrice * (1 + symbol.fundingRate * 0.15), symbol.tickSize);
    const volume = roundTo(1 + Math.random() * 12, 4);

    symbol.lastPrice = lastPrice;
    symbol.indexPrice = indexPrice;
    symbol.markPrice = markPrice;
    symbol.priceChange = roundTo(markPrice - previous);
    symbol.priceChangePercent = previous > 0 ? roundTo(((markPrice - previous) / previous) * 100, 4) : 0;
    symbol.volume24h = roundTo(symbol.volume24h * 0.999 + volume);
    symbol.updatedAt = new Date(nowMs).toISOString();

    for (const [timeframe, seconds] of Object.entries(TIMEFRAMES)) {
      appendCandle(state.market.candles[symbol.symbol][timeframe], seconds, markPrice, volume, nowMs);
    }

    const side = Math.random() > 0.5 ? ORDER_SIDE.BUY : ORDER_SIDE.SELL;
    state.market.recentTrades[symbol.symbol].unshift({
      id: makeId('mtr'),
      symbol: symbol.symbol,
      side,
      price: markPrice,
      quantity: roundTo(0.01 + Math.random() * 1.5, 4),
      createdAt: new Date(nowMs).toISOString()
    });
    state.market.recentTrades[symbol.symbol] = state.market.recentTrades[symbol.symbol].slice(0, 40);
  }
  state.market.source = 'simulated';
}

export async function tickMarket(state) {
  const now = Date.now();
  const lastLiveSyncAt = state.market?.lastLiveSyncAt ? new Date(state.market.lastLiveSyncAt).getTime() : 0;
  if (state.market?.source === 'binance' && now - lastLiveSyncAt < LIVE_TICK_INTERVAL_MS) {
    return;
  }
  const nextRetryAt = state.market?.nextLiveRetryAt ? new Date(state.market.nextLiveRetryAt).getTime() : 0;
  if (nextRetryAt && now < nextRetryAt) {
    throw new AppError(503, 'Live Binance market data is unavailable', 'MARKET_DATA_UNAVAILABLE', {
      retryAt: state.market.nextLiveRetryAt,
      lastLiveError: state.market.lastLiveError ?? null,
      lastLiveErrorAt: state.market.lastLiveErrorAt ?? null
    });
  }

  try {
    await tickBinanceMarket(state);
    state.market.nextLiveRetryAt = null;
    return;
  } catch (error) {
    state.market.source = 'error';
    state.market.lastLiveError = error.message;
    state.market.lastLiveErrorAt = new Date().toISOString();
    state.market.nextLiveRetryAt = new Date(Date.now() + (error.message.includes('418') ? 30_000 : 10_000)).toISOString();

    if (!ALLOW_SIMULATED_MARKET) {
      throw new AppError(503, 'Live Binance market data is unavailable', 'MARKET_DATA_UNAVAILABLE', {
        lastLiveError: error.message,
        lastLiveErrorAt: state.market.lastLiveErrorAt
      });
    }
  }

  tickSimulatedMarket(state);
}

export function buildOrderBook(symbol, depth = 14) {
  const bids = [];
  const asks = [];
  const mid = symbol.markPrice;

  for (let index = 1; index <= depth; index += 1) {
    const spread = symbol.tickSize * (index + 1);
    const quantityBase = Math.max(0.01, (depth - index + 1) * 0.18);
    bids.push({
      price: roundToTick(mid - spread, symbol.tickSize),
      quantity: roundTo(quantityBase + Math.random() * quantityBase, 4)
    });
    asks.push({
      price: roundToTick(mid + spread, symbol.tickSize),
      quantity: roundTo(quantityBase + Math.random() * quantityBase, 4)
    });
  }

  return { bids, asks };
}

export async function getMarketSnapshot(state, symbolName = 'BTCUSDT', timeframe = '1m') {
  const symbol = requireSymbol(state, symbolName);
  const safeTimeframe = TIMEFRAMES[timeframe] ? timeframe : '1m';
  ensureMarketCollections(state, symbol.symbol);
  const liveSyncedAt = state.market.lastLiveSyncAt ? new Date(state.market.lastLiveSyncAt).getTime() : 0;
  const liveIsFresh = state.market.source === 'binance' && Date.now() - liveSyncedAt <= LIVE_PRICE_MAX_AGE_MS;

  if (!liveIsFresh && !ALLOW_SIMULATED_MARKET) {
    assertApp(false, 503, 'Live Binance market data is unavailable', 'MARKET_DATA_UNAVAILABLE', {
      source: state.market.source ?? 'unknown',
      lastLiveSyncAt: state.market.lastLiveSyncAt ?? null,
      lastLiveError: state.market.lastLiveError ?? null,
      lastLiveErrorAt: state.market.lastLiveErrorAt ?? null
    });
  }

  if (!ALLOW_SIMULATED_MARKET) {
    try {
      await syncBinanceKlineForTimeframe(state, symbol, safeTimeframe);
    } catch (error) {
      state.market.source = 'error';
      state.market.lastLiveError = error.message;
      state.market.lastLiveErrorAt = new Date().toISOString();
      assertApp(false, 503, 'Live Binance chart data is unavailable', 'MARKET_DATA_UNAVAILABLE', {
        source: state.market.source,
        lastLiveSyncAt: state.market.lastLiveSyncAt ?? null,
        lastLiveError: state.market.lastLiveError,
        lastLiveErrorAt: state.market.lastLiveErrorAt
      });
    }
  }

  return {
    symbol,
    timeframe: safeTimeframe,
    source: state.market.source ?? 'simulated',
    lastLiveSyncAt: state.market.lastLiveSyncAt ?? null,
    lastLiveError: state.market.lastLiveError ?? null,
    lastStatsError: state.market.lastStatsError ?? null,
    candles: state.market.candles[symbol.symbol][safeTimeframe].slice(-240),
    orderBook: buildOrderBook(symbol),
    recentTrades: state.market.recentTrades[symbol.symbol].slice(0, 40)
  };
}
