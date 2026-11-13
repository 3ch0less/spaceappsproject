# SkyShift: the infrared sky from NASA's SPHEREx

NASA Space Apps Challenge 2026, challenge **"Planet X and SPHEREx"**.

Two things in one page:

1. **The whole sky.** You stand inside the sky (a "reverse panorama") and look around NASA SPHEREx's all-sky infrared
   map, in any of its 102 infrared colors. Search for any star, planet, asteroid, comet or galaxy and the view flies there.
2. **The time-lapse (the challenge requirement).** Pick any object or click any spot, and a side panel plays how that
   patch of sky looked on each of SPHEREx's visits, like a flipbook. Things that moved or changed brightness jump out.
   Below it, a spectrum shows the object's brightness in every infrared color, one line per visit.

## Run it

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
uvicorn main:app --port 8000
```

Open http://localhost:8000. The backend also serves the frontend and the sky tiles.

The first time you look at a patch of sky its tiles are downloaded from IRSA (slow: roughly 250 kB/s per
connection). After that they are served from `backend/.cache/` in a few milliseconds, and the browser keeps
them too. A time-lapse takes about 8 seconds the first time and is instant afterwards.
**Before a demo, click through the targets you plan to show once** so everything is already cached.

## Using the time-lapse

- **Open it:** search for something, click a featured chip, or click anywhere on the map. Clicking does not move the
  camera; dragging does not select.
- **Flipbook:** plays by itself. Each frame is one SPHEREx visit (about six months apart), with its date, visit number
  and exposure count. The arrow keys step, space plays and pauses. North is up, east is left.
- **Timeline:** the whole survey left to right, one tick per exposure, one band per visit. Click a band to jump to it.
- **Detectors D1 to D6:** SPHEREx has six detectors, each covering a slice of the infrared. One loads at first; click
  another to load it. Cold brown dwarfs start on D6 (4.4–5.0 µm), everything else on D2 (1.1–1.6 µm).
- **Blink / Difference:** Difference subtracts another visit. Grey means unchanged, a white dot next to a black dot is
  something that moved, a lone dot brightened or faded.
- **Options:** patch width (3′, 6′, 12′, 20′), speed, brightness, a marker showing where the catalog predicts the
  object on each date, and Gaia stars drawn at their positions for that date.
- **Spectrum:** brightness against wavelength, one line per visit, with a headline saying whether it changed.
  "Load the other detectors" fills in the full 0.75–5 µm range. "Show the numbers" gives the same data as a table.
- **Planets and asteroids** move across the sky, so a fixed patch does not follow them. The panel says so and waits
  for you to press the button.

What to expect from the challenge's test targets:

| Target | What you see |
|---|---|
| Barnard's Star | Moves about 8″ north across three visits. No spectrum: it is so bright it saturates the detector, and the panel says so |
| RW Aurigae | Brightness changes between visits (245 → 336 → 346 mJy in one band; up to 97% at the longest wavelengths) |
| R Draconis | Three visits load, but it is too bright to measure: it saturates detectors 2 and 6 (the other four are untested), so no spectrum yet |
| WISE 0855 | The field loads. The brown dwarf itself is extremely faint and we have not confirmed it is visible |
| Epsilon Indi B | Resolves and loads; its frames have not been studied closely yet |

## How it works

```
frontend/ (plain HTML/CSS/JS, no build step)
  index.html    layout
  style.css     look & feel, including the phone layout
  app.js        sky viewer (Aladin Lite v3), search, map clicks, wavelength slider, overlays, shareable URLs
  timelapse.js  the flipbook, its timeline and the spectrum chart in the side panel

backend/ (Python FastAPI)
  main.py       GET /api/resolve?q=...            name or coords → sky position + facts
                GET /api/identify?ra=&dec=        what is at this spot (a click on the map)
                GET /api/names?ra=&dec=&radius=   best-known named objects nearby ("Names" switch)
                GET /api/gaia?ra=&dec=&radius=    Gaia DR3 stars nearby ("Gaia stars" switches)
  tiles.py      GET /hips/<version>/<frame>/...   sky tiles, one HiPS per wavelength, cached on disk
                GET /api/survey                   wavelengths, blank frames, release version
                GET /api/warm                     "these tiles are needed soon" (look-ahead)
                GET /api/cache                    cache statistics
  timelapse.py  GET /api/timelapse?ra=&dec=&fov=&det=   one image per visit + brightness per exposure
