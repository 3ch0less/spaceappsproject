# Lumasphere

**The whole sky in infrared, from NASA's SPHEREx.** Built for the NASA Space Apps Challenge 2026,
challenge *"Planet X and SPHEREx"*.

Stand inside SPHEREx's all-sky map and look around in any of its 102 infrared colors. Pick any star, planet,
asteroid or galaxy, or click any spot, and watch how that patch of sky changed from one SPHEREx visit to the next.

## Features

- **All-sky map** in 102 infrared colors (0.75–5 µm), with object names and Gaia stars that appear as you zoom
- **Search** for stars, galaxies, planets, asteroids, comets or coordinates (`05h35m -05d23m`, `RA 83.8 Dec -5.4`)
- **Time-lapse:** a flipbook of every SPHEREx visit to a patch, with Blink and Difference modes, so moving and
  changing objects jump out
- **Spectrum:** brightness in every infrared color, one line per visit, zoomable, with a "did it change?" headline
- **WISE 2010:** the same patch as NASA's WISE telescope saw it about 16 years earlier
- **Asteroids:** known asteroids drawn on the map, and **Follow it** tracks one through every SPHEREx exposure

## Run it

You need **Python 3.12+** and **Git**. Paste one line, then open **http://localhost:8000**.

**macOS / Linux**
```bash
git clone https://github.com/3ch0less/spaceappsproject && cd spaceappsproject/backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/uvicorn main:app --port 8000
```

**Windows (PowerShell)**
```powershell
git clone https://github.com/3ch0less/spaceappsproject; cd spaceappsproject\backend; py -m venv .venv; .venv\Scripts\pip install -r requirements.txt; .venv\Scripts\uvicorn main:app --port 8000
```

**Docker**
```bash
git clone https://github.com/3ch0less/spaceappsproject && cd spaceappsproject && docker build -t lumasphere . && docker run -p 8000:8000 lumasphere
```

<details>
<summary><b>Didn't work? Step by step</b></summary>

