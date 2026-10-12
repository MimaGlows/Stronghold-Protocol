import { createStore } from '../store.js';
import { net, identity } from '../net.js';
import { aggregateStats } from '../../../shared/stats.js';
import { t } from '../../../shared/i18n.js';
export const profileViewStore=createStore({profileKey:null,revision:0,records:[],aggregate:aggregateStats([]),total:0,next:null,loading:false,error:''});
let serial=0,controller=null;
export function clearProfileView(){serial++;controller?.abort();controller=null;profileViewStore.reset();}
export async function loadProfileView(target,more=false){
  const seq=++serial;controller?.abort();controller=new AbortController();
  const state=profileViewStore.get(),owner=net.name;
  profileViewStore.set({profileKey:target,loading:true,error:'',...(!more?{records:[],total:0,next:null}: {})});
  try{
    const response=await fetch('/api/social-history?'+new URLSearchParams({identity:target,offset:String(more?state.next||0:0)}),{headers:{Authorization:`Bearer ${identity.getToken()}`},cache:'no-store',signal:controller.signal});
    if(!response.ok)throw new Error(response.status===403?t('对方的资料不可见'):t('资料读取失败'));
    const msg=await response.json();if(seq!==serial||owner!==net.name||net.status!=='online')return;
    if(more&&msg.revision!==state.revision)return loadProfileView(target);
    profileViewStore.set({...msg,records:more?[...state.records,...msg.records]:msg.records,loading:false});
  }catch(e){if(seq!==serial)return;profileViewStore.set({records:[],aggregate:aggregateStats([]),total:0,next:null,loading:false,error:e.name==='AbortError'?'':e.message});}
}