```

| Piece | Source |
|---|---|
| Sky map | IRSA's SPHEREx DR1 all-sky HiPS cube (102 wavelength frames, 0.75–5.0 µm), fetched through `backend/tiles.py`. The upstream URL is `SKYSHIFT_HIPS_URL` (default: IRSA). Wavelengths, blank frames, date range and the release version are all read from its `properties` file, so a new release needs no code change |
| Time-lapse images | SPHEREx level-2 exposures. IRSA's image search (SIA) lists the exposures covering a position; the pixels are read from NASA's public cloud copy (`nasa-irsa-spherex` on AWS), with IRSA itself as the fallback |
| Stars, galaxies, nebulae | CDS Sesame / SIMBAD (also gives distance and proper motion) |
| Planets, asteroids, comets | NASA JPL Horizons (position today and path during the SPHEREx survey) |
| Map clicks, Names overlay | SIMBAD's query service, through our backend |
| Gaia overlays | Gaia DR3 from ESA's archive, IRSA's copy as the fallback, through our backend |

### Details worth knowing

**Time-lapse**
- **A visit, a detector, an exposure.** SPHEREx returns to every spot about every six months. During a visit it
  photographs the spot roughly 20 times with each detector, each time through a slightly different color. One
  time-lapse frame is the median of one visit's exposures from one detector, re-gridded north-up onto a 128×128 grid.
- **Only the needed rows are downloaded.** Each exposure is a 65 MB file; the backend reads its header and just the
  rows around the target with HTTP range requests (under 1 MB for the default 6′ patch). IRSA's cutout service was tried first and
  rejected: every cutout is about 4 MB whatever its size, and parallel downloads get rate-limited.
- **The answer is streamed.** `/api/timelapse` sends one JSON object per line: the plan (visits and exposure times),
  progress counts, then the result. Results are cached in `backend/.cache/timelapse/` for a day (new exposures are
  published weekly). If the user moves on, the download is cancelled.
- **Brightness** is summed within 12″ of the source after subtracting the sky level measured in a ring around it.
  Treat the values as approximate. Saturated stars cannot be measured and are reported as such.
- SPHEREx pixels are 6.15″, so the frames are soft. A 3′ patch is about 30 detector pixels across.

**Sky map**
- **Fast stars are moved to where SPHEREx saw them.** SIMBAD positions are for the year 2000. Barnard's Star has moved 4.5 arcminutes since then, so the backend applies proper motion to the survey mid-point (2025.8). The yellow ring shows the year-2000 position. The Names and Gaia markers are moved the same way.
- **One HiPS per wavelength, not Aladin's cube mode.** Aladin Lite 3.8.2 can open the cube directly, but its cube
  renderer re-downloads every visible tile twice a second, has no low-resolution fallback while tiles load (the sky
  went black on zoom) and picks the wrong frame for a slice number. So `tiles.py` exposes frame *k* as an ordinary
  HiPS at `/hips/<version>/<k>/` (it maps `Npix123.png` to IRSA's `Npix123_k.png`), which uses Aladin's solid 2D
  path: blurry preview first, sharp tiles fade in, nothing is fetched twice.
- **Changing wavelength never blanks the sky.** The new frame's layer is added on top of the current one and the old
  one is removed only once the new tiles are on screen (`swapLayers()` in `app.js`). A switch takes about 0.3 s when
  cached; the sweep runs at about 2 frames per second (Aladin only looks for new tiles every 500 ms).
- **Caching, three layers deep.** Disk (`backend/.cache/`, capped by `SKYSHIFT_CACHE_GB`, default 5, least recently
  used tiles deleted first) → browser (tiles are served `immutable`, the release version is part of the URL) →
  GPU (Aladin). A new IRSA release changes the version, so every layer refreshes by itself.
- **Look-ahead.** When you search, the destination's tiles start downloading while the camera is still flying
  there; during a sweep the next few wavelengths are fetched in advance; when the view is still, the neighbouring
  wavelengths of a zoomed-in view are fetched so the slider responds at once.
- Frames 50 and 51 are blank (dichroic channels) and the slider skips them. The backend finds blank frames by
  asking IRSA, nothing is hard-coded. Frame index = 17·(detector−1) + (channel−1).
- The deepest tile level is HiPS order 5 (about 13″ per pixel), so below roughly 2° field of view you are looking at
  magnified pixels. The time-lapse panel shows the sharper individual exposures.
- Shareable links: `?q=Barnard's Star`, or `?ra=…&dec=…&fov=…&wl=1.66`.

**Catalogs**
- **Nothing in the browser talks to the CDS servers in Strasbourg.** They were down while this was built
  (HTTP 404), which broke Aladin's built-in Names and Gaia overlays. The backend now asks SIMBAD's Strasbourg and
  Harvard sites side by side and uses whichever answers first, with a 10-second limit, and gets Gaia from ESA.
- **Names shows the 80 most written-about objects in view**, not the nearest ones. A crowded field holds tens of
  thousands of catalogued objects.
- Clicking a Names or Gaia marker opens that exact object in the side panel.

### Settings (environment variables, all optional)
| Variable | Default | Meaning |
|---|---|---|
| `SKYSHIFT_HIPS_URL` | IRSA SPHEREx all-sky cube | Upstream HiPS cube to mirror |
| `SKYSHIFT_CACHE_DIR` | `backend/.cache` | Where tiles and time-lapses are kept. Safe to delete at any time |
| `SKYSHIFT_CACHE_GB` | `5` | Disk budget for the cache |
| `SKYSHIFT_SPHEREX_COLLECTIONS` | `spherex_dr1,spherex_qr3` | Data releases searched for exposures, most trusted first. Add the next release here when IRSA publishes it |
| `SKYSHIFT_SPHEREX_CLOUD` | `https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/` | Cloud copy the exposures are read from |

## Test targets (from the challenge)
Barnard's Star · Epsilon Indi B (`eps Ind B`) · WISE 0855 (`WISE J085510.83-071442.5`) · RW Aurigae · R Draconis.
All of them are one-click chips on the welcome card.

## Tested on
Chrome (Apple GPU), WebKit (Safari's engine) and software-rendered Chromium, driven by scripts; phone layout at
390×844 upright and sideways. Not yet tried by hand on a real phone.

## Next up
- [ ] Follow a planet or asteroid through its exposures (today the patch stays fixed on the sky)
- [ ] Look for WISE 0855 itself in the detector 6 frames, and study the Epsilon Indi B frames
- [ ] Phone "point at the sky" mode (GPS + compass → RA/Dec)
- [ ] Known asteroids overlay (SkyBoT) on time-lapse frames
- [ ] Deploy over HTTPS (needed for phone sensors)
