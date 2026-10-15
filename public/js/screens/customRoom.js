import { useState, useLayoutEffect, useRef } from '../../vendor/hooks.module.js';
import { matchingAnimate } from '../ui/matchingMotion.js';
import { html, Button, Modal, DifficultyTag, DifficultyIcon, Tooltip, confirmDialog } from '../ui/components.js';
import { ContractIcon } from '../ui/customContracts.js';
import { RoomInvite } from '../ui/roomInvite.js';
import { socialStore } from '../ui/social.js';
import { PlayerAvatar } from '../ui/avatarPicker.js';
import { BondGlyph } from '../ui/gameComponents.js';
import { store, useStore, emptyMatch } from '../store.js';
import { useSettings } from '../ui/settings.js';
import { data, useData } from '../data.js';
import { net } from '../net.js';
import { toastError } from '../ui/toasts.js';
import { DIFFICULTIES, DIFFICULTY_NAMES } from '../../../shared/constants.js';
import { CUSTOM_CAPACITIES, CUSTOM_DESCRIPTIONS, CUSTOM_NUMBERS, CUSTOM_FLAGS, CUSTOM_GROUPS, customScore, customWarnings, defaultCustom,canRequireBond } from '../../../shared/custom.js';
import { t } from '../../../shared/i18n.js';

