import crypto from 'node:crypto';
import { USER_ROLES, USER_STATUS, WALLET_TYPES } from '../shared/constants.js';
import { requiredString } from '../shared/validation.js';
import { assertApp } from '../lib/errors.js';
import { makeId, nowIso } from '../lib/id.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { createDefaultWallets, topUp } from './walletService.js';
import { pushNotification } from './notificationService.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24;

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, twoFactorSecret, ...safeUser } = user;
  return safeUser;
}

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function register(state, input) {
  const email = normalizeEmail(requiredString(input, 'email'));
  const password = requiredString(input, 'password');
  const phone = optionalString(input, 'phone');

  assertApp(password.length >= 8, 400, 'Password must be at least 8 characters', 'PASSWORD_WEAK');
  assertApp(!state.users.some((user) => user.email === email), 409, 'Email already exists', 'EMAIL_EXISTS');

  const createdAt = nowIso();
  const user = {
    id: makeId('usr'),
    email,
    phone,
    passwordHash: hashPassword(password),
    twoFactorEnabled: false,
    twoFactorSecret: null,
    status: USER_STATUS.ACTIVE,
    tradingLocked: false,
    role: USER_ROLES.USER,
    demoTier: 'standard',
    maxLeverageOverride: null,
    createdAt,
    updatedAt: createdAt,
    lastLoginAt: null,
    devices: []
  };

  state.users.push(user);
  createDefaultWallets(state, user.id);
  topUp(state, {
    userId: user.id,
    walletType: WALLET_TYPES.FUTURES,
    amount: 50000,
    actorId: 'system',
    reason: 'New demo account futures balance'
  });
  topUp(state, {
    userId: user.id,
    walletType: WALLET_TYPES.SPOT,
    amount: 1000,
    actorId: 'system',
    reason: 'New demo account spot balance'
  });
  pushNotification(state, {
    userId: user.id,
    type: 'welcome',
    title: 'Demo account ready',
    message: 'Virtual balances were credited to your account.'
  });

  return publicUser(user);
}

export function login(state, input, requestMeta = {}) {
  const email = normalizeEmail(requiredString(input, 'email'));
  const password = requiredString(input, 'password');
  const user = state.users.find((item) => item.email === email);

  assertApp(user && verifyPassword(password, user.passwordHash), 401, 'Invalid email or password', 'AUTH_INVALID');
  assertApp(user.status !== USER_STATUS.DISABLED, 403, 'Account is disabled', 'ACCOUNT_DISABLED');

  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session = {
    id: makeId('ses'),
    userId: user.id,
    token,
    ip: requestMeta.ip ?? '',
    userAgent: requestMeta.userAgent ?? '',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    lastSeenAt: new Date(now).toISOString()
  };

  state.sessions.push(session);
  user.lastLoginAt = session.createdAt;
  user.updatedAt = session.createdAt;
  user.devices.unshift({
    ip: session.ip,
    userAgent: session.userAgent,
    seenAt: session.createdAt
  });
  user.devices = user.devices.slice(0, 8);

  return { token, user: publicUser(user) };
}

export function authenticate(state, token) {
  const value = String(token ?? '').trim();
  assertApp(value, 401, 'Missing auth token', 'AUTH_MISSING');
  const session = state.sessions.find((item) => item.token === value);
  assertApp(session, 401, 'Invalid auth token', 'AUTH_INVALID');
  assertApp(new Date(session.expiresAt).getTime() > Date.now(), 401, 'Session expired', 'AUTH_EXPIRED');

  const user = state.users.find((item) => item.id === session.userId);
  assertApp(user, 401, 'User not found', 'AUTH_INVALID');
  assertApp(user.status !== USER_STATUS.DISABLED, 403, 'Account is disabled', 'ACCOUNT_DISABLED');
  session.lastSeenAt = nowIso();
  return user;
}

export function logout(state, token) {
  const before = state.sessions.length;
  state.sessions = state.sessions.filter((session) => session.token !== token);
  return { removed: before - state.sessions.length };
}
