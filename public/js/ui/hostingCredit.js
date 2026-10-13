// i18n-ignore-file: host-provided credit is intentionally fixed in Chinese.
import { html } from './components.js';
/** Preact owns this subtree; no MutationObserver may append siblings to a routed screen. */
export function HostingCredit() {
  return html`<div class="local-hosting-credit" data-local-hosting="credit">
    <div><a href="https://github.com/MimaGlows/Stronghold-Protocol" target="_blank" rel="noopener noreferrer">Hosted by MimaGlows</a></div>
    <div>仅限内部交流使用，请勿外传</div>
  </div>`;
}
