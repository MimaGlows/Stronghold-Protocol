import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { html, AvatarFrame, Button, Icon, Modal, TextField } from './components.js';
import { useStore } from '../store.js';
import { data, useData } from '../data.js';
import { avatarUrl } from '../assets.js';
import { t, N_ } from '../../../shared/i18n.js';
import { DEFAULT_AVATAR, sameAvatar, checkAvatarChoice } from '../../../shared/avatar.js';
import { avatarStore, openAvatar, closeAvatar, commitAvatar, rememberedProfileName } from './avatarProfile.js';
import { readAvatarImage, cropRect, encodeAvatar } from './avatarImage.js';

export function playerAvatarSrc(choice, manifest) {
  if (choice?.kind === 'custom') return choice.dataUrl;
  if (choice?.kind === 'operator') return avatarUrl(manifest, choice.charId, { e2: choice.e2 });
  return null;
}

export function PlayerAvatar({ avatar, ...props }) {
  useData('assets');
  return html`<${AvatarFrame} ...${props} src=${playerAvatarSrc(avatar, data.get('assets'))} />`;
}

/** Only caller-authorised self portraits render as buttons. Other players use PlayerAvatar. */
export function AvatarButton({ avatar, name = '', size = 'sm', variant = 'portrait', hint = t('更换'), onOpen, ...props }) {
  const saved = useStore((s) => s.avatar, Object.is, avatarStore);
  return html`<button type="button" class=${`avatar-edit${variant === 'field' ? ' avatar-edit--field' : ''}`} aria-label=${t('更换头像')} title=${variant === 'field' ? t('更换头像') : hint}
    onClick=${onOpen || (() => openAvatar(name))}><${PlayerAvatar} ...${props} avatar=${avatar || saved} name=${name} size=${size} />
    ${variant === 'field' ? html`<span class="avatar-edit__text">${t('更换头像')}</span><${Icon} name="chevrons" class="avatar-edit__arrow" />`
      : html`<span class="avatar-edit__hint">${hint}</span>`}</button>`;
}

export function avatarCatalog(manifest, records) {
  const names = new Map();
  for (const rec of records) if (rec?.charId && rec.name && !names.has(rec.charId)) names.set(rec.charId, rec.name);
  const list = [];
  for (const [charId, art] of Object.entries(manifest?.chars || {})) {
    if (!/^char_[A-Za-z0-9_]+$/.test(charId) || !names.has(charId)) continue;
    for (const e2 of [false, true]) {
      const src = art[e2 ? 'avatarE2' : 'avatar'];
      if (typeof src === 'string') list.push({ choice: { kind: 'operator', charId, e2 }, src,
        name: names.get(charId), label: e2 ? t('{name} · 精英', { name: names.get(charId) }) : names.get(charId), key: `${charId}:${e2}` });
    }
  }
  return list.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}

