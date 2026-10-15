// Pure official 0.2.2 record normalization and aggregate semantics, shared by server and UI.
import { checkCustom } from './custom.js';
import { PHASE } from './constants.js';

/** Current record-envelope version (bump + add a MIGRATIONS step when the record shape changes). */
export const STATS_VERSION = 1;
/** localStorage key under the app's `sp.matchmaking.pref.` prefix (store.js loadPref). */
export const STATS_PREF_KEY = 'stats';
/** Oldest records are dropped beyond this many matches. */
export const MAX_RECORDS = 1000;
/** The newest records that keep their full rows (lineups, bonds, teammates) — what the settlement replay reads. */
export const FULL_KEEP = 30;
/** Budget of the stored JSON in characters (a character costs up to 2 bytes of the browser's ~5 MB quota): the oldest records go first. */
export const MAX_CHARS = 800_000;
/** Largest export file the page reads. */
export const IMPORT_MAX_CHARS = 8_000_000;

/** @returns {{ v: number, records: Array }} a fresh empty envelope */
export const emptyStats = () => ({ v: STATS_VERSION, records: [] });

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v, d) => (Number.isFinite(v) ? Math.round(v) : d);
const num = (v) => (Number.isFinite(v) ? v : null);
const bool = (v, d = false) => (typeof v === 'boolean' ? v : d);
/** A non-empty string, cut to `max` characters. */
const str = (v, max = 64) => (typeof v === 'string' && v.length ? v.slice(0, max) : null);

// per-record bounds (an imported file is foreign data: nothing a row holds may grow without limit)
const MAX_PLAYERS = 6; // the game seats 4
const MAX_LINEUP = 12;
const MAX_ITEMS = 4;
const MAX_BONDS = 24;
const MAX_STAT_KEYS = 24;
const MAX_NAME = 24;

/**
 * Copy only the finite numeric keys of a stats block (the settlement's numbers; a numeric field this build does not
 * know is kept too, up to MAX_STAT_KEYS — display can lag, data should not).
 * @param {any} raw
 * @returns {Record<string, number>}
 */
function normalizeStatBlock(raw) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!isObj(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!Number.isFinite(v) || k.length > 32) continue;
    out[k] = v;
    if (++n >= MAX_STAT_KEYS) break;
  }
  return out;
}

/**
 * FNV-1a 32-bit, hex — a content hash needs no crypto, only stability across sessions.
 * @param {string} s
 * @returns {string}
 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The record's dedupe id, from match facts the server replays byte-identically on reconnect / reload
 * (server/lobby.js result replay): seed + duration + mode + rounds + outcome + who I was. Two distinct
 * matches colliding on all of these is not a real scenario; a replayed m.result hits the same id and is
 * dropped, which is the point (recording happens on every m.result arrival, replays included).
 * @param {any} res raw m.result payload
 * @param {string|null|undefined} myId the local player's id at that moment
 * @returns {string}
 */
export function recordId(res, myId) {
  const r = isObj(res) ? res : {};
  return `r1.${fnv1a([r.seed ?? '-', r.durationMs ?? '-', r.modeId ?? '-', r.roundsPassed ?? '-', r.victory ? 1 : 0, myId ?? '-'].join('|'))}`;
}

/**
 * Normalize ONE player row: known fields defaulted and bounded, unknown fields dropped. `quit`: the record is a quit
 * record, whose row may not know its rounds (`roundsPassed: null`).
 * @param {any} raw
 * @param {boolean} [quit]
 * @returns {any}
 */
