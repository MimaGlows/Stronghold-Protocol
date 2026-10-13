// Matching-only WAAPI choreography. System reduced-motion CSS remains in force elsewhere.
export const MATCHING_EASE = 'cubic-bezier(.16,1,.3,1)';

export function matchingAnimate(element, frames, duration, name, options = {}) {
  if (!element?.animate) return null;
  const animation = element.animate(frames, { duration, easing:MATCHING_EASE, fill:'both', ...options });
  animation.id = name;
  animation.finished.then(() => animation.cancel(), () => {});
  return animation;
}

/** One controller per visible queue; revisions and timer ticks never restart the loop. */
export function createQueueMotion(root) {
  let previous = null, revision = 0, rotation = null;
  const finite = new Set(), portraits = new Map();
  const run = (el,frames,duration,name,options = {}) => {
    const a = matchingAnimate(el,frames,duration,name,options);
    if (a) { finite.add(a); a.finished.then(() => finite.delete(a), () => finite.delete(a)); }
    return a;
  };
  const cancel = () => { revision++; for (const a of finite) a.cancel(); finite.clear(); rotation?.cancel(); rotation = null; };
  const resized=()=>{portraits.clear();for(const a of finite)if(a.id.startsWith('matching-member') || a.id==='matching-group-shift')a.cancel();};
  window.addEventListener('resize',resized);
  return {
    update(state) {
      const first = !previous, changed = previous?.attempt !== state.attempt, modeChanged=previous?.mode !== state.mode;
      if (changed || first || modeChanged) revision++;
      const turn = revision;
      const continuingEntry=changed && state.attempt && previous?.members===1 && previous?.invites===0 && [...finite].some(a=>a.id==='matching-queue-enter');
      const full = state.mode === 'full' && !!root.animate;
      const mark = root.querySelector('.matching-refresh'), icon = mark.querySelector('.icon');
      // Sample before changing phase classes: reversals start at the currently displayed frame.
      const oldHeight = previous && previous.extended !== state.extended ? previous.height : root.getBoundingClientRect().height, oldBg = getComputedStyle(root).backgroundColor;
      const oldTransform=getComputedStyle(root).transform;
      const oldOpacity=getComputedStyle(root).opacity;
      const parentDy=continuingEntry && oldTransform!=='none' ? new DOMMatrix(oldTransform).m42 : 0;
      const oldMark = { transform:getComputedStyle(mark).transform, opacity:getComputedStyle(mark).opacity };
      const oldRotation=getComputedStyle(icon).transform;
      const nodes = [...root.querySelectorAll('.matching-queue__members > .matching-member')];
      const before = new Map(nodes.map(el => [el.dataset.member, { rect:el.querySelector('.avatar').getBoundingClientRect(), opacity:getComputedStyle(el.querySelector('.matching-member__info')).opacity }]));
      const colors = [...root.querySelectorAll('.matching-queue__status h3,.matching-queue__micro,.matching-member__seat')].map(el => [el,getComputedStyle(el).color]);
      const leaving = [...portraits.entries()].filter(([key]) => !before.has(key));
      for (const a of finite) if(changed || !full || modeChanged || a.id.startsWith('matching-member') || a.id==='matching-ready') { a.cancel(); finite.delete(a); }
      if (changed || !full || modeChanged) { rotation?.cancel(); rotation = null; icon.style.transform=full && !state.attempt ? oldRotation : ''; }
      root.classList.toggle('is-searching', !!state.attempt);
      root.classList.toggle('is-forming', !state.attempt);
      const newBg = getComputedStyle(root).backgroundColor, newHeight = root.getBoundingClientRect().height;
      const targets=new Map(nodes.map(el=>[el.dataset.member,el.querySelector('.avatar').getBoundingClientRect()]));
      const group=root.querySelector('.matching-queue__members'), groupBox=group.getBoundingClientRect();
      const firstTarget=targets.get(nodes[0]?.dataset.member),lastTarget=targets.get(nodes.at(-1)?.dataset.member);
      const groupShift=full && changed && state.attempt ? Math.max(0,(firstTarget.x+lastTarget.right)/2-(groupBox.x+groupBox.width/2)) : 0;
      if (full) {
        if (oldBg !== newBg || first && state.attempt) run(root,[{backgroundColor:first ? '#141816' : oldBg},{backgroundColor:newBg}],320,'matching-color');
        for (const [el,color] of colors) if (color !== getComputedStyle(el).color) run(el,[{color},{color:getComputedStyle(el).color}],320,'matching-text-color');
        if (first || continuingEntry) run(root,[{transform:continuingEntry ? oldTransform : `translateY(${Math.max(32,innerHeight-root.getBoundingClientRect().top)}px)`,opacity:first ? 0 : oldOpacity},{transform:'translateY(0)',opacity:1}],state.attempt ? 360 : 280,'matching-queue-enter');
        else if (Math.abs(oldHeight-newHeight)>1) run(root,[{height:`${oldHeight}px`,minHeight:'0px'},{height:`${newHeight}px`,minHeight:'0px'}],state.extended ? 180 : 320,'matching-height');
        for (const el of nodes) {
          const key = el.dataset.member, target = targets.get(key);
          const old = before.get(key), saved = portraits.get(key);
          if (saved) {
            const from = changed ? old.rect : saved.rect;
            const dx=from.x-target.x+groupShift, dy=from.y-target.y-parentDy;
            if (Math.abs(dx)+Math.abs(dy)>1) run(el,[{transform:`translate(${dx}px,${dy}px)`},{transform:'translate(0,0)'}],changed ? 320 : 180,'matching-member-move');
          } else if (!first) run(el,[{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],180,'matching-member-enter');
          const info=el.querySelector('.matching-member__info');
          if (changed && !first) run(info,[{opacity:old.opacity},{opacity:state.attempt ? 0 : 1}],160,'matching-member-label');
          const ready=el.querySelector('.matching-member__ready');
          if (ready && saved?.ready !== ready.textContent) run(ready,[{opacity:0,transform:'scale(.75)'},{opacity:1,transform:'scale(1)'}],160,'matching-ready');
        }
        if (groupShift>1) run(group,[{transform:`translateX(-${groupShift}px)`},{transform:'translateX(0)'}],180,'matching-group-shift',{delay:320});
        for (const [,saved] of leaving) {
          const ghost=saved.node.cloneNode(true), box=root.getBoundingClientRect();
          ghost.classList.add('matching-member-ghost'); ghost.setAttribute('aria-hidden','true');
          ghost.style.cssText=`left:${saved.rect.x-box.x}px;top:${saved.rect.y-box.y}px;width:${saved.rect.width}px;height:${saved.rect.height}px`;
          ghost.querySelector('.matching-member__info')?.remove(); root.append(ghost);
          const a=run(ghost,[{opacity:1},{opacity:0,transform:'translateY(6px)'}],160,'matching-member-leave');
          a?.finished.then(()=>ghost.remove(),()=>ghost.remove());
        }
        if (state.extended && !previous?.extended) run(root.querySelector('.matching-queue__extended'),[{opacity:0,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],180,'matching-extended');
      }
      const rotate = () => {
        if (turn !== revision || !root.isConnected || !state.attempt || !full || rotation) return;
        icon.style.transform=''; rotation=icon.animate([{transform:'rotate(0deg)'},{transform:'rotate(360deg)'}],{duration:9000,iterations:Infinity,easing:'linear'}); rotation.id='matching-refresh-loop';
      };
      if (full && state.attempt && (changed || first || previous?.mode !== state.mode)) {
        const a=run(mark,[{transform:changed || first ? 'translateX(-125%) rotate(-45deg)' : oldMark.transform,opacity:changed || first ? 0 : oldMark.opacity},{transform:'translateX(0) rotate(0deg)',opacity:.35}],420,'matching-refresh-enter');
        a ? a.finished.then(rotate,()=>{}) : rotate();
      } else if (full && changed && !state.attempt) run(mark,[oldMark,{transform:'translateX(-125%)',opacity:0}],320,'matching-refresh-exit');
      else if (full && state.attempt && !rotation) rotate();
      portraits.clear();
      for (const el of nodes) portraits.set(el.dataset.member,{rect:targets.get(el.dataset.member),node:el.cloneNode(true),ready:el.querySelector('.matching-member__ready')?.textContent});
      previous={...state,height:newHeight};
    },
    destroy() { cancel(); window.removeEventListener('resize',resized); root.querySelectorAll('.matching-member-ghost').forEach(el=>el.remove()); portraits.clear(); }
  };
}
