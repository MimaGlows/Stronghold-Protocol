import { alertDialog, html } from './components.js';
import { t } from '../../../shared/i18n.js';
import { ERR_TEXT } from '../../../shared/constants.js';

let avatarNoticeOwner=null, nameNotice=null;
export function notifyMatchingAvatar(owner, restricted, avatar) {
  if (!restricted) { avatarNoticeOwner=null; return; }
  if (avatar?.kind!=='custom' || avatarNoticeOwner===owner) return;
  avatarNoticeOwner=owner; void showMatchingAvatarNotice();
}
export function showMatchingAvatarNotice() {
  return alertDialog({class:'matching-notice',title:t('匹配头像提示'),text:html`<p class="matching-notice-text">${t('正在使用自定义头像。匹配期间将临时显示阿罗玛·精英头像，也可改用干员头像；退出匹配后恢复原头像。')}</p>`,okText:t('知道了')});
}
export function showMatchingAdmissionError(error) {
  if (error?.code!=='MATCH_NAME') return false;
  if (!nameNotice) nameNotice=alertDialog({class:'matching-notice',title:t('博士代号检查未通过'),text:html`<p class="matching-notice-text">${t(ERR_TEXT.MATCH_NAME)}</p>`,okText:t('知道了')}).finally(()=>{nameNotice=null;});
  return true;
}
