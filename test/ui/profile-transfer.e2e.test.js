// SP_PROFILE_E2E=1 node --test test/ui/profile-transfer.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const enabled = process.env.SP_PROFILE_E2E === '1' && fs.existsSync(chrome);
test('new browser waits for owner approval and resumes the same deployed units, shop and seat', { skip: !enabled, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-profile-browser-'));
  const out = path.resolve('test/e2e/out/profile'); fs.mkdirSync(out, { recursive: true });
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, profileDir: dir, profileTransferCooldownMs: 0 });
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--mute-audio', '--disable-background-timer-throttling'] });
  const errors = [];
  const open = async () => {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); await page.setViewport({ width: 1214, height: 801 });
    await page.evaluateOnNewDocument(() => { localStorage.setItem('sp.name', '接管博士#0001'); sessionStorage.setItem('sp.entered', '1'); });
    await page.goto(server.url, { waitUntil: 'networkidle2' }); return page;
  };
  const request = (page, t, fields = {}) => page.evaluate((t, fields) => globalThis.__SP__.net.request(t, fields), t, fields);
  const click = async (page, text) => {
    await page.waitForFunction(() => document.activeElement?.closest('.profile-transfer'));
    for (const button of await page.$$('.profile-transfer .btn')) if (await button.evaluate((e) => e.textContent.trim()) === text) { await button.click(); return; }
    throw new Error(`Missing ${text}`);
  };
  try {
    const old = await open(); await old.waitForSelector('.lobby-screen');
    const playerId = await old.evaluate(() => globalThis.__SP__.store.get().me.playerId);
    await request(old, 'room.create', { mode: 'solo', difficulty: 'NORMAL' }); await request(old, 'room.start');
    await old.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK');
    await request(old, 'g.infoReady');
    await old.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'BAND_DRAFT');
    const room = server.lobby.roomOf(server.registry.byId(playerId));
    await request(old, 'g.band', { bandId: room.match.defaultBand(playerId) });
    await old.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'PREP');
    const ps = room.match.players.get(playerId), slot = ps.shop.slots.findIndex((s) => s?.kind === 'chess' && ps.priceOf(s) <= ps.funds);
    assert.ok(slot >= 0); await request(old, 'g.buy', { slot });
    const piece = ps.hand.find((p) => p?.kind === 'chess'); let to;
    for (let row = 9; row <= 12 && !to; row++) for (let col = 2; col <= 10 && !to; col++) if (ps._legal(piece, row, col)) to = { area: 'board', row, col };
    assert.ok(to); await request(old, 'g.move', { uid: piece.uid, to });
    const expected = await old.evaluate(() => globalThis.__SP__.store.get().match.private);
    const next = await open(); await next.waitForSelector('.profile-transfer'); await old.waitForSelector('.profile-transfer');
    assert.equal(await next.evaluate(() => sessionStorage.getItem('sp.token')), null);
    assert.equal(await next.evaluate(() => globalThis.__SP__.store.get().me.playerId), null);
    assert.equal(await next.evaluate(() => globalThis.__SP__.store.get().match.private), null);
    await old.screenshot({ path: path.join(out, 'owner-consent.png') }); await next.screenshot({ path: path.join(out, 'requester-waiting.png') });
    // Refusal preserves the current game, and an idle pending request can exceed the old 8-second hello timeout.
    await click(old, '拒绝'); await next.waitForSelector('.profile-transfer', { hidden: true });
    assert.equal(await old.evaluate(() => globalThis.__SP__.net.status), 'online');
    await next.evaluate(() => globalThis.__SP__.net.setName('接管博士#0001'));
    await next.waitForSelector('.profile-transfer'); await old.waitForSelector('.profile-transfer');
    await new Promise((resolve) => setTimeout(resolve, 8500));
    assert.equal(await next.evaluate(() => globalThis.__SP__.net.status), 'handshaking');
    await click(old, '同意接管');
    await next.waitForSelector('.shopbar'); await next.waitForFunction(() => globalThis.__SP__.store.get().match.private?.board?.length > 0);
    assert.equal(await next.evaluate(() => globalThis.__SP__.store.get().me.playerId), playerId);
    assert.equal(await next.evaluate(() => globalThis.__SP__.store.get().room.code), room.code);
    const restored = await next.evaluate(() => { const p = globalThis.__SP__.store.get().match.private; return { funds: p.funds, board: p.board, shop: p.shop }; });
    assert.equal(restored.funds, expected.funds); assert.ok(restored.board.some((p) => p.uid === piece.uid)); assert.deepEqual(restored.shop.slots, expected.shop.slots);
    await old.waitForFunction(() => globalThis.__SP__.net.status === 'closed'); assert.equal(await old.evaluate(() => globalThis.__SP__.net.lastError.code), 'REPLACED');
    await next.screenshot({ path: path.join(out, 'resumed-prep.png') });
    // A disconnected owner is recovered without another confirmation and without a reconnect token.
    await next.close(); const offline = await open(); await offline.waitForSelector('.shopbar');
    assert.equal(await offline.evaluate(() => globalThis.__SP__.store.get().me.playerId), playerId);
    assert.equal(await offline.$('.profile-transfer'), null); assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
