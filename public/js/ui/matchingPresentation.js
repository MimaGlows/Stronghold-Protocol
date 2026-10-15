// Presentation follows confirmed server transitions; it never holds up room or game routing.
import { useLayoutEffect, useRef } from '../../vendor/hooks.module.js';
import { createStore, useStore, store } from '../store.js';
import { audio } from '../audio.js';
import { settingsStore, useSettings } from './settings.js';
import { html, Icon } from './components.js';
import { PlayerAvatar } from './avatarPicker.js';
import { BondGlyph, GIcon } from './gameComponents.js';
import { t } from '../../../shared/i18n.js';
import { DEFAULT_AVATAR } from '../../../shared/avatar.js';
import { matchingAnimate } from './matchingMotion.js';

const searching = p => !!p?.attemptId && ['searching','extended'].includes(p.phase);
export function matchingTransition(previous, next) {
  if (!previous || previous.identity !== next.identity) return null;
  const a=previous.party, b=next.party;
  if (searching(b) && b.attemptId!==a?.attemptId) return {kind:'start',id:b.attemptId};
  if (searching(a) && ['playing','backfilled'].includes(b?.phase)) return {kind:'success',id:a.attemptId};
  if (searching(a) && !searching(b)) return {kind:'end',id:a.attemptId};
  if (a?.phase==='idle' && !b) return {kind:'leave',id:a.id};
  return null;
}
export const matchingPresentation = createStore({ success:null });

export function slideQueueAway(root) {
  if (!root || settingsStore.get().matchingMotion!=='full' || !root.animate) return;
  // An atomic leave can publish cancel then removal; retain just one departing visual for that party.
  if([...document.querySelectorAll('.matching-queue-departing')].some(e=>e.dataset.party===root.dataset.party)) return;
  const rect=root.getBoundingClientRect(), ghost=root.cloneNode(true);
  ghost.classList.add('matching-queue-departing'); ghost.setAttribute('aria-hidden','true'); ghost.inert=true;
  ghost.querySelectorAll('[id]').forEach(e=>e.removeAttribute('id'));
  ghost.style.cssText=`position:fixed;top:${rect.top}px;left:${rect.left}px;bottom:auto;width:${rect.width}px;height:${rect.height}px;min-height:0;margin:0;transform:none;pointer-events:none;z-index:58;background:${getComputedStyle(root).backgroundColor}`;
  const icon=ghost.querySelector('.matching-refresh .icon'), original=root.querySelector('.matching-refresh .icon');
  if(icon && original) icon.style.transform=getComputedStyle(original).transform;
  document.body.append(ghost);
  const animation=matchingAnimate(ghost,[{transform:'translateY(0)',opacity:getComputedStyle(root).opacity},{transform:`translateY(${Math.max(rect.height+24,innerHeight-rect.top+24)}px)`,opacity:0}],240,'matching-queue-exit',{easing:'cubic-bezier(.55,0,1,.45)'});
  const remove=()=>ghost.remove(); animation?.finished.then(remove,remove);
  const off=settingsStore.subscribe(s=>{if(s.matchingMotion==='reduced'){animation?.cancel();remove();}});
  animation?.finished.then(off,off);
}

export function installMatchingPresentation() {
  const seen=new Set();
  return store.subscribe((s,prev)=>{
    if(s.matching===prev.matching) return;
    if(s.matching.identity!==prev.matching.identity){seen.clear();matchingPresentation.set({success:null});if(typeof document!=='undefined')document.querySelectorAll('.matching-queue-departing').forEach(e=>e.remove());return;}
    const cue=matchingTransition(prev.matching,s.matching); if(!cue) return;
    // Backfill dissolves the lobby party in several pushes after joining the room; that is success, not cancellation.
    if(cue.kind==='leave' && s.room) return;
    const key=`${cue.kind}:${cue.id}`; if(seen.has(key)) return;
    seen.add(key); if(seen.size>64) seen.delete(seen.values().next().value);
    audio.sfx(cue.kind==='start' ? 'start' : cue.kind==='success' ? 'matchSucceed' : 'matchCancel');
    if(cue.kind==='success') {
      const members=s.room?.seats?.filter(m=>m && !m.isBot) || s.matching.party?.members || [];
      matchingPresentation.set({success:{id:cue.id,members,roomCode:s.room?.code}});
    } else if((cue.kind==='end' || !s.matching.party) && !s.room && typeof document!=='undefined') slideQueueAway(document.querySelector('.matching-queue'));
  });
}

export function MatchingSuccessHost() {
  const success=useStore(s=>s.success,Object.is,matchingPresentation), root=useRef(null);
  const room=useStore(s=>s.room);
  const {matchingMotion}=useSettings();
  useLayoutEffect(()=>{
    if(!success || !root.current) return undefined;
    const box=root.current, animations=[];
    const clear=()=>{if(matchingPresentation.get().success===success) matchingPresentation.set({success:null});};
    if(matchingMotion==='reduced' || !box.animate){const timer=setTimeout(clear,1000);return()=>clearTimeout(timer);}
    animations.push(matchingAnimate(box,[{opacity:0,transform:'translateY(20px)'},{opacity:1,transform:'translateY(0)',offset:.16},{opacity:1,transform:'translateY(0)',offset:.82},{opacity:0,transform:'translateY(18px)'}],1100,'matching-success'));
    animations.push(matchingAnimate(box.querySelector('.matching-success__sweep'),[{transform:'translateX(-110%)'},{transform:'translateX(110%)'}],640,'matching-success-sweep',{easing:'cubic-bezier(.3,0,.2,1)'}));
    animations.push(matchingAnimate(box.querySelector('.matching-success__mark'),[{transform:'scale(.65) rotate(-12deg)',opacity:0},{transform:'scale(1)',opacity:1}],260,'matching-success-lock'));
    box.querySelectorAll('.matching-success__member').forEach((e,i)=>animations.push(matchingAnimate(e,[{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'translateY(0)'}],220,'matching-success-member',{delay:60+i*35})));
    animations[0]?.finished.then(clear,()=>{});
    return()=>animations.forEach(a=>a?.cancel());
  },[success,matchingMotion]);
  if(!success) return null;
  const members=room && room.code===success.roomCode ? room.seats.filter(m=>m && !m.isBot) : success.members;
  return html`<section ref=${root} class="matching-success" data-motion=${matchingMotion} data-attempt=${success.id} role="status" aria-label=${t('匹配成功')}>
    <div class="matching-success__sweep" aria-hidden="true"></div><div class="matching-success__mark" aria-hidden="true"><${Icon} name="check" /></div>
    <div class="matching-success__copy"><span>MATCH FOUND</span><h3>${t('匹配成功')}</h3></div>
    <div class="matching-success__members">${members.map(m=>html`<div key=${m.playerId} class="matching-success__member"><${PlayerAvatar} avatar=${m.avatar?.kind==='custom' ? DEFAULT_AVATAR : m.avatar} name=${m.name} size="md" /><span>${m.preference ? html`<${BondGlyph} bondId=${m.preference} />` : html`<${GIcon} name="refresh" />`}</span></div>`)}</div>
  </section>`;
}
