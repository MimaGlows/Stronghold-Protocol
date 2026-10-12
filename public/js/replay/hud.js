import { html, Countdown } from '../ui/components.js';
import { UnitThumb, BandIcon } from '../ui/gameComponents.js';
import { ChessCard, ItemCard } from '../ui/shopBar.js';
import { BondStrip } from '../ui/bondStrip.js';
import { EffectsList } from '../ui/effectsList.js';
import { groupEnemies } from '../ui/gameLogic.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';

export function ReplayHud({ priv, pub, remaining, onBond }) {
  const band = data.lookup('bands', priv?.bandId);
  return html`<section class="replay-hud" aria-label=${t('本局信息')}>
    <div class="replay-status">
      <span>${t('资金')} <b class="num t-gold">${priv?.funds ?? '—'}</b></span>
      <span>${t('剩余生命')} <b class="num t-mint">${priv?.lp ?? '—'}</b></span>
      <span class="replay-deploy">${t('部署位')} <b class="num">${priv?.deployCount ?? 0} / ${priv?.deployCap ?? '—'}</b></span>
      <span>${t('剩余可放置角色：')}<b class="num t-mint">${Math.max(0, (priv?.deployCap ?? 0) - (priv?.deployCount ?? 0))}</b></span>
      ${band ? html`<span class="replay-band"><${BandIcon} bandId=${priv.bandId} size="sm" />${band.name}</span>` : null}
      ${remaining == null ? html`<span class="t-dim">${t('无倒计时')}</span>` : html`<${Countdown} seconds=${remaining} size="sm" gauge=${false} />`}
      ${pub.phase === 'PREP' ? html`<span class="t-mint">${priv?.ready ? t('已准备') : t('准备中')}</span>` : null}
    </div>
    <div class="replay-bonds"><${BondStrip} bonds=${priv?.bonds || []} onOpen=${onBond} /><${EffectsList} effects=${priv?.effects || []} /></div>
  </section>`;
}
export function ReplayEnemies({ priv, onDetail }) {
  const rows = groupEnemies(priv?.nextEnemies, (id) => data.lookup('enemies', id));
  return html`<section class="replay-enemies" aria-label=${t('敌方情报')}><b>${t('待出现的敌人')} <span class="num t-orange">${rows.reduce((n, r) => n + r.count, 0)}</span></b>
    <div>${rows.length ? rows.map((r) => html`<button key=${`${r.enemyKey}:${r.tag}`} title=${r.name} onClick=${() => onDetail(r.enemyKey, 'enemy', r.count)}>
      <${UnitThumb} kind="enemy" id=${r.enemyKey} size="sm" /><span>${r.name}</span><b class="num">×${r.count}</b></button>`) : html`<span class="t-dim">${t('暂无敌方情报')}</span>`}</div></section>`;
}
export function ReplayShop({ priv, offBonds, onDetail }) {
  const offer = priv?.shop?.rewardOffer;
  const slots = offer?.slots?.length ? offer.slots : priv?.shop?.slots || [];
  return html`<section class="replay-shop" aria-label=${t('待选干员')}>
    <div class="replay-shop-heading"><b>${offer ? t('选择奖励') : t('待选干员')}</b><span>${t('商店等级')} <b class="num">${priv?.shop?.level ?? '—'}</b></span>${priv?.shop?.frozen ? html`<span>${t('冻结')}</span>` : null}</div>
    <div class="replay-shop-cards">${slots.map((s, i) => !s || s.sold ? html`<div class="scard scard--sold"><span class="scard__soldtxt">${t('已售出')}</span></div>`
      : s.kind === 'item' ? html`<${ItemCard} slot=${s} idx=${i} frozen=${priv?.shop?.frozen} free=${!!offer} onTap=${() => onDetail(s.id, 'item')} onDetail=${onDetail} />`
        : html`<${ChessCard} slot=${s} idx=${i} priv=${priv} frozen=${priv?.shop?.frozen} free=${!!offer} offBonds=${offBonds} onTap=${() => onDetail(s.id, 'chess')} onDetail=${onDetail} />`)}</div>
  </section>`;
}