function normalizePlayerRow(raw, quit = false) {
  const p = isObj(raw) ? raw : {};
  // the page and the replay read the title record from the game data by id: the sent texts are not kept
  const title = isObj(p.title) && str(p.title.id) ? { id: str(p.title.id) } : null;
  const lineup = (Array.isArray(p.lineup) ? p.lineup : []).filter(isObj).slice(0, MAX_LINEUP).map((u) => {
    // ids only — the tile position (row/col) is replay detail, not a statistic; items kept (配发装备统计); a 自选
    // pick and a 补位 stand-in kept too, or the replayed card would draw the plain operator
    const e = {
      id: str(u.id) || '', golden: bool(u.golden), tier: int(u.tier, 0),
      items: (Array.isArray(u.items) ? u.items : []).filter((i) => typeof i === 'string' && i.length).slice(0, MAX_ITEMS).map((i) => i.slice(0, 64)),
    };
    if (u.kind === 'token') e.kind = 'token';
    if (isObj(u.diy) && str(u.diy.charId)) {
      e.diy = { charId: str(u.diy.charId), skillIndex: Number.isInteger(u.diy.skillIndex) ? u.diy.skillIndex : 0, uniEquipId: str(u.diy.uniEquipId) };
    }
    if (str(u.standInFor)) e.standInFor = str(u.standInFor);
    return e;
  }).filter((u) => u.id);
  const bonds = (Array.isArray(p.bonds) ? p.bonds : []).filter(isObj).slice(0, MAX_BONDS).map((b) => ({
    bondId: str(b.bondId) || str(b.id) || '', layers: int(b.layers, 0), active: bool(b.active),
  })).filter((b) => b.bondId);
  return {
    playerId: str(p.playerId) || '',
    seat: int(p.seat, 0),
    name: str(p.name, MAX_NAME) || '',
    isBot: bool(p.isBot),
    left: bool(p.left),
    alive: bool(p.alive, true),
    victory: bool(p.victory), // server semantics: team won AND this player was still in at the end
    roundsPassed: quit ? num(p.roundsPassed) : int(p.roundsPassed, 0),
    eliminatedRound: num(p.eliminatedRound),
    lp: num(p.lp),
    bandId: str(p.bandId),
    title,
    trophies: int(p.trophies, 0),
    reward: int(p.reward, 0),
    lineup,
    bonds,
    stats: normalizeStatBlock(p.stats),
  };
}

/**
 * Normalize ONE match record to the current shape (a strict schema: missing fields get defaults, unknown ones are
 * dropped, every string / list is bounded). A record without an `end` is a settled one — the PR #323 build, which
 * never recorded anything else, wrote none.
 * @param {any} raw
 * @returns {any|null} null when the row is not salvageable (no usable player row at all)
 */
export function normalizeRecord(raw) {
  const r = isObj(raw) ? raw : {};
  // a record IS a played match — no usable players array, no record
  if (!Array.isArray(r.players)) return null;
  const quit = r.end === 'quit';
  const players = r.players.filter(isObj).slice(0, MAX_PLAYERS).map((p) => normalizePlayerRow(p, quit));
  if (!players.length) return null;
  /** @type {any} */
  const rec = {
    id: str(r.id),
    v: STATS_VERSION,
    t: int(r.t, 0),
    end: quit ? 'quit' : 'settled',
    ...(r.isMatchingMatch ? { isMatchingMatch: true } : {}),
    victory: bool(r.victory),
    roundsPassed: quit ? num(r.roundsPassed) : int(r.roundsPassed, 0),
    lastRound: num(r.lastRound),
    hiddenReached: bool(r.hiddenReached),
    hiddenCleared: bool(r.hiddenCleared),
    reason: str(r.reason, 32),
    matchPrivacy:!!r.matchPrivacy||!!r.isMatchingMatch, customConfig:r.customConfig?checkCustom(r.customConfig,null,{legacy:true}):null, customEvaluation:r.customEvaluation||null, roomName:str(r.roomName),...(r.initialPlayerCount?{initialPlayerCount:int(r.initialPlayerCount,0),baselineKind:['single','multi'].includes(r.baselineKind)?r.baselineKind:null}:{}),
    ...(r.customConfig ? {customRulesVersion:int(r.customRulesVersion,1)} : {}),
    ...(r.customMetadataMissing ? {customMetadataMissing:true} : {}),
    modeId: str(r.modeId),
    difficulty: str(r.difficulty, 24),
    stageId: str(r.stageId),
    bossId: str(r.bossId),
    hiddenBossId: str(r.hiddenBossId),
    seed: num(r.seed),
    durationMs: num(r.durationMs),
    teamLp: num(r.teamLp),
    roomMode: r.roomMode === 'solo' || r.roomMode === 'coop' || r.roomMode === 'custom' ? r.roomMode : null,
    selfId: str(r.selfId),
    players,
    ...(r.compact===true?{compact:true}:{}),
  };
  // an id-less (hand-made) record gets a content id, so both copies of it land on the same key
  if (!rec.id) rec.id = `c.${fnv1a(JSON.stringify(rec))}`;
  return rec;
}

