import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVoicePreferences, sanitizeVoicePreferences, resolveVoiceLines } from '../shared/voice.js';
import { validateC2S } from '../shared/protocol.js';
import { AudioManager, VoiceGate } from '../public/js/audio.js';

const id = 'char_102_texas';
const manifest = { audio: { voice: { [id]: { select: '/cn.mp3' } }, voices: {
  cn: { [id]: { select: ['/cn.mp3', '/cn2.mp3'], place: '/cn-place.mp3' } },
  jp: { [id]: { select: '/jp.mp3' } },
} } };
test('Japanese default, per-character override and deterministic missing-slot fallback', () => {
  assert.deepEqual(sanitizeVoicePreferences(null), { voiceLanguage: 'jp', voiceOverrides: {} });
  assert.deepEqual(resolveVoiceLines(manifest, id, 'select', {}), [['/jp.mp3'], ['/cn.mp3', '/cn2.mp3']]);
  assert.deepEqual(resolveVoiceLines(manifest, id, 'select', { voiceLanguage: 'jp', voiceOverrides: { [id]: 'cn' } }), [['/cn.mp3', '/cn2.mp3'], ['/jp.mp3']]);
  assert.deepEqual(resolveVoiceLines(manifest, id, 'place', {}), [['/cn-place.mp3']]);
  assert.deepEqual(resolveVoiceLines(manifest, 'char_absent', 'select', {}), []);
  assert.deepEqual(resolveVoiceLines({ audio: { voice: manifest.audio.voice } }, id, 'select', {}), [['/cn.mp3']]);
});
test('voice protocol refuses other languages, injected keys, arrays and unbounded override maps', () => {
  const good = { voiceLanguage: 'cn', voiceOverrides: { [id]: 'jp' } };
  assert.equal(isVoicePreferences(good), true); assert.equal(validateC2S({ t: 'profile.voice', preferences: good }), null);
  for (const preferences of [{ ...good, voiceLanguage: 'en' }, { ...good, voiceOverrides: [] },
    { ...good, voiceOverrides: { '__proto__': 'jp', x: 'jp' } },
    { ...good, voiceOverrides: Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`char_${i}`, 'jp'])) }]) {
    assert.ok(validateC2S({ t: 'profile.voice', preferences }));
  }
});
test('a language edit leaves the current line intact and changes the next trigger', () => {
  const audio = new AudioManager({ getManifest: () => manifest });
  audio.setVoicePreferences(sanitizeVoicePreferences(null));
  audio.ctx = {}; audio.voiceGain = {};
  const played = []; audio._playVoice = (url) => played.push(url);
  assert.equal(audio.voice(id, 'select'), true);
  const token = audio.voiceToken;
  audio.setVoicePreferences({ voiceLanguage: 'cn', voiceOverrides: {} });
  assert.equal(audio.voiceToken, token);
  audio.voiceGate = new VoiceGate();
  audio.voice(id, 'place'); assert.deepEqual(played, ['/jp.mp3', '/cn-place.mp3']);
});
test('failed decode falls back without reopening the voice gate; stale decode cannot play', async () => {
  const audio = new AudioManager({ getManifest: () => manifest });
  audio.setVoicePreferences(sanitizeVoicePreferences(null));
  const started = [];
  audio.ctx = { createBufferSource: () => ({ connect() {}, start() { started.push(true); }, buffer: null }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }) };
  audio.voiceGain = {};
  audio._buffer = async (url) => url === '/jp.mp3' ? null : { duration: 0 };
  assert.equal(audio.voice(id, 'select'), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(started.length, 1); assert.equal(audio.voiceNode.url.startsWith('/cn'), true);
  let finish;
  audio._buffer = () => new Promise((resolve) => { finish = resolve; });
  audio.voiceGate = new VoiceGate(); audio.voice(id, 'select'); audio._stopVoice(); finish({ duration: 0 });
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(started.length, 1);
});

test('asset planner retains both language banks and the CN compatibility index, including an extra language', async () => {
  const { buildPlan } = await import('../tools/assets/plan.mjs');
  const { indexAudio } = await import('../tools/assets/audio.mjs');
  const plan = buildPlan({ assets07: {}, ops03: {}, enemies05: {}, maps05: {}, audio: indexAudio({}), modelsData: {}, voiceLang: 'en',
    extraOperators: { [id]: { name: '德克萨斯', skills: [] } },
    charword: { charWords: { line: { charId: id, wordKey: id, voiceId: 'CN_023', placeType: 'BATTLE_SELECT', voiceAsset: `${id}/CN_023`, voiceIndex: 23 } } } }).template;
  for (const lang of ['cn', 'jp', 'en']) assert.equal(plan.audio.voices[lang][id].select.alts[0].rel, `audio/voice/${lang}/${id}/cn_023.mp3`);
  assert.equal(plan.audio.voice, plan.audio.voices.en);
  assert.equal(plan.audio.voiceJp, plan.audio.voices.jp);
});
