import { useEffect, useState } from '../../vendor/hooks.module.js';
import { createStore, useStore } from '../store.js';
import { net } from '../net.js';
import { html, Modal, Button } from './components.js';
import { toastError } from './toasts.js';
import { t } from '../../../shared/i18n.js';

const transfers = createStore({ request: null, waiting: null });
const timed = (msg) => ({ ...msg, deadline: Date.now() + Math.max(0, msg.expiresAt - msg.serverNow) });
export function installProfileTransfer() {
  net.on('profile.transferRequest', (msg) => transfers.set({ request: timed(msg) }));
  net.on('profile.transferPending', (msg) => transfers.set({ waiting: timed(msg) }));
  net.on('profile.transferEnded', (msg) => { if (transfers.get().request?.requestId === msg.requestId) transfers.set({ request: null }); });
  net.on('welcome', () => transfers.set({ waiting: null }));
  net.on('helloError', () => transfers.set({ waiting: null }));
  net.on('status', ({ status }) => { if (!['online', 'handshaking'].includes(status)) transfers.set({ request: null, waiting: null }); });
}

export function ProfileTransferHost() {
  const { request, waiting } = useStore((s) => s, Object.is, transfers);
  const [now, setNow] = useState(Date.now());
  const active = request || waiting;
  useEffect(() => { if (!active) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  if (!active) return null;
  const seconds = Math.max(0, Math.ceil((active.deadline - now) / 1000));
  const respond = (accept) => { void net.request('profile.transferResponse', { requestId: request.requestId, accept }).catch(toastError); };
  const cancel = () => { net.send('profile.transferCancel', { requestId: waiting.requestId }); };
  return html`<div class="profile-transfer-layer"><${Modal} key=${active.requestId} open=${true} class="profile-transfer" width="min(520px,94vw)" micro="SESSION TRANSFER"
    title=${request ? t('其他窗口请求接管游戏') : t('等待旧窗口确认')} closeOnBackdrop=${false} onClose=${request ? () => respond(false) : cancel}
    actions=${request ? html`<${Button} data-autofocus onClick=${() => respond(false)}>${t('拒绝')}<//><${Button} variant="primary" onClick=${() => respond(true)}>${t('同意接管')}<//>` : html`<${Button} onClick=${cancel}>${t('取消登录')}<//>`}>
    <p class="modal__text">${request ? t('另一个设备或浏览器正在请求进入你的当前对局。同意后，本窗口将断开，由新窗口继续游戏；拒绝或超时则保留本窗口。') : t('此账号正在其他窗口游玩。只有旧窗口同意后，才能恢复对局；等待期间不能操作该对局。')}</p>
    <p class="modal__text" role="status">${t('请求将在 {seconds} 秒后过期', { seconds })}</p>
  <//></div>`;
}
