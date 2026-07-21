# Can I Sweat?

A tiny mobile web app. Open it, and it tells you — for the weather at your
current location — whether **your sweat can actually cool you**, or whether you
need to **cool down another way**. It also shows how hard your sweating is
working, so you can tell how much margin you have.

No accounts, no API keys, no build step. Just a static page.

## How it works

Sweat cools you only by **evaporating**. How fast it can evaporate depends on
how much moisture the air can still absorb, which is captured by the **wet-bulb
temperature**. As the wet-bulb temperature climbs toward skin temperature
(~35 °C), evaporation slows to nothing and sweating stops cooling you — no
matter how much you sweat.

The app:

1. Gets your location (with permission) and fetches the current air temperature,
   humidity and wind from [Open-Meteo](https://open-meteo.com) (free, no key).
2. Computes:
   - **Wet-bulb temperature** (Stull 2011 approximation) — the master signal.
   - **Heat index** ("feels like", NWS Rothfusz regression).
   - A simple **heat-balance model**: your metabolic heat production (from the
     activity you pick) versus how much heat the air lets you shed by evaporation
     and convection. The ratio — *required sweating ÷ what the air allows* — is
     the "sweat load" meter. Below 100 % your sweat can compensate; above it, it
     can't.
   - A dew point indicator that will tell you how "heavy" the air is
3. Gives a color-coded verdict from "plenty of margin" to "sweat cannot cool
   you — cool down now."

Activity level matters: at rest your body produces little heat, so sweat copes
in conditions that would overwhelm you during hard exertion.

### Cooling recommendations

When the Thermometer verdict turns orange or worse, a **"Google
recommendations"** link appears under the verdict sentence. It opens a Google
search pre-filled with your situation — current temperature, feels-like and
humidity (in your chosen unit), your age group and activity level, your rough
location, and a plain-language question asking how to cool down safely — so the
search AI can point you to concrete, local advice.

Privacy note: the link only opens if you tap it, and the location it includes
is deliberately coarse — the city-level place name when available, coordinates
rounded to one decimal (~10 km) otherwise, and nothing at all for manually
entered conditions.

### Not medical advice

This is a physics estimate. Real risk also depends on hydration,
acclimatization, age, medication and **direct sun** (Open-Meteo reports shade
air temperature; sun load is not modeled). If you feel unwell, stop and cool
down regardless of what the app says.

## Run locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Geolocation and the service worker need a secure context — `localhost` counts,
so local testing works. In production it must be served over HTTPS (GitHub Pages
is).

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` publishes the site on every push to the feature
branch (and `main`). **One-time setup:** in the repository, go to
**Settings → Pages → Build and deployment → Source** and choose
**GitHub Actions**. After the next push the workflow deploys and prints the live
URL in its summary.

## Two views

The default screen is **The Thermometer** — the whole screen is the verdict, its
colour shifting with risk. A second **Poster** view (editorial, ink-on-paper) is
at [`/poster`](poster/). A tiny link at the bottom of each switches to the other;
both share the same engine, weather and calibrated verdict.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Default view — the full-screen "Thermometer" verdict |
| `thermometer.css` / `thermometer.js` | Styling and controller for the default view |
| `poster/` | Alternate "Poster" view served at `/poster` |
| `core.js` | Shared engine: geolocation, weather fetch, physiology model, state |
| `manifest.webmanifest`, `icons/` | PWA install metadata |
| `sw.js` | Network-first service worker (offline shell) |
| `.github/workflows/deploy.yml` | GitHub Pages deploy |
