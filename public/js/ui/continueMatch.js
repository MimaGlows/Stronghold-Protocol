import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button } from './components.js';
import { identity, net } from '../net.js';
import { store } from '../store.js';
import { doctorProfileKey } from '../../../shared/doctor.js';
import { t } from '../../../shared/i18n.js';
import { resumeProfile } from './resumeProfile.js';
/** Current account, server-owned active match; no local match list or official restore protocol. */
export function ContinueMatchButton({ onResume = null }) {
  const [item, setItem] = useState(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    let dead = false, controller;
    const refresh = async () => {
      controller?.abort(); controller = new AbortController();
      const requestController = controller;
      const name = identity.loadName();
      if (!doctorProfileKey(name)) { setItem(null); return; }
      try {
        const r = await fetch('/api/profiles/active-match?' + new URLSearchParams({ identity: name }), { signal: requestController.signal, cache: 'no-store' });
        const data = await r.json();
        if (!dead && !requestController.signal.aborted && name === identity.loadName()) setItem(r.ok && data.active ? { id: name, name } : null);
      } catch { if (!dead && !requestController.signal.aborted) setItem(null); }
    };
    void refresh(); const timer = setInterval(refresh, 15000);
    const offChanging = net.on('profileChanging', () => { controller?.abort(); setItem(null); });
    const offWelcome = net.on('welcome', refresh);
    window.addEventListener('focus', refresh); window.addEventListener('storage', refresh);
    return () => { dead = true; controller?.abort(); offChanging(); offWelcome(); clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('storage', refresh); };
  }, []);
  if (!item) return null;
  const enter = onResume || ((name) => { identity.setEntered(true); store.patch('session', { entered: true }); net.setName(name); return true; });
  return html`<div class="continue-match"><${Button} data-testid="continue-current-match" disabled=${busy} onClick=${async () => { setBusy(true); try { await resumeProfile(item, identity, enter); } finally { setBusy(false); } }}>${t('继续当前对局')}<//></div>`;
}
