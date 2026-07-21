/* "The Thermometer" (design 1c) controller.
 * All state, geolocation, map and manual-entry flow comes from CIS.createApp;
 * this file only paints the full-bleed verdict screen. Colour and copy follow
 * the calibrated evaluate() verdict; the sweat-load % is shown on its own bar. */

'use strict';

const CIS = window.CIS;

// Gradient "from" colour per tier — used to keep the browser chrome in sync.
const THEME = { ok: '#0f766e', watch: '#a16207', high: '#c2410c', over: '#b91c1c', critical: '#7f1d1d' };
const themeMeta = document.querySelector('meta[name="theme-color"]');

const root = document.getElementById('root');
const els = {
  temp: document.getElementById('temp'),
  meta: document.getElementById('meta'),
  sentence: document.getElementById('sentence'),
  recsLink: document.getElementById('recsLink'),
  loadValue: document.getElementById('loadValue'),
  loadFill: document.getElementById('loadFill'),
  place: document.getElementById('place'),
  manualPanel: document.getElementById('manualPanel'),
  muggyFill: document.getElementById('muggyFill'),
  muggyLine: document.getElementById('muggyLine'),
  muggyWord: document.getElementById('muggyWord'),
  muggyDew: document.getElementById('muggyDew'),
};

// Degrees-only display (e.g. "33°"), honouring the current unit.
const deg = (c, unit) => `${Math.round(CIS.toDisplay(c, unit))}°`;

// A 4-point star: 8 vertices alternating outer R and inner R*k, 45° apart,
// first vertex at top. As k→1 the vertices land on a regular octagon — so the
// spiky (dry) star retracts into a hard octagon (oppressive).
function starPoints(cx, cy, R, k) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const ang = -Math.PI / 2 + i * Math.PI / 4;
    const rad = (i % 2 === 0) ? R : R * k;
    pts.push(`${(cx + rad * Math.cos(ang)).toFixed(1)},${(cy + rad * Math.sin(ang)).toFixed(1)}`);
  }
  return pts.join(' ');
}

// Paint the mugginess mark: outline morphs spiky→octagon with dew point, and a
// same-shape fill grows from the centre out to the edge (both driven by m.f).
function drawMuggy(m) {
  const f = m ? m.f : 0;
  const k = 0.40 + f * 0.60;
  els.muggyLine.setAttribute('points', starPoints(60, 60, 52, k));
  els.muggyFill.setAttribute('points', starPoints(60, 60, 52 * f, k));
  els.muggyWord.textContent = m ? m.word : '—';
}

function setTier(tier) {
  root.dataset.tier = tier;
  if (themeMeta && THEME[tier]) themeMeta.setAttribute('content', THEME[tier]);
}

function placeLabel(reading) {
  if (!reading) return '';
  if (reading.source === 'manual') return 'Manual conditions';
  if (reading.placeName) return reading.placeName;
  if (reading.lat != null) return `${reading.lat.toFixed(3)}, ${reading.lon.toFixed(3)}`;
  return '';
}

function render(r, state) {
  const tier = CIS.TIER_FROM_LEVEL[r.level];
  setTier(tier);

  els.temp.textContent = deg(r.t, state.unit);
  els.meta.textContent =
    `feels like ${deg(r.feels, state.unit)}${r.feelsClipped ? '+' : ''} · wet-bulb ${deg(r.Tw, state.unit)}`;
  els.sentence.textContent = r.headline;

  // From orange up, offer a Google search pre-filled with the situation.
  const hot = tier === 'high' || tier === 'over' || tier === 'critical';
  els.recsLink.hidden = !hot;
  if (hot) els.recsLink.href = CIS.recsSearchUrl(r, state);

  drawMuggy(r.muggy);
  els.muggyDew.textContent = `DEW PT ${deg(r.dewC, state.unit)}`;

  const crit = r.w === Infinity;
  const pct = crit ? 120 : Math.min(120, Math.round(r.w * 100));
  els.loadValue.textContent = crit ? 'off the scale' : `${pct}%`;
  els.loadFill.style.width = `${Math.min(100, pct)}%`;

  els.place.textContent = placeLabel(state.reading);
}

function showMessage(headline, detail, opts) {
  // Loading / error states use the calm teal field (README).
  setTier('ok');
  els.temp.textContent = '—';
  els.meta.textContent = detail || ' ';
  els.sentence.textContent = headline;
  els.recsLink.hidden = true;
  els.loadValue.textContent = '—';
  els.loadFill.style.width = '0%';
  drawMuggy(null);
  els.muggyDew.innerHTML = '&nbsp;';
  if (opts && opts.showManual && els.manualPanel) els.manualPanel.hidden = false;
}

CIS.createApp({ render, showMessage });

// Register the service worker for the offline shell / installability.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
