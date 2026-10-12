import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/js/store.js';
import { installProfilePreferences } from '../../public/js/ui/profilePreferences.js';
import { defaultProfilePreferences } from '../../shared/voice.js';
function harness(stored = {}, old = {}) {
  const listeners = new Map(), sent = [], warnings = [];
  const net = { status: 'online', on(t, fn) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); return () => listeners.get(t).delete(fn); },
    async request(t, fields) {
      sent.push({ t, ...fields });
      if (net.fail) throw Object.assign(new Error('offline'), { code: 'OFFLINE' });
      Object.assign(confirmed, t === 'profile.voice' ? fields.preferences : t === 'profile.privacy' ? { socialPrivacy: fields.preferences } : t === 'room.loadout' ? { loadout: fields.entries, ops: fields.ops } : t === 'room.diy' ? { diy: fields.picks } : { notOwned: fields.notOwned });
      emit('profile.preferences', { profileKey: owner, preferences: { ...confirmed } });
      return { t: 'ok' };
    } };
  let owner, confirmed;
  const emit = (t, v) => { for (const fn of listeners.get(t) || []) fn(v); };
  const settings = createStore({ ...defaultProfilePreferences(), bgm: 0.4 });
  const roster = createStore({ entries: old.loadout || {}, notOwned: old.notOwned || [], diy: old.diy || {}, open: false });
  const sync = installProfilePreferences({ net, settings, roster, load: (k, d) => stored[k] ?? d, save: (k, v) => { stored[k] = JSON.parse(JSON.stringify(v)); }, notify: (message) => warnings.push(message) });
  const welcome = (name, code, preferences = defaultProfilePreferences(), initialized = true) => {
    owner = `${name}#${code}`; confirmed = { ...preferences };
    emit('welcome', { name, doctorCode: code, profilePreferences: preferences, profilePreferencesInitialized: initialized });
  };
  return { net, emit, settings, roster, sent, sync, stored, warnings, welcome };
}
test('server hydration cannot upload empty browser defaults; changing accounts clears all configuration', async () => {
  const h = harness({ profilePreferencesMigrated: 'A#0001' });
  try {
    const p = { ...defaultProfilePreferences(), voiceLanguage: 'cn', voiceOverrides: { char_102_texas: 'jp' }, loadout: { chess_1: { skill: 2 } }, notOwned: ['chess_2'], diy: { slot_5: { charId: 'char_102_texas' } } };
    h.welcome('A', '0001', p); await h.sync.flush(); assert.deepEqual(h.sent, []);
    assert.deepEqual(h.roster.get().entries, p.loadout); assert.equal(h.settings.get().voiceLanguage, 'cn');
    h.emit('profileChanging', {}); assert.deepEqual(h.roster.get().entries, {}); assert.equal(h.settings.get().bgm, 0.4);
    h.welcome('A', '0002'); await h.sync.flush(); assert.equal(h.settings.get().voiceLanguage, 'jp'); assert.deepEqual(h.roster.get().diy, {}); assert.deepEqual(h.sent, []);
  } finally { h.sync.dispose(); }
});
test('legacy configuration migrates once; clearing a selection persists to the correct account', async () => {
  const legacy = { loadout: { chess_1: { skill: 2 } }, notOwned: ['chess_2'], diy: { slot_5: { charId: 'char_102_texas' } } };
  const h = harness({}, legacy);
  try {
    h.welcome('A', '0001', defaultProfilePreferences(), false); await h.sync.flush();
    assert.equal(h.sent.length, 3); assert.deepEqual(h.roster.get().entries, legacy.loadout);
    assert.equal(h.stored.profilePreferencesMigrated, 'A#0001');
    h.roster.set({ entries: {} }); await h.sync.flush(); assert.deepEqual(h.sent.at(-1), { t: 'room.loadout', entries: {}, ops: {} });
    h.emit('profileChanging', {}); h.welcome('B', '0001', defaultProfilePreferences(), false); await h.sync.flush();
    assert.deepEqual(h.roster.get().diy, {}); assert.equal(h.sent.length, 4);
  } finally { h.sync.dispose(); }
});

