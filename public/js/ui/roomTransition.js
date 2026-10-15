import { store } from '../store.js';
import { confirmDialog } from './components.js';
import { t } from '../../../shared/i18n.js';
export async function confirmRoomTransition(){
  const state=store.get(),room=state.room,p=state.matching.party;
  if(!room&&!p)return {};
  if(room?.inMatch||p?.phase==='playing')return null;
  const source={roomCode:room?.code||null,roomRevision:room?.revision||room?.matching?.revision||0,partyId:p?.id||null,partyRevision:p?.revision||0};
  const accepted=await confirmDialog({title:t('切换房间'),text:t('将离开当前等待房间或取消匹配队伍准备，并加入目标房间。加入失败时保留当前状态。'),okText:t('确认切换')});
  return accepted?{replaceCurrent:true,source}:null;
}