export function CustomRoomScreen() {
  const room=useStore(s=>s.room), me=useStore(s=>s.me), connection=useStore(s=>s.connection);
  const {matchingMotion}=useSettings(); useData('bonds');useData('assets');
  const [open,setOpen]=useState(false),[draft,setDraft]=useState(defaultCustom),[name,setName]=useState(''),[group,setGroup]=useState('basic'),[busy,setBusy]=useState(false);
  const [draftDifficulty,setDraftDifficulty]=useState('NORMAL'),[draftRevision,setDraftRevision]=useState(0);
  const [contractFocus,setContractFocus]=useState('hiddenWar');
  const root=useRef(null),rects=useRef(new Map());
  useLayoutEffect(()=>{document.documentElement.classList.toggle('custom-settings-open',open);return()=>document.documentElement.classList.remove('custom-settings-open');},[open]);
  useLayoutEffect(()=>{
    const node=root.current;if(!node)return;
    const running=[],next=new Map();
    if(matchingMotion==='full'&&!rects.current.size)running.push(matchingAnimate(node,[{opacity:0,transform:'translateY(18px)'},{opacity:1,transform:'none'}],240,'custom-room-enter'));
    for(const seat of node.querySelectorAll('[data-player]')){
      const id=seat.dataset.player,box=seat.getBoundingClientRect(),old=rects.current.get(id);next.set(id,box);
      if(matchingMotion==='full'&&old&&Math.abs(old.y-box.y)>1)running.push(matchingAnimate(seat,[{transform:`translateY(${old.y-box.y}px)`},{transform:'none'}],200,'custom-seat-move'));
    }
    if(open&&matchingMotion==='full'){const modal=node.querySelector('.custom-settings');if(modal)running.push(matchingAnimate(modal,[{opacity:0,transform:'translateY(14px)'},{opacity:1,transform:'none'}],220,'custom-settings-enter'));}
    rects.current=next;return()=>running.forEach(a=>a?.cancel());
  },[room?.revision,open,matchingMotion]);
  if(!room)return null;
  const host=room.hostId===me.playerId, mine=room.seats.find(s=>s?.playerId===me.playerId), evaluation=room.customEvaluation||customScore(room.custom,room.difficulty);
  const context=room.scoreContexts?.[draftDifficulty]||room.scoreContext;
  const preview=customScore(draft,draftDifficulty,context?{...context,coreIds:new Set(context.coreIds)}:undefined),warnings=customWarnings(draft,preview),bonds=data.get('bonds')||{};
  const run=async(fn)=>{if(busy)return;setBusy(true);try{await fn();}catch(e){toastError(e);}finally{setBusy(false);}};
  const edit=()=>{setDraft({...room.custom,requiredBonds:[...room.custom.requiredBonds]});setName(room.name);setDraftDifficulty(room.difficulty);setDraftRevision(room.revision);setOpen(true);};
  const save=()=>run(async()=>{await net.request('room.custom',{config:draft,name,difficulty:draftDifficulty,revision:draftRevision});setOpen(false);});
  const leave=()=>run(async()=>{
    try { await net.request('room.leave',{}); }
    catch(error) { if(error?.code!=='NOT_IN_ROOM')throw error; }
    // The server only broadcasts the updated room to its remaining members.
    // Clear this page after an acknowledged departure, without clearing a later destination.
    store.set(s=>s.room?.code===room.code?{room:null,match:emptyMatch(),ticker:[],emotes:[]}:{});
  });
  const start=()=>run(async()=>{
    if(evaluation.ratio>=4 && !await confirmDialog({title:t('极难配置'),text:t('压力达到基准四倍，仍要开始自订模拟吗？'),okText:t('开始模拟'),danger:true}))return;
    await net.request('room.start',{});
  });
  const toggle=key=>setDraft({...draft,[key]:!draft[key],...(!draft[key]&&key==='oneLife'?{lastStand:false}:!draft[key]&&key==='lastStand'?{oneLife:false}:{})});
  const values=Object.entries({...CUSTOM_NUMBERS,...CUSTOM_FLAGS}).filter(([key])=>room.custom[key]!==defaultCustom()[key]);
  const activeContracts=Object.entries(CUSTOM_FLAGS).filter(([key,v])=>v[1]==='contracts'&&room.custom[key]);
  const ready=room.seats.filter(s=>s&&!s.isBot&&(s.ready||s.playerId===room.hostId)).length,humans=room.seats.filter(s=>s&&!s.isBot).length;
  return html`<div ref=${root} class="screen custom-room" data-motion=${matchingMotion}>
    <header class="custom-room__header"><${Button} icon="exit" variant="secondary" disabled=${busy||connection.status!=='online'} onClick=${leave}>${t('离开同盟')}<//>
      <div><span class="custom-kicker">CUSTOM SIMULATION</span><h1>${room.name}</h1></div>
      <div class="custom-room__key"><${RoomInvite} code=${room.code} name=${me.name} difficulty=${room.difficulty} roomName=${room.name}/><${Button} variant="secondary" icon="users" onClick=${()=>socialStore.set({open:true})}>${t('邀请好友')}<//></div></header>
    <main class="custom-room__body"><section class="custom-summary">
      <div class="custom-summary__hero"><span class="micro">${t('模拟难度')}</span><${DifficultyTag} difficulty=${room.difficulty} size="lg"/>${room.custom.requiredBonds.length?html`<h3>${t('必选盟约')}</h3><div class="custom-bond-summary">${room.custom.requiredBonds.map(id=>html`<span><${BondGlyph} bondId=${id}/><span>${bonds[id]?.name||id}</span></span>`)}</div>`:null}</div>
      <div class="custom-summary__title"><h2>${t('模拟协议')}</h2><${Button} icon="edit" disabled=${!host||busy} onClick=${edit}>${t('自定设置')}<//></div>
      <div class="custom-protocol-metrics">${['enemyHp','enemyAtk','enemyAspd','enemyCount'].map(key=>html`<div class=${room.custom[key]!==100?'is-modified':''}><span>${t(CUSTOM_NUMBERS[key][3])}</span><strong>${room.custom[key]}<small>%</small></strong></div>`)}</div>
      ${activeContracts.length?html`<div class="custom-active-contracts"><h3>${t('历战合约')}</h3><div>${activeContracts.map(([key,[label]])=>html`<${Tooltip} key=${key} text=${t(CUSTOM_DESCRIPTIONS[key])}><span class="custom-active-contract" tabindex="0" data-active-contract=${key}><${ContractIcon} name=${key}/><span>${t(label)}</span></span><//>`)}</div></div>`:null}
      <dl class="custom-changes">${values.length?values.filter(([key])=>!['enemyHp','enemyAtk','enemyAspd','enemyCount'].includes(key)&&CUSTOM_FLAGS[key]?.[1]!=='contracts').map(([key,meta])=>html`<div key=${key}><dt>${t(meta[3]||meta[0])}</dt><dd>${typeof room.custom[key]==='boolean'?t('开启'):[ 'capacity','deployCap','supply'].includes(key)?room.custom[key]:`${room.custom[key]}%`}</dd></div>`):html`<p>${t('全部参数沿用基准难度')}</p>`}</dl>
      ${evaluation.ratio!==1?html`<div class="custom-score-factors"><h3>${t('难度系数')}</h3><dl class="custom-changes">${[['enemy',t('敌军'),'×'],['ally',t('我方'),'÷'],['time',t('回合与时间'),'×']].map(([key,label,sign])=>Math.abs(evaluation[key]-1)>.001?html`<div><dt>${label}</dt><dd>${sign} ${evaluation[key].toFixed(2)}</dd></div>`:null)}${evaluation.factors.map(f=>html`<div><dt>${bonds[f.key]?.name||t((f.key==='bountyEconomy'?'悬赏收益补偿':CUSTOM_FLAGS[f.key]?.[0])||(f.key==='life'?(room.custom.oneLife?CUSTOM_FLAGS.oneLife[0]:CUSTOM_FLAGS.lastStand[0]):f.key))}</dt><dd>× ${f.factor.toFixed(2)}</dd></div>`)}</dl></div>`:null}
      ${customWarnings(room.custom,evaluation).map(w=>html`<p class="custom-warning">${t(w)}</p>`)}
    </section><section class="custom-roster"><div class="custom-roster__title"><h2>${t('博士席位')}</h2><span>${room.seats.filter(Boolean).length}/${room.capacity}</span></div>
      ${room.seats.map((s,i)=>html`<article class=${`custom-seat ${s?.ready?'is-ready':''}`} data-player=${s?.playerId||undefined} key=${s?.playerId||i}>
        <span class="custom-seat__index">P${i+1}</span><${PlayerAvatar} name=${s?.name||''} avatar=${s?.avatar} size="md" />
        <div class="custom-seat__identity"><strong>${s?.name||t('空位')}</strong><span>${s?s.isBot?'AI':s.playerId===room.hostId?t('房主'):s.connected===false?t('连接中断'):s.ready?t('已就绪'):t('未准备'):t('选择此位置')}</span></div>
        ${!s&&mine?html`<${Button} size="sm" variant="secondary" disabled=${busy} onClick=${()=>run(()=>net.request('room.seat',{seat:i,revision:room.revision}))}>${t('入座')}<//>`:null}
        ${host&&!s?html`<${Button} size="sm" variant="ghost" disabled=${busy} onClick=${()=>run(()=>net.request('room.addBot',{}))}>${t('添加 AI 队友')}<//>`:null}
        ${host&&s?.isBot?html`<${Button} size="sm" variant="ghost" onClick=${()=>run(()=>net.request('room.removeBot',{seat:i}))}>${t('移除')}<//>`:null}
        ${host&&s&&!s.isBot&&s.playerId!==me.playerId?html`<${Button} size="sm" variant="ghost" onClick=${()=>run(async()=>{if(await confirmDialog({title:t('移出同盟'),text:t('确定将「{name}」移出同盟吗？对方可以凭同盟密钥重新加入。',{name:s.name}),okText:t('移出'),danger:true}))await net.request('room.kick',{seat:i,playerId:s.playerId});})}>${t('移出')}<//>`:null}
        ${s?.playerId===me.playerId?html`<span class="custom-you">${t('你')}</span>`:null}
      </article>`)}
      <h3>${t('观察者')}</h3><div class="custom-observers">${room.spectators.length?room.spectators.map(s=>html`<span>${s.name}${host?html`<${Button} size="sm" variant="ghost" onClick=${()=>run(()=>net.request('room.removeSpectator',{playerId:s.playerId}))}>${t('移除')}<//>`:null}</span>`):t('暂无观察者')}</div>
    </section></main>
    <footer class="custom-room__footer"><div class="custom-room__score"><strong class="num">${evaluation.score}</strong><div><span>${t('难度系数')}</span><small>${t('已就绪')} ${ready}/${humans}</small></div></div>
      ${host?html`<${Button} variant="primary" iconRight="chevrons" disabled=${busy||connection.status!=='online'||room.seats.some(s=>s&&!s.isBot&&s.playerId!==me.playerId&&(!s.ready||!s.connected))} onClick=${start}>${t('开始模拟')}<//>`:mine?html`<${Button} variant="primary" disabled=${busy} onClick=${()=>run(()=>net.request('room.ready',{ready:!mine.ready}))}>${mine.ready?t('取消准备'):t('准备就绪')}<//>`:html`<span>${t('观战中')}</span>`}
    </footer>
    <${Modal} open=${open} title=${t('自定设置')} micro="PROTOCOL CONFIGURATION" class="custom-settings" onClose=${()=>setOpen(false)} actions=${html`<div class="custom-score-preview" title=${t('相对压力估计，不代表胜率')}><strong>${preview.score}</strong><span>${t('难度系数')}</span></div><${Button} variant="secondary" onClick=${()=>setOpen(false)}>${t('取消')}<//><${Button} variant="primary" disabled=${busy||(!name.trim())||draft.oneLife&&draft.lastStand} onClick=${save}>${t('保存设置')}<//>`}>
      <div class="custom-settings__layout"><nav>${Object.entries(CUSTOM_GROUPS).map(([key,label])=>html`<button class=${group===key?'is-active':''} onClick=${()=>setGroup(key)}>${t(label)}</button>`)}</nav>
      <div class="custom-settings__fields">
        ${group==='basic'?html`<label class="custom-field">${t('房间名称')}<input value=${name} onInput=${e=>setName(e.target.value)} /><small>${t('最多10个可见字符')}</small></label><div class="custom-difficulty">${DIFFICULTIES.map(d=>html`<${Button} size="sm" variant=${draftDifficulty===d?'primary':'secondary'} onClick=${()=>setDraftDifficulty(d)}><${DifficultyIcon} difficulty=${d}/>${t(DIFFICULTY_NAMES[d])}<//>`)}</div><div class="custom-field"><span>${t('玩家人数')}</span><div class="custom-capacity" role="group" aria-label=${t('玩家人数')}>${CUSTOM_CAPACITIES.map(n=>html`<${Button} aria-pressed=${draft.capacity===n} data-capacity=${n} variant=${draft.capacity===n?'primary':'secondary'} disabled=${room.seats.filter(Boolean).length>n} onClick=${()=>setDraft({...draft,capacity:n})}>${t('{n}人',{n})}<//>`)}</div></div>`:null}
        ${Object.entries(CUSTOM_NUMBERS).filter(([key,v])=>key!=='capacity'&&v[4]===group).map(([key,[min,max,baseline,label]])=>html`<label class="custom-field" key=${key}><span>* ${t(label)}</span><div><input aria-label=${t(label)} type="range" min=${min} max=${max} step="1" value=${draft[key]} onInput=${e=>setDraft({...draft,[key]:Number(e.target.value)})} /><input aria-label=${t('{name}数值',{name:t(label)})} type="number" min=${min} max=${max} value=${draft[key]} onInput=${e=>setDraft({...draft,[key]:Number(e.target.value)})}/><span>${['deployCap','supply'].includes(key)?'':'%'}</span></div><small>${t('基准值：{value}',{value:baseline})}</small></label>`)}
        ${Object.entries(CUSTOM_FLAGS).filter(([,v])=>v[1]===group&&group!=='contracts').map(([key,[label]])=>html`<label class="custom-contract" key=${key}><input type="checkbox" checked=${draft[key]} onChange=${()=>toggle(key)}/><span>* ${t(label)}</span></label>`)}
        ${group==='contracts'?html`<div class="custom-contract-grid">${Object.entries(CUSTOM_FLAGS).filter(([,v])=>v[1]==='contracts').map(([key,[label]])=>html`<button type="button" data-contract=${key} class=${`custom-contract-tile ${draft[key]?'is-selected':''}`} aria-pressed=${!!draft[key]} onFocus=${()=>setContractFocus(key)} onMouseEnter=${()=>setContractFocus(key)} onClick=${()=>{setContractFocus(key);toggle(key);}}><${ContractIcon} name=${key}/><span>${['hiddenWar','whitebird'].includes(key)?'':'* '}${t(label)}</span></button>`)}</div><div class="custom-contract-detail" role="status"><${ContractIcon} name=${contractFocus}/><div><strong>${t(CUSTOM_FLAGS[contractFocus][0])}</strong><p>${t(CUSTOM_DESCRIPTIONS[contractFocus])}</p>${contractFocus==='whitebird'?html`<small>${t('不影响难度系数')}</small>`:null}</div></div>`:null}
        ${group==='basic'?html`<h3>* ${t('必选盟约')}</h3><p class="t-dim">${t('可不选；选择后保证本局可用')}</p><p class="custom-required-limit">${t('最多3个：核心最多2个，附加最多1个')} · ${draft.requiredBonds.length}/3</p><div class="custom-bond-picker">${Object.entries(bonds).filter(([,b])=>Number(b.weight)>0).map(([id,b])=>html`<button type="button" class=${draft.requiredBonds.includes(id)?'is-selected':''} data-required-bond=${id} aria-pressed=${draft.requiredBonds.includes(id)} disabled=${!draft.requiredBonds.includes(id)&&!canRequireBond(draft.requiredBonds,id,bonds)} title=${!draft.requiredBonds.includes(id)&&!canRequireBond(draft.requiredBonds,id,bonds)?t('已达到必选盟约的总数或分类上限'):undefined} onClick=${()=>setDraft({...draft,requiredBonds:draft.requiredBonds.includes(id)?draft.requiredBonds.filter(v=>v!==id):[...draft.requiredBonds,id]})}><${BondGlyph} bondId=${id}/><span>${b.name}</span></button>`)}</div>`:null}
      </div></div>
      ${warnings.map(w=>html`<p class="custom-warning">${t(w)}</p>`)}
    <//>
  </div>`;
}

