// Real participants, server archives and readonly Pixi playback. SP_REPLAY_E2E=1 node --test test/replays/browser.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../../server/index.js';
import { Match } from '../../server/match/Match.js';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const enabled = process.env.SP_REPLAY_E2E === '1' && fs.existsSync(chrome);
const out = path.resolve('test/e2e/out/replay');
class QuickMatch extends Match { constructor(opts) { super({ ...opts, combatSpeed: 20, botRehearsal: 0 }); } }
async function button(page, root, text) {
  // Route effects can replace the first settlement paint with its fetched summary.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      for (const handle of await page.$$(`${root} .btn`)) if ((await handle.evaluate((e) => e.textContent.trim())) === text) { await handle.scrollIntoView(); await page.waitForFunction((e) => { const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !e.disabled && (hit === e || e.contains(hit)); }, {}, handle); await handle.click(); return; }
    } catch (e) { if (!/detached|not attached|not clickable/i.test(e.message)) throw e; }
    await delay(100);
  }
  throw new Error(`Missing ${text}`);
}
async function panel(page, kind, open) {
  const selector = kind === 'actions' ? '.replay-decisions' : '.replay-controls';
  const handle = `.replay-handle--${kind}`;
  if ((await page.$eval(handle, (e) => e.getAttribute('aria-expanded'))) !== String(open)) await page.click(handle);
  await page.waitForFunction((selector, open) => {
    const e = document.querySelector(selector), style = e && getComputedStyle(e);
    return e?.classList.contains('is-open') === open && e.inert === !open && style.visibility === (open ? 'visible' : 'hidden') && e.getAnimations().every((a) => a.playState !== 'running');
  }, {}, selector, open);
}
async function closeModal(page) {
  await page.waitForFunction(() => document.activeElement?.closest('.history-overlay .modal'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.history-overlay .modal', { hidden: true });
}
async function wait(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await delay(50); } throw new Error('wait timed out'); }
test('two browsers archive the same match, reopen settlement and pause/seek/full renderer on desktop and phone', { skip: !enabled, timeout: 180000 }, async () => {
  fs.mkdirSync(out, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-browser-replay-'));
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--mute-audio'] });
  let server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, replayDir: dir, MatchClass: QuickMatch });
  const base = server.url, problems = [];
  const pages = [];
  async function newPage() {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => problems.push(e.message));
    await page.evaluateOnNewDocument(() => { if (!localStorage.getItem('sp.name')) localStorage.setItem('sp.name', '同名博士'); sessionStorage.setItem('sp.entered', '1'); });
    await page.goto(base, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && document.querySelector('.lobby-screen'));
    return page;
  }
  const request = (page, t, f = {}) => page.evaluate((t, f) => globalThis.__SP__.net.request(t, f), t, f);
  try {
    let a = await newPage(); const b = await newPage(); pages.push(a, b);
    await a.evaluate(async () => (await import('/js/ui/avatarProfile.js')).commitAvatar({ kind: 'operator', charId: 'char_010_chen', e2: false }));
    await a.waitForFunction(async () => (await import('/js/ui/avatarProfile.js')).avatarStore.get().sync === 'synced');
    await request(a, 'room.create', { mode: 'coop', difficulty: 'NORMAL' });
    await a.waitForSelector('.room-screen');
    const code = await a.evaluate(() => globalThis.__SP__.store.get().room.code);
    await request(b, 'room.join', { code });
    await request(a, 'room.addBot', {});
    await request(b, 'room.ready', { ready: true });
    await request(a, 'room.start');
    const m = server.lobby.getRoom(code).match;
    for (const page of pages) await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK');
    const byId = new Map();
    for (const page of pages) byId.set(await page.evaluate(() => globalThis.__SP__.store.get().me.playerId), page);
    for (const page of pages) await request(page, 'g.infoReady');
    await wait(() => m.phase === 'BAND_DRAFT');
    for (let i = 0; i < 4 && m.phase === 'BAND_DRAFT'; i++) {
      const pid = m.draftTurn(); if (byId.has(pid)) await request(byId.get(pid), 'g.band', { bandId: m.defaultBand(pid) }); else await delay(50);
    }
    await wait(() => m.phase === 'PREP');
    for (const [pid, page] of byId) {
      const ps = m.players.get(pid), idx = ps.shop.slots.findIndex((s) => s?.kind === 'chess' && ps.priceOf(s) <= ps.funds);
      assert.ok(idx >= 0); await request(page, 'g.buy', { slot: idx });
      const piece = ps.hand.find((p) => p?.kind === 'chess');
      let tile;
      for (let row = 9; row <= 12 && !tile; row++) for (let col = 2; col <= 10 && !tile; col++) if (ps._legal(piece, row, col)) tile = { area: 'board', row, col };
      assert.ok(tile); await request(page, 'g.move', { uid: piece.uid, to: tile }); await request(page, 'g.ready', { ready: true });
    }
    await wait(() => m.phase === 'COMBAT');
    await wait(() => m.phase === 'SETTLE' || m.phase === 'PREP' && m.round === 2);
    m.finish({ victory: false, reason: 'replay-acceptance' });
    await a.waitForSelector('.result__archive-actions');
    await a.waitForFunction(async () => (await import('/js/replay/history.js')).historyStore.get().items[0]?.ended === true);
    const entry = await a.evaluate(async () => (await import('/js/replay/history.js')).historyStore.get().items[0]);
    assert.equal(entry.ended, true); assert.equal(entry.playerId, [...byId.keys()][0]);
    const other = await b.evaluate(async () => (await import('/js/replay/history.js')).historyStore.get().items[0]);
    assert.equal(entry.id, other.id); assert.notEqual(entry.playerId, other.playerId);
    await wait(() => server.replays.get(entry.id, entry.key)?.status !== 'processing');
    const record = server.replays.get(entry.id, entry.key); fs.writeFileSync(path.join(out, 'record.json'), JSON.stringify(record));
    assert.equal(record.status, 'ready', JSON.stringify(record.errors));
    assert.equal((await fetch(`${base}/api/replays/${entry.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/replays/${entry.id}`, { headers: { Authorization: `Bearer ${entry.key}` } })).status, 200);
    assert.deepEqual(await a.$$eval('.result__archive-actions .btn', (els) => els.map((e) => e.textContent.trim())), ['游玩记录']);
    await button(a, '.result__archive-actions', '游玩记录'); await a.waitForSelector('.history-row'); await a.click('.history-row'); await a.waitForSelector('.history-result');
    await button(a, '.history-result .result__archive-actions', '同盟限制'); await a.waitForSelector('.minfo-dlg'); await closeModal(a);
    assert.ok(await a.$('.result__archive-actions')); // Escape only closes the nested restrictions dialog.
    await button(a, '.history-result', '分享对局'); await a.waitForSelector('.replay-share');
    const shareLink = await a.$eval('.replay-share__url', (e) => e.value); assert.ok(shareLink.endsWith(`#replay=${record.shareCode}`)); assert.ok(!shareLink.includes(entry.key)); await closeModal(a);
    const guestContext = await browser.createBrowserContext(), guest = await guestContext.newPage(); pages.push(guest);
    guest.on('pageerror', (e) => problems.push(e.message)); await guest.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true });
    await guest.goto(shareLink, { waitUntil: 'networkidle2' }); await guest.waitForSelector('.history-result .rcard');
    assert.equal(await guest.evaluate(() => localStorage.getItem('sp.name')), null);
    assert.equal(await guest.evaluate(async () => (await import('/js/replay/history.js')).historyStore.get().items.length), 0);
    const shareBody = await (await fetch(`${base}/api/shared-replays/${record.shareCode}`)).text(); assert.ok(!shareBody.includes(entry.key));
    await button(guest, '.history-result', '回放'); await guest.waitForSelector('.replay-player');
    await guest.waitForFunction(() => globalThis.__SP_VIEW__?.kind === 'engine'); await guest.click('.gtop__exit'); await guest.waitForSelector('.history-result');
    await button(guest, '.history-result', '关闭分享'); await guest.waitForSelector('.title-screen');
    const fillIdentity = (field, value) => guest.$eval(`.title-identity input[name="doctor-${field}"]`, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    await fillIdentity('name', '同名博士'); await fillIdentity('code', '1');
    await guest.waitForFunction(() => document.querySelector('.title-identity__hint').textContent.includes('四位数字'));
    assert.ok(await guest.$eval('.title-login > .btn', (e) => e.disabled));
    await fillIdentity('code', '12x345'); assert.equal(await guest.$eval('input[name="doctor-code"]', (e) => e.value), '1234');
    await fillIdentity('code', ''); await guest.waitForFunction(() => document.querySelector('.title-identity__hint').textContent.includes('代号重复'));
    const originalCode = await a.evaluate(() => globalThis.__SP__.store.get().me.doctorCode); await fillIdentity('code', originalCode);
    await guest.waitForFunction(() => document.querySelector('.title-identity__hint').textContent.includes('完整代号重复'));
    assert.ok(await guest.$eval('input[name="doctor-code"]', (e) => e.scrollWidth <= e.clientWidth + 1), 'all four code digits fit without horizontal clipping');
    await guest.screenshot({ path: path.join(out, 'split-identity-mobile.png') });
    await button(guest, '.title-login', '开始'); await guest.waitForSelector('.lobby-screen');
    await guest.waitForFunction(() => globalThis.__SP__.store.get().me.avatar?.charId === 'char_010_chen');
    assert.equal(await guest.evaluate(async () => (await import('/js/replay/history.js')).historyStore.get().items[0]?.id), entry.id);
    // Same browser, only the code changes: new profile is empty and cannot inherit the old cookie avatar.
    const extraCode = ['9999', '9998', '9997'].find((code) => !server.lobby.profiles.availability('同名博士', code).codeExists);
    const originalIdentity = `同名博士#${originalCode}`;
    const switchProfile = async (name, code) => {
      await guest.evaluate((full) => globalThis.__SP__.net.setName(full), `${name}#${code}`);
      await guest.waitForFunction((name, code) => { const s = globalThis.__SP__.store.get(); return s.connection.status === 'online' && s.me.name === name && s.me.doctorCode === code; }, {}, name, code);
    };
    await button(guest, '.lobby-screen', '返回'); await guest.waitForSelector('.title-screen');
    await fillIdentity('code', extraCode);
    assert.equal(await guest.$('.title-avatar'), null, 'title no longer contains an avatar editor');
    await button(guest, '.title-login', '开始'); await guest.waitForSelector('.lobby-screen');
    await guest.waitForFunction((code) => globalThis.__SP__.store.get().me.doctorCode === code, {}, extraCode);
    assert.equal(await guest.evaluate(() => globalThis.__SP__.store.get().me.avatar.kind), 'default');
    assert.equal(await guest.evaluate(async () => (await import('/js/replay/history.js')).historyStore.get().items.length), 0);
    // Cookies are optional cache: edit the confirmed account from the game's lobby portrait.
    await guest.evaluate(() => { const d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie'); Object.defineProperty(document, 'cookie', { configurable: true, get() { return d.get.call(this); }, set() {} }); });
    await guest.click('.me-chip .avatar-edit'); await guest.waitForSelector('.avatar-picker');
    await guest.waitForSelector('.avatar-option[aria-label="雷蛇"]'); await guest.click('.avatar-option[aria-label="雷蛇"]'); await guest.click('.avatar-confirm'); await guest.waitForSelector('.avatar-picker', { hidden: true });
    await guest.waitForFunction(async () => (await import('/js/ui/avatarProfile.js')).avatarStore.get().sync === 'synced');
    assert.equal(server.lobby.profiles.read('同名博士', extraCode).avatar.charId, 'char_107_liskam');
    await guest.evaluate(() => { delete document.cookie; });
    await switchProfile('其他博士', extraCode);
    assert.equal(await guest.evaluate(() => globalThis.__SP__.store.get().me.avatar.kind), 'default');
    assert.equal(await guest.evaluate(async () => (await import('/js/replay/history.js')).historyStore.get().items.length), 0);
    await switchProfile('同名博士', extraCode);
    assert.equal(await guest.evaluate(() => globalThis.__SP__.store.get().me.avatar.charId), 'char_107_liskam');
    assert.equal(await guest.evaluate(async () => (await import('/js/replay/history.js')).historyStore.get().items.length), 0);
    await guest.reload({ waitUntil: 'networkidle2' }); await guest.waitForSelector('.lobby-screen');
    assert.equal(await guest.evaluate(() => globalThis.__SP__.store.get().me.avatar.charId), 'char_107_liskam');
    assert.equal(await guest.evaluate(async () => (await import('/js/replay/history.js')).historyStore.get().items.length), 0);
    await switchProfile('同名博士', originalCode);
    assert.equal(await guest.evaluate(() => globalThis.__SP__.store.get().me.avatar.charId), 'char_010_chen');
    assert.equal(await guest.evaluate(async () => (await import('/js/replay/history.js')).historyStore.get().items[0]?.id), entry.id);
    assert.equal(await guest.evaluate(() => localStorage.getItem('sp.name')), originalIdentity);
    await a.hover('.history-result .result__replay-button'); await a.waitForSelector('.tooltip');
    assert.match(await a.$eval('.tooltip', (e) => e.textContent), /版本更新时过期/);
    await button(a, '.history-result .result__archive-actions', '回放'); await a.waitForSelector('.replay-player');
    await a.waitForFunction(() => globalThis.__SP_VIEW__?.kind === 'engine');
    assert.equal(await a.$eval('.replay-handle--controls', (e) => e.getAttribute('aria-expanded')), 'true');
    assert.equal(await a.$eval('.replay-handle--actions', (e) => e.getAttribute('aria-expanded')), 'true');
    await panel(a, 'controls', true); await panel(a, 'actions', true);
    const drawers = await a.evaluate(() => ({ actions: document.querySelector('.replay-decisions').getBoundingClientRect().bottom, controls: document.querySelector('.replay-controls').getBoundingClientRect().top }));
    assert.ok(drawers.actions <= drawers.controls + 1, 'two open panels do not overlap');
    await panel(a, 'actions', false);
    for (const phase of ['INFO_CHECK', 'BAND_DRAFT']) {
      const node = record.nodes.find((n) => n.phase === phase); assert.ok(node);
      await a.$eval('.replay-range', (e, at) => { e.value = at; e.dispatchEvent(new Event('input', { bubbles: true })); }, node.at);
      await a.waitForSelector(phase === 'INFO_CHECK' ? '.replay-original-screen .brief' : '.replay-original-screen .draft');
      assert.equal(await a.$eval('.replay-player > .gm__field', (e) => getComputedStyle(e).visibility), 'hidden');
      assert.equal(await a.$eval('.replay-player > .gm__hud', (e) => getComputedStyle(e).visibility), 'hidden');
      await a.screenshot({ path: path.join(out, `replay-${phase.toLowerCase()}.png`) });
    }
    await a.click('.replay-handle--actions');
    assert.ok(await a.$eval('.replay-decisions', (e) => e.getAnimations().some((a) => a.playState === 'running')));
    await panel(a, 'actions', true); await panel(a, 'actions', false);
    await a.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await panel(a, 'actions', true);
    assert.equal(await a.$eval('.replay-decisions', (e) => getComputedStyle(e).animationName), 'none');
    await panel(a, 'actions', false); await a.emulateMediaFeatures([]);
    await a.evaluate(() => { const net = globalThis.__SP__.net, fn = net.request.bind(net); globalThis.__replayIntents = []; net.request = (...args) => { globalThis.__replayIntents.push(args[0]); return fn(...args); }; });
    const prep = record.nodes.find((n) => n.phase === 'PREP');
    await a.$eval('.replay-range', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, prep.at);
    await a.waitForSelector('.shopbar .scard'); await delay(200);
    assert.ok(await a.$('.pbanner.is-replay-clock'));
    assert.equal(await a.$eval('.gtop .ping', (e) => e.textContent.trim()), '回放');
    assert.equal(await a.$$eval('.shopbar .scard', (els) => els.length), prep.players[entry.playerId].private.shop.slots.length);
    assert.ok(await a.$('[data-testid=check-enemy]'));  assert.ok(await a.$('.gm__bonds .bstrip'));
    const countdown = await a.$eval('.gtop [role=timer]', (e) => e.getAttribute('aria-label'));
    await delay(250); assert.equal(await a.$eval('.gtop [role=timer]', (e) => e.getAttribute('aria-label')), countdown);
    await panel(a, 'controls', false);
    await a.click('.shopbar .scard:not(.scard--sold)'); await a.waitForSelector('.replay-player .dpanel');
    assert.equal(await a.$$eval('.replay-player .dpanel .btn:not(:disabled)', (els) => els.filter((e) => /购买|出售|销毁/.test(e.textContent)).length), 0);
    await a.click('.dpanel__close');
    await a.screenshot({ path: path.join(out, 'replay-prep-desktop.png') });
    const field = record.fields.find((f) => f.players.includes(entry.playerId));
    const position = Math.min(record.durationMs, field.at + 300);
    await a.$eval('.replay-range', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, position);
    await delay(300);
    const frozen = await a.evaluate(() => globalThis.__SP_VIEW__.raw.stats().renderT);
    await delay(500); assert.equal(await a.evaluate(() => globalThis.__SP_VIEW__.raw.stats().renderT), frozen);
    await a.screenshot({ path: path.join(out, 'replay-desktop.png') });
    await panel(a, 'controls', true);
    await button(a, '.replay-toolbar', '继续'); await delay(250); await button(a, '.replay-toolbar', '暂停');
    assert.ok(await a.evaluate(() => globalThis.__SP_VIEW__.raw.stats().renderT) > frozen);
    await a.keyboard.press('Space'); await delay(100); await a.keyboard.press('Space');
    await button(a, '.replay-toolbar', '上一节点'); await button(a, '.replay-toolbar', '下一节点');
    await a.click('.replay-player .team__row:nth-child(2) .team__btn');
    await a.waitForFunction((id) => document.querySelector('.replay-player').dataset.player === id, {}, other.playerId);
    await a.$eval('.replay-range', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, prep.at);
    assert.ok((await a.$eval('.shopbar', (e) => e.textContent)).includes(String(prep.players[other.playerId].private.deployCap - prep.players[other.playerId].private.deployCount)));
    await a.click('.replay-player .team__row:nth-child(3) .team__btn');
    await a.waitForFunction((id) => document.querySelector('.replay-player').dataset.player === id, {}, record.participants.find((p) => p.isBot).playerId);
    assert.deepEqual(await a.evaluate(() => globalThis.__replayIntents), []);
    // New tab in the same browser storage: set mobile emulation before loading, so toggling it cannot abort data fetches.
    const context = a.browserContext(); await a.close(); a = await context.newPage(); pages[0] = a;
    await a.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true });
    a.on('pageerror', (e) => problems.push(e.message));
    await a.evaluateOnNewDocument(() => { if (location.protocol === 'http:') sessionStorage.setItem('sp.entered', '1'); });
    await a.goto(base, { waitUntil: 'networkidle2' }); await a.waitForSelector('.lobby-screen, .room-screen, .result__archive-actions');
    if (await a.$('.room-screen')) { await request(a, 'room.leave'); await a.waitForSelector('.lobby-screen'); }
    await button(a, await a.$('.result__archive-actions') ? '.result__archive-actions' : '.lobby-screen', '游玩记录');
    await a.waitForSelector('.history-row'); await a.click('.history-row'); await a.waitForSelector('.history-result'); await button(a, '.history-result', '回放');
    await a.waitForSelector('.replay-player');
    await a.waitForFunction(() => globalThis.__SP_VIEW__?.kind === 'engine');
    assert.equal(await a.$eval('.replay-handle--controls', (e) => e.getAttribute('aria-expanded')), 'true');
    assert.equal(await a.$eval('.replay-handle--actions', (e) => e.getAttribute('aria-expanded')), 'true');
    await panel(a, 'controls', true); await panel(a, 'actions', true);
    const mobileDrawers = await a.evaluate(() => ({ actions: document.querySelector('.replay-decisions').getBoundingClientRect().bottom, controls: document.querySelector('.replay-controls').getBoundingClientRect().top }));
    assert.ok(mobileDrawers.actions <= mobileDrawers.controls + 1, 'two open panels do not overlap');
    await panel(a, 'actions', false);
    await a.$eval('.replay-range', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, position); await delay(300);
    await a.screenshot({ path: path.join(out, 'replay-mobile.png') });
    const layout = await a.evaluate(() => {
      const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, height: r.height }; };
      return { header: [...document.querySelectorAll('.replay-top .btn,.replay-top .history-close')].map(rect), toolbar: [...document.querySelectorAll('.replay-toolbar .btn')].map(rect), width: innerWidth };
    });
    for (let i = 1; i < layout.header.length; i++) assert.ok(layout.header[i - 1].right <= layout.header[i].x);
    for (const r of layout.toolbar) assert.ok(r.right <= layout.width);
    assert.equal(new Set(layout.toolbar.map((r) => r.height)).size, 1);
    await a.$eval('.replay-range', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, prep.at); await delay(150);
    const cards = await a.$$eval('.shopbar .scard', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
    await panel(a, 'controls', false);
    const controlsTop = 390;
    assert.ok(await a.$eval('.replay-player .gm__field', (e) => e.getBoundingClientRect().height) >= 100);
    assert.ok(cards.length && cards.every((r) => r.bottom <= controlsTop && r.top > 0));
    await a.screenshot({ path: path.join(out, 'replay-prep-mobile.png') });
    await panel(a, 'controls', true);
    const bounds = await a.$eval('.replay-toolbar', (e) => { const r = e.getBoundingClientRect(); return { bottom: r.bottom, right: r.right, h: innerHeight, w: innerWidth }; });
    assert.ok(bounds.bottom <= bounds.h && bounds.right <= bounds.w);
    await a.click('.gtop__exit');
    await a.waitForSelector('.history-result');
    await a.click('.history-close');
    const port = server.port; await server.close(); server = await startServer({ port, host: '127.0.0.1', quiet: true, replayDir: dir });
    await a.reload({ waitUntil: 'networkidle2' }); await a.waitForSelector('.lobby-screen');
    await button(a, '.lobby-screen', '游玩记录'); await a.waitForSelector('.history-row'); await a.click('.history-row'); await a.waitForSelector('.history-result .result');
    await a.waitForFunction(() => document.querySelectorAll('.history-result .rcard').length === 3); await delay(800);
    await a.screenshot({ path: path.join(out, 'historical-settlement.png') });
    const settlementButtons = await a.$$eval('.history-result .result__foot .btn', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { text: e.textContent.trim(), height: r.height, x: r.x, right: r.right, bottom: r.bottom, screenHeight: innerHeight }; }));
    assert.deepEqual(settlementButtons.map((b) => b.text), ['返回记录', '同盟限制', '回放', '分享对局']);
    assert.equal(new Set(settlementButtons.map((b) => b.height)).size, 1);
    assert.ok(settlementButtons[1].right <= settlementButtons[2].x);
    assert.ok(settlementButtons.every((b) => b.bottom <= b.screenHeight));
    await button(a, '.history-result', '同盟限制'); await a.waitForSelector('.minfo-dlg'); await closeModal(a);
    assert.ok(await a.$('.history-result'));
    await a.hover('.history-result .result__replay-button'); await a.waitForSelector('.tooltip');
    assert.match(await a.$eval('.tooltip', (e) => e.textContent), /版本更新时过期/);
    await button(a, '.history-result', '回放'); await a.waitForSelector('.replay-player');
    // A fresh browser has no cookies, local history or reconnect token; the specified code restores both.
    const fullName = await a.evaluate(() => localStorage.getItem('sp.name'));
    const cContext = await browser.createBrowserContext(), c = await cContext.newPage(); pages.push(c);
    c.on('pageerror', (e) => problems.push(e.message));
    await c.evaluateOnNewDocument((name) => { localStorage.setItem('sp.name', name); sessionStorage.setItem('sp.entered', '1'); }, fullName);
    await c.goto(base, { waitUntil: 'networkidle2' }); await c.waitForSelector('.lobby-screen');
    await c.waitForFunction(() => globalThis.__SP__.store.get().me.avatar?.charId === 'char_010_chen');
    const recovered = await c.evaluate(async () => (await import('/js/replay/history.js')).historyStore.get().items[0]);
    assert.equal(recovered.id, entry.id); assert.equal(recovered.playerId, entry.playerId);
    await button(c, '.lobby-screen', '游玩记录'); await c.waitForSelector('.history-row'); await c.click('.history-row'); await c.waitForSelector('.history-result');
    server.replays.now = () => Date.now() + 73 * 3600 * 1000;
    await button(c, '.history-result', '返回记录'); await c.waitForSelector('.history-row'); await c.click('.history-row'); await c.waitForSelector('.history-result');
    await c.waitForFunction(() => document.querySelector('.history-result .result__replay-button .btn')?.disabled);
    await c.hover('.history-result .result__replay-button'); await c.waitForSelector('.tooltip');
    assert.match(await c.$eval('.tooltip', (e) => e.textContent), /超过72小时/);
    assert.match(await c.$eval('.result__expiry', (e) => e.textContent), /超过72小时/);
    await guest.goto(shareLink, { waitUntil: 'networkidle2' }); await guest.waitForSelector('.history-result .result__expiry');
    assert.match(await guest.$eval('.result__expiry', (e) => e.textContent), /超过72小时/);
    assert.ok(await guest.$eval('.result__replay-button .btn', (e) => e.disabled));
    assert.equal(problems.length, 0, problems.join('\n'));
  } catch (e) {
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(e), problems, pages: await Promise.all(pages.map((p) => p.evaluate(() => document.body.innerText).catch(() => 'closed'))) }, null, 2));
    throw e;
  } finally { await browser.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