function AvatarPicker() {
  useData('assets'); useData('chess'); useData('backups');
  const manifest = data.get('assets'), chess = data.get('chess'), backups = data.get('backups');
  const catalog = useMemo(() => avatarCatalog(manifest, [...Object.values(chess || {}), ...Object.values(backups || {})]), [manifest, chess, backups]);
  const [draft, setDraft] = useState(avatarStore.get().avatar);
  const [profileKey] = useState(avatarStore.get().profileKey);
  const [name] = useState(avatarStore.get().name || rememberedProfileName());
  const [query, setQuery] = useState('');
  const [image, setImage] = useState(null);
  const [crop, setCrop] = useState({ zoom: 1, x: 0, y: 0 });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const uploadRef = useRef(null), drag = useRef(null), operation = useRef(0);
  const urlRef = useRef(null);
  useEffect(() => () => { operation.current++; if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  const clearImage = () => {
    operation.current++; setBusy(false); setImage(null);
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  };
  const choose = (choice) => { clearImage(); setDraft(choice); setError(''); };
  const upload = async (file) => {
    if (!file) return;
    const seq = ++operation.current;
    setBusy(true); setError('');
    try {
      const loaded = await readAvatarImage(file);
      if (seq !== operation.current) { URL.revokeObjectURL(loaded.url); return; }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = loaded.url;
      setImage(loaded.image); setCrop({ zoom: 1, x: 0, y: 0 });
    } catch (e) { if (seq === operation.current) setError(t(e.message)); }
    finally { if (seq === operation.current) setBusy(false); }
  };
  const confirm = async () => {
    const seq = ++operation.current;
    setBusy(true); setError('');
    try {
      const next = image ? await encodeAvatar(image, crop.zoom, crop.x, crop.y) : draft;
      if (seq !== operation.current) return;
      const checked = checkAvatarChoice(next, manifest);
      if ('error' in checked) throw new Error(N_('当前头像无效或素材尚未加载'));
      commitAvatar(checked.avatar, profileKey);
      closeAvatar();
    } catch (e) { if (seq === operation.current) setError(t('未保存：{error}', { error: t(e.message || N_('浏览器存储不可用，请检查隐私设置或存储空间')) })); }
    finally { if (seq === operation.current) setBusy(false); }
  };
  const rect = image ? cropRect(image.naturalWidth, image.naturalHeight, crop.zoom, crop.x, crop.y) : null;
  const selected = catalog.find((item) => sameAvatar(item.choice, draft));
  const filtered = catalog.filter((item) => `${item.label} ${item.choice.charId}`.toLowerCase().includes(query.trim().toLowerCase()));
  const pointerDown = (e) => {
    if (!rect) return;
    const box = e.currentTarget.getBoundingClientRect();
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: rect.x, startY: rect.y, ratio: 256 / box.width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const pointerMove = (e) => {
    const d = drag.current;
    if (d && d.id === e.pointerId) setCrop((c) => ({ ...c, x: d.startX + (e.clientX - d.x) * d.ratio, y: d.startY + (e.clientY - d.y) * d.ratio }));
  };
  const onKey = (e) => {
    const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[e.key];
    if (delta && rect) { e.preventDefault(); setCrop((c) => ({ ...c, x: rect.x + delta[0], y: rect.y + delta[1] })); }
  };
  return html`<${Modal} open=${true} title=${t('更换头像')} micro="DOCTOR PROFILE" width="8.4rem" class="avatar-picker"
    onClose=${closeAvatar} actions=${html`<${Button} onClick=${closeAvatar}>${t('取消')}<//><${Button} class="avatar-confirm" variant="primary" loading=${busy} onClick=${confirm}>${t('保存头像')}<//>`}>
    <div class="avatar-picker__layout">
      <section class="avatar-picker__preview">
        ${image && rect ? html`<svg class="avatar-crop" viewBox="0 0 256 256" tabindex="0" role="img" aria-label=${t('拖动图片或使用方向键调整裁剪')}
          onPointerDown=${pointerDown} onPointerMove=${pointerMove} onPointerUp=${() => { drag.current = null; }} onPointerCancel=${() => { drag.current = null; }} onKeyDown=${onKey}>
          <image href=${urlRef.current} x=${(256 - image.naturalWidth * rect.scale) / 2 + rect.x} y=${(256 - image.naturalHeight * rect.scale) / 2 + rect.y}
            width=${image.naturalWidth * rect.scale} height=${image.naturalHeight * rect.scale} />
        </svg>` : html`<${PlayerAvatar} avatar=${draft} name=${name} size="xl" self=${true} />`}
        <p class="avatar-picker__caption">${image ? t('拖动调整位置') : selected?.label || (draft.kind === 'custom' ? t('自定义头像') : draft.kind === 'operator' ? t('干员头像') : t('默认头像'))}</p>
        ${image ? html`<label class="avatar-zoom">${t('缩放')}<input aria-label=${t('头像缩放')} type="range" min="1" max="4" step="0.01" value=${crop.zoom}
          onInput=${(e) => setCrop((c) => ({ ...c, zoom: Number(e.currentTarget.value), x: rect.x, y: rect.y }))} /></label>` : null}
        <${Button} class="avatar-upload" size="sm" disabled=${busy} onClick=${() => uploadRef.current.click()}>${t('上传图片')}<//>
        <${Button} class="avatar-reset" size="sm" variant="ghost" disabled=${busy} onClick=${() => choose(DEFAULT_AVATAR)}>${t('恢复默认')}<//>
        <small>${t('PNG / JPEG / WebP，最大 5 MB')}</small>
      </section>
      <section class="avatar-picker__operators">
        <${TextField} label=${t('选择干员头像')} placeholder=${t('搜索干员名称')} value=${query} onInput=${setQuery} />
        <div class="avatar-grid" aria-label=${t('干员头像')}>
          ${filtered.map((item) => html`<button type="button" key=${item.key} class=${`avatar-option${!image && sameAvatar(item.choice, draft) ? ' is-selected' : ''}`}
            aria-label=${item.label} aria-pressed=${!image && sameAvatar(item.choice, draft)} disabled=${busy} onClick=${() => choose(item.choice)}>
            <${AvatarFrame} name=${item.name} src=${item.src} size="md" /><span>${item.label}</span></button>`)}
          ${!filtered.length ? html`<p class="t-lo">${manifest ? t('未找到对应干员') : t('正在加载头像…')}</p>` : null}
        </div>
      </section>
    </div>
    ${error ? html`<p class="avatar-error" role="alert">${error}</p>` : null}
    <input ref=${uploadRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange=${(e) => { void upload(e.currentTarget.files[0]); e.currentTarget.value = ''; }} />
  <//>`;
}

export function AvatarHost() {
  const open = useStore((s) => s.open, Object.is, avatarStore);
  return open ? html`<${AvatarPicker} />` : null;
}
