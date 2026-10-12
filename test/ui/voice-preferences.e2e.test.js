// SP_VOICE_E2E=1 node --test test/ui/voice-preferences.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const enabled = process.env.SP_VOICE_E2E === '1' && fs.existsSync(chrome);
test('native settings, decoded CN/JP audio, cross-browser restore and mobile layout', { skip: !enabled, timeout: 150000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-voice-browser-'));
  const out = path.resolve('test/e2e/out/voice'); fs.mkdirSync(out, { recursive: true });
  const server = await startServer({ host: '127.0.0.1', port: 0, quiet: true, profileDir: dir });
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling'] });
  const errors = [];
  const open = async (viewport = { width: 1214, height: 801 }) => {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); await page.setViewport(viewport);
    await page.goto(server.url, { waitUntil: 'networkidle2' }); await page.waitForSelector('.title-screen'); await page.waitForSelector('#boot', { hidden: true });
    await page.evaluate(() => globalThis.__SP__.net.setName('配音测试#0001'));
    await page.waitForFunction(() => globalThis.__SP__.net.status === 'online');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.title-login')).transform === 'none');

    if (viewport.hasTouch) { await page.screenshot({ path: path.join(out, 'mobile-before-settings.png') }); await page.tap('.title-settings'); }
    else await page.click('.title-settings');
    await page.waitForSelector('.set-voice');
    await page.waitForFunction(() => document.querySelector('.modal').getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished'));
    return page;
  };
  try {
    const a = await open();
    assert.equal(await a.$eval('.set-voice .set-seg [aria-checked=true]', (e) => e.textContent), '日文');
    await a.click('.set-voice .set-seg button:first-child');
    await a.type('.set-voice__search input', '德克萨斯');
    await a.waitForSelector('.set-voice__results [data-char-id="char_102_texas"]');
    await a.click('.set-voice__results [data-char-id="char_102_texas"] .set-voice__choices button:nth-child(2)');
    await a.waitForSelector('.set-voice__overrides [data-char-id="char_102_texas"]');
    await a.waitForFunction(async () => {
      const p = JSON.parse(localStorage.getItem('sp.pref.profilePreferencesCache')); return p?.pending?.length === 0;
    });
    const configured = await a.evaluate(async () => {
      const { loadoutOptions } = await import('/shared/protocol.js');
      const { diySlotIds, diySlot, diyPool } = await import('/shared/diy.js');
      const { loadoutStore, setEntries, setNotOwned, setDiyPicks } = await import('/js/ui/loadoutSync.js');
      const data = globalThis.__SP__.data;
      await data.loadAll('chess', 'backups');
      const gd = { chess: data.get('chess'), backups: data.get('backups') };
      const base = Object.values(gd.chess).find((c) => !c.isGolden && !c.isDiy && !c.isHidden && c.visible !== false && loadoutOptions(c, gd.chess[c.goldenId]).skills.length > 1);
      const options = loadoutOptions(base, gd.chess[base.goldenId]);
      setEntries({ [base.chessId]: { skill: options.skills.find((skill) => skill !== options.defaultSkill), module: options.modules.find((module) => module !== options.defaultModule) || options.defaultModule } });
      const owned = Object.values(gd.chess).find((c) => !c.isGolden && c.chessType === 'NORMAL'); setNotOwned([owned.chessId]);
      const slotId = diySlotIds(gd)[0], slot = diySlot(slotId, gd);
      setDiyPicks({ [slotId]: { charId: diyPool(slot.tier, { data: gd, kitted: loadoutStore.get().diyKitted })[0] } });
      return { entries: loadoutStore.get().entries, notOwned: loadoutStore.get().notOwned, diy: loadoutStore.get().diy };
    });
    await a.waitForFunction(() => !JSON.parse(localStorage.getItem('sp.pref.profilePreferencesCache'))?.pending?.length);
    await a.screenshot({ path: path.join(out, 'settings-desktop.png') });
    const b = await open();
    assert.equal(await b.$eval('.set-voice .set-seg [aria-checked=true]', (e) => e.textContent), '中文普通话');
    assert.equal(await b.$eval('.set-voice__overrides [aria-pressed=true]', (e) => e.textContent), '日文');
    const restoredRoster = await b.evaluate(async () => {
      const { loadoutStore } = await import('/js/ui/loadoutSync.js');
      const s = loadoutStore.get(); return { entries: s.entries, notOwned: s.notOwned, diy: s.diy };
    });
    assert.deepEqual(restoredRoster.entries, configured.entries);
    assert.deepEqual(restoredRoster.notOwned, configured.notOwned);
    assert.equal(Object.values(restoredRoster.diy)[0].charId, Object.values(configured.diy)[0].charId);
    const decoded = await b.evaluate(async () => {
      const { audio } = await import('/js/audio.js'); audio._unlock();
      const manifest = globalThis.__SP__.data.get('assets');
      const output = [];
      for (const lang of ['cn', 'jp']) {
        const url = manifest.audio.voices[lang].char_102_texas.select;
        const buffer = await audio._buffer(Array.isArray(url) ? url[0] : url);
        output.push({ lang, duration: buffer?.duration, channels: buffer?.numberOfChannels });
      }
      audio.voiceGate.release(); audio.voice('char_102_texas', 'select');
      return output;
    });
    assert.ok(decoded.every((d) => d.duration > 0 && d.channels > 0));
    await b.waitForFunction(async () => (await import('/js/audio.js')).audio.voiceNode?.url.includes('/jp/'));
    const mobile = await open({ width: 844, height: 390, isMobile: true, hasTouch: true });
    await mobile.screenshot({ path: path.join(out, 'settings-mobile.png') });
    assert.ok(await mobile.$eval('.set-voice', (e) => e.scrollWidth <= e.clientWidth + 1));
    await (await mobile.$('.set-voice__follow')).scrollIntoView();
    await mobile.screenshot({ path: path.join(out, 'settings-mobile-overrides.png') });
    await mobile.tap('.set-voice__follow');
    await a.waitForFunction(() => !document.querySelector('.set-voice__overrides [data-char-id="char_102_texas"]'));
    await b.evaluate(() => globalThis.__SP__.net.setName('配音测试#0002'));
    await b.waitForFunction(async () => (await import('/js/ui/settings.js')).settingsStore.get().voiceLanguage === 'jp');
    assert.equal(await b.$('.set-voice__overrides [data-char-id="char_102_texas"]'), null);
    await a.reload({ waitUntil: 'networkidle2' });
    await a.waitForFunction(() => !!globalThis.__SP__?.net);
    await a.evaluate(() => globalThis.__SP__.net.setName('配音测试#0001'));
    await a.waitForFunction(async () => (await import('/js/ui/settings.js')).settingsStore.get().voiceLanguage === 'cn');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