/**
 * The MIGRATIONS chain: `MIGRATIONS[v]` upgrades a v-envelope to v+1, for v = STATS_VERSION and down.
 * Empty at v1 — the steps exist so the next format change lands as one function here and every stored /
 * imported envelope walks the whole chain.
 * @type {Record<number, (stats: any) => any>}
 */
export const MIGRATIONS = {};

/** Newest first (the stored order): by time, then id. */
const newestFirst = (a, b) => (b.t - a.t) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Bring any stored / imported envelope to the current version.
 * @param {any} raw
 * @returns {{ stats: { v: number, records: any[] }, changed: boolean, newer: boolean, dropped: number }}
 *   `newer` = the data was written by a NEWER build: returned untouched, callers must not save over it.
 *   `dropped` = rows that were not salvageable, repeated a record or went beyond MAX_RECORDS: gone from `stats`.
 */
export function migrateStats(raw) {
  if (!isObj(raw) || !Array.isArray(raw.records)) return { stats: emptyStats(), changed: false, newer: false, dropped: 0 };
  if ((raw.v ?? 0) > STATS_VERSION) {
    return { stats: { v: raw.v, records: raw.records }, changed: false, newer: true, dropped: 0 };
  }
  let v = Number.isFinite(raw.v) ? raw.v : 0;
  let records = raw.records;
  let changed = v !== STATS_VERSION;
  while (v < STATS_VERSION) {
    const step = MIGRATIONS[v];
    if (typeof step === 'function') records = step({ v, records }).records;
    v++;
  }
  // a hand-edited / merged list can be oversized, unsorted or repeat a record: only the newest MAX_RECORDS survive, newest first
  const normalized = [];
  const seen = new Set(); // a record listed twice (hand-merged data) counts once: the first copy
  for (const r of records) {
    const rec = normalizeRecord(r);
    if (rec && !seen.has(rec.id)) { seen.add(rec.id); normalized.push(rec); }
  }
  normalized.sort(newestFirst);
  const kept = normalized.slice(0, MAX_RECORDS);
  const dropped = records.length - kept.length;
  // storage is rewritten (self-healed) when a row went, the order changed or an id-less row got its content id
  changed ||= dropped > 0 || kept.some((rec, i) => !isObj(records[i]) || rec.id !== records[i].id);
  return { stats: { v: STATS_VERSION, records: kept }, changed, newer: false, dropped };
}

// ---- compaction + the storage budget ---------------------------------------------------------------------------

const COMPACT_FRAME = ['customRulesVersion','customMetadataMissing','matchPrivacy','customConfig','customEvaluation','roomName','initialPlayerCount','baselineKind','id', 'v', 't', 'end', 'victory', 'roundsPassed', 'lastRound', 'hiddenReached', 'hiddenCleared', 'reason', 'modeId',
  'difficulty', 'roomMode', 'durationMs', 'selfId', 'isMatchingMatch'];

/**
 * The compact form of a record: the frame and the player's OWN row without lineup, bonds and name — everything the
 * aggregates and the history list read, nothing a replay needs. Teammates are gone. Idempotent.
 * @param {any} rec a normalized record
 * @returns {any}
 */
