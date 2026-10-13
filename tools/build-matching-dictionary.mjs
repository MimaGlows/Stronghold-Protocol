// Offline, reproducible conversion of the owner's fixed upstream dictionary snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeCallsign } from '../server/matchmaking/sensitive.js';
const root = path.resolve('.development/sensitive-source');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
const words = new Set();
for (const entry of manifest.files) {
  const bytes = fs.readFileSync(path.join(root, entry.file));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Source checksum mismatch: ${entry.path}`);
  let text, encoding;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else if ([...bytes.subarray(0, 256)].filter((b) => b === 0).length > 25) encoding = 'utf-16le';
  if (encoding) text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  else try { encoding = 'utf-8'; text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { encoding = 'gb18030'; text = new TextDecoder(encoding).decode(bytes); }
  entry.encoding = encoding;
  entry.decodingWarnings = (text.match(/\uFFFD/g) || []).length;
  const list = entry.file.endsWith('.php') ? [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]) : text.split(/[\r\n|]+/);
  for (let word of list) {
    word = word.split('=')[0].replace(/\{\d+\}/g, '').trim();
    word = normalizeCallsign(word).replace(/[\s\p{P}\p{S}]/gu, '');
    // Callsigns have at most 12 UTF-16 units. Exclude file annotations and unmatchable long entries.
    if (word && word.length <= 12 && !/[\uFFFD\u0000-\u001F]/u.test(word)) words.add(word);
  }
}
const bytes = Buffer.from([...words].sort().join('\n') + '\n');
fs.writeFileSync('server/matchmaking/sensitive-words.txt', bytes);
fs.writeFileSync('server/matchmaking/sensitive-source.json', JSON.stringify({ ...manifest, count: words.size, sha256: createHash('sha256').update(bytes).digest('hex'), conversion: 'NFKC/lowercase, zero-width and separator removal; exact literals; UTF-8, UTF-16 or GB18030; <=12 UTF-16 units', exclusions: 'Archive/PDF/spreadsheet duplicates, synonym list and dictionary statistics; archived-only files are not imported.' }, null, 2) + '\n');
console.log(`Matching dictionary: ${words.size} normalized entries from ${manifest.files.length} files`);
