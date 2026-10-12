// Account-owned listening and roster preferences. Hydrate before sending, never upload an unrelated browser's defaults.
import { loadPref, savePref } from '../store.js';
import { settingsStore } from './settings.js';
import { loadoutStore } from './loadoutSync.js';
import { parseStored, parseStoredOps } from './loadoutModel.js';
import { cleanIds } from './ownershipModel.js';
import { cleanPicks } from './diyModel.js';
import { defaultProfilePreferences, sanitizeVoicePreferences } from '../../../shared/voice.js';
import { sanitizeSocialPrivacy } from '../../../shared/social.js';
import { toast } from './toasts.js';
import { t, N_ } from '../../../shared/i18n.js';

const FIELDS = ['voice', 'privacy', 'loadout', 'notOwned', 'diy'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function installProfilePreferences({ net, settings = settingsStore, roster = loadoutStore, load = loadPref, save = savePref,
  notify = (text) => toast(t(text), 'warn'), timers = globalThis } = {}) {
  const legacy = { loadout: roster.get().entries, ops: roster.get().ops || {}, notOwned: roster.get().notOwned, diy: roster.get().diy };
  let owner = null, generation = 0, applying = false, ready = false, timer = null, sending = false, inFlight = null, disposed = false;
  let migrated = load('profilePreferencesMigrated', null);
  let dirty = new Set(), confirmed = defaultProfilePreferences();
  const value = (field) => field === 'voice'
    ? { voiceLanguage: settings.get().voiceLanguage, voiceOverrides: settings.get().voiceOverrides }
    : field === 'privacy' ? sanitizeSocialPrivacy(settings.get().socialPrivacy) : roster.get()[field === 'loadout' ? 'entries' : field];
  const current = () => ({ ...value('voice'), socialPrivacy: value('privacy'), loadout: value('loadout'), ops: roster.get().ops || {}, notOwned: value('notOwned'), diy: value('diy') });
  const cache = () => {
    if (!owner) return;
    try { if (save('profilePreferencesCache', { owner, preferences: current(), pending: [...dirty] }) === false) notify(N_('本机缓存保存失败；配置仍将尝试保存到账号')); }
    catch { notify(N_('本机缓存保存失败；配置仍将尝试保存到账号')); }
  };
  const apply = (preferences, force = false) => {
    const p = { ...defaultProfilePreferences(), ...preferences, ...sanitizeVoicePreferences(preferences) };
    p.loadout = parseStored({ entries: p.loadout }); p.notOwned = cleanIds(p.notOwned); p.diy = cleanPicks(p.diy);
    p.ops = parseStoredOps({ entries: p.loadout, ops: p.ops });
    applying = true;
    try {
      if (force || !dirty.has('voice')) settings.set({ voiceLanguage: p.voiceLanguage, voiceOverrides: p.voiceOverrides });
      if (force || !dirty.has('privacy')) settings.set({ socialPrivacy: sanitizeSocialPrivacy(p.socialPrivacy) });
      const patch = {};
      for (const field of ['loadout', 'notOwned', 'diy']) if (force || !dirty.has(field)) patch[field === 'loadout' ? 'entries' : field] = p[field];
      if (force || !dirty.has('loadout')) patch.ops = p.ops;
      roster.set(patch);
    } finally { applying = false; }
  };
  const schedule = (delay = 500) => {
    timers.clearTimeout(timer);
    if (!owner || !ready || disposed) return;
    timer = timers.setTimeout(() => { timer = null; void flush(); }, delay);
  };
  async function flush() {
    if (inFlight) await inFlight;
    if (!dirty.size) return;
    const run = performFlush();
    inFlight = run;
    try { await run; } finally { if (inFlight === run) inFlight = null; }
  }
  async function performFlush() {
    if (!ready || !owner || disposed || sending || net.status !== 'online') return;
    sending = true;
    const myGeneration = generation;
    let retry = false, failed = false;
    try {
      for (const field of FIELDS) {
        if (myGeneration !== generation || !ready || disposed) return;
        if (!dirty.has(field)) continue;
        const payload = value(field);
        const sentOps = field === 'loadout' ? roster.get().ops || {} : null;
        const stateKey = { loadout: 'sync', notOwned: 'ownSync', diy: 'diySync' }[field];
        if (stateKey) roster.set({ [stateKey]: 'sending' });
        const message = { voice: 'profile.voice', privacy: 'profile.privacy', loadout: 'room.loadout', notOwned: 'room.ownership', diy: 'room.diy' }[field];
        const key = { voice: 'preferences', privacy: 'preferences', loadout: 'entries', notOwned: 'notOwned', diy: 'picks' }[field];
        let locked = false;
        try { await net.request(message, { [key]: payload, ...(field === 'loadout' ? { ops: sentOps } : {}) }); }
        catch (e) {
          if (myGeneration !== generation) return;
          if (['WRONG_PHASE', 'ROOM_STARTED'].includes(e.code)) { locked = true; notify(N_('本局干员配置已锁定，修改已保存至账号，将在下一局生效')); }
          else {
            failed = true;
            retry = ['RATE', 'TIMEOUT', 'OFFLINE'].includes(e.code);
            if (stateKey) roster.set({ [stateKey]: 'error' });
            notify(N_('账号配置保存失败，本机选择已保留，请联网后重试'));
            continue;
          }
        }
        if (myGeneration !== generation) return;
        if (equal(value(field), payload) && (field !== 'loadout' || equal(roster.get().ops || {}, sentOps))) dirty.delete(field);
        if (stateKey) roster.set({ [stateKey]: locked ? 'locked' : 'synced' });
        apply(confirmed); cache();
      }
    } finally {
      if (myGeneration === generation) {
        sending = false;
        if (dirty.size && (retry || !failed)) schedule(retry ? 1500 : 0);
      }
    }
  }
  const change = (fields) => {
    if (applying || !owner || !ready) return;
    for (const field of fields) dirty.add(field);
    cache(); schedule();
  };
  const reset = () => {
    generation++; ready = false; sending = false; inFlight = null; owner = null; dirty = new Set();
    timers.clearTimeout(timer); apply(defaultProfilePreferences(), true);
    roster.set({ open: false, sync: 'idle', ownSync: 'idle', diySync: 'idle', diyKitted: null });
  };
  const off = [
    net.on('profileChanging', reset),
    net.on('welcome', (msg) => {
      generation++; sending = false; inFlight = null; timers.clearTimeout(timer);
      const key = msg.doctorCode ? `${msg.name}#${msg.doctorCode}` : null;
      if (!key) { reset(); return; }
      const cached = load('profilePreferencesCache', null);
      owner = key; ready = false;
      dirty = new Set(cached?.owner === key && Array.isArray(cached.pending) ? cached.pending.filter((field) => FIELDS.includes(field)) : []);
      confirmed = { ...defaultProfilePreferences(), ...msg.profilePreferences };
      apply(confirmed, true);
      if (cached?.owner === key && dirty.size) {
        const recovered = { ...confirmed };
        for (const field of dirty) {
          if (field === 'voice') Object.assign(recovered, sanitizeVoicePreferences(cached.preferences));
          else if (field === 'privacy') recovered.socialPrivacy = sanitizeSocialPrivacy(cached.preferences?.socialPrivacy);
          else recovered[field] = cached.preferences?.[field] ?? confirmed[field];
          if (field === 'loadout') recovered.ops = cached.preferences?.ops ?? confirmed.ops;
        }
        apply(recovered, true);
      }
      if (!migrated) {
        migrated = key;
        save('profilePreferencesMigrated', key);
        if (!msg.profilePreferencesInitialized) {
          applying = true;
          roster.set({ entries: legacy.loadout, ops: legacy.ops, notOwned: legacy.notOwned, diy: legacy.diy });
          applying = false;
          for (const field of ['loadout', 'notOwned', 'diy']) dirty.add(field);
        }
      }
      roster.set({ diyKitted: Array.isArray(msg.diyKitted) ? msg.diyKitted : null, sync: 'synced', ownSync: 'synced', diySync: 'synced' });
      ready = true; cache(); if (dirty.size) schedule(0);
    }),
    net.on('profile.preferences', (msg) => {
      if (!ready || msg.profileKey !== owner) return;
      confirmed = { ...defaultProfilePreferences(), ...msg.preferences };
      apply(confirmed); cache();
    }),
    settings.subscribe((s, previous) => {
      if (s.voiceLanguage !== previous.voiceLanguage || !equal(s.voiceOverrides, previous.voiceOverrides)) change(['voice']);
      if (!equal(s.socialPrivacy, previous.socialPrivacy)) change(['privacy']);
    }),
    roster.subscribe((s, previous) => {
      const fields = ['loadout', 'notOwned', 'diy'].filter((field) => !equal(s[field === 'loadout' ? 'entries' : field], previous[field === 'loadout' ? 'entries' : field]));
      if (!equal(s.ops, previous.ops) && !fields.includes('loadout')) fields.push('loadout');
      if (fields.length) change(fields);
      if (previous.open && !s.open && dirty.size) { timers.clearTimeout(timer); timer = null; void flush(); }
    }),
  ];
  net.flushProfilePreferences = async () => {
    const expectedGeneration = generation;
    await flush();
    if (generation !== expectedGeneration) throw Object.assign(new Error('profile changed'), { code: 'CLOSED' });
    // Another section may have been edited while the first upload was in flight.
    if (dirty.size) await flush();
    if (generation !== expectedGeneration) throw Object.assign(new Error('profile changed'), { code: 'CLOSED' });
    if (dirty.size) throw Object.assign(new Error(t('账号配置尚未保存，请联网后重试')), { code: 'OFFLINE' });
  };
  // Global legacy preferences are kept solely for the one-time migration above.
  apply(defaultProfilePreferences(), true);
  return { flush, dispose() { net.flushProfilePreferences = null; disposed = true; timers.clearTimeout(timer); off.forEach((fn) => fn?.()); } };
}