export function compactRecord(rec) {
  const self = selfRowOf(rec);
  const out = {};
  for (const k of COMPACT_FRAME) if (rec[k] != null) out[k] = rec[k];
  out.compact = true;
  out.players = self ? [{
    playerId: self.playerId, seat: self.seat, alive: self.alive, victory: self.victory, roundsPassed: self.roundsPassed,
    eliminatedRound: self.eliminatedRound, bandId: self.bandId, title: self.title, left: self.left, stats: self.stats,
  }] : [];
  return out;
}

/**
 * What goes to storage: the newest FULL_KEEP records as they are, older ones compacted, then the oldest dropped until
 * the JSON fits `maxChars` (the newest record is always kept).
 * @param {any[]} records newest first
 * @param {number} [maxChars]
 * @returns {any[]}
 */
export function fitToBudget(records, maxChars = MAX_CHARS) {
  const kept = [];
  let used = 40; // the envelope itself
  records.slice(0, MAX_RECORDS).forEach((r, i) => {
    const rec = i < FULL_KEEP ? r : compactRecord(r);
    const n = JSON.stringify(rec).length + 1;
    if (kept.length && used + n > maxChars) return;
    used += n;
    kept.push(rec);
  });
  return kept;
}

/**
 * Derive the room shape ('solo' | 'coop') the way constants.js modeIdFor builds modeIds.
 * @param {string|null|undefined} modeId
 * @param {string|null|undefined} roomMode room.state `mode` when known
 * @returns {'solo'|'coop'|'custom'|null}
 */
export function roomModeOf(modeId, roomMode) {
  if (roomMode === 'solo' || roomMode === 'coop' || roomMode === 'custom') return roomMode;
  if (typeof modeId !== 'string') return null;
  if (modeId.includes('_single_')) return 'solo';
  if (modeId.includes('_multi_')) return 'coop';
  return null;
}

/**
 * Build one settled record from a raw m.result payload (+ context). Null when there is nothing to store: payloads
 * without players (the error-path settlement) or matches the local player did not take part in (spectator
 * seats get every result pushed too — eliminated players, who ARE in players[], keep recording).
 * @param {any} res raw m.result payload
 * @param {{ myId?: string|null, roomMode?: string|null, now?: number }} ctx
 * @returns {any|null}
 */
export function buildRecord(res, ctx = {}) {
  const r = isObj(res) ? res : {};
  if (!Array.isArray(r.players) || !r.players.length) return null;
  const myId = str(ctx.myId);
  const selfRow = r.players.find((p) => isObj(p) && p.playerId === myId);
  if (!selfRow) return null; // spectator / observer: not my match
  return normalizeRecord({
    v: STATS_VERSION,
    t: int(ctx.now, 0),
    id: recordId(r, myId),
    end: 'settled',
    victory: bool(r.victory),
    roundsPassed: int(r.roundsPassed, 0),
    lastRound: num(r.lastRound),
    hiddenReached: bool(r.hiddenReached),
    hiddenCleared: bool(r.hiddenCleared),
    reason: str(r.reason),
    matchPrivacy:r.matchPrivacy,customConfig:r.customConfig,customEvaluation:r.customEvaluation,roomName:r.roomName,initialPlayerCount:r.initialPlayerCount,baselineKind:r.baselineKind,
    customRulesVersion:r.customRulesVersion,customMetadataMissing:r.customMetadataMissing,
    modeId: str(r.modeId),
    difficulty: str(r.difficulty),
    stageId: str(r.stageId),
    bossId: str(r.bossId),
    hiddenBossId: str(r.hiddenBossId),
    seed: num(r.seed),
    durationMs: num(r.durationMs),
    teamLp: num(r.teamLp),
    roomMode: roomModeOf(str(r.modeId), r.roomMode||ctx.roomMode),
    selfId: myId,
    players: r.players,
  });
}

