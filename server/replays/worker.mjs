// Build durable frame tracks from the exact archived inputs, in an isolated worker.
import { parentPort, workerData } from 'node:worker_threads';
import { createBattleFromSpec, battleProgress } from '../sim/spec.js';
import { DataSource, setSimData } from '../sim/simdata.js';
import { setGameData } from '../sim/content/support/index.js';
const { record, data } = workerData;
setSimData(data); setGameData(data);
const ds = new DataSource(data, null);
const logger = { error(...args) { record.errors.push(String(args[0])); }, warn() {}, info() {}, debug() {} };
for (const field of record.fields) {
  if (field.frames?.length) continue;
  try {
    const b = createBattleFromSpec(field.spec, ds, { logger });
    b.start(); field.meta = b.fieldMeta(); field.frames = [];
    let ci = 0, ticks = 0;
    const cap = Math.min(600, field.endGt ?? field.spec.timeLimit ?? 240);
    const emit = () => field.frames.push({ gt: b.time, snap: b.snapshot(), progress: battleProgress(b), ev: b.drainEvents() });
    emit();
    while (!b.finished && b.time < cap) {
      while (ci < field.controls.length && field.controls[ci].gt <= b.time) {
        const c = field.controls[ci++]; b.sharedBoss?.sync?.(c.hp, c.acked);
      }
      b.step(); ticks++;
      if (ticks % 3 === 0 || b.finished) emit();
    }
    if (!b.finished) { b.forceEnd(field.result?.reason || 'timeout'); emit(); }
    // The recorded browser timeline can outlast the reconstructed battle. Keep its final state
    // visible until the recorded end, without inventing combat events or dropping the last frame.
    if (field.frames.at(-1)?.gt < cap) field.frames.push({
      gt: cap, snap: b.snapshot(), progress: battleProgress(b), ev: [],
    });
    field.endGt = field.endGt ?? b.time;
    // Explicitly label reconstructed frames; these are not captured video of a client's renderer.
    field.source = 'simulation';
  } catch (e) { field.error = String(e.message); record.errors.push(field.error); }
}
record.status = record.errors.length ? 'partial' : 'ready';
parentPort.postMessage(record);
