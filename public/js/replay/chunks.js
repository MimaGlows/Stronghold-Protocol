export const REPLAY_CACHE_BYTES = 32 * 1024 * 1024;
/** LRU by decoded JSON byte size; only the requested position is loaded, no whole-match duplicate. */
export function createReplayCache(limit = REPLAY_CACHE_BYTES) {
  const entries = new Map(); let bytes=0;
  return {
    get(key) { const item=entries.get(key); if(!item)return null; entries.delete(key);entries.set(key,item);return item.value; },
    put(key,value,size) {
      if (!Number.isFinite(size) || size<0 || size>limit) throw new Error('replay-cache-size');
      if(entries.has(key)){bytes-=entries.get(key).size;entries.delete(key);}
      while(bytes+size>limit && entries.size){const oldest=entries.keys().next().value;bytes-=entries.get(oldest).size;entries.delete(oldest);}
      entries.set(key,{value,size});bytes+=size;
    },
    clear(){entries.clear();bytes=0;}, stats(){return {bytes,entries:entries.size,limit};},
  };
}
export function chunkAt(field, gt) {
  const chunks=field.chunks || [];
  return Math.max(0,chunks.findLastIndex((c)=>c.from<=gt));
}