// ---- the match left early ----------------------------------------------------------------------------------------

/**
 * What the page remembers of the match on screen, so that giving it up can still be recorded: when the page first saw
 * it, whether that was at the start (a duration is only kept then), and the last round the player was seen alive in
 * (the server tells the others at the settlement, a leaver nothing).
 * @returns {{ active: boolean, startedAt: number, sawStart: boolean, aliveRound: number|null }}
 */
export const createLiveMatch = () => ({ active: false, startedAt: 0, sawStart: false, aliveRound: null });

/** The module's own tracker (fed by installStatsRecorder, read by recordQuit). */
export const liveMatch = createLiveMatch();

/**
 * Feed the tracker one app state (cheap: called on every store change).
 * @param {ReturnType<typeof createLiveMatch>} live
 * @param {any} state the app store state
 * @param {number} [now]
 */
export function observeMatch(live, state, now = Date.now()) {
  const pub = state?.match?.public;
  const inMatch = !!pub && !!pub.phase && pub.phase !== PHASE.LOBBY && pub.phase !== PHASE.RESULT && !state.match.result;
  if (!inMatch) { live.active = false; return live; }
  const round = Number(pub.round) || 0;
  if (!live.active) {
    live.active = true;
    live.startedAt = now;
    live.sawStart = round <= 1;
    live.aliveRound = null;
  }
  const me = Array.isArray(pub.players) ? pub.players.find((p) => isObj(p) && p.playerId === state.me?.playerId) : null;
  if (me && me.alive !== false) live.aliveRound = Math.max(live.aliveRound ?? 0, round);
  return live;
}

/** Start following the store (main.js). Returns the unsubscribe function. */
export function installStatsRecorder(store) {
  observeMatch(liveMatch, store.get());
  return store.subscribe((s) => observeMatch(liveMatch, s));
}

/**
 * The rounds a player who leaves in `phase` of `round` has cleared — the server's rule for a quit (platform.js _quit:
 * eliminated in round k ⇒ k − 1 passed; leaving in the settlement of round k counts k).
 * @param {string} phase @param {number} round
 */
export function clearedRounds(phase, round) {
  const r = Number.isFinite(round) ? round : 0;
  return Math.max(0, phase === PHASE.SETTLE ? r : r - 1);
}

/**
 * Build the quit record of a match the local player is leaving (放弃模拟), from the app state and the tracker. Null when
 * there is nothing of mine to record: no match on screen, its settlement already here (that one is recorded by
 * recordResult), a spectator seat, or a match the page never saw.
 * @param {any} state the app store state BEFORE the match is cleared
 * @param {{ live?: ReturnType<typeof createLiveMatch>, now?: number }} [ctx]
 * @returns {any|null}
 */
