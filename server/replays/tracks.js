import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { unpackRecord } from './codec.js';

export const TRACK_CHUNK_BYTES = 8 * 1024 * 1024;
export const TRACK_CHUNK_SECONDS = 10;

/** Sidecars are private archive data. Source archives remain unchanged and authoritative. */
export function trackDirectory(archive, id) { return path.join(archive.dir, `${id}.tracks`); }
export function readTrackIndex(archive, id) {
  try {
    const data = JSON.parse(gunzipSync(fs.readFileSync(path.join(trackDirectory(archive,id), 'index.gz'))));
    const stat = fs.statSync(archive.file(id));
    return stat.size === data.sourceSize && stat.mtimeMs === data.sourceTime ? data.record : null;
  } catch { return null; }
}
function atomic(file, obj) {
  const tmp = `${file}.tmp`; fs.writeFileSync(tmp, gzipSync(JSON.stringify(obj))); fs.renameSync(tmp,file);
}
export function buildTrackIndex(archive, raw) {
  const record = unpackRecord(raw), dir = trackDirectory(archive,raw.id);
  fs.mkdirSync(dir,{recursive:true});
  const fields = record.fields.map((field, fi) => {
    const { frames = [], ...rest } = field;
    const infos = new Map((field.meta?.units || []).map((u)=>[u.id,u])), forms = new Map(), chunks=[];
    let batch=[], bytes=0, start=0, meta=null, restoreEvents=[];
    const flush = () => {
      if (!batch.length) return;
      const chunk = { fieldId: field.id, start, meta, restoreEvents, frames: batch };
      const jsonBytes = Buffer.byteLength(JSON.stringify(chunk));
      if (jsonBytes > TRACK_CHUNK_BYTES) throw new Error('track-chunk-size');
      const n=chunks.length; atomic(path.join(dir,`${fi}-${n}.gz`),chunk);
      chunks.push({ index:n, from:batch[0].gt, to:batch.at(-1).gt, bytes:jsonBytes });
      start += batch.length; batch=[]; bytes=0;
    };
    for (const frame of frames) {
      const size=Buffer.byteLength(JSON.stringify(frame));
      if (batch.length && (frame.gt-batch[0].gt >= TRACK_CHUNK_SECONDS || bytes+size > TRACK_CHUNK_BYTES/2)) flush();
      if (!batch.length) { meta={...field.meta,units:[...infos.values()]}; restoreEvents=[...forms.values()]; }
      batch.push(frame); bytes+=size;
      for (const e of frame.ev) {
        if (e[0]==='spawn') infos.set(e[1].id,e[1]);
        if(e[0]==='fx' && e[4]?.id != null && Object.hasOwn(e[4],'form')) forms.set(e[4].id,e);
      }
    }
    flush();
    const progressTrack=frames.filter((f,i)=>i===0 || i===frames.length-1 || Math.floor(f.gt)!==Math.floor(frames[i-1].gt))
      .map((f)=>({gt:f.gt,progress:f.progress}));
    return {...rest, chunks, progressTrack, trackField:fi};
  });
  const manifest={...record,fields,trackMode:'chunks-v1'};
  const stat=fs.statSync(archive.file(raw.id));
  atomic(path.join(dir,'index.gz'),{sourceSize:stat.size,sourceTime:stat.mtimeMs,record:manifest});
  return manifest;
}
export function readTrackChunk(archive, record, field, chunk) {
  if (!Number.isInteger(field) || !Number.isInteger(chunk) || !record.fields[field]?.chunks?.[chunk]) return null;
  try { return JSON.parse(gunzipSync(fs.readFileSync(path.join(trackDirectory(archive,record.id),`${field}-${chunk}.gz`)),{maxOutputLength:TRACK_CHUNK_BYTES})); } catch { return null; }
}
