import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../server/index.js';
test('maintenance shutdown refuses new room and matching requests before asynchronous socket cleanup',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-maintenance-'));const server=await startServer({port:0,quiet:true,recording:false,profileDir:dir,matchmakingDir:path.join(dir,'matching')});
  try{server.lobby.shutdown();for(const t of ['room.create','matching.start'])assert.equal(server.lobby.onMessage({}, {t}).error,'WRONG_PHASE');assert.equal(server.lobby.stats().matches,0);}
  finally{await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('maintenance drain blocks new starts but preserves the running platform until resumed',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-maintenance-drain-')),server=await startServer({port:0,quiet:true,recording:false,profileDir:dir,matchmakingDir:path.join(dir,'matching'),maintenance:true});
  try{
    assert.equal(server.lobby.stats().maintenance,true);server.lobby.setMaintenance(true);
    for(const t of ['room.start','matching.start','matching.prepare'])assert.equal(server.lobby.onMessage({}, {t}).error,'MAINTENANCE');
    assert.equal(server.lobby.start({}).error,'MAINTENANCE');assert.equal(server.lobby.startMatch({}).error,'MAINTENANCE');assert.equal(server.lobby.matchmakingService.parties.beginSearch({}).error,'MAINTENANCE');
    assert.equal(server.lobby.shuttingDown,undefined);server.lobby.setMaintenance(false);assert.equal(server.lobby.stats().maintenance,undefined);
  }finally{await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});
