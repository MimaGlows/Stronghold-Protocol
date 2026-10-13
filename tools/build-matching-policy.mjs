// Reclassify the pinned local snapshot. No networking and no per-account allowlist.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeCallsign } from '../server/matchmaking/sensitive.js';
const meta = JSON.parse(fs.readFileSync('server/matchmaking/sensitive-source.json', 'utf8'));
const political = new Set(), abuse = new Set(['fuck','fucking','motherfucker','shit','bitch','asshole','cunt','porn','penis','vagina']);
const categories = /反动词库|政治类|时事类|领导名人类|迷信、邪教类|BBSCH\/(?:zhengfu|zhengzhi|xiejiao)\.txt/;
const abusiveCategories = /色情词库|色情类|骂人、讽刺类|BBSCH\/(?:seqing|disu)\.txt|english_dictionary/;
const explicit = /傻[逼屄]|[操肏]你|[操肏]他|[操肏]她|[操肏]妈|你妈[逼屄]|鸡巴|阴茎|阴道|阴蒂|龟头|肛交|口交|[强輪轮]奸|精液|射精|裸聊|做爱|卖淫|嫖娼|淫乱|色情|性交|兽交|援交|娘炮|婊子|杂种|王八蛋|狗娘养/;
let excluded = 0;
for (const entry of meta.files) {
  const bytes = fs.readFileSync('.development/sensitive-source/' + entry.file);
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Source checksum mismatch');
  const text = new TextDecoder(entry.encoding).decode(bytes);
  const list = entry.file.endsWith('.php') ? [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]) : text.split(/[\r\n|]+/);
  for (let word of list) {
    word = normalizeCallsign(word.split('=')[0].replace(/\{\d+\}/g,'').trim()).replace(/[\s\p{P}\p{S}]/gu,'');
    if (!word || word.length > 12 || /[\uFFFD\u0000-\u001F]/u.test(word)) { excluded++; continue; }
    if (categories.test(entry.path)) political.add(word);
    else if (abusiveCategories.test(entry.path) && explicit.test(word)) abuse.add(word);
    else excluded++;
  }
}
const write = (file, words) => { const bytes = Buffer.from([...words].sort().join('\n')+'\n'); fs.writeFileSync('server/matchmaking/'+file,bytes); return createHash('sha256').update(bytes).digest('hex'); };
const sha256 = write('sensitive-words.txt',political), abuseSha256 = write('sensitive-abuse.txt',abuse);
fs.writeFileSync('server/matchmaking/sensitive-source.json', JSON.stringify({ ...meta, policyVersion: 2, count: political.size, sha256, abuseCount: abuse.size, abuseSha256,
  categories: { political: categories.source, abusiveSources: abusiveCategories.source, explicitNonPolitical: explicit.source },
  policy: 'Political: normalized substring, unchanged categorized source terms. Nonpolitical: explicit Chinese substrings, English whole token or whole compact callsign. Generic mixed lists, admin terms and meaningless short terms excluded.',
  exclusions: { count: excluded, reason: 'Invalid/too long entries or unclassified/general/non-explicit nonpolitical terms', regression: 'ma from 其他词库 and 百度过滤词 excluded by category, no MimaGlows allowlist' } }, null, 2)+'\n');
console.log(`Political ${political.size}, explicit abuse ${abuse.size}; policy v2`);
