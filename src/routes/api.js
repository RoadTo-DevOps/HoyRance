import { URL } from 'node:url';
import { USER_ROLES, WALLET_TYPES } from '../shared/constants.js';
import { assertApp, toHttpError } from '../lib/errors.js';
import { authenticate, login, logout, publicUser, register } from '../services/authService.js';
import { adjustUserBalance, assertAdmin, auditAdminAction, getAdminOverview, listUsersForAdmin, updateSymbolConfig, updateUserControls } from '../services/adminService.js';
import { applyDueFunding } from '../services/fundingService.js';
import { getMarketSnapshot, tickMarket } from '../services/marketDataService.js';
import { buildUserSnapshot } from '../services/snapshotService.js';
import { cancelOrder, closePosition, placeOrder, processOpenOrders } from '../services/orderService.js';
import { scanLiquidations } from '../engines/liquidationEngine.js';
import { topUp, transfer } from '../services/walletService.js';

const routes = [];

function add(method, pattern, options, handler) {
  routes.push({
    method,
    pattern,
    options,
    handler,
    matcher: compilePattern(pattern)
  });
}

function compilePattern(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const regex = new RegExp(`^${source}$`);
  return (pathname) => {
    const match = regex.exec(pathname);
    if (!match) return null;
    return keys.reduce((params, key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
      return params;
    }, {});
  };
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'vary': 'Origin'
  };
}

function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...corsHeaders(req),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    assertApp(total <= 1024 * 1024, 413, 'Request body is too large', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    assertApp(false, 400, 'Request body must be valid JSON', 'JSON_INVALID');
  }
}

function bearerToken(req, query) {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return query.get('token') ?? '';
}

function requestMeta(req) {
  return {
    ip: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'] ?? ''
  };
}

function findRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = route.matcher(pathname);
    if (params) return { route, params };
  }
  return null;
}

add('POST', '/api/auth/register', {}, ({ state, body }) => register(state, body));

add('POST', '/api/auth/login', {}, ({ state, body, req }) => login(state, body, requestMeta(req)));

add('POST', '/api/auth/logout', { auth: true }, ({ state, token }) => logout(state, token));

add('GET', '/api/me', { auth: true }, ({ user }) => publicUser(user));

add('GET', '/api/snapshot', { auth: true }, ({ state, user, query }) => buildUserSnapshot(state, user, {
  symbol: query.get('symbol'),
  timeframe: query.get('timeframe')
}));

add('GET', '/api/market', { auth: true }, ({ state, query }) => getMarketSnapshot(state, query.get('symbol') ?? 'BTCUSDT', query.get('timeframe') ?? '1m'));

add('POST', '/api/wallet/top-up', { auth: true }, ({ state, user, body }) => {
  const amount = Number(body.amount);
  assertApp(Number.isFinite(amount) && amount > 0 && amount <= 100000, 400, 'Top-up amount must be from 0 to 100000', 'AMOUNT_INVALID');
  return topUp(state, {
    userId: user.id,
    walletType: body.walletType ?? WALLET_TYPES.FUTURES,
    amount,
    actorId: user.id,
    reason: 'User virtual top-up'
  });
});

add('POST', '/api/wallet/transfer', { auth: true }, ({ state, user, body }) => transfer(state, {
  userId: user.id,
  fromWalletType: body.fromWalletType,
  toWalletType: body.toWalletType,
  amount: Number(body.amount)
}));

add('POST', '/api/orders', { auth: true }, ({ state, user, body }) => placeOrder(state, user, body));

add('POST', '/api/orders/:id/cancel', { auth: true }, ({ state, user, params }) => cancelOrder(state, user, params.id));

add('POST', '/api/positions/:id/close', { auth: true }, ({ state, user, params }) => closePosition(state, user, params.id));

add('GET', '/api/admin/overview', { auth: true, admin: true }, ({ state }) => getAdminOverview(state));

add('GET', '/api/admin/users', { auth: true, admin: true }, ({ state }) => listUsersForAdmin(state));

add('PATCH', '/api/admin/users/:id', { auth: true, admin: true }, ({ state, user, params, body }) => updateUserControls(state, {
  actorId: user.id,
  userId: params.id,
  status: body.status,
  tradingLocked: body.tradingLocked,
  maxLeverageOverride: body.maxLeverageOverride
}));

add('POST', '/api/admin/users/:id/balance-adjustments', { auth: true, admin: true }, ({ state, user, params, body }) => adjustUserBalance(state, {
  actorId: user.id,
  userId: params.id,
  walletType: body.walletType ?? WALLET_TYPES.FUTURES,
  amount: Number(body.amount),
  reason: body.reason ?? 'Admin balance adjustment'
}));

add('PATCH', '/api/admin/symbols/:symbol', { auth: true, admin: true }, ({ state, user, params, body }) => updateSymbolConfig(state, {
  actorId: user.id,
  symbolName: params.symbol,
  patch: body
}));

add('GET', '/api/admin/audit-logs', { auth: true, admin: true }, ({ state }) => state.adminAuditLogs.slice(0, 120));

add('POST', '/api/admin/market/tick', { auth: true, admin: true }, async ({ state, user, req }) => {
  await tickMarket(state);
  processOpenOrders(state);
  scanLiquidations(state);
  applyDueFunding(state);
  auditAdminAction(state, {
    actorId: user.id,
    action: 'manual_market_tick',
    ip: req.socket.remoteAddress
  });
  return { ok: true };
});

export async function handleApi(req, res, store) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const matched = findRoute(req.method, url.pathname);

  if (!matched) {
    sendJson(req, res, 404, { ok: false, error: 'API route not found', code: 'ROUTE_NOT_FOUND' });
    return;
  }

  try {
    const body = await readBody(req);
    const token = bearerToken(req, url.searchParams);
    const runStoreTask = req.method === 'GET' || req.method === 'HEAD'
      ? store.read.bind(store)
      : store.transact.bind(store);
    const data = await runStoreTask((state) => {
      let user = null;
      if (matched.route.options.auth) {
        user = authenticate(state, token);
        if (matched.route.options.admin) {
          assertAdmin(user);
        }
      }

      return matched.route.handler({
        state,
        user,
        token,
        body,
        query: url.searchParams,
        params: matched.params,
        req
      });
    });

    sendJson(req, res, 200, { ok: true, data });
  } catch (error) {
    if (error.status !== 404 && error.status !== 400 && error.status !== 401 && error.status !== 403) {
      console.error(error);
    }
    const httpError = toHttpError(error);
    sendJson(req, res, httpError.status, httpError.body);
  }
}