export function buildQuitRecord(state, ctx = {}) {
  const live = ctx.live ?? liveMatch;
  const now = int(ctx.now, Date.now());
  const pub = state?.match?.public;
  const myId = str(state?.me?.playerId);
  if (!pub || !myId || state.match.result || !live.active) return null;
  const row = Array.isArray(pub.players) ? pub.players.find((p) => isObj(p) && p.playerId === myId) : null;
  if (!row) return null; // a spectator seat is no player of the match
  const alive = row.alive !== false;
  const round = Number(pub.round) || 0;
  // alive: the rounds cleared so far; already eliminated: the round it was seen alive in, less one (unknown when the
  // page never saw it alive — a reload after the elimination)
  const roundsPassed = alive ? clearedRounds(pub.phase, round) : (live.aliveRound != null ? Math.max(0, live.aliveRound - 1) : null);
  return normalizeRecord({
    v: STATS_VERSION,
    t: now,
    id: `q.${fnv1a([myId, live.startedAt, pub.modeId ?? '-', state.room?.code ?? '-'].join('|'))}`,
    end: 'quit',
    victory: false,
    roundsPassed,
    lastRound: num(pub.lastRound),
    hiddenReached: pub.phase === PHASE.HIDDEN_CORE,
    hiddenCleared: false,
    reason: 'quit',
    modeId: str(pub.modeId),
    difficulty: str(pub.difficulty),
    stageId: str(pub.stageId),
    bossId: str(pub.bossId),
    hiddenBossId: str(pub.hiddenBossId),
    seed: null,
    durationMs: live.sawStart ? Math.max(0, now - live.startedAt) : null,
    teamLp: num(pub.teamLp),
    roomMode: roomModeOf(str(pub.modeId), state.room?.mode),
    matchPrivacy:pub.matchPrivacy,isMatchingMatch:pub.matchmaking,
    customConfig:pub.customConfig,customEvaluation:pub.customEvaluation,roomName:pub.roomName,
    initialPlayerCount:pub.initialPlayerCount,baselineKind:pub.baselineKind,customRulesVersion:pub.customRulesVersion,
    selfId: myId,
    players: [{
      playerId: myId, seat: row.seat, name: row.name, isBot: false, left: true, alive, victory: false, roundsPassed,
      eliminatedRound: alive ? null : live.aliveRound, lp: row.lp, bandId: row.bandId,
    }],
  });
}

/**
 * The m.result-shaped payload behind a settled record — the inverse of buildRecord. The stats page's history
 * rows hand this to the settlement view (screens/result.js reads it through normalizeResult): a finished match can be
 * RE-VIEWED because the record kept every field the payload had. Whatever a record never stored is simply absent and
 * normalizeResult defaults it, exactly like a tolerant live payload. A quit record (nothing was settled) and a
 * compacted one (its rows are gone) have no settlement to show.
 * @param {any} rec
 * @returns {any|null} null when the row is not a usable, full, settled record
 */
export function recordToResult(rec) {
  const r = normalizeRecord(rec);
  if (!r || r.end === 'quit' || r.compact) return null;
  const res = {
    victory: r.victory,
    roundsPassed: r.roundsPassed,
    hiddenReached: r.hiddenReached,
    hiddenCleared: r.hiddenCleared,
    reason: r.reason,matchPrivacy:r.matchPrivacy,customConfig:r.customConfig,customEvaluation:r.customEvaluation,roomMode:r.roomMode,roomName:r.roomName,initialPlayerCount:r.initialPlayerCount,baselineKind:r.baselineKind,
    customRulesVersion:r.customRulesVersion,customMetadataMissing:r.customMetadataMissing,
    modeId: r.modeId,
    difficulty: r.difficulty,
    bossId: r.bossId,
    hiddenBossId: r.hiddenBossId,
    seed: r.seed,
    durationMs: r.durationMs,
    teamLp: r.teamLp,
    players: r.players,
  };
  if (Number.isFinite(r.lastRound)) res.lastRound = r.lastRound;
  return res;
}

/**
 * Append one record: replays (same content id) are dropped, newest first, capped at MAX_RECORDS.
 * @param {{ v: number, records: any[] }} stats
 * @param {any} record
 * @returns {{ stats: { v: number, records: any[] }, added: boolean }}
 */
export function appendRecord(stats, record) {
  if (!record || !record.id) return { stats, added: false };
  if (stats.records.some((r) => r.id === record.id)) return { stats, added: false };
  const records = [record, ...stats.records].slice(0, MAX_RECORDS);
  return { stats: { v: STATS_VERSION, records }, added: true };
}

export function mergeStats(a, b) {
  const byId = new Map();
  for (const r of [...(Array.isArray(b?.records) ? b.records : []), ...(Array.isArray(a?.records) ? a.records : [])]) {
    const rec = normalizeRecord(r);
    if (rec) byId.set(rec.id, rec);
  }
  const records = [...byId.values()].sort(newestFirst).slice(0, MAX_RECORDS);
  return { v: STATS_VERSION, records };
}

