export const ASSET = 'USDT';

export const WALLET_TYPES = Object.freeze({
  SPOT: 'spot',
  FUTURES: 'futures'
});

export const USER_ROLES = Object.freeze({
  USER: 'user',
  ADMIN: 'admin'
});

export const USER_STATUS = Object.freeze({
  ACTIVE: 'active',
  FROZEN: 'frozen',
  DISABLED: 'disabled'
});

export const ORDER_SIDE = Object.freeze({
  BUY: 'BUY',
  SELL: 'SELL'
});

export const POSITION_SIDE = Object.freeze({
  LONG: 'LONG',
  SHORT: 'SHORT'
});

export const ORDER_TYPE = Object.freeze({
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  STOP_MARKET: 'STOP_MARKET',
  TAKE_PROFIT_MARKET: 'TAKE_PROFIT_MARKET'
});

export const ORDER_STATUS = Object.freeze({
  OPEN: 'OPEN',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELED: 'CANCELED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED'
});

export const POSITION_STATUS = Object.freeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  LIQUIDATED: 'LIQUIDATED'
});

export const MARGIN_MODE = Object.freeze({
  ISOLATED: 'isolated',
  CROSS: 'cross'
});

export const LEDGER_ACCOUNT = Object.freeze({
  USER_WALLET: 'USER_WALLET',
  SYSTEM_DEMO: 'SYSTEM_DEMO',
  SYSTEM_FEE: 'SYSTEM_FEE',
  SYSTEM_PNL: 'SYSTEM_PNL',
  SYSTEM_FUNDING: 'SYSTEM_FUNDING',
  SYSTEM_LIQUIDATION: 'SYSTEM_LIQUIDATION'
});

export const TIMEFRAMES = Object.freeze({
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400
});

export const DEFAULT_SYMBOLS = Object.freeze([
  {
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: ASSET,
    tickSize: 0.1,
    stepSize: 0.001,
    minNotional: 5,
    maxLeverage: 50,
    maxOrderNotional: 500000,
    maintenanceMarginRate: 0.004,
    liquidationFeeRate: 0.002,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
    fundingRate: 0.0001,
    fundingIntervalMinutes: 480,
    initialPrice: 65000
  },
  {
    symbol: 'ETHUSDT',
    baseAsset: 'ETH',
    quoteAsset: ASSET,
    tickSize: 0.01,
    stepSize: 0.001,
    minNotional: 5,
    maxLeverage: 75,
    maxOrderNotional: 300000,
    maintenanceMarginRate: 0.005,
    liquidationFeeRate: 0.002,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
    fundingRate: 0.00008,
    fundingIntervalMinutes: 480,
    initialPrice: 3500
  },
  {
    symbol: 'BNBUSDT',
    baseAsset: 'BNB',
    quoteAsset: ASSET,
    tickSize: 0.01,
    stepSize: 0.01,
    minNotional: 5,
    maxLeverage: 50,
    maxOrderNotional: 200000,
    maintenanceMarginRate: 0.006,
    liquidationFeeRate: 0.002,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
    fundingRate: -0.00003,
    fundingIntervalMinutes: 480,
    initialPrice: 580
  }
]);

export const EPSILON = 1e-8;
