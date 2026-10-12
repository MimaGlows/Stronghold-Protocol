import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommunicationInput } from '../../public/js/ui/communicationInput.js';
import { sanitizeHotkeys, DEFAULT_HOTKEYS, shortcutFor, actionForKey } from '../../public/js/ui/gameLogic/shortcuts.js';
import { Net } from '../../public/js/net.js';

function input() {
  const listeners = new Map(), timers = new Map(), sent = [], ui = { active: false, radio: false, wheel: null }, state = { enabled: true, blocked: false };
  const target = { kind: 'tile', playerId: 'p_0', row: 9, col: 2, intent: 'location' };
  const control = createCommunicationInput({ surface: { addEventListener: (n, f) => listeners.set(n, f), removeEventListener: (n) => listeners.delete(n) },
    get: () => ({ ...state, ...ui, contains: () => true, action: (e) => shortcutFor(e), releasePing: (e) => actionForKey(e) === 'ping' }),
    resolve: () => ({ target, tile: target }), send: (target) => sent.push(target), change: (s) => Object.assign(ui, s),
    schedule: (f) => { timers.set(1, f); return 1; }, unschedule: () => timers.delete(1),
  });
  const fire = (name, fields = {}) => { const e = { button: 0, pointerId: 1, clientX: 100, clientY: 100, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...fields }; listeners.get(name)?.(e); return e; };
  return { control, fire, ui, state, sent, hold: () => timers.get(1)?.() };
}
test('short click and long wheel send once; all directions and cancel work', () => {
  const h = input(); h.fire('keydown', { key: 'z', code: 'KeyZ' }); assert.equal(h.ui.active, true);
  assert.equal(h.fire('pointerdown').stopped, true); h.fire('pointerup'); assert.equal(h.sent.length, 1);
  assert.equal(h.fire('click').stopped, true, 'native purchase/detail click is swallowed');
  for (const [dx, dy, result] of [[0, -80, 'danger'], [80, 0, 'missing'], [-80, 0, 'good'], [0, 80, null], [0, 0, null]]) {
    const before = h.sent.length; h.fire('pointerdown'); h.hold(); assert.ok(h.ui.wheel); h.fire('pointermove', { clientX: 100 + dx, clientY: 100 + dy }); h.fire('pointerup');
    assert.equal(h.sent.length, before + (result ? 1 : 0)); if (result) assert.equal(h.sent.at(-1).intent, result);
    assert.equal(h.ui.wheel, null);
  }
  h.control.dispose();
});
test('release Z, Escape, blur, pointercancel, blocked drag and disabled observer cancel safely', () => {
  for (const [event, fields] of [['keyup', { key: 'z', code: 'KeyZ' }], ['keydown', { key: 'Escape' }], ['blur', {}], ['pointercancel', {}]]) {
    const h = input(); h.fire('keydown', { key: 'z' }); h.fire('pointerdown'); h.hold(); h.fire(event, fields); h.fire('pointerup'); assert.equal(h.sent.length, 0); assert.equal(h.ui.active, false); h.control.dispose();
  }
  const h = input(); h.state.blocked = true; h.fire('keydown', { key: 'z' }); assert.equal(h.ui.active, false); h.state.blocked = false;
  h.fire('keydown', { key: 'z', target: { tagName: 'INPUT' } }); assert.equal(h.ui.active, false);
  h.state.enabled = false; h.fire('keydown', { key: 'x' }); assert.equal(h.ui.radio, false);
});
test('radio closes ping mode, repeat does not toggle, touch uses the same hold and release', () => {
  const h = input(); h.control.touchToggle(); h.fire('pointerdown'); h.hold(); h.fire('pointermove', { clientY: 30 }); h.fire('pointerup'); assert.equal(h.sent[0].intent, 'danger');
  h.fire('keydown', { key: 'x' }); assert.equal(h.ui.radio, true); assert.equal(h.ui.active, false);
  h.fire('keydown', { key: 'x', repeat: true }); assert.equal(h.ui.radio, true); h.fire('keydown', { key: 'Escape' }); assert.equal(h.ui.radio, false); h.control.dispose();
});
test('legacy bindings migrate only conflicts and current rebinding maps are stable', () => {
  const legacy = { refresh: 'KeyR', freeze: 'KeyF', levelUp: 'KeyD', retreat: 'KeyQ', sell: 'KeyX', ready: 'Space' };
  assert.deepEqual(sanitizeHotkeys(legacy), { ...DEFAULT_HOTKEYS });
  const custom = sanitizeHotkeys({ ...legacy, refresh: 'KeyC', retreat: 'KeyZ' });
  assert.equal(custom.refresh, 'KeyC'); assert.equal(custom.retreat, 'KeyV'); assert.equal(custom.sell, 'KeyB');
  assert.equal(custom.ping, 'KeyZ'); assert.equal(custom.radio, 'KeyX'); assert.equal(new Set(Object.values(custom)).size, 8);
  const later = sanitizeHotkeys({ ...legacy, refresh: 'KeyX', sell: 'KeyC', ready: 'KeyV' });
  assert.equal(later.sell, 'KeyC'); assert.equal(later.ready, 'KeyV'); assert.equal(later.refresh, 'KeyB');
  assert.deepEqual(sanitizeHotkeys(custom), custom); assert.equal(shortcutFor({ key: 'x' }), 'radio'); assert.equal(shortcutFor({ key: 'c' }), 'sell');
});

test('a cancelled pointer without a click cannot swallow a later ordinary action', () => {
  const h = input(); h.fire('keydown', { key: 'z' }); h.fire('pointerdown'); h.fire('pointercancel');
  h.fire('pointerdown'); assert.equal(h.fire('click').stopped, undefined); h.control.dispose();
});

test('communications never queue during reconnection and pending sends are cancelled on account switch', async () => {
  const n = new Net(); n.name = '旧博士#0001'; n.status = 'reconnecting';
  const radio = { id: 0, phase: 'PREP', round: 1 };
  await assert.rejects(n.request('g.radio', radio), (e) => e.code === 'OFFLINE');
  await assert.rejects(n.request('g.ping', { phase: 'PREP', round: 1, target: { kind: 'funds', playerId: 'p_0' } }), (e) => e.code === 'OFFLINE');
  assert.equal(n._pending.size, 0);
  n.status = 'online'; n.ws = { readyState: 1, send() {}, close() {} };
  const pending = n.request('g.radio', radio).catch((e) => e.code);
  assert.equal(n._pending.size, 1); n.setName('新博士#0001');
  assert.equal(await pending, 'OFFLINE'); assert.ok([...n._pending.values()].every((e) => e.msg.t !== 'g.radio'));
  n.close();
});
