/* "The Poster" (design 1a) controller.
 * Editorial layout: the verdict is a headline. The big word under "SWEAT" and
 * the accent colour on it, the sweat-load figure and the bar all follow the
 * calibrated evaluate() tier; the load % itself is shown on the bar. */

'use strict';

const CIS = window.CIS;

// Ink-on-paper accent per tier (mock palette PA). Applied inline from JS.
const ACCENT = { ok: '#177245', watch: '#a07600', high: '#c25a10', over: '#c22d1e', critical: '#8f1313' };

const els = {
  status: document.getElementById('status'),
  word: document.getElementById('word'),
  airWord: document.getElementById('airWord'),
  detail: document.getElementById('detail'),
  pct: document.getElementById('pct'),
  barFill: document.getElementById('barFill'),
  cellTemp: document.getElementById('cellTemp'),
  cellHum: document.getElementById('cellHum'),
  cellFeels: document.getElementById('cellFeels'),
  cellWet: document.getElementById('cellWet'),
  place: document.getElementById('place'),
  manualPanel: document.getElementById('manualPanel'),
};

function placeLabel(reading) {
  if (!reading) return '—';
  if (reading.source === 'manual') return 'MANUAL';
  if (reading.placeName) return reading.placeName;
  if (reading.lat != null) return `${reading.lat.toFixed(3)}, ${reading.lon.toFixed(3)}`;
  return '—';
}

function render(r, state) {
  const tier = CIS.TIER_FROM_LEVEL[r.level];
  const accent = ACCENT[tier];

  els.status.textContent = r.status.toUpperCase();
  els.word.textContent = CIS.TIER_WORD[tier];
  els.word.style.color = accent;
  els.detail.textContent = r.detail;

  const crit = r.w === Infinity;
  const pct = crit ? 120 : Math.min(120, Math.round(r.w * 100));
  els.pct.textContent = crit ? 'OFF THE SCALE' : `${pct}%`;
  els.pct.style.color = accent;
  els.barFill.style.background = accent;
  els.barFill.style.width = `${Math.min(100, pct)}%`;

  els.airWord.textContent = r.muggy.word.toUpperCase();
  els.cellTemp.textContent = CIS.fmtTemp(r.t, state.unit);
  els.cellHum.textContent = `${CIS.fmtTemp(r.dewC, state.unit)} · ${Math.round(r.rh)}%`;
  els.cellFeels.textContent = CIS.fmtTemp(r.feels, state.unit) + (r.feelsClipped ? '+' : '');
  els.cellWet.textContent = CIS.fmtTemp(r.Tw, state.unit);
  els.place.textContent = placeLabel(state.reading);
}

function showMessage(headline, detail, opts) {
  els.status.textContent = '';
  els.word.textContent = '—';
  els.word.style.color = '';
  els.airWord.textContent = '—';
  // Headlines are unpunctuated fragments — add a sentence break before the
  // detail unless the headline already ends with punctuation ("Locating you…").
  const sep = /[.!?…]$/.test(headline) ? ' ' : '. ';
  els.detail.textContent = headline + (detail ? sep + detail : '');
  els.pct.textContent = '—';
  els.barFill.style.width = '0%';
  if (opts && opts.showManual && els.manualPanel) els.manualPanel.hidden = false;
}

CIS.createApp({ render, showMessage });

// Register the service worker (lives at the site root) for offline / install.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('../sw.js').catch(() => {});
  });
}
