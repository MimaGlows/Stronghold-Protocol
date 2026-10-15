import { html } from './components.js';
// Original vector artwork: one consistent 32px grid, 2px strokes, no downloaded assets.
export const CONTRACT_PATHS=Object.freeze({
  hiddenWar:'M8 14h16v14H8z M11 14V9a5 5 0 0 1 10 0v5 M16 20v4',
  lastStand:'M16 3 27 8v8c0 7-11 13-11 13S5 23 5 16V8z M3 22h7l3-5 5 9 3-4h8',
  oneLife:'M16 27 5 16C-1 7 9 1 16 9c7-8 17-2 11 7z M16 12v9 M13 15l3-3 3 3',
  noLeakCap:'M5 5h22v22H5z M11 5v22 M21 5v22 M5 11h22 M5 21h8 M16 19l12 9 M25 18l3 10-10-2',
  debt:'M4 27V14a5 5 0 0 1 10 0v13z M7 17h4 M9 15v7 M15 10h13 M23 5l5 5-5 5 M20 27v-8l4 3 4-3v8z',
  tourist:'M4 7l8-3 8 3 8-3v22l-8 3-8-3-8 3z M12 4v11 M20 7v8 M9 20h14 M17 17l-3 3 3 3',
  wildfire:'M16 3c2 8 11 10 9 19-2 10-17 10-19 1-1-5 2-8 5-12 0 6 3 7 5 10 4-6-2-9 0-18z M12 26c-2-3 1-6 4-9 3 3 6 6 4 9',
  whitebird:'M5 28h22 M3 24h26 M12 23l3-9-7-6 9 2 2-7 3 1-1 8 6 4-8 1-2 6 M10 6 4 3l4 8',
  fateWager:'M3 5h17v17H3z M7 9h.1 M16 9h.1 M11 14h.1 M7 18h.1 M16 18h.1 M21 28l-7-7c-3-5 3-9 7-4 4-5 10-1 7 4z',
  carnival:'M4 7h24v20H4z M9 7V4h14v3 M8 13h16 M10 22h12 M16 11v13 M22 14l4 4-4 4',
});
export function ContractIcon({name,class:cls=''}){
  return html`<svg class=${`contract-icon ${cls}`} viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d=${CONTRACT_PATHS[name]||CONTRACT_PATHS.hiddenWar}/></svg>`;
}
