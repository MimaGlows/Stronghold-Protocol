/** Public projection only. Durable account ownership remains in the server archive. */
export function redactMatchIdentity(value) {
  if(Array.isArray(value))return value.map(redactMatchIdentity);
  if(!value || typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='doctorCode').map(([k,v])=>[k,redactMatchIdentity(v)]));
}
export function hasMatchPrivacy(record) {
  return !!(record?.matchPrivacy || record?.isMatchingMatch || record?.matching || record?.result?.matchPrivacy || record?.result?.isMatchingMatch || record?.result?.matching);
}
export function privacyRecord(record) {
  return hasMatchPrivacy(record) ? redactMatchIdentity(record) : record;
}
