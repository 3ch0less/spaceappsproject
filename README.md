# SkyShift: the infrared sky from NASA's SPHEREx

NASA Space Apps Challenge 2026, challenge **"Planet X and SPHEREx"**.

You stand inside the sky (a "reverse panorama") and look around NASA SPHEREx's all-sky infrared map,
in any of its 102 infrared colors. Search for any star, planet, asteroid, comet or galaxy and the view flies there.

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
them too. **Before a demo, click through the targets you plan to show once** so everything is already cached.

## How it works

```
frontend/ (plain HTML/CSS/JS, no build step)
  index.html   layout
  style.css    look & feel
  app.js       sky viewer (Aladin Lite v3), search, wavelength slider, overlays, shareable URLs

backend/ (Python FastAPI)
  main.py      GET /api/resolve?q=...  name or coords → sky position + facts
  tiles.py     GET /hips/<version>/<frame>/...  sky tiles, one HiPS per wavelength, cached on disk
               GET /api/survey                  wavelengths, blank frames, release version
               GET /api/warm                    "these tiles are needed soon" (look-ahead)
               GET /api/cache                   cache statistics
```

| Piece | Source |
|---|---|
| Sky images | IRSA's SPHEREx DR1 all-sky HiPS cube (102 wavelength frames, 0.75–5.0 µm), fetched through `backend/tiles.py`. The upstream URL is `SKYSHIFT_HIPS_URL` (default: IRSA). Wavelengths, blank frames, date range and the release version are all read from its `properties` file, so a new release needs no code change |
| Stars, galaxies, nebulae | CDS Sesame / SIMBAD (also gives distance and proper motion) |
| Planets, asteroids, comets | NASA JPL Horizons (position today and path during the SPHEREx survey) |
| Names overlay | SIMBAD cone search (via Aladin) |
| Gaia overlay | Gaia DR3 via VizieR |

### Details worth knowing
- **Fast stars are moved to where SPHEREx saw them.** SIMBAD positions are for the year 2000. Barnard's Star has moved 4.5 arcminutes since then, so the backend applies proper motion to the survey mid-point (2025.9). The yellow ring shows the year-2000 position. Great demo moment.
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
  magnified pixels. Sharper views need the individual SPHEREx images (the time-lapse feature below).
- Shareable links: `?q=Barnard's Star`, or `?ra=…&dec=…&fov=…&wl=1.66`.

### Settings (environment variables, all optional)
| Variable | Default | Meaning |
|---|---|---|
| `SKYSHIFT_HIPS_URL` | IRSA SPHEREx all-sky cube | Upstream HiPS cube to mirror |
| `SKYSHIFT_CACHE_DIR` | `backend/.cache` | Where tiles are kept. Safe to delete at any time |
| `SKYSHIFT_CACHE_GB` | `5` | Disk budget for the tile cache |

## Test targets (from the challenge)
Barnard's Star · Epsilon Indi B (`eps Ind B`) · WISE 0855 (`WISE J085510.83-071442.5`) · RW Aurigae · R Draconis.
All of them are one-click chips on the welcome card.

## Next up
- [ ] **Time-lapse / blink (core challenge requirement).** Backend endpoint that queries IRSA SIA (`spherex_qr`) for all SPHEREx images covering a position, cuts out the patch, aligns the cutouts, and returns frames by date. Frontend plays them like a flipbook, with stack/subtract options.
- [ ] Spectrum on click (flux vs. wavelength from the cube or the individual images)
- [ ] Phone "point at the sky" mode (GPS + compass → RA/Dec)
- [ ] Known asteroids overlay (Aladin's SkyBoT catalog) on time-lapse frames
- [ ] Deploy over HTTPS (needed for phone sensors)
