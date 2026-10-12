// SP_COMM_E2E=1: real WebSocket clients in independent Chrome contexts, no mock transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';
const chrome = [process.env.SP_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => p && fs.existsSync(p));
test('real coop communication, capture safety, other fields, wheel, spectator, fallback, landscape and replay', {
  skip: process.env.SP_COMM_E2E !== '1' || !chrome, timeout: 150000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-communication-'));
  const out = path.resolve('test/e2e/out/communications'); fs.mkdirSync(out, { recursive: true });
  const server = await startServer({ host: '127.0.0.1', port: 0, quiet: true, profileDir: dir, replayDir: path.join(dir, 'replays') });
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [], stage = (value) => fs.writeFileSync(path.join(out, 'progress.txt'), value);
  const pause = (ms = 1100) => new Promise((resolve) => setTimeout(resolve, ms));
  const open = async (name, fallback = false) => {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); await page.setViewport({ width: 1214, height: 801 });
    if (fallback) { await page.setRequestInterception(true); page.on('request', (r) => r.url().endsWith('/js/render/app.js') ? r.abort() : r.continue()); }
    await page.goto(server.url, { waitUntil: 'networkidle2' }); await page.waitForSelector('#boot', { hidden: true });
    await page.waitForFunction(() => !!globalThis.__SP__);
    await page.evaluate((value) => globalThis.__SP__.net.setName(value), name);
    await page.waitForFunction((value) => { const s = globalThis.__SP__; return s.net.status === 'online' && `${s.store.get().me.name}#${s.store.get().me.doctorCode}` === value; }, {}, name);
    await page.evaluate(async () => { (await import('/js/net.js')).identity.setEntered(true); globalThis.__SP__.store.patch('session', { entered: true }); });
    return page;
  };
  const req = (p, t, fields = {}) => p.evaluate((type, value) => globalThis.__SP__.net.request(type, value), t, fields);
  const events = (p) => p.evaluate(async () => (await import('/js/ui/communications.js')).communicationStore.get().events);
  const ping = async (p, selector) => { await p.bringToFront(); await p.keyboard.down('KeyZ'); await p.click(selector); await p.keyboard.up('KeyZ'); };
  try {
    stage('opening'); const a = await open('通讯甲#0001'), b = await open('通讯乙#0001', true), observer = await open('观战#0001');
    await req(a, 'room.create', { mode: 'coop', difficulty: 'NORMAL' });
    const code = await a.evaluate(() => globalThis.__SP__.store.get().room.code);
    await req(b, 'room.join', { code }); await req(observer, 'room.spectate', { code });
    await req(b, 'room.ready', { ready: true }); await req(a, 'room.start');
    const m = server.lobby.getRoom(code).match;
    // Keep preparation untimed during UI assertions; gameplay and requests use the real match implementation.
    m.loneHuman = true;
    await a.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK');
    assert.equal(await a.$('.communication-controls'), null);
    await req(a, 'g.infoReady'); await req(b, 'g.infoReady');
    await a.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'BAND_DRAFT');
    for (let i = 0; i < 2; i++) {
      const pid = m.draftTurn(), p = pid === await a.evaluate(() => globalThis.__SP__.store.get().me.playerId) ? a : b;
      await req(p, 'g.band', { bandId: m.timeoutBand(pid) });
    }
    await a.waitForSelector('.communication-controls');
    await a.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'PREP');
    await b.waitForSelector('.ff'); stage('hud and capture');
    const funds = await a.evaluate(() => globalThis.__SP__.store.get().match.private.funds);
    await ping(a, '[data-comm="shop"]');
    await b.waitForFunction(async () => (await import('/js/ui/communications.js')).communicationStore.get().events.some((e) => e.kind.startsWith('shop-')));
    assert.equal(await a.evaluate(() => globalThis.__SP__.store.get().match.private.funds), funds);
    assert.equal(await a.$('.scard.is-armed'), null);
    await pause(); await ping(a, '[data-comm="funds"]');
    await pause(); await ping(a, '[data-comm="life"]');
    await a.bringToFront(); await a.keyboard.press('KeyX'); await a.waitForSelector('.radio-menu');
    await pause(200); await a.screenshot({ path: path.join(out, 'radio-desktop.png') });
    await pause(); await a.click('.radio-menu > button'); await a.waitForSelector('.radio-menu', { hidden: true });
    await observer.waitForFunction(async () => (await import('/js/ui/communications.js')).communicationStore.get().events.some((e) => e.kind === 'radio'));
    assert.equal(await observer.$('.communication-controls'), null);
    const denied = await observer.evaluate(async () => {
      const { net, store } = globalThis.__SP__, pub = store.get().match.public;
      try { await net.request('g.radio', { id: 0, phase: pub.phase, round: pub.round }); } catch (e) { return e.code; }
    }); assert.equal(denied, 'SPECTATOR');
    stage('engine map picking');
    const ap = [...m.players.values()].find((p) => p.name === '通讯甲');
    const [ar, ac] = [...ap.deployMap().keys()][0].split(',').map(Number);
    await a.bringToFront(); await pause();
    const enginePoint = await a.evaluate((row, col) => {
      const view = globalThis.__SP_VIEW__, point = view.tileScreen(row, col);
      return { x: point.x, y: point.y, hit: view.pickCommunication(point.x, point.y) };
    }, ar, ac);
    assert.equal(enginePoint.hit.type, 'tile'); assert.equal(enginePoint.hit.row, ar); assert.equal(enginePoint.hit.col, ac);
    await a.keyboard.down('KeyZ'); await a.mouse.click(enginePoint.x, enginePoint.y); await a.keyboard.up('KeyZ');
    await a.waitForSelector('.communication-marker');
    assert.equal(m.recorder.record.communications.at(-1).location.ownerId, ap.playerId);
    await a.waitForSelector('.communication-marker', { hidden: true, timeout: 6000 });
    stage('fallback wheel and separate battlefield');
    await b.bringToFront(); await pause();
    const bp = [...m.players.values()].find((p) => p.name === '通讯乙');
    const [row, col] = [...bp.deployMap().keys()][0].split(',').map(Number);
    const selector = `.ff [data-drop="board"][data-row="${row}"][data-col="${col}"]`;
    const tile = await b.$eval(selector, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await b.keyboard.down('KeyZ'); await b.mouse.move(tile.x, tile.y); await b.mouse.down();
    await b.waitForSelector('.ping-wheel'); await b.mouse.move(tile.x, tile.y - 70);
    assert.equal(await b.$$eval('.ping-wheel small', (els) => els.length), 0);
    assert.equal(await b.$eval('.ping-wheel__good svg', (el) => getComputedStyle(el).color), 'rgb(255, 255, 255)');
    await b.screenshot({ path: path.join(out, 'wheel-fallback.png') });
    await b.mouse.up(); await b.keyboard.up('KeyZ');
    await a.waitForFunction(async () => (await import('/js/ui/communications.js')).communicationStore.get().events.some((e) => e.kind === 'danger'));
    await b.waitForSelector('.communication-marker');
    assert.equal(await a.$('.communication-marker'), null, 'other battlefields only show text');
    const before = (await events(b)).length;
    await b.keyboard.down('KeyZ'); await b.mouse.move(tile.x, tile.y); await b.mouse.down(); await b.waitForSelector('.ping-wheel');
    await b.keyboard.up('KeyZ'); await b.mouse.up(); await pause(100);
    assert.equal((await events(b)).length, before, 'release Z cancels without a short ping');
    await b.waitForSelector('.communication-marker', { hidden: true, timeout: 6000 });
    const fallbackProjection = await b.evaluate((r, c) => globalThis.__SP_VIEW__.fieldTileScreen(r, c), row, col);
    assert.ok(Math.abs(fallbackProjection.x - tile.x) < 2 && Math.abs(fallbackProjection.y - tile.y) < 2);
    stage('phone controls');
    await b.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true }); await b.bringToFront();
    await b.waitForSelector('.communication-controls'); await b.waitForFunction(() => globalThis.__SP__?.store.get().match.public?.phase === 'PREP'); await pause(1600);
    await b.tap('.communication-controls button:last-child'); await b.waitForSelector('.radio-menu'); await pause(250);
    const box = await b.$eval('.radio-menu', (e) => { const r = e.getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom, overflow: e.scrollWidth - e.clientWidth }; });
    assert.ok(box.top >= 0 && box.right <= 845 && box.bottom <= 391 && box.overflow <= 1, JSON.stringify(box));
    assert.ok(await b.$eval('.communication-controls button', (e) => e.getBoundingClientRect().height >= 44));
    await b.screenshot({ path: path.join(out, 'radio-landscape.png') });
    stage('real touch hold and drag');
    await b.tap('.radio-menu header button'); await b.tap('.communication-controls button:first-child');
    const mobileTile = await b.$eval(selector, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const beforeTouch = m.recorder.record.communications.length;
    const finger = await b.touchscreen.touchStart(mobileTile.x, mobileTile.y);
    await b.waitForSelector('.ping-wheel'); await finger.move(mobileTile.x + 65, mobileTile.y); await finger.end();
    await b.waitForFunction(async () => (await import('/js/ui/communications.js')).communicationStore.get().events.some((e) => e.kind === 'missing'));
    assert.equal(m.recorder.record.communications.length, beforeTouch + 1);
    await b.tap('.communication-controls button:first-child');
    assert.ok(m.recorder.record.communications.length >= 5);
    assert.ok(m.recorder.record.communications.every((e) => !e.state && !e.snap));
    stage('replay persistence and random access');
    const entry = { ...m.recorder.ticket(), playerId: bp.playerId };
    m.recorder.abort();
    await a.waitForFunction(async (entry) => {
      const r = await (await fetch(`/api/replays/${entry.id}`, { headers: { Authorization: `Bearer ${entry.key}` } })).json();
      return ['ready', 'partial'].includes(r.status);
    }, { timeout: 30000 }, entry);
    await a.bringToFront();
    await a.evaluate(async (entry) => (await import('/js/replay/history.js')).openHistory(entry, 'replay'), entry);
    await a.waitForSelector('.replay-player');
    const dangerAt = m.recorder.record.communications.find((e) => e.kind === 'danger').at;
    const seek = (time) => a.$eval('.replay-range', (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, time);
    await seek(dangerAt + 50); await a.waitForSelector('.replay-player .communication-marker');
    const frozen = await a.$eval('.replay-player .communication-feed', (el) => el.textContent);
    await pause(1200); assert.equal(await a.$eval('.replay-player .communication-feed', (el) => el.textContent), frozen, 'paused lifetime uses replay time');
    const accepted = m.recorder.record.communications.length;
    await a.keyboard.press('KeyX'); assert.equal(m.recorder.record.communications.length, accepted, 'replay never sends');
    await seek(dangerAt + 4100); await a.waitForSelector('.replay-player .communication-marker', { hidden: true });
    await seek(dangerAt + 50); await a.waitForSelector('.replay-player .communication-marker');
    await a.screenshot({ path: path.join(out, 'replay-communication.png') });
    await a.evaluate(async () => (await import('/js/replay/history.js')).closeHistory());
    stage('disconnect cleanup'); await a.evaluate(() => globalThis.__SP__.net.close());
    await a.waitForFunction(async () => (await import('/js/ui/communications.js')).communicationStore.get().events.length === 0);
    assert.equal((await (await fetch(server.url + '/healthz')).json()).ok, true);
    assert.deepEqual(errors, []); stage('passed');
  } finally { await browser.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
