import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveCommunicationTarget} from '../../public/js/ui/communications.js';
import {deployMap} from '../../public/js/ui/gameLogic.js';
import {fieldTile} from '../../server/match/board.js';
import {makeMatch} from '../match/harness.js';
const surface={closest:selector=>selector==='[data-comm]'?null:{}};
function setup(t){const h=makeMatch({humans:2,mode:'coop',fake:true}).start().toPrep(1);t.after(()=>h.m.dispose());return h;}
test('client resolves watched teammate board rather than the sender board',t=>{
 const h=setup(t),pub=h.m.publicView(),other=h.ps('p_1');
 const [row,col]=[...other.deployMap().keys()][0].split(',').map(Number);
 const actual=resolveCommunicationTarget({target:surface,clientX:1,clientY:2},{view:{pickCommunication:()=>({type:'tile',space:'board',row,col})},pub,myId:'p_0',ownerId:'p_1',stage:h.m.stage});
 assert.deepEqual(actual.target,{kind:'tile',playerId:'p_1',row,col,intent:'location'});
});
test('actual boss field membership and side override sender seat on both halves; occupied combat tile is rejected',t=>{
 const h=setup(t),pub={...h.m.publicView(),phase:'FINAL_ASSAULT',round:h.m.gd.bossRound};
 const field={fieldId:'boss-pair',spec:{players:[{playerId:'p_1',side:'L'},{playerId:'p_0',side:'R'}]},units:[]};
 pub.fields=[{fieldId:'boss-pair',kind:'boss',players:['p_1','p_0']}];
 for(const [owner,placement] of [['p_1','bossL'],['p_0','bossR']]){
  const [row,col]=[...deployMap(h.m.stage,{field:placement}).keys()][0].split(',').map(Number),[r,c]=fieldTile(placement,row,col);
  const options={view:{pickCommunication:()=>({type:'tile',space:'field',row:r,col:c})},pub,myId:'p_0',ownerId:'p_0',field,stage:h.m.stage};
  const actual=resolveCommunicationTarget({target:surface},options);assert.deepEqual(actual.target,{kind:'tile',playerId:owner,row,col,intent:'location'});
  field.units=[{side:'ally',ownerId:owner,pos:[r,c]}];assert.equal(resolveCommunicationTarget({target:surface},options),null);field.units=[];
 }
});
test('personal bounty target contains only current index, choice id and own identity',()=>{
 const dom={dataset:{comm:'bounty',idx:'2',choiceId:'choice-2',player:'other'}};
 const actual=resolveCommunicationTarget({target:{closest:()=>dom}},{myId:'self'});
 assert.deepEqual(actual,{target:{kind:'bounty',playerId:'self',idx:2,choiceId:'choice-2'}});
});
