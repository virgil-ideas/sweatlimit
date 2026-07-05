/* Can I Sweat? — shared core
 * The calibrated physiology/thermodynamics model plus the data, geolocation,
 * unit, preference and map-picker helpers shared by both views: the default
 * Thermometer (root: index.html + thermometer.js) and the Poster (poster/).
 *
 * Everything is exposed on a single global, `window.CIS`. This is a classic
 * script (no build step, no modules) so it can be shared by the equally-classic
 * per-view controllers, and so the service worker keeps working.
 *
 * IMPORTANT: the model below (constants through pickVerdict) is the canonical,
 * literature-calibrated version. Keep it byte-identical to its history — the
 * sub-pages depend on the same verdict everyone else sees.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Physiology / thermodynamics model
   * ------------------------------------------------------------------ */

  const SKIN_TEMP = 35;      // °C, typical warm-skin temperature
  const H_RADIATIVE = 4.5;   // W/m²·K, whole-body radiative coeff (de Dear 1997)
  const LEWIS = 16.5;        // W/m²·kPa per W/m²·K (Lewis relation for air)
  const MAX_SWEAT_COOLING = 450; // W/m² — peak evaporative cooling the body can
                                 // actually produce. ~350–400 for an average
                                 // unacclimatized adult, ~560+ for a fit,
                                 // acclimatized one; 450 is a conservative middle.

  // Metabolic heat production by activity (W/m² of body surface).
  const METABOLIC = {
    rest: 65,       // sitting / standing still (~1.1 MET)
    light: 130,     // walking, easy chores (~2.2 MET)
    moderate: 230,  // brisk work, cycling (~4 MET)
    hard: 350,      // running, heavy labor (~6 MET)
  };

  // Age-group heat-vulnerability adjustments. Two effects:
  //   • offset  — degrees added to the perceived wet-bulb / air temperature for
  //     the risk tiers. Vulnerable groups reach danger at lower ambient heat.
  //   • sweat   — fraction of an adult's evaporative (sweat) capacity.
  // Calibrated to the heat-physiology literature (Vecellio 2022, Wolf 2023,
  // Vanos 2023, Falk & Dotan 2008). Only three groups are actually distinguishable
  // from the data — children, healthy adults, older adults — so we use those;
  // "infant" is kept for parents but flagged as not calibratable (little hard
  // human data; much infant risk is caregiver dependence, not physiology).
  // These are coarse RISK adjustments, not per-person predictions.
  const AGE = {
    infant:  { offset: 3.5, sweat: 0.50, vulnerable: true, lowConfidence: true,
               note: 'For infants and toddlers this is a rough guide only — there’s little hard data on infant heat limits, and much of the danger is being left in a hot room or car. Never leave a small child in the heat, and don’t rely on an app.' },
    child:   { offset: 1.0, sweat: 0.70, vulnerable: false, lowConfidence: false, note: '' },
    adult:   { offset: 0.0, sweat: 1.00, vulnerable: false, lowConfidence: false, note: '' },
    older:   { offset: 2.5, sweat: 0.70, vulnerable: true, lowConfidence: false,
               note: 'Older adults sweat less, feel thirst less, and may take medications that reduce heat tolerance — take this more seriously than the numbers alone suggest.' },
  };

  // Saturation vapor pressure over water (kPa), Tetens equation. T in °C.
  function satVaporPressure(t) {
    return 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
  }

  // Wet-bulb temperature (°C) from air temp (°C) and RH (%). Stull (2011).
  function wetBulb(t, rh) {
    const r = Math.max(1, Math.min(100, rh)); // formula is undefined at RH<~1
    return (
      t * Math.atan(0.151977 * Math.sqrt(r + 8.313659)) +
      Math.atan(t + r) -
      Math.atan(r - 1.676331) +
      0.00391838 * Math.pow(r, 1.5) * Math.atan(0.023101 * r) -
      4.686035
    );
  }

  // NWS Heat Index (Rothfusz) — "feels like" temperature in °C, from T(°C), RH(%).
  function heatIndex(tC, rh) {
    const t = tC * 9 / 5 + 32; // work in °F
    // Below ~80°F the regression isn't used; NWS falls back to a simple form.
    if (t < 80) {
      const hiF = 0.5 * (t + 61 + (t - 68) * 1.2 + rh * 0.094);
      const avg = (hiF + t) / 2;
      return (avg - 32) * 5 / 9;
    }
    let hi =
      -42.379 + 2.04901523 * t + 10.14333127 * rh -
      0.22475541 * t * rh - 0.00683783 * t * t -
      0.05481717 * rh * rh + 0.00122874 * t * t * rh +
      0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
    // Adjustments
    if (rh < 13 && t >= 80 && t <= 112) {
      hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(t - 95)) / 17);
    } else if (rh > 85 && t >= 80 && t <= 87) {
      hi += ((rh - 85) / 10) * ((87 - t) / 5);
    }
    return (hi - 32) * 5 / 9;
  }

  // Convective heat-transfer coefficient (W/m²·K) as a function of wind (m/s).
  function convectiveCoeff(windMs) {
    const v = Math.max(0, windMs || 0);
    return Math.max(3.1, 8.3 * Math.sqrt(v)); // 3.1 ≈ still-air natural convection
  }

  // Dew-point temperature (°C) from air temp (°C) and RH (%). Magnus-Tetens.
  function dewPoint(t, rh) {
    const r = Math.max(1, Math.min(100, rh));
    const a = 17.27, b = 237.7;
    const g = (a * t) / (b + t) + Math.log(r / 100);
    return (b * g) / (a - g);
  }

  // Mugginess — a SEPARATE axis from the danger verdict. It answers "how muggy
  // does the air feel", which is governed by absolute moisture (dew point),
  // independent of temperature: your skin is a fixed ~35 °C vapour source, so
  // only the air's dew point changes how fast sweat can evaporate. High dew
  // point → sweat lingers → clammy, even when the danger verdict is fine.
  // This is comfort, not safety, and never changes the verdict.
  //
  // Word buckets follow the meteorological dew-point comfort scale. `f` is a
  // 0–1 fraction over the 6–26 °C dew-point range, used by the Thermometer to
  // drive its mugginess mark (the star that retracts into an octagon).
  const MUGGY_WORDS = [
    { max: 13, word: 'Dry' },          // sweat flashes off instantly
    { max: 16, word: 'Comfortable' },  // evaporates easily
    { max: 19, word: 'Humid' },        // you notice it
    { max: 22, word: 'Sticky' },       // slow to dry, skin feels tacky
    { max: 25, word: 'Damp' },         // you stay damp, never quite dry
    { max: Infinity, word: 'Soupy' },  // air is saturated; barely any evaporation
  ];
  function mugginess(dewC) {
    const bucket = MUGGY_WORDS.find((b) => dewC < b.max) || MUGGY_WORDS[MUGGY_WORDS.length - 1];
    const f = Math.max(0, Math.min(1, (dewC - 6) / (26 - 6)));
    return { dewC, word: bucket.word, f };
  }

  /**
   * Core evaluation. Returns everything the UI needs.
   * @param {number} t    air temperature (°C)
   * @param {number} rh   relative humidity (%)
   * @param {number} windMs wind speed (m/s)
   * @param {string} activity  key of METABOLIC
   * @param {string} age  key of AGE
   */
  function evaluate(t, rh, windMs, activity, age) {
    const Tw = wetBulb(t, rh);
    const feels = heatIndex(t, rh);
    const dewC = dewPoint(t, rh);
    const ageAdj = AGE[age] ?? AGE.adult;

    const M = METABOLIC[activity] ?? METABOLIC.light;
    const hc = convectiveCoeff(windMs);

    // Dry heat exchange (skin → air): positive = heat lost, negative = heat gained.
    const dryLoss = (hc + H_RADIATIVE) * (SKIN_TEMP - t);

    // Required evaporative cooling to stay in balance.
    const Ereq = M - dryLoss;

    // Max evaporative cooling the environment allows.
    const Pskin = satVaporPressure(SKIN_TEMP);
    const Pair = (Math.max(0, Math.min(100, rh)) / 100) * satVaporPressure(t);
    const he = LEWIS * hc;
    const Emax = Math.max(0, he * (Pskin - Pair));
    // The usable evaporative cooling is the lesser of what the air permits and
    // what the body can actually sweat — otherwise a breeze invents capacity.
    // The sweat ceiling is scaled down for age groups that sweat less.
    const Eusable = Math.min(Emax, MAX_SWEAT_COOLING * ageAdj.sweat);

    // Skin wettedness required: the fraction of skin that must be sweat-soaked.
    // w <= 1 → sweat can compensate; w > 1 → it cannot.
    let w;
    if (Ereq <= 0) {
      w = 0; // no evaporative cooling needed (air is cool relative to skin/heat)
    } else if (Eusable <= 0) {
      w = Infinity; // air is saturated at skin temp — evaporation impossible
    } else {
      w = Ereq / Eusable;
    }

    const level = classify(w, Tw, t, ageAdj);
    return { t, rh, windMs, Tw, feels, dewC, muggy: mugginess(dewC), w, ...level };
  }

  // Map wettedness (is sweat sufficient for this effort?) plus the absolute
  // wet-bulb temperature (is the environment dangerous at all?) to a verdict.
  //
  // Two independent axes, because they answer different questions:
  //   • Wet-bulb sets the danger floor — near skin temp, nobody sheds heat,
  //     regardless of effort. This is the well-established heat-stress metric.
  //   • Wettedness `w` says whether YOUR current effort outpaces evaporation.
  //     In cool air, w>1 just means "you'll warm up running" — not dangerous.
  //   • Air temperature is a third floor: once it reaches skin temp (~35 °C) the
  //     air ADDS heat to you and sweat is your only cooling — so a low sweat load
  //     (often thanks to wind) must never read as "easy". Wind aids evaporation
  //     in dry heat, but it can't be trusted to cool you when the air is this hot.
  function classify(w, Tw, t, age) {
    const result = pickVerdict(w, Tw, t, age);
    // Append the age note. Low-confidence groups (infants) always show it — the
    // "don't rely on an app" message matters even in mild conditions. Others show
    // it only when we're actually flagging something (warn/bad/crit).
    if (age.note) {
      const flagged = result.level !== 'great' && result.level !== 'good';
      if (age.lowConfidence || flagged) result.detail += ` ${age.note}`;
    }
    return result;
  }

  // A fan/breeze only cools while the air is cooler than skin; once it's hotter,
  // moving it just adds convective heat (WHO/CDC caution). Pivot on skin temp.
  function fanAdvice(t) {
    return t < SKIN_TEMP
      ? 'A fan helps.'
      : 'Skip the fan — the air is hotter than your skin, so it just blows heat at you.';
  }

  function pickVerdict(w, Tw, t, age) {
    // Physical limit first — evaporation is impossible for ANYONE at this
    // wet-bulb, so age can't change it. Uses the real wet-bulb, not adjusted.
    if (Tw >= 35) {
      return {
        level: 'crit',
        status: 'No evaporation',
        headline: 'Sweat can’t cool you',
        detail:
          'The air is so warm and humid that sweat will not evaporate at all. Get to ' +
          'shade, air conditioning or cold water now — sweating cannot help here.',
      };
    }

    // For the risk tiers below, treat the environment as hotter for vulnerable
    // ages: they reach the same danger at a lower true temperature.
    const TwR = Tw + age.offset;
    const tR = t + age.offset;

    // Dangerous wet-bulb: risky even at rest, and worse if you can't keep up.
    if (TwR >= 31) {
      return {
        level: 'bad',
        status: 'Dangerous heat',
        headline: 'Dangerous heat — cool another way',
        detail:
          'The wet-bulb temperature is in the dangerous range — sweat can barely ' +
          'evaporate even at rest. Seek shade/AC, wet the skin, and limit exertion. ' +
          fanAdvice(t) + ' Core temperature can climb here.',
      };
    }

    // Sweat can't keep up with this effort (w > 1).
    if (w > 1) {
      if (TwR >= 27) {
        // Warm AND overloaded — genuinely cool down another way.
        return {
          level: 'bad',
          status: 'Overwhelmed',
          headline: 'Overwhelmed — cool another way',
          detail:
            'At this effort you’re making more heat than the warm, humid air lets you ' +
            'sweat off. Core temperature will rise. Ease off, seek shade/AC, and wet the ' +
            'skin. ' + fanAdvice(t),
        };
      }
      // Cool air but hard effort — normal, self-limiting, not dangerous.
      return {
        level: 'warn',
        status: 'Maxed out',
        headline: 'Sweat is maxed out',
        detail:
          'Working hard enough to outpace evaporation means warming up — the air ' +
          'itself is cool, but this might be dangerous. Ease off or hydrate and it settles.',
      };
    }

    // Sweat is keeping up, but the air itself is hot. A wet-bulb this high is a
    // genuine heat-stress environment even when the sweat load looks modest —
    // heavy sweating and fluid loss, so this must never read as "easy".
    if (TwR >= 27) {
      return {
        level: 'warn',
        status: 'Heat stress',
        headline: 'Heat stress — don’t overdo it',
        detail:
          'Sweat is keeping up for now, but this is a genuinely hot, humid ' +
          'environment. Expect heavy sweating and fluid loss — drink plenty, ' +
          'rest in shade or AC, and avoid hard exertion.',
      };
    }

    // Air at or above skin temperature: it's adding heat, and evaporating sweat
    // is the ONLY cooling. Dry enough that wind still helps, but fluid is going
    // fast and a lull in wind or rise in humidity tips you over.
    if (tR >= 35) {
      return {
        level: 'warn',
        status: 'Hotter than skin',
        headline: 'The air is hotter than your skin',
        detail:
          'The air is hotter than skin, so it’s warming the body — only evaporating ' +
          'sweat is cooling you. It’s dry enough that a breeze still helps, speeding ' +
          'evaporation faster than it adds heat — but only while you keep sweating and ' +
          'stay hydrated, and a more humid wind would tip the other way. Fluid is going ' +
          'fast, so drink constantly and seek shade or AC.',
      };
    }

    // Sweat is compensating — grade by how much margin is left.
    if (w > 0.85) {
      return {
        level: 'warn',
        status: 'Little margin',
        headline: 'Sweat is working — with little margin',
        detail:
          'Sweating is keeping you in balance, but you’re close to its limit. A little ' +
          'more effort, sun or humidity will tip you over. Hydrate and take it steady.',
      };
    }
    // Moderate load, warm-but-muggy air (wet-bulb 24–27 °C), or simply hot air
    // (≥33 °C): comfortable, but not "nothing" — you'll feel it and should drink.
    if (w > 0.5 || TwR >= 24 || tR >= 33) {
      return {
        level: 'good',
        status: 'Warm but fine',
        headline: 'Warm, but you’re fine',
        detail:
          'Sweat is evaporating well and keeping you in balance. It may feel warm ' +
          'or muggy, so keep drinking water — but there’s room to spare.',
      };
    }
    return {
      level: 'great',
      status: 'Plenty of margin',
      headline: 'Plenty of cooling margin',
      detail:
        'Conditions are easy for the body — sweat evaporates readily and there’s lots ' +
        'of spare cooling capacity.',
    };
  }

  /* ------------------------------------------------------------------ *
   * Design-tier mapping (shared by both views)
   * ------------------------------------------------------------------ */

  // The design mocks speak in five visual tiers keyed off "sweat load". We drive
  // them from the calibrated verdict instead, so the alternate pages agree with
  // the main app rather than a cruder percentage. The load % is still shown on
  // its own bar/gauge; only the colour and copy come from the verdict level.
  const TIER_FROM_LEVEL = { great: 'ok', good: 'watch', warn: 'high', bad: 'over', crit: 'critical' };
  // Poster flourish — the single verb under "SWEAT".
  const TIER_WORD = { ok: 'WORKS.', watch: 'COPES.', high: 'STRAINS.', over: 'LOSES.', critical: 'FAILS.' };

  /* ------------------------------------------------------------------ *
   * Data layer
   * ------------------------------------------------------------------ */

  async function fetchWeather(lat, lon) {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather request failed (${res.status})`);
    const data = await res.json();
    const c = data.current;
    return {
      t: c.temperature_2m,
      rh: c.relative_humidity_2m,
      windMs: (c.wind_speed_10m ?? 0) / 3.6, // km/h → m/s
    };
  }

  // Approximate location from the caller's IP — no GPS and no permission
  // prompt, city-level accuracy (plenty for regional weather). Used only as a
  // fallback when precise geolocation is unavailable or times out. GeoJS is
  // free, needs no key, and is HTTPS + CORS-enabled (same constraints as the
  // weather API). The returned place carries a leading "≈" so it always reads
  // as approximate.
  async function ipLocate() {
    const res = await withTimeout(fetch('https://get.geojs.io/v1/ip/geo.json'), 8000);
    if (!res.ok) throw new Error(`IP location failed (${res.status})`);
    const d = await res.json();
    const lat = parseFloat(d.latitude);
    const lon = parseFloat(d.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lon)) throw new Error('IP location unavailable');
    const where = [d.city, d.region].filter(Boolean).join(', ') || d.country || null;
    return { lat, lon, place: where ? `≈ ${where}` : null };
  }

  // Best-effort reverse geocode for a friendly place label (no key needed).
  async function reverseGeocode(lat, lon) {
    try {
      const res = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?latitude=${lat}&longitude=${lon}&count=1`
      );
      if (!res.ok) return null;
      const d = await res.json();
      const p = d.results && d.results[0];
      return p ? [p.name, p.admin1].filter(Boolean).join(', ') : null;
    } catch {
      return null;
    }
  }

  // Reject with a `.code === 'TIMEOUT'` error if `promise` hasn't settled in
  // `ms`. Guards against browsers that ignore the geolocation `timeout` option
  // (some e-reader WebKit builds) and would otherwise hang us forever.
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const id = setTimeout(() => {
        const e = new Error('Timed out');
        e.code = 'TIMEOUT';
        reject(e);
      }, ms);
      promise.then(
        (v) => { clearTimeout(id); resolve(v); },
        (e) => { clearTimeout(id); reject(e); }
      );
    });
  }

  // Promise wrapper around geolocation. Rejects with a GeolocationPositionError
  // (numeric `.code` 1/2/3) for real failures, or an Error with
  // `.code === 'UNAVAILABLE'` when the browser has no geolocation at all.
  function getPosition(opts) {
    return new Promise((resolve, reject) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        const e = new Error('Geolocation unavailable');
        e.code = 'UNAVAILABLE';
        reject(e);
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject,
        opts || { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    });
  }

  /* ------------------------------------------------------------------ *
   * Units
   * ------------------------------------------------------------------ */

  const toDisplay = (c, unit) => (unit === 'F' ? c * 9 / 5 + 32 : c);
  const fmtTemp = (c, unit) => `${Math.round(toDisplay(c, unit))}°${unit}`;

  /* ------------------------------------------------------------------ *
   * Preferences (activity / age / unit) — shared across every page.
   * ------------------------------------------------------------------ */

  const PREFS_KEY = 'cis:prefs';

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      const p = raw ? JSON.parse(raw) : null;
      return p && typeof p === 'object' ? p : {};
    } catch {
      return {};
    }
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore quota / disabled storage */
    }
  }

  /* ------------------------------------------------------------------ *
   * Map picker (Leaflet). One implementation, reused by every page.
   * ------------------------------------------------------------------ */

  /**
   * @param {object}   o
   * @param {HTMLDialogElement} o.dialog     the <dialog> to show
   * @param {string|HTMLElement} o.mapEl     Leaflet map container (id or element)
   * @param {HTMLButtonElement} o.confirmBtn confirm button (disabled until a pin)
   * @param {HTMLElement} [o.closeBtn]       optional close button
   * @param {() => ({lat:number, lon:number}|null)} [o.getCenter] initial centre
   * @param {({lat:number, lon:number}) => void} o.onConfirm called with the pick
   * @returns {{ open: () => void }}
   */
  function initMapPicker({ dialog, mapEl, confirmBtn, closeBtn, getCenter, onConfirm }) {
    let map = null;
    let marker = null;
    let picked = null;

    function ensureMap() {
      if (map) return;
      map = L.map(mapEl, { zoomControl: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      map.on('click', (e) => {
        picked = e.latlng;
        if (marker) {
          marker.setLatLng(picked);
        } else {
          marker = L.circleMarker(picked, {
            radius: 9, weight: 3, color: '#2f6bd8', fillColor: '#5b9dff', fillOpacity: 0.9,
          }).addTo(map);
        }
        if (confirmBtn) confirmBtn.disabled = false;
      });
    }

    function open() {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      ensureMap();
      const c = getCenter ? getCenter() : null;
      if (c && c.lat != null) map.setView([c.lat, c.lon], 10);
      else map.setView([20, 0], 2);
      // The map measures itself while the dialog is still opening; re-measure after.
      setTimeout(() => map.invalidateSize(), 60);
    }

    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => {
        if (!picked) return;
        const { lat, lng } = picked;
        dialog.close();
        onConfirm({ lat, lon: lng });
      });
    }
    if (closeBtn) closeBtn.addEventListener('click', () => dialog.close());

    return { open };
  }

  /* ------------------------------------------------------------------ *
   * Shared page controller (used by both views)
   * ------------------------------------------------------------------ *
   * The two views differ only in how they DISPLAY a reading. The
   * state, preference persistence, geolocation / manual / map flows and event
   * wiring are identical, so they live here. A page supplies two callbacks:
   *   • render(result, state) — paint a computed evaluate() result
   *   • showMessage(headline, detail, { showManual }) — paint a non-reading
   *     state (loading, geolocation error, validation prompt)
   * and standard element ids in its markup:
   *   activity, ageGroup, unitToggle, refreshBtn, mapBtn, place,
   *   mapModal, map, mapClose, mapConfirm,
   *   manualToggle, manualPanel, manualTemp, manualHum, manualWind, applyManual
   * Both views (Thermometer and Poster) drive themselves through this.
   */
  function createApp({ render, showMessage }) {
    const el = (id) => document.getElementById(id);
    const els = {
      activity: el('activity'), ageGroup: el('ageGroup'), unitToggle: el('unitToggle'),
      refreshBtn: el('refreshBtn'), mapBtn: el('mapBtn'), place: el('place'),
      mapModal: el('mapModal'), mapClose: el('mapClose'), mapConfirm: el('mapConfirm'),
      manualToggle: el('manualToggle'), manualPanel: el('manualPanel'),
      manualTemp: el('manualTemp'), manualHum: el('manualHum'),
      manualWind: el('manualWind'), applyManual: el('applyManual'),
    };

    const state = { activity: 'light', age: 'adult', unit: 'C', reading: null };
    const saved = loadPrefs();
    if (saved.activity) state.activity = saved.activity;
    if (saved.age) state.age = saved.age;
    if (saved.unit === 'C' || saved.unit === 'F') state.unit = saved.unit;

    function setActive(container, key, value) {
      if (!container) return;
      for (const b of container.querySelectorAll('.seg')) {
        b.classList.toggle('is-active', b.dataset[key] === value);
      }
    }
    function syncUnitTags() {
      for (const tag of document.querySelectorAll('.unitTag')) tag.textContent = `°${state.unit}`;
    }
    function persist() {
      savePrefs({ activity: state.activity, age: state.age, unit: state.unit });
    }

    function update() {
      if (!state.reading) return;
      const { t, rh, windMs } = state.reading;
      const r = evaluate(t, rh, windMs, state.activity, state.age);
      render(r, state);
      // Keep the manual fields as a live starting point, in the current unit.
      if (els.manualTemp) els.manualTemp.value = Math.round(toDisplay(t, state.unit) * 10) / 10;
      if (els.manualHum) els.manualHum.value = Math.round(rh);
    }

    /* ------------------------------------------------------------------ *
     * Auto-refresh for a left-open display (e.g. a wall-mounted screen).
     * ------------------------------------------------------------------ *
     * Every REFRESH_MS, while the tab is visible, silently re-pull weather
     * for the last known coordinates. It never re-prompts geolocation and
     * never flashes the loading state; a manual reading is left untouched, and
     * a transient network failure keeps the last good values on screen. */
    const REFRESH_MS = 15 * 60 * 1000;
    let lastFetchAt = 0; // ms epoch of the last successful weather fetch

    async function refreshReading() {
      const rd = state.reading;
      if (!rd || rd.lat == null || rd.source === 'manual') return;
      try {
        const reading = await fetchWeather(rd.lat, rd.lon);
        state.reading = { ...rd, ...reading }; // keep source/place/coords
        lastFetchAt = Date.now();
        update();
      } catch {
        /* keep showing the last good reading on a transient failure */
      }
    }

    function maybeAutoRefresh() {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (Date.now() - lastFetchAt < REFRESH_MS) return;
      refreshReading();
    }

    async function locate() {
      showMessage('Locating you…', 'Reading the weather where you are.', {});
      if (els.refreshBtn) els.refreshBtn.disabled = true;
      try {
        let lat, lon, placeName = null, source;
        try {
          const pos = await withTimeout(getPosition(), 12000);
          ({ latitude: lat, longitude: lon } = pos.coords);
          source = 'gps';
        } catch (geoErr) {
          // Respect an explicit denial — don't silently IP-track the user.
          if (geoErr && geoErr.code === 1) throw geoErr;
          // Unavailable / timed out / position error → fall back to IP.
          showMessage('Estimating your location…',
            'Precise location unavailable — using your approximate network location.', {});
          const ip = await ipLocate();
          ({ lat, lon, place: placeName } = ip);
          source = 'ip';
        }
        const [reading, revName] = await Promise.all([
          fetchWeather(lat, lon),
          placeName ? Promise.resolve(placeName) : reverseGeocode(lat, lon),
        ]);
        state.reading = { ...reading, source, placeName: revName || placeName, lat, lon };
        lastFetchAt = Date.now();
        update();
      } catch (err) {
        locationError(err);
      } finally {
        if (els.refreshBtn) els.refreshBtn.disabled = false;
      }
    }

    function locationError(err) {
      if (err && err.code === 'UNAVAILABLE') {
        showMessage('Location unavailable',
          'Your browser can’t share location. Enter the conditions manually below.',
          { showManual: true });
      } else if (err && err.code === 1) {
        showMessage('Location permission denied',
          'Enter the current temperature and humidity manually below and tap Calculate.',
          { showManual: true });
      } else if (err && (err.code === 2 || err.code === 3)) {
        showMessage('Couldn’t find your location',
          'Enter the current temperature and humidity manually below and tap Calculate.',
          { showManual: true });
      } else {
        const msg = err && err.message ? err.message : 'Something went wrong';
        showMessage('Couldn’t get the weather',
          `${msg}. Check your connection or enter conditions manually.`,
          { showManual: true });
      }
    }

    function applyManual() {
      const rawT = parseFloat(els.manualTemp.value);
      const rh = parseFloat(els.manualHum.value);
      if (Number.isNaN(rawT) || Number.isNaN(rh)) {
        showMessage('Enter temperature and humidity',
          'Both a temperature and a humidity value are needed to calculate.',
          { showManual: true });
        return;
      }
      const tC = state.unit === 'F' ? (rawT - 32) * 5 / 9 : rawT;
      const windKmh = parseFloat(els.manualWind ? els.manualWind.value : '');
      state.reading = {
        t: tC,
        rh: Math.max(0, Math.min(100, rh)),
        windMs: Number.isNaN(windKmh) ? 0 : windKmh / 3.6,
        source: 'manual',
        placeName: null,
      };
      update();
    }

    let mapPicker = null;
    function openMap() {
      if (!mapPicker) {
        mapPicker = initMapPicker({
          dialog: els.mapModal,
          mapEl: 'map',
          confirmBtn: els.mapConfirm,
          closeBtn: els.mapClose,
          getCenter: () =>
            state.reading && state.reading.lat != null
              ? { lat: state.reading.lat, lon: state.reading.lon }
              : null,
          onConfirm: onMapConfirm,
        });
      }
      mapPicker.open();
    }
    async function onMapConfirm({ lat, lon }) {
      showMessage('Getting the weather…', 'Fetching conditions for the pinned location.', {});
      try {
        const [reading, placeName] = await Promise.all([
          fetchWeather(lat, lon),
          reverseGeocode(lat, lon),
        ]);
        state.reading = { ...reading, source: 'map', placeName, lat, lon };
        lastFetchAt = Date.now();
        update();
      } catch (err) {
        showMessage('Couldn’t get the weather',
          `${err.message}. Check your connection or enter conditions manually.`,
          { showManual: true });
      }
    }

    if (els.activity) els.activity.addEventListener('click', (e) => {
      const b = e.target.closest('.seg'); if (!b) return;
      state.activity = b.dataset.activity;
      setActive(els.activity, 'activity', state.activity); persist(); update();
    });
    if (els.ageGroup) els.ageGroup.addEventListener('click', (e) => {
      const b = e.target.closest('.seg'); if (!b) return;
      state.age = b.dataset.age;
      setActive(els.ageGroup, 'age', state.age); persist(); update();
    });
    if (els.unitToggle) els.unitToggle.addEventListener('click', (e) => {
      const b = e.target.closest('.seg'); if (!b || b.dataset.unit === state.unit) return;
      state.unit = b.dataset.unit;
      setActive(els.unitToggle, 'unit', state.unit); syncUnitTags(); persist(); update();
    });
    if (els.refreshBtn) els.refreshBtn.addEventListener('click', locate);
    if (els.mapBtn) els.mapBtn.addEventListener('click', openMap);
    if (els.applyManual) els.applyManual.addEventListener('click', applyManual);
    if (els.manualToggle && els.manualPanel) {
      els.manualToggle.addEventListener('click', () => {
        els.manualPanel.hidden = !els.manualPanel.hidden;
      });
    }

    // Reflect restored preferences in the controls before the first reading.
    setActive(els.activity, 'activity', state.activity);
    setActive(els.ageGroup, 'age', state.age);
    setActive(els.unitToggle, 'unit', state.unit);
    syncUnitTags();

    locate();

    // Keep a left-open display current: tick every minute (cheap; only fetches
    // when visible and due) and top up immediately whenever the tab is shown
    // again after being hidden/asleep.
    if (typeof window !== 'undefined') {
      window.setInterval(maybeAutoRefresh, 60 * 1000);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', maybeAutoRefresh);
      }
    }

    return { state, update, showMessage: (h, d, o) => showMessage(h, d, o || {}), refreshReading };
  }

  /* ------------------------------------------------------------------ *
   * Export
   * ------------------------------------------------------------------ */

  const CIS = {
    // model
    evaluate, wetBulb, heatIndex, dewPoint, mugginess, satVaporPressure, convectiveCoeff,
    SKIN_TEMP, METABOLIC, AGE,
    // design mapping
    TIER_FROM_LEVEL, TIER_WORD,
    // data / geolocation
    fetchWeather, reverseGeocode, ipLocate, getPosition,
    // units
    toDisplay, fmtTemp,
    // prefs
    loadPrefs, savePrefs,
    // map
    initMapPicker,
    // shared page controller (both views)
    createApp,
  };

  const root = typeof window !== 'undefined' ? window : globalThis;
  root.CIS = CIS;
  // Kept for quick console/unit checks.
  root.__canISweat = { evaluate, wetBulb, heatIndex };
})();
