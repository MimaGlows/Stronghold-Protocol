import { html } from '../ui/components.js';
import { useGameData } from '../ui/gameComponents.js';
import { MatchInfoDialog, matchInfoModel } from '../ui/matchInfo.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';

export function RestrictionsDialog({ open, onClose, restrictions, priv }) {
  const gd = useGameData();
  const model = matchInfoModel(restrictions || {}, { bonds: gd.list('bonds'), chess: gd.chess, mode: restrictions?.mode || {}, priv,
    diyData: { chess: data.get('chess'), backups: data.get('backups') } });
  return html`<${MatchInfoDialog} open=${open} onClose=${onClose} model=${model} status=${t('本次同盟限制')} />`;
}
