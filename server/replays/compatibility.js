import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Generation signature intentionally excludes UI, HTTP, account and host presentation code. */
export function simulationVersion(root = fileURLToPath(new URL('../../', import.meta.url))) {
  const hash = createHash('sha256');
  const files = new Set();
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.(js|json)$/.test(entry.name)) files.add(file);
    }
  };
  scan(path.join(root, 'server/sim'));
  // Follow actual relative code dependencies (loadout, potential, constants, etc.),
  // avoiding unrelated shared UI/protocol changes in the generation signature.
  const visit = (file) => {
    const src=fs.readFileSync(file,'utf8');
    for (const match of src.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const dep=path.resolve(path.dirname(file),match[1]);
      if(!dep.startsWith(path.resolve(root)+path.sep) || !/\.js$/.test(dep) || files.has(dep) || !fs.existsSync(dep))continue;
      files.add(dep);visit(dep);
    }
  };
  for(const file of [...files])if(file.endsWith('.js'))visit(file);
  for(const file of [...files].sort()) { hash.update(path.relative(root,file).replaceAll('\\','/'));hash.update(fs.readFileSync(file)); }
  // Inputs include their own archived data. This signature guards code, not live data replacements.
  return hash.digest('hex').slice(0,20);
}

export function playbackCompatibility(record) {
  if (record.v !== 1 || !Array.isArray(record.nodes) || !Array.isArray(record.fields)) return 'archive-schema';
  if (record.encoding && record.encoding !== 'units-delta-v1') return 'snapshot-encoding';
  for (const f of record.fields) {
    if (!Array.isArray(f.players) || !f.spec || f.spec.v !== 1) return 'field-schema';
    for (const frame of f.frames || []) {
      if (!Number.isFinite(frame.gt) || !frame.snap || !Array.isArray(frame.ev)) return 'frame-schema';
      const rows = record.encoding ? frame.snap.unitDelta : frame.snap.units;
      if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row) || row.length < 5)) return 'snapshot-schema';
      if (record.encoding && (!Array.isArray(frame.snap.unitRemoved) || !Array.isArray(frame.snap.unitOrder))) return 'snapshot-schema';
    }
  }
  return null;
}
