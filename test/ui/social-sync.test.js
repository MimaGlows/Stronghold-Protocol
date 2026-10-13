import { test } from 'node:test';
import assert from 'node:assert/strict';
import { net } from '../../public/js/net.js';
import { beginSocialProfile, socialStore, installSocial, socialAction, socialSearchQuery, notifyInvite, inviteNotificationText, notificationAvailability, enableInviteNotifications } from '../../public/js/ui/social.js';

test('social responses, late requests, avatars and invitations cannot cross pseudo-account boundaries', async (t) => {
  const original = { request: net.request, name: net.name, status: net.status, listeners: net._listeners };
  net._listeners = new Map(); net.request = async () => ({ t: 'ok' }); net.status = 'online';
  t.after(() => { beginSocialProfile(null); Object.assign(net, { request: original.request, name: original.name, status: original.status, _listeners: original.listeners }); });
  installSocial(); net.name = '甲#0001'; net._emit('welcome', { name: '甲', doctorCode: '0001' });
  assert.equal(socialSearchQuery('', '0001'), null); assert.equal(socialSearchQuery('乙', '001'), null);
  assert.equal(socialSearchQuery(' 乙 ', ''), null); assert.equal(socialSearchQuery('乙', '0001'), '乙#0001');
  socialStore.set({ query: '乙', code: '0001' });
  net._emit('social.search', { profileKey: '甲#0001', query: '旧查询', entries: [{ identity: '旧账号#0001' }] }); assert.equal(socialStore.get().search, null);
  net._emit('social.search', { profileKey: '甲#0001', query: '乙#0001', entries: [{ identity: '乙#0001' }], truncated: false }); assert.equal(socialStore.get().search.length, 1);
  const row = { identity: '乙#0001', avatarRevision: 'old', status: 'online' };
  net._emit('social.state', { profileKey: '甲#0001', friends: [row], recent: [] }); socialStore.set({ open: true });
  net._emit('social.avatar', { profileKey: '甲#0001', identity: row.identity, avatarRevision: 'other', avatar: { kind: 'default' } });
  assert.deepEqual(socialStore.get().avatars, {});
  net._emit('social.invite', { profileKey: '甲#0001', inviteId: 'a'.repeat(32), expiresAt: 200, serverNow: 100 });
  assert.equal(socialStore.get().invites.length, 1);
  let finish; net.request = () => new Promise((resolve) => { finish = resolve; });
  const operation = socialAction('social.add', { identity: '乙#0001' });
  net._emit('profileChanging', { name: '甲#0002' }); net.name = '甲#0002'; finish();
  assert.equal(await operation, false); assert.equal(socialStore.get().open, false); assert.equal(socialStore.get().invites.length, 0);
  net._emit('social.state', { profileKey: '甲#0001', friends: [row], recent: [] });
  net._emit('social.presence', { profileKey: '甲#0001', entries: [row] });
  net._emit('social.search', { profileKey: '甲#0001', query: '乙', entries: [row] }); assert.equal(socialStore.get().search, null);
  net._emit('social.invite', { profileKey: '甲#0001', inviteId: 'a'.repeat(32), expiresAt: 200, serverNow: 100 });
  assert.deepEqual(socialStore.get().friends, []); assert.equal(socialStore.get().ready, false); assert.deepEqual(socialStore.get().invites, []);
  net.request = original.request;
  net._emit('status', { status: 'reconnecting' }); assert.equal(socialStore.get().online, false);
});
test('invitation notifications deduplicate and focus without joining; permission and HTTP fallbacks remain in-game', async (t) => {
  const descriptor = (key) => Object.getOwnPropertyDescriptor(globalThis, key);
  const saved = { Notification: descriptor('Notification'), isSecureContext: descriptor('isSecureContext') }, originalName = net.name;
  t.after(() => { beginSocialProfile(null); net.name = originalName; for (const [key, value] of Object.entries(saved)) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });
  const notices = []; let permissionCalls = 0, focusCalls = 0;
  class NotificationDouble {
    static permission = 'default';
    static async requestPermission() { permissionCalls++; return 'denied'; }
    constructor(title, options) { this.title = title; this.options = options; notices.push(this); }
    close() { this.closed = true; }
  }
  globalThis.Notification = NotificationDouble; globalThis.isSecureContext = false;
  assert.equal(notificationAvailability({}), 'unsupported'); assert.equal(notificationAvailability(), 'insecure');
  await enableInviteNotifications(); assert.equal(permissionCalls, 0); assert.match(socialStore.get().notificationHint, /HTTPS/);
  globalThis.isSecureContext = true; await enableInviteNotifications(); assert.equal(permissionCalls, 1); assert.equal(socialStore.get().notifications, false);
  NotificationDouble.permission = 'denied'; await enableInviteNotifications(); assert.equal(permissionCalls, 1);
  NotificationDouble.permission = 'granted'; net.name = '甲#0001'; beginSocialProfile(net.name); await enableInviteNotifications();
  const storage = new Map(), win = { Notification: NotificationDouble, isSecureContext: true, localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) }, focus: () => focusCalls++ };
  const invite = { inviteId: 'a'.repeat(32), from: '乙#0001', difficulty: 'NORMAL', deadline: Date.now() + 120000 };
  socialStore.set({ invites: [invite] }); notifyInvite(invite, win); notifyInvite(invite, win); assert.equal(notices.length, 1);
  assert.equal(notices[0].title,'乙邀请你加入【险境模拟】【房间】');
  assert.equal(inviteNotificationText({...invite,kind:'matching'}),'乙邀请你加入【险境模拟】【匹配队列】');
  notices[0].onerror(); assert.match(socialStore.get().notificationHint, /无法显示/);
  notices[0].onclick(); assert.equal(focusCalls, 1); assert.equal(socialStore.get().open, true);
  beginSocialProfile('甲#0002'); net.name = '甲#0002'; assert.equal(notices[0].closed, true); notices[0].onclick(); assert.equal(focusCalls, 1);
  socialStore.set({ notifications: true, invites: [invite] }); notifyInvite(invite, { ...win, isSecureContext: false }); assert.equal(notices.length, 1);
});
