// Lossless per-unit snapshot deltas; all frame timestamps and battle events are retained.
export function packRecord(record) {
  return { ...record, encoding: 'units-delta-v1', fields: record.fields.map((field) => {
    let prev = new Map();
    return { ...field, frames: field.frames?.map((frame, i) => {
      const rows = frame.snap.units || [], next = new Map(rows.map((row) => [row[0], row]));
      const keyframe = i % 100 === 0;
      const changed = keyframe ? rows : rows.filter((row) => JSON.stringify(row) !== JSON.stringify(prev.get(row[0])));
      const removed = keyframe ? [] : [...prev.keys()].filter((id) => !next.has(id));
      prev = next;
      const { units, ...snap } = frame.snap; void units;
      return { ...frame, snap: { ...snap, unitDelta: changed, unitRemoved: removed, unitKeyframe: keyframe, unitOrder: rows.map((r) => r[0]) } };
    }) };
  }) };
}
export function unpackRecord(record) {
  if (record.encoding !== 'units-delta-v1') return record;
  const { encoding, ...plain } = record; void encoding;
  return { ...plain, fields: record.fields.map((field) => {
    let units = new Map();
    return { ...field, frames: field.frames?.map((frame) => {
      const { unitDelta, unitRemoved, unitKeyframe, unitOrder, ...snap } = frame.snap;
      if (unitKeyframe) units = new Map();
      for (const id of unitRemoved) units.delete(id);
      for (const row of unitDelta) units.set(row[0], row);
      return { ...frame, snap: { ...snap, units: unitOrder.map((id) => units.get(id)) } };
    }) };
  }) };
}
