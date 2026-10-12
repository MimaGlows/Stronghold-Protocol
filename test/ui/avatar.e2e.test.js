// Opt-in real-browser acceptance for the portrait feature: SP_AVATAR_E2E=1 node --test test/ui/avatar.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../../server/index.js';
import { isAvatarChoice, AVATAR_MAX_BYTES, avatarBytes, webpDimensions } from '../../shared/avatar.js';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const enabled = process.env.SP_AVATAR_E2E === '1' && fs.existsSync(chrome);
const OUT = path.resolve('test/e2e/out/avatar');

async function clickText(page, selector, text) {
  const handles = await page.$$(selector);
  for (const h of handles) if ((await h.evaluate((e) => e.textContent.trim())).includes(text)) { await h.click(); return; }
  throw new Error(`Button missing: ${text}`);
}
async function fill(page, selector, text) {
  await page.click(selector, { clickCount: 3 }); await page.type(selector, text);
}
async function waitRoute(page, selector) { await page.waitForSelector(selector, { timeout: 20000 }); }
async function saved(page) { return page.evaluate(async () => (await import('/js/ui/avatarProfile.js')).loadAvatar()); }

test('portraits in real browsers: upload/crop, cookie persistence, room sync and mobile', { skip: !enabled, timeout: 180000 }, async (testContext) => {
  fs.mkdirSync(OUT, { recursive: true });
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-avatar-browser-'));
  let server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, profileDir });
  const base = `http://127.0.0.1:${server.port}`, problems = [];
  const aContext = await browser.createBrowserContext(), bContext = await browser.createBrowserContext();
  async function pageIn(context, url = base) {
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(url, { waitUntil: 'networkidle2' }); await waitRoute(page, '.title-screen'); return page;
  }
  try {
    let a = await pageIn(aContext); const b = await pageIn(bContext);
    const raster = await a.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 480; c.height = 320;
      const g = c.getContext('2d'); g.fillStyle = '#ee5533'; g.fillRect(0, 0, 240, 320); g.fillStyle = '#3388ee'; g.fillRect(240, 0, 240, 320);
      return c.toDataURL('image/png').split(',')[1];
    });
    const imageFile = path.join(OUT, 'crop-fixture.png'); fs.writeFileSync(imageFile, Buffer.from(raster, 'base64'));
    const corrupt = path.join(OUT, 'corrupt.png'); fs.writeFileSync(corrupt, 'not an image');
    const oversized = path.join(OUT, 'oversized.png'); fs.writeFileSync(oversized, Buffer.alloc(5 * 1024 * 1024 + 1));
    const inputSelector = '.avatar-picker input[type=file][accept="image/png,image/jpeg,image/webp"]';
    assert.equal(await a.$('.title-avatar'), null);
    await fill(a, 'input[name=doctor-name]', '头像博士'); await clickText(a, '.title-login .btn', '开始'); await waitRoute(a, '.lobby-screen');
    await a.click('.me-chip .avatar-edit'); await waitRoute(a, '.avatar-option');
    await waitRoute(a, '.avatar-option[aria-label="雷蛇"]');
    await fill(a, '.avatar-picker .field__input', '雷蛇');
    await a.click('.avatar-option[aria-label="雷蛇"]'); await a.click('.avatar-confirm');
    await a.waitForSelector('.avatar-picker', { hidden: true });
    const original = await saved(a); assert.equal(original.charId, 'char_107_liskam');
    await a.click('.me-chip .avatar-edit');
    await (await a.$(inputSelector)).uploadFile(corrupt); await a.waitForFunction(() => document.querySelector('.avatar-error')?.textContent.includes('损坏'));
    assert.deepEqual(await saved(a), original);
    await (await a.$(inputSelector)).uploadFile(oversized); await a.waitForFunction(() => document.querySelector('.avatar-error')?.textContent.includes('5 MB'));
    await (await a.$(inputSelector)).uploadFile(imageFile); await waitRoute(a, '.avatar-crop');
    await a.$eval('.avatar-zoom input', (e) => { e.value = '2'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    const box = await (await a.$('.avatar-crop')).boundingBox();
    await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await a.mouse.down();
    await a.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 4 }); await a.mouse.up();
    await a.screenshot({ path: path.join(OUT, 'crop-desktop.png') });
    await a.click('.avatar-confirm'); await a.waitForSelector('.avatar-picker', { hidden: true });
    await a.waitForFunction(async () => (await import('/js/ui/avatarProfile.js')).avatarStore.get().sync === 'synced');
    const custom = await saved(a); assert.equal(custom.kind, 'custom'); assert.equal(isAvatarChoice(custom), true);
    assert.ok(avatarBytes(custom.dataUrl).length <= AVATAR_MAX_BYTES); assert.deepEqual(webpDimensions(avatarBytes(custom.dataUrl)), { width: 256, height: 256 });
    const pixels = await a.evaluate(async (src) => {
      const im = new Image(); im.src = src; await im.decode(); const c = document.createElement('canvas'); c.width = c.height = 256;
      const g = c.getContext('2d'); g.drawImage(im, 0, 0); return Array.from(g.getImageData(128, 128, 1, 1).data);
    }, custom.dataUrl);
    assert.ok(pixels[2] > pixels[0] + 80, 'drag and zoom select the blue side of the source image');
    await a.screenshot({ path: path.join(OUT, 'title.png') });
    await a.waitForFunction(() => globalThis.__SP__.net.status === 'online');
    assert.equal(await a.$eval('.me-chip .avatar img', (e) => e.src), custom.dataUrl);
    await a.screenshot({ path: path.join(OUT, 'lobby.png') });
    await a.reload({ waitUntil: 'networkidle2' }); await waitRoute(a, '.lobby-screen'); assert.deepEqual(await saved(a), custom);
    await a.close(); a = await aContext.newPage(); await a.setViewport({ width: 1440, height: 900 });
    a.on('pageerror', (e) => problems.push(e.message)); await a.goto(base, { waitUntil: 'networkidle2' });
    await waitRoute(a, '.title-screen'); assert.equal(await a.$('.title-avatar'), null);
    await clickText(a, '.title-login .btn', '开始'); await waitRoute(a, '.lobby-screen');
    await fill(b, 'input[name=doctor-name]', '头像博士'); await clickText(b, '.title-login .btn', '开始'); await waitRoute(b, '.lobby-screen'); await b.click('.me-chip .avatar-edit');
    await waitRoute(b, '.avatar-option[aria-label="薄绿"]');
    await fill(b, '.avatar-picker .field__input', '薄绿'); await b.click('.avatar-option[aria-label="薄绿"]'); await b.click('.avatar-confirm');
    await b.waitForSelector('.avatar-picker', { hidden: true });
    await clickText(a, '.mode-card', '同盟模拟'); await clickText(a, '.create-box .btn', '创建同盟'); await waitRoute(a, '.room-screen');
    const code = await a.evaluate(() => globalThis.__SP__.store.get().room.code);
    await fill(b, '.join-panel .field__input', code); await clickText(b, '.join-panel .btn', '加入同盟'); await waitRoute(b, '.room-screen');
    await a.waitForFunction(() => globalThis.__SP__.store.get().room.seats.filter(Boolean).length === 2);
    assert.equal(await a.$$eval('.seat .avatar-edit', (e) => e.length), 1);
    assert.equal(await b.$$eval('.seat .avatar-edit', (e) => e.length), 1);
    assert.equal(await b.$eval('.seat:not(.is-me) .avatar img', (e) => e.src), custom.dataUrl);
    await a.screenshot({ path: path.join(OUT, 'room.png') });
    await a.click('.seat.is-me .avatar-edit'); await a.click('.avatar-reset');
    await clickText(a, '.avatar-picker .modal__actions .btn', '取消'); assert.deepEqual(await saved(a), custom);
    await a.click('.seat.is-me .avatar-edit'); await a.click('.avatar-reset');
    await a.evaluate(() => { const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie'); Object.defineProperty(document, 'cookie', { configurable: true, get() { return desc.get.call(this); }, set(_) { /* simulate cookies blocked */ } }); });
    await a.click('.avatar-confirm'); await a.waitForSelector('.avatar-picker', { hidden: true });
    await b.waitForFunction(() => globalThis.__SP__.store.get().room.seats[0].avatar.kind === 'default');
    assert.deepEqual(await saved(a), custom, 'a blocked cache does not prevent the server profile update');
    await a.evaluate(() => { delete document.cookie; });
    await a.reload({ waitUntil: 'networkidle2' }); await waitRoute(a, '.room-screen');
    assert.deepEqual(await saved(a), { kind: 'default' });
    await a.click('.seat.is-me .avatar-edit');
    await (await a.$(inputSelector)).uploadFile(imageFile); await waitRoute(a, '.avatar-crop'); await a.click('.avatar-confirm'); await a.waitForSelector('.avatar-picker', { hidden: true });
    await b.waitForFunction(() => globalThis.__SP__.store.get().room.seats[0].avatar.kind === 'custom');
    const current = await saved(a);
    await b.reload({ waitUntil: 'networkidle2' }); await waitRoute(b, '.room-screen');
    assert.equal(await b.$eval('.seat:not(.is-me) .avatar img', (e) => e.src), current.dataUrl);
    await a.click('.seat.is-me .avatar-edit');
    assert.equal(await a.$('.avatar-export'), null); assert.equal(await a.$('.avatar-import'), null);
    const dimensions = await a.$$eval('.avatar-picker .modal__actions .btn', (buttons) => buttons.map((e) => { const r = e.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
    assert.ok(Math.abs(dimensions[0].width - dimensions[1].width) < 0.5 && Math.abs(dimensions[0].height - dimensions[1].height) < 0.5, 'cancel/save buttons have equal size within subpixel rounding');
    await clickText(a, '.avatar-picker .modal__actions .btn', '取消');
    await a.mouse.move(1, 1);
    assert.equal(await a.$eval('.seat.is-me .avatar-edit__hint', (e) => getComputedStyle(e).opacity), '0');
    await a.hover('.seat.is-me .avatar-edit'); await delay(250);
    assert.equal(await a.$eval('.seat.is-me .avatar-edit__hint', (e) => e.textContent), '单击更换图像');
    assert.equal(await a.$eval('.seat.is-me .avatar-edit__hint', (e) => getComputedStyle(e).opacity), '1');
    await a.screenshot({ path: path.join(OUT, 'room-hover.png') });
    assert.equal(await a.evaluate(() => localStorage.getItem('sp.profile.avatar')), null);
    const cookies = await a.cookies(); assert.ok(cookies.some((c) => c.name === 'sp.avatar' && c.expires > Date.now() / 1000));
    // Independent hosts get their own cookies; import/export controls no longer exist.
    const migrated = await pageIn(aContext, `http://localhost:${server.port}`);
    assert.deepEqual(await saved(migrated), { kind: 'default' });
    await fill(migrated, 'input[name=doctor-name]', '横屏博士'); await clickText(migrated, '.title-login .btn', '开始'); await waitRoute(migrated, '.lobby-screen');
    await migrated.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true }); await migrated.reload({ waitUntil: 'networkidle2' });
    await waitRoute(migrated, '.lobby-screen'); await migrated.click('.me-chip .avatar-edit'); await waitRoute(migrated, '.avatar-picker');
    await delay(400); await migrated.screenshot({ path: path.join(OUT, 'picker-mobile.png') });
    const bounds = await migrated.$eval('.avatar-picker', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight }; });
    assert.ok(bounds.x >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height);
    await clickText(migrated, '.avatar-picker .modal__actions .btn', '取消');
    testContext.diagnostic('Upload/crop, cookies, room hover, equal buttons and mobile passed');
    await a.bringToFront();
    await clickText(a, '.seat--empty .btn', '添加 AI');
    await b.bringToFront(); await clickText(b, '.room-bar .btn', '准备就绪');
    await a.bringToFront();
    await a.waitForFunction(() => [...document.querySelectorAll('.room-bar button')].some((e) => e.textContent.includes('开始模拟') && !e.disabled), { polling: 100, timeout: 10000 });
    await clickText(a, '.room-bar .btn', '开始模拟');
    await a.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK', { polling: 100, timeout: 20000 });
    await waitRoute(a, '.brief'); await a.screenshot({ path: path.join(OUT, 'coop-start.png') });
    testContext.diagnostic('Co-op starts with the real match engine');
    await migrated.bringToFront(); await waitRoute(migrated, '.lobby-screen');
    await clickText(migrated, '.mode-card', '独立模拟');
    await clickText(migrated, '.create-box .btn', '开始独立模拟'); await waitRoute(migrated, '.room-screen');
    await clickText(migrated, '.room-bar .btn', '开始模拟');
    await migrated.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK', { polling: 100, timeout: 20000 });
    testContext.diagnostic('Solo starts with the real match engine');
    // Exercise the full 24 KiB cookie budget using a real decodable WebP plus a legal optional RIFF chunk.
    const originalBytes = Buffer.from(current.dataUrl.split(',')[1], 'base64'), padded = Buffer.alloc(AVATAR_MAX_BYTES);
    originalBytes.copy(padded); padded.writeUInt32LE(padded.length - 8, 4);
    padded.write('JUNK', originalBytes.length); padded.writeUInt32LE(padded.length - originalBytes.length - 8, originalBytes.length + 4);
    const maximum = { kind: 'custom', dataUrl: 'data:image/webp;base64,' + padded.toString('base64') };
    const largeContext = await browser.createBrowserContext(), largePage = await pageIn(largeContext);
    await fill(largePage, 'input[name=doctor-name]', '大图博士'); await clickText(largePage, '.title-login .btn', '开始'); await waitRoute(largePage, '.lobby-screen');
    await largePage.evaluate(async (avatar) => {
      const im = new Image(); im.src = avatar.dataUrl; await im.decode();
      const { commitAvatar } = await import('/js/ui/avatarProfile.js'); commitAvatar(avatar);
    }, maximum);
    await largePage.waitForFunction(async () => (await import('/js/ui/avatarProfile.js')).avatarStore.get().sync === 'synced');
    assert.equal(await largePage.evaluate(async () => (await fetch('/healthz')).status), 200);
    await largePage.reload({ waitUntil: 'networkidle2' }); await waitRoute(largePage, '.lobby-screen');
    assert.deepEqual(await saved(largePage), maximum);
    await largePage.waitForFunction(() => globalThis.__SP__.net.status === 'online');
    assert.equal((await largePage.cookies()).filter((c) => c.name.startsWith('sp.avatar')).length, 13);
    await largeContext.close(); testContext.diagnostic('Full 24 KiB cookie avatar decodes and survives HTTP/WS reconnect');
    const port = server.port; await server.close(); server = await startServer({ port, host: '127.0.0.1', quiet: true, profileDir });
    await a.bringToFront(); await a.reload({ waitUntil: 'networkidle2' }); await waitRoute(a, '.lobby-screen');
    assert.deepEqual(await saved(a), current); assert.equal(await a.$eval('.me-chip img', (e) => e.src), current.dataUrl);
    assert.deepEqual(problems, []);
    fs.writeFileSync(path.join(OUT, 'acceptance.json'), JSON.stringify({ passed: true, customBytes: avatarBytes(current.dataUrl).length, cases: ['upload/crop', 'corrupt/oversized files', 'blocked cookies', 'cancel/default', 'reload/reopen', 'same-name players', 'live room sync', 'reconnect', 'cookie persistence/host isolation', '24 KiB real image/header limits', 'equal action buttons', 'hover-only hint', 'mobile landscape', 'solo/coop start', 'server restart'] }, null, 2));
  } finally { await browser.close(); await server.close(); fs.rmSync(profileDir, { recursive: true, force: true }); }
});
