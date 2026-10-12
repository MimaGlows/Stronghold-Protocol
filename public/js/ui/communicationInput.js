import { HOLD_MS, wheelDirection } from '../../../shared/communication.js';

/** Capture controller shared by mouse and touch. No synthetic game clicks. */
export function createCommunicationInput({ surface, get, resolve, send, change, schedule = setTimeout, unschedule = clearTimeout }) {
  let held = false, touch = false, press = null, timer = null, swallowClick = false;
  const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const cancelPress = () => { unschedule(timer); timer = null; press = null; change({ wheel: null }); };
  const cancel = () => { held = false; touch = false; cancelPress(); change({ active: false, radio: false }); };
  const active = () => held || touch;
  const blocked = () => !get().enabled || get().blocked;
  const down = (e) => {
    if (!active()) { swallowClick = false; return; }
    if (!active() || e.button !== 0 || e.target?.closest?.('[data-communication-control]') || !get().contains(e.target)) return;
    stop(e); swallowClick = true;
    if (blocked()) { cancel(); return; }
    const hit = resolve(e);
    if (!hit) { cancelPress(); return; }
    cancelPress();
    press = { target: hit.target, tile: hit.tile, pointerId: e.pointerId, x: e.clientX, y: e.clientY, direction: 'cancel', wheel: false };
    if (hit.tile) timer = schedule(() => { if (!press || blocked()) { cancel(); return; } press.wheel = true; change({ wheel: { x: press.x, y: press.y, direction: press.direction } }); }, HOLD_MS);
  };
  const move = (e) => {
    if (!press || press.pointerId !== e.pointerId) return;
    stop(e);
    press.direction = wheelDirection(e.clientX - press.x, e.clientY - press.y);
    if (press.wheel) change({ wheel: { x: press.x, y: press.y, direction: press.direction } });
  };
  const up = (e) => {
    if (!press || press.pointerId !== e.pointerId) return;
    stop(e);
    const p = press;
    cancelPress();
    if (blocked() || !active()) return;
    if (p.wheel) { if (p.direction !== 'cancel') send({ ...p.tile, intent: p.direction }); }
    else send(p.target);
  };
  const click = (e) => {
    if (swallowClick) { swallowClick = false; if (get().contains(e.target) && !e.target?.closest?.('[data-communication-control]')) stop(e); }
    else if (active() && get().contains(e.target) && !e.target?.closest?.('[data-communication-control]')) stop(e);
  };
  const key = (e) => {
    const s = get(), action = s.action(e);
    if (action === 'escape' && (active() || s.radio)) { stop(e); cancel(); return; }
    if (action === 'ping' || action === 'radio') {
      if (blocked()) return;
      stop(e);
      if (e.repeat) return;
      if (action === 'ping') { held = true; change({ active: true, radio: false }); }
      else { held = false; touch = false; cancelPress(); change({ active: false, radio: !s.radio }); }
    } else if (active() && action) stop(e);
  };
  const release = (e) => { if (get().releasePing(e) && held) { held = false; cancelPress(); change({ active: touch }); } };
  const listeners = { pointerdown: down, pointermove: move, pointerup: up, click, keydown: key, keyup: release, blur: (e) => { if (!e.target || e.target === surface) cancel(); }, pointercancel: cancel };
  for (const [name, fn] of Object.entries(listeners)) surface.addEventListener(name, fn, { capture: true, passive: false });
  return {
    cancel,
    touchToggle() { if (blocked()) return; touch = !touch; held = false; cancelPress(); change({ active: touch, radio: false }); },
    dispose() { cancel(); for (const [name, fn] of Object.entries(listeners)) surface.removeEventListener(name, fn, true); },
  };
}
