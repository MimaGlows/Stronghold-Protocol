// SP_SOCIAL_E2E=1 node --test test/ui/social.e2e.test.js (Chrome, optional SP_CHROME_PATH).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';
const chrome = [process.env.SP_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => p && fs.existsSync(p));
const enabled = process.env.SP_SOCIAL_E2E === '1' && !!chrome;
test('independent Chrome profiles: drawer, invitations, live coop/solo spectators, notifications and landscape layout', { skip: !enabled, timeout: 150000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-social-browser-'));
  const out = path.resolve('test/e2e/out/social'); fs.mkdirSync(out, { recursive: true });
  const server = await startServer({ host: '127.0.0.1', port: 0, quiet: true, profileDir: dir, replayDir: path.join(dir, 'replays') });
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, protocolTimeout: 45000, args: ['--no-first-run', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const stage = (value) => fs.writeFileSync(path.join(out, 'progress.txt'), value);
  const open = async (name, viewport = { width: 1214, height: 801 }, context = null) => {
    context ||= await browser.createBrowserContext(); const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); await page.setViewport(viewport);
    await page.evaluateOnNewDocument(() => {
      globalThis.__notifications = []; globalThis.__permissionRequests = 0; globalThis.__focusRequests = 0;
      // Native OS delivery is not available in headless Chrome; verify the actual browser integration with its API double.
      globalThis.Notification = class {
        static permission = 'default';
        static async requestPermission() { globalThis.__permissionRequests++; this.permission = 'granted'; return 'granted'; }
        constructor(title, options) { this.title = title; this.options = options; globalThis.__notifications.push(this); }
        close() { this.closed = true; }
      };
      globalThis.focus = () => { globalThis.__focusRequests++; };
    });
    await page.goto(server.url, { waitUntil: 'networkidle2' }); await page.waitForSelector('#boot', { hidden: true });
    await page.waitForFunction(() => !!globalThis.__SP__);
    await page.evaluate((value) => globalThis.__SP__.net.setName(value), name);
    await page.waitForFunction((value) => { const me = globalThis.__SP__.store.get().me; return globalThis.__SP__.net.status === 'online' && `${me.name}#${me.doctorCode}` === value; }, {}, name);
    await page.evaluate(() => globalThis.__SP__.store.patch('session', { entered: true }));
    await page.waitForSelector('.friends-handle');
    await page.waitForFunction(async () => (await import('/js/ui/social.js')).socialStore.get().ready);
    return page;
  };
  const request = (page, t, fields = {}) => { stage(`${page.url()} request ${t}`); return page.evaluate((type, value) => globalThis.__SP__.net.request(type, value, { timeout: 8000 }), t, fields); };
  const clickText = (page, selector, text) => page.evaluate((sel, label) => {
    const element = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === label);
    if (!element) throw new Error(`Missing button ${label}`); element.click();
  }, selector, text);
  const openTouchDrawer = async (page) => {
    await page.bringToFront();
    // The handle moves with the drawer. Wait for account-reset/closing motion
    // before tapping so the synthesized touch cannot land at its old position.
    await page.waitForFunction(() => document.querySelector('.friends-handle').getAnimations().every((animation) => animation.playState === 'finished'));
    if (await page.$eval('.friends-handle', (element) => element.getAttribute('aria-expanded')) === 'false') await page.tap('.friends-handle');
    await page.waitForFunction(() => document.querySelector('.friends-handle').getAttribute('aria-expanded') === 'true' && getComputedStyle(document.querySelector('.friends-panel')).transform === 'matrix(1, 0, 0, 1, 0, 0)');
  };
  const friend = '.friends-section:first-child .friend-row';
  try {
    stage('opening profiles');
    const a = await open('好友甲#0001'), b = await open('好友乙#0001');
    assert.equal(await a.$eval('.friends-handle', (e) => e.getAttribute('aria-expanded')), 'false');
    assert.equal(await a.$eval('.friends-panel', (e) => e.inert), true);
    await a.click('.friends-handle'); await a.waitForFunction(() => getComputedStyle(document.querySelector('.friends-panel')).transform === 'matrix(1, 0, 0, 1, 0, 0)');
    {
      server.lobby.profiles.resolve('好友乙', '0002');
      await a.type('.friends-search__code input', '0001'); await a.click('.friends-search button');
      await a.waitForFunction(() => document.querySelector('.friends-note[role="alert"]')?.textContent.includes('不能只输入代码'));
      await a.$eval('.friends-search__code input', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await a.type('.friends-search__name input', '友乙'); await a.click('.friends-search button');
      await a.waitForFunction(() => document.querySelectorAll('.friends-search-result').length === 2);
      await a.$eval('.friends-search__name input', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    }
    await a.type('.friends-search__name input', '好友乙'); await a.type('.friends-search__code input', '0001'); await a.click('.friends-search button');
    await a.waitForSelector('.friends-search-result'); await a.click('.friends-search-result button');
    await a.waitForSelector(friend); assert.equal(await a.$eval(`${friend} strong`, (e) => e.textContent), '好友乙#0001');
    const identityStyle = await a.$eval(`${friend} strong`, (e) => ({ name: parseFloat(getComputedStyle(e).fontSize), code: parseFloat(getComputedStyle(e.querySelector('span')).fontSize), color: getComputedStyle(e.querySelector('span')).color }));
    assert.ok(identityStyle.code < identityStyle.name); assert.equal(identityStyle.color, 'rgb(141, 156, 149)');
    const closeOffset = await a.$eval('.friends-panel>header>button', (e) => { const r = e.getBoundingClientRect(), icon = e.querySelector('svg').getBoundingClientRect(); return Math.abs(r.x + r.width / 2 - icon.x - icon.width / 2) + Math.abs(r.y + r.height / 2 - icon.y - icon.height / 2); });
    assert.ok(closeOffset < 1, 'close icon centered in its button');
    await request(b, 'profile.avatar', { avatar: { kind: 'operator', charId: 'char_103_angel', e2: false } });
    await a.waitForFunction(() => { const img = document.querySelector('.friend-row .avatar img'); return img?.complete && img.naturalWidth > 0; });
    await a.screenshot({ path: path.join(out, 'drawer-desktop.png') });
    assert.equal(await b.evaluate(async () => (await import('/js/ui/social.js')).socialStore.get().friends.length), 0);
    stage('privacy settings and profile history');
    await b.bringToFront(); await b.evaluate(() => globalThis.__SP__.store.patch('session', { entered: false })); await b.waitForSelector('.title-settings'); await b.click('.title-settings');
    await b.waitForSelector('.set-privacy');
    await b.waitForFunction(() => document.querySelector('.modal').getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished'));
    assert.equal(await b.$eval('.set-privacy [aria-label="允许好友观战"]', (el) => el.getAttribute('aria-checked')), 'true');
    assert.equal(await b.$eval('.set-privacy [aria-label="允许好友加入房间"]', (el) => el.getAttribute('aria-checked')), 'true');
    await b.click('.set-privacy [aria-label="允许好友观战"]'); await b.click('.set-privacy [aria-label="允许好友加入房间"]');
    await b.select('.set-privacy__scope', 'friends'); await b.evaluate(() => globalThis.__SP__.net.flushProfilePreferences());
    await b.screenshot({ path: path.join(out, 'privacy-settings.png') });
    await clickText(b, '.modal__actions button', '完成'); await b.evaluate(() => globalThis.__SP__.store.patch('session', { entered: true })); await b.waitForSelector('.friends-handle');
    await request(b, 'social.add', { identity: '好友甲#0001' });
    await a.waitForSelector('.friend-profile-avatar:not(:disabled)'); await a.bringToFront(); await a.click('.friend-profile-avatar');
    await a.waitForFunction(() => document.querySelector('.history-list h2')?.textContent.includes('好友乙#0001'));
    await a.waitForFunction(() => document.querySelector('.history-empty')?.textContent.includes('暂无已结算'));
    await a.screenshot({ path: path.join(out, 'friend-history.png') }); await clickText(a, '.history-overlay button', '关闭');
    const saved = { v: 1, id: '2233ab45-6767-4545-baba-898989898989', key: 'b'.repeat(48), version: server.replays.version, status: 'ready', startedAt: Date.now(), expiresAt: Date.now() + 7200000, durationMs: 0, nodes: [], fields: [], events: [], restrictions: {}, participants: [{ playerId: 'history-a', name: '好友甲', doctorCode: '0001' }, { playerId: 'history-b', name: '好友乙', doctorCode: '0001' }], result: { victory: true, roundsPassed: 1, difficulty: 'NORMAL', modeId: 'mode_multi_normal', players: [{ playerId: 'history-a', name: '好友甲', doctorCode: '0001' }, { playerId: 'history-b', name: '好友乙', doctorCode: '0001' }] } };
    server.replays.write(saved);
    const ticket = { id: saved.id, key: saved.key, startedAt: saved.startedAt };
    server.lobby.profiles.remember(server.lobby.profiles.read('好友乙', '0001'), ticket, 'history-b', saved.result);
    server.lobby.profiles.remember(server.lobby.profiles.read('好友甲', '0001'), ticket, 'history-a', saved.result);
    await a.click('.friend-profile-link'); await a.waitForSelector('.history-row'); await a.click('.history-row'); await a.waitForSelector('.history-result .result');
    assert.equal(await a.$('.history-result .rcard__you'), null, 'another player is not labelled as the viewer');
    assert.equal(await a.evaluate(async () => (await import('/js/replay/history.js')).historyStore.get().items.length), 0, 'viewing another profile does not import their ticket');
    await a.screenshot({ path: path.join(out, 'friend-history-result.png') }); await clickText(a, '.history-overlay button', '返回记录'); await clickText(a, '.history-overlay button', '关闭');
    await request(b, 'profile.privacy', { preferences: { allowFriendJoin: true, allowFriendSpectate: true, profileVisibility: 'friends_recent' } });
    await request(a, 'social.remove', { identity: '好友乙#0001' }); await a.waitForSelector('.friends-section:last-child .friend-profile-link:not(:disabled)');
    await a.click('.friends-section:last-child .friend-profile-link'); await a.waitForSelector('.history-row'); await clickText(a, '.history-overlay button', '关闭'); await request(a, 'social.add', { identity: '好友乙#0001' });
    await request(b, 'social.remove', { identity: '好友甲#0001' });
    await b.click('.friends-handle'); await clickText(b, '.friends-panel footer button', '启用邀请通知');
    assert.equal(await b.evaluate(() => globalThis.__permissionRequests), 1);
    const b2 = await open('好友乙#0001', { width: 1214, height: 801 }, b.browserContext());
    await request(a, 'room.create', { mode: 'coop', difficulty: 'NORMAL' });
    assert.equal(await a.$eval('.friends-handle', (e) => e.getAttribute('aria-expanded')), 'true');
    await a.waitForFunction(() => [...document.querySelectorAll('.friend-row button')].some((e) => e.textContent.trim() === '邀请'));
    await clickText(a, `${friend} button`, '邀请');
    await b.waitForSelector('.social-invite-layer'); await b2.waitForSelector('.social-invite-layer');
    assert.equal(await b.evaluate(() => globalThis.__SP__.store.get().room), null);
    const notificationCount = await b.evaluate(() => globalThis.__notifications.length) + await b2.evaluate(() => globalThis.__notifications.length);
    assert.equal(notificationCount, 1, 'same browser invitation should notify once');
    await b.evaluate(() => globalThis.__notifications[0]?.onclick());
    assert.equal(await b.evaluate(() => globalThis.__focusRequests), 1);
    assert.equal(await b.evaluate(() => globalThis.__SP__.store.get().room), null, 'notification does not auto-join');
    await b.bringToFront();
    await b.waitForFunction(() => document.querySelector('.social-invite-layer .modal').getAnimations({ subtree: true }).every((a) => a.effect.getTiming().iterations === Infinity || a.playState === 'finished'));
    await b.screenshot({ path: path.join(out, 'invite.png') });
    stage('accept invitation');
    await clickText(b, '.social-invite-layer button', '接受邀请');
    await b.waitForFunction(() => !!globalThis.__SP__.store.get().room); await b2.waitForSelector('.social-invite-layer', { hidden: true });
    stage('leave and rejoin through friends');
    await b.bringToFront();
    await b.click('.room-screen [aria-label="离开同盟"]');
    await b.waitForFunction(() => !globalThis.__SP__.store.get().room); await b.bringToFront();
    stage('search host from guest');
    await b.type('.friends-search__name input', '好友甲'); await b.type('.friends-search__code input', '0001');
    stage('submit guest search');
    await b.click('.friends-search button'); await b.waitForSelector('.friends-search-result'); await b.click('.friends-search-result button');
    await b.waitForSelector(`${friend} button`); await clickText(b, `${friend} button`, '加入房间');
    await b.waitForFunction(() => !!globalThis.__SP__.store.get().room);
    stage('start real coop');
    await request(b, 'room.ready', { ready: true }); await request(a, 'room.start');
    await a.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK');
    assert.equal(await a.$('.friends-handle'), null, 'drawer only exists on specified waiting screens');
    await request(b2, 'social.add', { identity: '好友甲#0001' }).catch(() => {});
    await b2.bringToFront(); await b2.click('.friends-handle'); await b2.waitForFunction(() => document.querySelector('.friend-row__status')?.textContent.includes('正在游玩'));
    stage('spectate real coop');
    await clickText(b2, `${friend} button`, '观战');
    await b2.waitForFunction(() => globalThis.__SP__.store.get().room?.spectators.some((s) => s.playerId === globalThis.__SP__.store.get().me.playerId));
    await a.screenshot({ path: path.join(out, 'coop-start.png') });
    const mobile = await open('手机博士#0001', { width: 844, height: 390, isMobile: true, hasTouch: true });
    stage('mobile layout');
    await request(mobile, 'social.add', { identity: '好友甲#0001' });
    await openTouchDrawer(mobile); await mobile.waitForSelector(friend);
    await mobile.waitForFunction(() => document.querySelector('.friends-panel').getBoundingClientRect().right <= innerWidth + 1);
    await mobile.screenshot({ path: path.join(out, 'drawer-mobile.png') });
    const layout = await mobile.$eval('.friends-panel', (e) => { const r = e.getBoundingClientRect(); return { right: r.right, bottom: r.bottom, width: r.width, viewportWidth: innerWidth, viewportHeight: innerHeight, overflow: e.scrollWidth - e.clientWidth }; });
    assert.ok(layout.width <= 360 && layout.right <= layout.viewportWidth + 1 && layout.bottom <= layout.viewportHeight + 1 && layout.overflow <= 1);
    assert.ok(await mobile.$eval(`${friend} button`, (e) => e.getBoundingClientRect().height >= 44));
    assert.ok(await mobile.$eval('.friends-search button', (e) => e.getBoundingClientRect().height >= 44));
    assert.ok(await mobile.$eval('.friends-panel footer button', (e) => e.getBoundingClientRect().height >= 44));
    await mobile.evaluate(() => globalThis.__SP__.store.patch('session', { entered: false })); await mobile.bringToFront(); await mobile.waitForSelector('.title-settings');
    await mobile.waitForFunction(() => getComputedStyle(document.querySelector('.title-login')).transform === 'none');
    await mobile.tap('.title-settings'); await mobile.waitForSelector('.set-privacy');
    await mobile.waitForFunction(() => document.querySelector('.modal').getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished'));
    await mobile.$eval('.set-privacy__scope', (el) => el.scrollIntoView({ block: 'center' }));
    await mobile.waitForFunction(() => { const r = document.querySelector('.set-privacy__scope').getBoundingClientRect(), box = document.querySelector('.modal__body').getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; });
    const privacyLayout = await mobile.$eval('.set-privacy__scope', (el) => { const r = el.getBoundingClientRect(), box = el.closest('.modal').getBoundingClientRect(); return { height: r.height, left: r.left, right: r.right, modalLeft: box.left, modalRight: box.right }; });
    assert.ok(privacyLayout.height >= 44 && privacyLayout.left >= privacyLayout.modalLeft && privacyLayout.right <= privacyLayout.modalRight);
    await mobile.screenshot({ path: path.join(out, 'privacy-settings-mobile.png') }); await clickText(mobile, '.modal__actions button', '完成'); await mobile.evaluate(() => globalThis.__SP__.store.patch('session', { entered: true }));
    await mobile.evaluate(() => globalThis.__SP__.net.setName('手机博士#0002'));
    await mobile.waitForFunction(async () => { const s = (await import('/js/ui/social.js')).socialStore.get(); return s.owner === '手机博士#0002' && s.ready; });
    assert.equal(await mobile.evaluate(async () => (await import('/js/ui/social.js')).socialStore.get().friends.length), 0);
    assert.equal(await mobile.$eval('.friends-handle', (e) => e.getAttribute('aria-expanded')), 'false');
    await a.evaluate(() => globalThis.__SP__.net.reconnectNow()); await a.waitForFunction(() => globalThis.__SP__.net.status === 'online' && !!globalThis.__SP__.store.get().match.public);
    for (const page of [a, b, b2]) {
      // Fixture teardown uses the same local reset performed by the real exit UI after room.leave succeeds.
      await page.evaluate(async () => {
        try { await globalThis.__SP__.net.request('room.leave'); } catch (error) { if (error.code !== 'NOT_IN_ROOM') throw error; }
        const { emptyMatch } = await import('/js/store.js'); globalThis.__SP__.store.set({ room: null, match: emptyMatch() });
      });
    }
    await request(a, 'room.create', { mode: 'solo', difficulty: 'FUNNY' }); await request(a, 'room.start');
    stage('spectate real solo');
    await request(mobile, 'social.add', { identity: '好友甲#0001' }); await openTouchDrawer(mobile); await mobile.waitForSelector(friend);
    await clickText(mobile, `${friend} button`, '观战'); await mobile.waitForFunction(() => globalThis.__SP__.store.get().room?.mode === 'solo' && !!globalThis.__SP__.store.get().match.public);
    await mobile.screenshot({ path: path.join(out, 'solo-spectator-mobile.png') });
    assert.equal((await (await fetch(server.url + '/healthz')).json()).ok, true);
    stage('passed');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
