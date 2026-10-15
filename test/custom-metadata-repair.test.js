import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {gzipSync} from 'node:zlib';
import {defaultCustom} from '../shared/custom.js';
import {recoverCustomMetadata,repairCustomRecords} from '../server/profiles/customMetadata.js';
const id='12345678-1234-1234-1234-123456789abc';
const profile={name:'Repair',code:'0123'},record={id,end:'quit',roomMode:'custom',selfId:'p0',t:123,victory:false,roundsPassed:3};
const archive={id,participants:[{playerId:'p0',...profile,doctorCode:profile.code}],result:{customConfig:defaultCustom(),customEvaluation:{version:2,score:456},initialPlayerCount:1}};
test('metadata restores authoritative values without recomputing old scores or changing quit outcome',()=>{
  const r=recoverCustomMetadata(record,profile,archive);assert.equal(r.customEvaluation.score,456);assert.equal(r.customEvaluation.version,2);assert.equal(r.baselineKind,'single');assert.equal(r.t,123);assert.equal(r.end,'quit');assert.equal(r.roundsPassed,3);assert.equal(r.customRulesVersion,1);
  const existing={...record,customEvaluation:{version:1,score:999}};assert.equal(recoverCustomMetadata(existing,profile,archive).customEvaluation.score,999);
  assert.equal(recoverCustomMetadata(r,profile,archive),null);
});
test('missing, ambiguous or wrong-owner archives never invent scores/configuration',()=>{
  for(const a of [null,{...archive,id:'bad'},{...archive,participants:[{playerId:'p0',name:'Repair',doctorCode:'9999'}]}]){
    const r=recoverCustomMetadata(record,profile,a);assert.equal(r.customMetadataMissing,true);assert.equal(r.customConfig,undefined);assert.equal(r.customEvaluation,undefined);
  }
  const r=recoverCustomMetadata(record,profile,{...archive,customEvaluation:{version:3,score:900}});assert.equal(r.customEvaluation,null);assert.equal(r.customMetadataMissing,true);
});
test('offline repair supports dry run, atomic apply, backup and idempotent restart',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-record-repair-'));try{
    const profiles=path.join(dir,'profiles'),backup=path.join(dir,'backup');fs.mkdirSync(profiles);
    const file=path.join(profiles,'a'.repeat(64)+'.json'),p={...profile,statistics:{revision:2,records:[record]}};fs.writeFileSync(file,JSON.stringify(p));fs.writeFileSync(path.join(dir,id+'.json.gz'),gzipSync(JSON.stringify(archive)));
    assert.equal(repairCustomRecords({profileDir:profiles,replayDir:dir}).restored,1);assert.deepEqual(JSON.parse(fs.readFileSync(file)),p);
    assert.equal(repairCustomRecords({profileDir:profiles,replayDir:dir,backupDir:backup,apply:true}).restored,1);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup,path.basename(file)))),p);
    assert.equal(repairCustomRecords({profileDir:profiles,replayDir:dir,backupDir:backup,apply:true}).updatedProfiles,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('offline recent-cache repair removes only evidenced private matches, preserving unknown archives, friends and source identities',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-recent-repair-'));try{
    const profiles=path.join(dir,'profiles'),backup=path.join(dir,'backup');fs.mkdirSync(profiles);
    const file=path.join(profiles,'b'.repeat(64)+'.json');
    const normalId='22345678-1234-1234-1234-123456789abc',wrongId='32345678-1234-1234-1234-123456789abc';
    const p={...profile,friends:['Friend#9999'],socialVersion:1,socialRecentMatches:[{id,participants:archive.participants},{id:normalId},{id:wrongId},{id:'expired'},{id:'flagged',result:{isMatchingMatch:true}}]};
    fs.writeFileSync(file,JSON.stringify(p));
    fs.writeFileSync(path.join(dir,id+'.json.gz'),gzipSync(JSON.stringify({...archive,matchPrivacy:true})));
    fs.writeFileSync(path.join(dir,normalId+'.json.gz'),gzipSync(JSON.stringify({...archive,id:normalId})));
    fs.writeFileSync(path.join(dir,wrongId+'.json.gz'),gzipSync(JSON.stringify({...archive,id:wrongId,isMatchingMatch:true,participants:[{name:profile.name,doctorCode:'9999'}]})));
    assert.equal(repairCustomRecords({profileDir:profiles,replayDir:dir}).privacyExcluded,2);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),p,'dry run does not change the live cache');
    const result=repairCustomRecords({profileDir:profiles,replayDir:dir,backupDir:backup,apply:true});
    assert.equal(result.privacyExcluded,2);
    const repaired=JSON.parse(fs.readFileSync(file));
    assert.deepEqual(repaired.socialRecentMatches.map(m=>m.id),[normalId,wrongId,'expired']);
    assert.deepEqual(repaired.friends,p.friends);assert.equal(repaired.code,p.code);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup,path.basename(file)))),p);
    assert.equal(repairCustomRecords({profileDir:profiles,replayDir:dir,backupDir:backup,apply:true}).updatedProfiles,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
