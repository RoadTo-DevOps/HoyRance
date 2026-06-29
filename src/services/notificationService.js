import { makeId, nowIso } from '../lib/id.js';

export function pushNotification(state, { userId, type, title, message, level = 'info', meta = {} }) {
  const notification = {
    id: makeId('ntf'),
    userId,
    type,
    title,
    message,
    level,
    meta,
    readAt: null,
    createdAt: nowIso()
  };
  state.notifications.unshift(notification);
  state.notifications = state.notifications.slice(0, 500);
  return notification;
}

export function listNotifications(state, userId, limit = 30) {
  return state.notifications
    .filter((item) => item.userId === userId)
    .slice(0, limit);
}