test('potential and cultivation synchronize together, survive hydration and stay isolated by account', async () => {
  const h = harness({ profilePreferencesMigrated: 'A#0001' });
  try {
    const ops = { char_102_texas: { potential: 2, cultivate: 1 } };
    h.welcome('A', '0001', { ...defaultProfilePreferences(), ops });
    await h.sync.flush(); assert.deepEqual(h.sent, []); assert.deepEqual(h.roster.get().ops, ops);
    h.roster.set({ ops: { char_102_texas: { potential: 3, cultivate: 2 } } }); await h.sync.flush();
    assert.deepEqual(h.sent.at(-1), { t: 'room.loadout', entries: {}, ops: { char_102_texas: { potential: 3, cultivate: 2 } } });
    h.emit('profileChanging', {}); h.welcome('A', '0002'); await h.sync.flush(); assert.deepEqual(h.roster.get().ops, {});
    h.welcome('A', '0001', { ...defaultProfilePreferences(), ops }); assert.deepEqual(h.roster.get().ops, ops);
  } finally { h.sync.dispose(); }
});
test('failed offline changes retry for the same account; switching discards requests and foreign cache', async () => {
  const h = harness({ profilePreferencesMigrated: 'A#0001' });
  try {
    h.welcome('A', '0001'); h.net.fail = true;
    h.settings.set({ voiceLanguage: 'cn' }); await h.sync.flush();
    assert.ok(h.warnings.length); assert.deepEqual(h.stored.profilePreferencesCache.pending, ['voice']);
    h.net.fail = false; h.welcome('A', '0001', { ...defaultProfilePreferences(), loadout: { chess_fresh: { skill: 3 } } }); await h.sync.flush(); assert.equal(h.settings.get().voiceLanguage, 'cn');
    assert.deepEqual(h.roster.get().entries, { chess_fresh: { skill: 3 } });
    h.settings.set({ voiceOverrides: { char_102_texas: 'cn' } }); h.emit('profileChanging', {});
    const before = h.sent.length; h.welcome('B', '0002'); await h.sync.flush();
    assert.equal(h.sent.length, before); assert.deepEqual(h.settings.get().voiceOverrides, {});
  } finally { h.sync.dispose(); }
});
test('an incoming account update preserves a pending edit but restores other sections', async () => {
  const h = harness({ profilePreferencesMigrated: 'A#0001' });
  try {
    h.welcome('A', '0001'); h.settings.set({ voiceLanguage: 'cn' });
    h.emit('profile.preferences', { profileKey: 'A#0001', preferences: { ...defaultProfilePreferences(), loadout: { chess_1: { skill: 3 } } } });
    assert.equal(h.settings.get().voiceLanguage, 'cn'); assert.equal(h.roster.get().entries.chess_1.skill, 3);
    await h.sync.flush(); assert.equal(h.sent.length, 1);
  } finally { h.sync.dispose(); }
});
test('switching accounts while a pre-match save is pending cancels the old operation', async () => {
  const h = harness({ profilePreferencesMigrated: 'A#0001' });
  try {
    h.welcome('A', '0001'); h.settings.set({ voiceLanguage: 'cn' });
    let finish; h.net.request = () => new Promise((resolve) => { finish = resolve; });
    const operation = h.net.flushProfilePreferences();
    h.emit('profileChanging', {}); h.welcome('B', '0002'); finish({ t: 'ok' });
    await assert.rejects(operation, { code: 'CLOSED' });
    assert.equal(h.settings.get().voiceLanguage, 'jp');
  } finally { h.sync.dispose(); }
});
test('privacy hydrates from the account, retries only its pending edits and resets on account switches', async () => {
  const h = harness({ profilePreferencesMigrated: 'A#0001' });
  try {
    const privacy = { allowFriendJoin: false, allowFriendSpectate: false, profileVisibility: 'none' };
    h.welcome('A', '0001', { ...defaultProfilePreferences(), socialPrivacy: privacy }); await h.sync.flush();
    assert.deepEqual(h.settings.get().socialPrivacy, privacy); assert.deepEqual(h.sent, []);
    h.net.fail = true; h.settings.set({ socialPrivacy: { ...privacy, profileVisibility: 'friends' } }); await h.sync.flush();
    assert.deepEqual(h.stored.profilePreferencesCache.pending, ['privacy']);
    h.net.fail = false; h.welcome('A', '0001', { ...defaultProfilePreferences(), socialPrivacy: privacy }); await h.sync.flush();
    assert.equal(h.sent.at(-1).t, 'profile.privacy'); assert.equal(h.settings.get().socialPrivacy.profileVisibility, 'friends');
    h.emit('profileChanging', {}); h.welcome('B', '0001'); await h.sync.flush();
    assert.equal(h.settings.get().socialPrivacy.allowFriendJoin, true); assert.equal(h.settings.get().socialPrivacy.profileVisibility, 'friends_recent');
  } finally { h.sync.dispose(); }
});