1. Check `python3 --version` (Windows: `py --version`) says **3.12 or newer**. If not, install it from
   [python.org](https://www.python.org/downloads/). On Windows, tick **"Add python.exe to PATH"**.
2. `git clone https://github.com/3ch0less/spaceappsproject` (or **Code → Download ZIP**)
3. `cd spaceappsproject/backend`
4. `python3 -m venv .venv` (Windows: `py -m venv .venv`)
5. `source .venv/bin/activate` (Windows: `.venv\Scripts\Activate.ps1`)
6. `pip install -r requirements.txt`
7. `uvicorn main:app --port 8000`, then open http://localhost:8000

**Common problems**
- *PowerShell won't run scripts:* `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then retry.
- *numpy/astropy won't install:* use Python 3.12+ and run `python -m pip install --upgrade pip` first.
- *Port 8000 is busy:* use `--port 8001` and open http://localhost:8001.
- *Sky stays black or search fails:* the app needs internet access, because it streams live NASA data.

</details>

The first view of each patch of sky downloads from NASA and is slow. After that it's cached and opens instantly.
Before a demo, run `python prebuild.py` in `backend/` (while the server runs) to pre-load the featured targets.

## Using it

- **Look around:** drag to turn, scroll to zoom. The slider at the bottom changes the infrared color, from
  0.75 µm (starlight) to 5 µm (warm dust). **Sphere**, **Whole sky** and **Close-up** change the view.
- **Open something:** search, pick a target from the list, or click anywhere on the map. A side panel opens with
  facts about it.
- **Time-lapse:** plays by itself, one frame per SPHEREx visit (about six months apart). Arrow keys step, space
  pauses. **Blink** flips between visits. **Difference** subtracts them, so a moving star shows as a white dot
  beside a black one.
- **Detectors D1–D6:** each covers a slice of the infrared. One loads first; click others to add them.
- **Spectrum:** drag across the chart to zoom into a range of wavelengths; double-click to reset. Shaded bands mark
  wavelengths where the object was too bright to measure.
- **WISE, 2010:** open the fold-away panel to compare with the same patch 16 years earlier.
- **Asteroids:** tick **Asteroids** in the header, or search one (`Vesta`, `Psyche`) and press **Follow it**.
- **Share:** **Copy link** gives a URL that opens the exact same view.

## Deploy

One container serves everything. It listens on `$PORT` and has a health check at `/api/health`.

- **Render:** New → Blueprint → this repo (uses `render.yaml`)
- **Fly.io, Railway, Cloud Run or any Docker host:** deploy the `Dockerfile`

Give it about 1 GB of RAM, and mount a volume at `/data` to keep the cache across restarts.

## How it works

The frontend is plain HTML, CSS and JavaScript with no build step; [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/)
draws the sky. The backend is Python (FastAPI, astropy, NumPy). It serves the page, proxies and caches NASA's sky
tiles, builds the time-lapses and measures the spectra.

| File | What it does |
|---|---|
| `frontend/app.js` | Sky viewer, search, map clicks, wavelength slider, shareable links |
| `frontend/timelapse.js` | Flipbook, timeline, spectrum chart, WISE panel |
| `frontend/follow.js` | "Follow it" for asteroids and comets |
| `frontend/names.js`, `stars.js` | Object names and Gaia stars on the map, more as you zoom |
| `backend/main.py` | Search, suggestions, "what's here?" for map clicks, names and Gaia stars |
| `backend/tiles.py` | Sky-tile proxy with a disk cache |
| `backend/timelapse.py` | Finds every SPHEREx exposure of a patch, stacks each visit, measures brightness |
| `backend/wise.py` | The WISE 2010 image of the same patch |
| `backend/asteroids.py`, `track.py` | Asteroids on the map, and tracking one through the exposures |
| `backend/prebuild.py` | Pre-loads the featured targets so they open instantly |

Everything downloaded is kept in `backend/.cache/` (5 GB by default, oldest removed first), so each patch of sky is
slow only the first time.

| Data | Source |
|---|---|
| Sky map and time-lapse images | NASA IRSA: SPHEREx all-sky maps and individual exposures |
| WISE comparison | AllWISE images (2010), via IRSA and CDS |
| Star and galaxy names | CDS SIMBAD |
| Planets, asteroids, comets | NASA JPL Horizons, JPL Small-Body Database, IMCCE SkyBoT |
| Star positions and motion | ESA Gaia DR3 |

### Settings

All optional, set as environment variables.

| Variable | Default | What it does |
|---|---|---|
| `LUMASPHERE_CACHE_DIR` | `backend/.cache` | Where downloads are cached (safe to delete) |
| `LUMASPHERE_CACHE_GB` | `5` | Cache size limit |
| `LUMASPHERE_HIPS_URL` | IRSA SPHEREx map | Sky map source |
| `LUMASPHERE_SPHEREX_COLLECTIONS` | `spherex_dr1,spherex_qr3` | SPHEREx data releases to search |

## Challenge targets

Each one is a click away on the first screen, with a note on what to look for.

| Target | What you'll see |
|---|---|
| Barnard's Star | Moves about 10″ a year: use **Difference** mode. Too bright to measure below 3.8 µm |
| Epsilon Indi B | Moves about 6″ in 1.4 years, clearest on D5–D6 |
| WISE 0855 | Only shows at 3.8–5 µm (D5–D6), moving about 8″. Too faint to judge its brightness |
| RW Aurigae | Really changes: +40–55% at 0.75–1.6 µm and about −50% at 3.8–5 µm between visits |
| R Draconis | Too bright to measure directly; its glow fades to about 40%, a less certain measure |

## Credits

Built for NASA Space Apps 2026. Data courtesy of NASA/JPL-Caltech/IPAC, CDS Strasbourg, ESA and IMCCE.
