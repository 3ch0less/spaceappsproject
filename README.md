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

## Deploy

One container serves everything. It listens on `$PORT` and has a health check at `/api/health`.

- **Render:** New → Blueprint → this repo (uses `render.yaml`)
- **Fly.io, Railway, Cloud Run or any Docker host:** deploy the `Dockerfile`

Give it about 1 GB of RAM, and mount a volume at `/data` to keep the cache across restarts.

## How it works

```
frontend/   plain HTML, CSS and JavaScript (no build step). Aladin Lite draws the sky
backend/    Python + FastAPI: search, sky-tile proxy, time-lapses, spectra, WISE, asteroids
```

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

Barnard's Star · Epsilon Indi B · WISE 0855 · RW Aurigae · R Draconis. Each one is a click away on the first
screen, with a note on what to look for.

## Credits

Built for NASA Space Apps 2026. Data courtesy of NASA/JPL-Caltech/IPAC, CDS Strasbourg, ESA and IMCCE.
