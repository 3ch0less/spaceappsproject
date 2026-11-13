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

Open http://localhost:8000. The backend also serves the frontend.

## How it works

```
frontend/ (plain HTML/CSS/JS, no build step)
  index.html   layout
  style.css    look & feel
  app.js       sky viewer (Aladin Lite v3), search, wavelength slider, overlays, shareable URLs

backend/ (Python FastAPI)
  main.py      GET /api/resolve?q=...  name or coords → sky position + facts
```

| Piece | Source |
|---|---|
| Sky images | IRSA's SPHEREx DR1 all-sky HiPS cube (102 wavelength frames, 0.75–5.0 µm). URL lives in `HIPS_URL` in `app.js`; wavelengths are read from it, so new releases are a one-line swap |
| Stars, galaxies, nebulae | CDS Sesame / SIMBAD (also gives distance and proper motion) |
| Planets, asteroids, comets | NASA JPL Horizons (position today and path during the SPHEREx survey) |
| Names overlay | SIMBAD cone search (via Aladin) |
| Gaia overlay | Gaia DR3 via VizieR |

### Details worth knowing
- **Fast stars are moved to where SPHEREx saw them.** SIMBAD positions are for the year 2000. Barnard's Star has moved 4.5 arcminutes since then, so the backend applies proper motion to the survey mid-point (2025.9). The yellow ring shows the year-2000 position. Great demo moment.
- **Aladin slice bug workaround.** `layer.setSliceNumber(k)` does not load frame k for this cube, because Aladin goes through frequency space. `aladinSliceFor(k)` in `app.js` inverts that conversion. Verified for frames 0–101.
- Frames 50 and 51 are blank (dichroic channels) and the slider skips them. Frame index = 17·(detector−1) + (channel−1).
- Shareable links: `?q=Barnard's Star`, or `?ra=…&dec=…&fov=…&wl=1.66`.

## Test targets (from the challenge)
Barnard's Star · Epsilon Indi B (`eps Ind B`) · WISE 0855 (`WISE J085510.83-071442.5`) · RW Aurigae · R Draconis.
All of them are one-click chips on the welcome card.

## Next up
- [ ] **Time-lapse / blink (core challenge requirement).** Backend endpoint that queries IRSA SIA (`spherex_qr`) for all SPHEREx images covering a position, cuts out the patch, aligns the cutouts, and returns frames by date. Frontend plays them like a flipbook, with stack/subtract options.
- [ ] Spectrum on click (flux vs. wavelength from the cube or the individual images)
- [ ] Phone "point at the sky" mode (GPS + compass → RA/Dec)
- [ ] Known asteroids overlay (Aladin's SkyBoT catalog) on time-lapse frames
- [ ] Deploy over HTTPS (needed for phone sensors)
