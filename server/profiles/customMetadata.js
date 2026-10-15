// Offline, evidence-only repair. No battle execution or score recalculation belongs here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {checkCustom} from '../../shared/custom.js';
import {hasMatchPrivacy} from '../../shared/matchPrivacy.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x));
export function recoverCustomMetadata(record,profile,archive){
  if(record.end!=='quit'||record.roomMode!=='custom')return null;
  const next={...record};
  const people=archive?.participants?.filter(p=>!p.isBot&&p.name===profile.name&&p.doctorCode===profile.code);
  const trusted=archive?.id===record.id&&people?.length===1&&people[0].playerId===record.selfId;
  if(trusted){
    const sources=[archive,archive.result].filter(Boolean);
    // Conflicting authoritative snapshots are not guessed away.
    const configs=sources.filter(s=>s.customConfig&&checkCustom(s.customConfig,null,{legacy:true})).map(s=>s.customConfig);
    const evaluations=sources.filter(s=>Number.isFinite(s.customEvaluation?.score)&&s.customEvaluation.score>=1).map(s=>s.customEvaluation);
    const unique=xs=>xs.length&&xs.every(x=>JSON.stringify(x)===JSON.stringify(xs[0]))?clone(xs[0]):null;
    if(!next.customConfig)next.customConfig=unique(configs);
    if(!next.customEvaluation)next.customEvaluation=unique(evaluations);
    if(!next.initialPlayerCount){
      const counts=[...new Set(sources.map(s=>s.initialPlayerCount).filter(n=>Number.isInteger(n)&&n>=1&&n<=6))];
      if(counts.length===1)next.initialPlayerCount=counts[0];
      else if(!counts.length&&archive.participants.length>=1&&archive.participants.length<=6)next.initialPlayerCount=archive.participants.length;
    }
    if(!next.baselineKind&&next.initialPlayerCount)next.baselineKind=next.initialPlayerCount===1?'single':'multi';
    if(!next.roomName)next.roomName=sources.find(s=>s.roomName)?.roomName||'';
    if(!next.customRulesVersion&&next.customConfig)next.customRulesVersion=archive.customRulesVersion||archive.result?.customRulesVersion||1;
  }
  if(!next.customConfig||!next.customEvaluation||!next.initialPlayerCount)next.customMetadataMissing=true;
  else delete next.customMetadataMissing;
  return JSON.stringify(record)===JSON.stringify(next)?null:next;
}

export function repairCustomRecords({profileDir,replayDir,apply=false,backupDir}){
  if(apply&&!backupDir)throw Error('A dedicated backup directory is required');
  const report={version:1,apply,profiles:0,updatedProfiles:0,restored:0,missing:0,privacyExcluded:0,records:[],errors:[]};
  if(!fs.existsSync(profileDir))return report;
  for(const filename of fs.readdirSync(profileDir).filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).sort()){
    const file=path.join(profileDir,filename),bytes=fs.readFileSync(file);let profile;
    try{profile=JSON.parse(bytes);}catch{report.errors.push({file:filename,reason:'invalid-profile'});continue;}
    report.profiles++;let changed=false;
    const loadArchive=id=>{
      if(!/^[a-f0-9-]{36}$/.test(id||''))return null;
      try{return JSON.parse(gunzipSync(fs.readFileSync(path.join(replayDir,`${id}.json.gz`)),{maxOutputLength:256*1024*1024}));}catch{return null;}
    };
    // Old social caches omitted privacy flags. Only remove entries backed by an explicit
    // flag, with archive ID and full account ownership checked before trusting an archive.
    if(Array.isArray(profile.socialRecentMatches))profile.socialRecentMatches=profile.socialRecentMatches.filter(recent=>{
      const archive=loadArchive(recent.id);
      const owners=archive?.participants?.filter(p=>!p.isBot&&p.name===profile.name&&p.doctorCode===profile.code);
      const trusted=archive?.id===recent.id&&owners?.length===1;
      const record=profile.statistics?.records?.find(r=>r.id===recent.id);
      if(!hasMatchPrivacy(recent)&&!hasMatchPrivacy(record)&&!(trusted&&hasMatchPrivacy(archive)))return true;
      changed=true;report.privacyExcluded++;report.records.push({profile:filename,id:recent.id,status:'privacy-excluded',fields:['socialRecentMatches']});return false;
    });
    for(const [index,record]of(profile.statistics?.records||[]).entries()){
      if(record.end!=='quit'||record.roomMode!=='custom')continue;
      const archive=loadArchive(record.id);
      const repaired=recoverCustomMetadata(record,profile,archive);
      if(!repaired)continue;
      profile.statistics.records[index]=repaired;changed=true;
      const incomplete=!!repaired.customMetadataMissing;report[incomplete?'missing':'restored']++;
      report.records.push({profile:filename,id:record.id,status:incomplete?'missing':'restored',fields:Object.keys(repaired).filter(k=>JSON.stringify(repaired[k])!==JSON.stringify(record[k]))});
    }
    if(!changed)continue;
    report.updatedProfiles++;
    if(apply){
      // No startup migration: caller stops the managed instance before applying this journalled repair.
      if(hash(fs.readFileSync(file))!==hash(bytes))throw Error('Profile changed during repair');
      fs.mkdirSync(backupDir,{recursive:true});const backup=path.join(backupDir,filename);
      if(!fs.existsSync(backup))fs.writeFileSync(backup,bytes,{flag:'wx'});
      if(profile.statistics)profile.statistics.revision=(profile.statistics.revision||0)+1;
      const temp=file+'.custom-repair.tmp';fs.writeFileSync(temp,JSON.stringify(profile));fs.renameSync(temp,file);
    }
  }
  return report;
}