const SELF_STATS = ['dmgDealt', 'kills', 'bossDamage', 'activatedLayers', 'merges', 'itemsEquipped', 'gold', 'perfectRounds', 'refreshes', 'leaks', 'lpLost'];
export function selfRowOf(rec) {
  const ps = Array.isArray(rec?.players) ? rec.players : [];
  return ps.find((p) => p.playerId && p.playerId === rec.selfId)
    || ps.find((p) => !p.isBot)
    || ps[0]
    || null;
}

/** Whether this record counts as a win for its self player (per-row victory = team won AND still in). */
const selfWon = (rec, self) => (self ? !!self.victory : !!rec.victory);

/**
 * The rounds the player passed in a record: its own row's (the table the settlement prints per player), else the
 * team's; 0 when the record does not know.
 * @param {any} rec
 */
export function roundsOf(rec) {
  const self = selfRowOf(rec);
  const v = self && Number.isFinite(self.roundsPassed) ? self.roundsPassed : rec?.roundsPassed;
  return Number.isFinite(v) ? v : 0;
}

/**
 * Whether a record enters the aggregates (see the header). A settled record always does. A quit record does once the
 * player had finished at least one battle: cleared a round, or was already eliminated; a match given up before that —
 * entered and left right away — is history only.
 * @param {any} rec a normalized record
 * @returns {boolean}
 */
export function countsTowardStats(rec) {
  if (!isObj(rec)) return false;
  if (rec.end !== 'quit') return true;
  const self = selfRowOf(rec);
  if (!self) return false;
  return self.alive === false || (Number.isFinite(self.roundsPassed) && self.roundsPassed >= 1);
}

/**
 * Aggregate records for the stats page — over the records that count; `total` / `excluded` say how many did not.
 * Everything is keyed by ids (bandId / titleId / difficulty); the page maps them to names and icons through the game
 * data. The combat totals read the settled records' stat blocks (a quit record has none).
 * @param {any[]} records
 * @returns {any}
 */
export function aggregateStats(records) {
  const all = Array.isArray(records) ? records : [];
  const rs = all.filter(countsTowardStats);
  const out = {
    total: all.length, count: rs.length, excluded: all.length - rs.length, wins: 0,
    rounds: { total: 0, max: 0 },
    duration: { totalMs: 0 },
    hidden: { reached: 0, cleared: 0 },
    byDifficulty: {}, byMode: { solo: 0, coop: 0 },
    titles: {}, bands: {}, sums: {},
  };
  for (const rec of rs) {
    const self = selfRowOf(rec);
    const won = selfWon(rec, self);
    if (won) out.wins++;
    const rounds = roundsOf(rec);
    out.rounds.total += rounds;
    out.rounds.max = Math.max(out.rounds.max, rounds);
    out.duration.totalMs += num(rec.durationMs) || 0;
    if (rec.hiddenReached) out.hidden.reached++;
    if (rec.hiddenCleared) out.hidden.cleared++;

    const d = rec.difficulty || 'UNKNOWN';
    const bd = (out.byDifficulty[d] ||= { games: 0, wins: 0, hiddenCleared: 0 });
    bd.games++;
    if (won) bd.wins++;
    if (rec.hiddenCleared) bd.hiddenCleared++;

    if (rec.roomMode === 'solo' || rec.roomMode === 'coop') out.byMode[rec.roomMode]++;

    const titleId = self?.title?.id;
    if (titleId) {
      const t = (out.titles[titleId] ||= { count: 0 });
      t.count++;
    }

    const bandId = self?.bandId;
    if (bandId) {
      const b = (out.bands[bandId] ||= { games: 0, wins: 0 });
      b.games++;
      if (won) b.wins++;
    }

    if (rec.end !== 'quit' && self && isObj(self.stats)) {
      for (const k of SELF_STATS) {
        const v = self.stats[k];
        if (Number.isFinite(v)) out.sums[k] = (out.sums[k] || 0) + v;
      }
    }
  }
  return out;
}
