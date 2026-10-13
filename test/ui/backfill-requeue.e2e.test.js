import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';
const chrome = process.env.CHROME_PATH;
const enabled = process.env.SP_MATCH_E2E === '1' && chrome && fs.existsSync(chrome);
const OUT = path.resolve('test/e2e/out/backfill-requeue');
const state = page => page.evaluate(() => globalThis.__SP__.store.get());
const request = (page, type, fields = {}) => page.evaluate(({ type, fields }) => globalThis.__SP__.net.request(type, fields), { type, fields });
async function clickText(page, selector, text) {
  for (const button of await page.$$(selector)) if ((await button.evaluate(e => e.textContent)).includes(text)) { await button.click(); return; }
  throw Error('Missing button: ' + text);
}
test('host disabling backfill sends matching friends to the lobby search and never reveals their codes in an ordinary room', { skip: !enabled, timeout: 90000 }, async t => {
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-backfill-requeue-browser-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, profileDir: path.join(dir, 'profiles'), matchmakingDir: path.join(dir, 'matching') });
  let now = Date.now(); server.lobby.now = () => now;
  const pages = [], errors = [];
  fs.mkdirSync(OUT, { recursive: true });
  t.after(async () => {
    if (!t.passed) for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(OUT, `failure-${i}.png`) });
    await browser.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const name of ['房主', '博士甲', '博士乙']) {
    const context = await browser.createBrowserContext(), page = await context.newPage(); pages.push(page);
    page.on('pageerror', e => errors.push(e.message)); await page.setViewport({ width: 1440, height: 900 });
    await page.goto(server.url, { waitUntil: 'networkidle2' }); await page.type('input[name=doctor-name]', name);
    await page.click('.title-login .btn--primary'); await page.waitForSelector('.lobby-screen');
    await page.waitForFunction(() => !!globalThis.__SP__.store.get().matching.identity);
  }
  const [host, a, b] = pages, identities = await Promise.all([a, b].map(async p => (await state(p)).matching.identity));
  await request(a, 'social.add', { identity: identities[1] });
  await request(a, 'matching.invite', { identity: identities[1], difficulty: 'NORMAL' });
  await b.waitForSelector('.social-invite-layer'); await clickText(b, '.social-invite-layer .btn', '接受邀请');
  await a.waitForFunction(() => globalThis.__SP__.store.get().matching.party?.members.length === 2);
  const originalPartyId = (await state(a)).matching.party.id;
  await request(host, 'room.create', { mode: 'coop', difficulty: 'NORMAL' }); await host.waitForSelector('.room-screen');
  const oldCode = (await state(host)).room.code;
  async function enable() {
    await host.click('.matching-toggle input'); await host.waitForSelector('.alliance-picker');
    await host.click('.alliance-option[data-bond="yanShip"]'); await host.click('.alliance-confirm');
    await host.waitForFunction(() => globalThis.__SP__.store.get().room?.matching?.enabled);
  }
  await enable();
  assert.ok(await host.$eval('.room-screen', e => e.textContent.includes('关闭补位后，匹配玩家将返回大厅继续匹配')));
  for (const [p, bond] of [[a, 'yanShip'], [b, 'sargonShip']]) {
    const party = (await state(p)).matching.party;
    await request(p, 'matching.prepare', { partyId: party.id, revision: party.revision, difficulty: 'NORMAL', bond });
  }
  now += 60001; server.lobby.matchmakingService.parties.pump();
  for (const p of [a, b]) {
    await p.waitForSelector('.room-screen'); await p.waitForFunction(() => !globalThis.__SP__.store.get().matching.party);
  }
  // Record every wire frame so a transient ordinary-room identity disclosure cannot be hidden by later rendering.
  for (const p of pages) await p.evaluate(() => {
    globalThis.__backfillRoomFrames = [];
    globalThis.__SP__.net.on('room.state', m => globalThis.__backfillRoomFrames.push(m));
  });
  now += 180000; await host.click('.matching-toggle input');
  for (const p of [a, b]) {
    await p.waitForSelector('.lobby-screen');
    await p.waitForFunction(oldId => !globalThis.__SP__.store.get().room && globalThis.__SP__.store.get().matching.party?.id !== oldId && globalThis.__SP__.store.get().matching.party?.phase === 'extended', {}, originalPartyId);
    await p.waitForSelector('.matching-queue');
    assert.ok(await p.$eval('.matching-queue', e => e.textContent.includes('正在匹配') && e.textContent.includes('取消准备')));
    const saved = await state(p); assert.equal(saved.matching.party.members.length, 2); assert.ok(saved.matching.party.members.every(m => m.ready));
    assert.ok(Math.abs((Date.now() + saved.matching.offset) - saved.matching.party.startedAt - 60001) < 5000);
    assert.ok(await p.evaluate(() => document.body.textContent.includes('房主已关闭匹配补位，你已返回大厅继续匹配')));
  }
  const aState = await state(a), bState = await state(b);
  assert.equal(aState.matching.party.id, bState.matching.party.id);
  assert.deepEqual(aState.matching.party.members.map(m => m.preference), ['yanShip', 'sargonShip']);
  const ids = aState.matching.party.members.map(m => m.playerId);
  for (const p of pages) {
    const frames = await p.evaluate(() => globalThis.__backfillRoomFrames);
    assert.ok(frames.every(m => m.matching.rules || !m.seats.some(s => s && ids.includes(s.playerId))));
  }
  await host.waitForFunction(() => !globalThis.__SP__.store.get().room.matching.enabled);
  const room = (await state(host)).room; assert.equal(room.seats.filter(Boolean).length, 1); assert.notEqual(room.code, oldCode);
  assert.ok(!await a.evaluate(ids => ids.some(id => document.body.textContent.includes(id)), identities));
  await a.screenshot({ path: path.join(OUT, 'returned-to-queue.png') });
  await host.screenshot({ path: path.join(OUT, 'ordinary-room-after-disable.png') });
  await enable(); server.lobby.matchmakingService.parties.pump();
  assert.equal((await state(host)).room.seats.filter(Boolean).length, 1);
  assert.equal((await state(a)).room, null); assert.equal((await state(b)).room, null);
  await a.setViewport({ width: 844, height: 390 }); await a.screenshot({ path: path.join(OUT, 'returned-to-queue-mobile.png') });
  assert.deepEqual(errors, []);
});
