// Content fingerprint survives copying a deployment but changes when code/data versions change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = new URL('../../', import.meta.url);
export function replayVersion(rootDir = fileURLToPath(root), relativePath = path.relative) {
  const hash = createHash('sha256');
  function scan(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) scan(file);
      else if (/\.(js|mjs|json|html|css)$/.test(item.name)) { hash.update(relativePath(rootDir, file).replaceAll('\\', '/')); hash.update(fs.readFileSync(file)); }
    }
  }
  for (const dir of ['server', 'shared', 'public/js', 'public/css', 'data']) scan(path.join(rootDir, dir));
  hash.update(fs.readFileSync(path.join(rootDir, 'package.json')));
  return hash.digest('hex').slice(0, 20);
}
