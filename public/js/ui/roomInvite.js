import { html,Button,Icon,MicroLabel } from './components.js';
import { copyText } from './clipboard.js';
import { toast } from './toasts.js';
import { DIFFICULTY_NAMES } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';
export function RoomInvite({code,name,difficulty,roomName=null}){
  const copy=async what=>{
    const url=`${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
    const text=roomName?t('{name}邀请你加入卫戍协议：盟约【自订模拟】【{roomName}】',{name:name||'',roomName}):t('{name}邀请你加入卫戍协议：盟约【{difficulty}】',{name:name||'',difficulty:t(DIFFICULTY_NAMES[difficulty]||'')});
    const ok=await copyText(what==='code'?code:`${url} ${text}`);toast(ok?(what==='code'?t('已复制同盟密钥 {code}',{code}):t('已复制邀请链接')):t('复制失败，请手动复制'),ok?'success':'warn');
  };
  return html`<div class="invite brackets"><div class="invite__label"><${Icon} name="key"/><span>${t('同盟密钥')}</span><${MicroLabel}>ALLIANCE KEY<//></div><div class="invite__code num selectable" aria-label=${t('同盟密钥 {code}',{code})}>${[...String(code)].map((ch,i)=>html`<span key=${i}>${ch}</span>`)}</div><div class="invite__btns"><${Button} size="sm" icon="copy" onClick=${()=>copy('code')}>${t('复制密钥')}<//><${Button} size="sm" icon="link" onClick=${()=>copy('link')}>${t('复制链接')}<//></div></div>`;
}
