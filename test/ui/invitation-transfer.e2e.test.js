import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';
const chrome = process.env.CHROME_PATH;
const enabled = process.env.SP_MATCH_E2E === '1' && chrome && fs.existsSync(chrome);
const state = page => page.evaluate(() => globalThis.__SP__.store.get());
const request = (page, type, fields = {}) => page.evaluate(({ type, fields }) => globalThis.__SP__.net.request(type, fields), { type, fields });
async function click(page, text) {
  for (const button of await page.$$('.social-invite-layer .btn')) if ((await button.evaluate(e => e.textContent)).includes(text)) {
    assert.equal(await button.evaluate(e => e.disabled), false); await button.click(); return;
  }
  throw Error('Missing invitation button: ' + text);
}
test('browser confirms transfers from a waiting room and a searching queue without stale room/party UI', { skip: !enabled, timeout: 90000 }, async t => {
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-invitation-browser-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, profileDir: path.join(dir, 'profiles'), matchmakingDir: path.join(dir, 'matching') });
  const pages = [], errors = [];
  t.after(async () => { await browser.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const name of ['邀请博士', '接受博士', '房间博士']) {
    const context = await browser.createBrowserContext(), page = await context.newPage(); pages.push(page);
    page.on('pageerror', e => errors.push(e.message)); await page.setViewport({ width: 1440, height: 900 });
    await page.goto(server.url, { waitUntil: 'networkidle2' }); await page.type('input[name=doctor-name]', name);
    await page.click('.title-login .btn--primary'); await page.waitForSelector('.lobby-screen');
    await page.waitForFunction(() => !!globalThis.__SP__.store.get().matching.identity);
  }
  const [a, b, c] = pages, bIdentity = (await state(b)).matching.identity;
  await request(a, 'social.add', { identity: bIdentity }); await request(c, 'social.add', { identity: bIdentity });
  await request(b, 'room.create', { mode: 'coop', difficulty: 'NORMAL' });
  await request(a, 'matching.invite', { identity: bIdentity, difficulty: 'NORMAL' });
  await b.waitForSelector('.social-invite-layer');
  assert.ok(await b.$eval('.social-invite-layer', e => e.textContent.includes('加入失败时保留原状态')));
  await click(b, '接受并切换队伍');
  await b.waitForFunction(() => !globalThis.__SP__.store.get().room && globalThis.__SP__.store.get().matching.party?.members.length === 2);
  await b.waitForSelector('.lobby-screen');
  await request(c, 'room.create', { mode: 'coop', difficulty: 'NORMAL' });
  await request(c, 'social.invite', { identity: bIdentity }); await b.waitForSelector('.social-invite-layer');
  await click(b, '接受并切换队伍');
  await b.waitForFunction(() => !!globalThis.__SP__.store.get().room && !globalThis.__SP__.store.get().matching.party);
  assert.equal((await state(b)).room.code, (await state(c)).room.code);
  // Another target invitation while both sides search; accepting cancels both attempts and requires fresh ready.
  await request(b, 'room.leave');
  await b.evaluate(() => globalThis.__SP__.store.set({ room: null }));
  const pa = (await state(a)).matching.party;
  await request(a, 'matching.start', { partyId: pa.id, revision: pa.revision, difficulty: 'NORMAL' });
  await request(b, 'matching.start', { partyId: null, revision: 0, difficulty: 'NORMAL' });
  await b.waitForFunction(() => globalThis.__SP__.store.get().matching.party?.phase === 'searching');
  // A fresh sender account has no invitation cooldown for this pair.
  await request(c, 'room.leave'); await c.evaluate(() => globalThis.__SP__.store.set({ room: null }));
  await request(c, 'matching.start', { partyId: null, revision: 0, difficulty: 'NORMAL' });
  await request(c, 'matching.invite', { identity: bIdentity, difficulty: 'NORMAL' });
  await b.waitForSelector('.social-invite-layer'); const old = (await state(b)).matching.party.id;
  await click(b, '接受并切换队伍');
  await b.waitForFunction(oldId => globalThis.__SP__.store.get().matching.party?.id !== oldId && globalThis.__SP__.store.get().matching.party?.phase === 'idle', {}, old);
  assert.equal((await state(b)).matching.party.id, (await state(c)).matching.party.id);
  assert.deepEqual(errors, []);
});
