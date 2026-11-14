"""Follow a moving object (asteroid, comet) through SPHEREx's exposures.

A fixed time-lapse can't show an asteroid: it crosses a 6' patch in minutes. Instead, every
frame here is cut out centred on where NASA JPL Horizons says the object was at the moment
that exposure was taken. The object stays in the middle while the star field behind it changes.

    GET /api/track?q=Vesta&fov=12
      {"stage": "..."}                 what it is doing (several of these)
      {"progress": [done, total]}      while downloading
      {"result": {...}}                frames, in time order
      {"error": "..."}

How the exposures are found:
  1. Horizons gives the object's position and its angle from the Sun for every day of the survey.
  2. SPHEREx only looks 80-127 deg from the Sun (measured on 8,324 exposures), so only those days
     can have caught it. On every few of them, IRSA's image search is asked which exposures
     covered the object's position within a couple of days (a SPHEREx detector spans 3.5 deg;
     a main-belt asteroid moves ~0.25 deg a day).
  3. Horizons gives the exact position at each candidate exposure's moment; exposures whose
     outline (s_region) really contains it, away from the edges, are kept.
Results are cached on disk for a week.
"""

from __future__ import annotations

import asyncio
import base64
import csv
import hashlib
import io
import json
import logging
import math
import time
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

import tiles
import timelapse

log = logging.getLogger("skyshift.track")
router = APIRouter()

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
SURVEY_START = "2025-04-24"
ELONGATION = (79.0, 128.0)    # degrees from the Sun that SPHEREx observes (measured, with a margin)
SAMPLE_DAYS = 3               # one exposure search every this many observable days...
WINDOW_DAYS = 2.0             # ...covering this many days either side
SEARCHES_AT_ONCE = 6          # IRSA's image search slows down (and refuses) when asked too much at once
MAX_FRAMES = 48
FOV_CHOICES = (6.0, 12.0, 20.0)
TRACK_VERSION = 3  # 2: saturated cores filled; 3: "seen" per frame
TTL = 7 * 86400
CACHE = timelapse.CACHE_DIR / "track"

_jobs: dict[str, "asyncio.Task"] = {}
_progress: dict[str, dict] = {}


# ---------------------------------------------------------------- Horizons

async def horizons(client: httpx.AsyncClient, command: str, extra: dict) -> tuple[list[list[str]], str]:
    params = {"format": "json", "COMMAND": f"'{command}'", "OBJ_DATA": "NO", "MAKE_EPHEM": "YES",
              "EPHEM_TYPE": "OBSERVER", "CENTER": "'500@399'", "ANG_FORMAT": "DEG", "CSV_FORMAT": "YES", **extra}
    r = await client.get(HORIZONS_URL, params=params, timeout=60)
    r.raise_for_status()
    result = r.json().get("result", "")
    if "$$SOE" not in result:
        return [], result
    body = result.split("$$SOE")[1].split("$$EOE")[0].strip()
    return [[c.strip() for c in row] for row in csv.reader(io.StringIO(body))], result


def numbers(cells: list[str]) -> list[float]:
    out = []
    for c in cells[1:]:
        try:
            out.append(float(c))
        except ValueError:
            pass
    return out


async def daily_path(client: httpx.AsyncClient, name: str) -> tuple[str, str, list[dict]]:
    """(Horizons command that worked, object name, [{mjd, ra, dec, elong}] for every survey day)."""
    from main import pick_from_matches  # main imports this module; by now main is fully loaded

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    extra = {"START_TIME": f"'{SURVEY_START}'", "STOP_TIME": f"'{today}'", "STEP_SIZE": "'1d'", "QUANTITIES": "'1,23'"}
    command = f"{name};"
    rows, text = await horizons(client, command, extra)
    if not rows and (retry := pick_from_matches(text)):
        command = retry
        rows, text = await horizons(client, command, extra)
    if not rows:
        raise HTTPException(404, f"JPL Horizons doesn't know a small body called \"{name}\".")
    start = datetime(2025, 4, 24)
    path = []
    for i, cells in enumerate(rows):
        v = numbers(cells)
        if len(v) >= 3:
            path.append({"mjd": (start - timelapse.MJD0).days + i, "ra": v[0], "dec": v[1], "elong": v[2]})
    label = next((ln.split(":", 1)[1].split("  ")[0].strip() for ln in text.splitlines() if ln.startswith("Target body name:")), name)
    return command, label, path


async def exact_positions(client: httpx.AsyncClient, command: str, mjds: list[float]) -> list[tuple[float, float] | None]:
    """Where the object was at each of these moments (Horizons, 50 moments per question)."""
    out: list[tuple[float, float] | None] = []
    for i in range(0, len(mjds), 50):
        chunk = mjds[i:i + 50]
        rows, _ = await horizons(client, command, {"TLIST": "'" + " ".join(f"{m + 2400000.5:.6f}" for m in chunk) + "'",
                                                   "TLIST_TYPE": "JD", "QUANTITIES": "'1'"})
        got = [numbers(r)[:2] for r in rows]
        out += [tuple(g) if len(g) == 2 else None for g in got] + [None] * (len(chunk) - len(got))
    return out


# ---------------------------------------------------------------- geometry

def tangent(ra0: float, dec0: float, ra: np.ndarray, dec: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Gnomonic projection around (ra0, dec0), in degrees."""
    r0, d0, r, d = map(np.radians, (ra0, dec0, ra, dec))
    cosc = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(r - r0)
    x = np.cos(d) * np.sin(r - r0) / cosc
    y = (np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(r - r0)) / cosc
    return np.degrees(x), np.degrees(y)


def inside_with_margin(s_region: str, ra: float, dec: float, margin_deg: float) -> bool:
    """Is (ra, dec) inside the exposure's outline, at least margin_deg from every edge?"""
    try:
        vals = [float(v) for v in s_region.replace("POLYGON", "").replace("ICRS", "").split()]
    except ValueError:
        return False
    if len(vals) < 6:
        return False
    x, y = tangent(ra, dec, np.array(vals[0::2]), np.array(vals[1::2]))
    inside = False
    n = len(x)
    for i in range(n):  # ray casting from the origin (our point) along +x
        x1, y1, x2, y2 = x[i], y[i], x[(i + 1) % n], y[(i + 1) % n]
        if (y1 > 0) != (y2 > 0) and 0 < x1 + (0 - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    if not inside:
        return False
    for i in range(n):  # distance from the origin to each edge
        x1, y1, x2, y2 = x[i], y[i], x[(i + 1) % n], y[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        t = max(0.0, min(1.0, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy or 1e-12)))
        if math.hypot(x1 + t * dx, y1 + t * dy) < margin_deg:
            return False
    return True


# ---------------------------------------------------------------- the job

async def search_day(client: httpx.AsyncClient, sem: asyncio.Semaphore, day: dict) -> list[dict]:
    rows = []
    for collection in timelapse.COLLECTIONS:
        params = {"COLLECTION": collection, "POS": f"CIRCLE {day['ra']:.6f} {day['dec']:.6f} 0.0001",
                  "TIME": f"{day['mjd'] - WINDOW_DAYS:.4f} {day['mjd'] + WINDOW_DAYS:.4f}", "RESPONSEFORMAT": "CSV"}
        for attempt in range(2):
            try:
                async with sem:
                    r = await client.get(timelapse.SIA_URL, params=params, timeout=45)
                r.raise_for_status()
                for row in csv.DictReader(io.StringIO(r.text)):
                    band = row.get("energy_bandpassname") or ""
                    url = row.get("access_url") or ""
                    if "/level2/" in url and url.endswith(".fits") and band[-1:].isdigit() and row.get("t_min"):
                        rows.append({"uri": url.split("irsa.ipac.caltech.edu/", 1)[-1], "det": int(band[-1]),
                                     "mjd": (float(row["t_min"]) + float(row.get("t_max") or row["t_min"])) / 2,
                                     "s_region": row.get("s_region", ""), "release": collection})
                break
            except (httpx.HTTPError, ValueError) as e:
                log.warning("track search %s failed (%r)%s", collection, e, ", retrying" if not attempt else "")
    return rows


async def build_track(key: str, name: str, fov: float) -> dict:
    prog = _progress[key]
    client = timelapse._client
    prog["stage"] = "Asking NASA JPL where it has been since SPHEREx started…"
    command, label, path = await daily_path(client, name)
    observable = [d for d in path if ELONGATION[0] <= d["elong"] <= ELONGATION[1]]
    samples = observable[::SAMPLE_DAYS]
    prog["stage"] = f"Searching SPHEREx exposures along its path ({len(samples)} places)…"
    sem = asyncio.Semaphore(SEARCHES_AT_ONCE)
    found = await asyncio.gather(*(search_day(client, sem, d) for d in samples))

    best: dict[str, dict] = {}  # one entry per exposure (it can turn up in several searches and releases)
    order = {c: i for i, c in enumerate(timelapse.COLLECTIONS)}
    for row in (r for part in found for r in part):
        exp_name = row["uri"].rsplit("/", 1)[1].split("_spx")[0]
        if exp_name not in best or order[row["release"]] < order[best[exp_name]["release"]]:
            best[exp_name] = row
    candidates = sorted(best.values(), key=lambda r: r["mjd"])
    prog["stage"] = f"Checking which of {len(candidates)} exposures really caught it…"
    positions = await exact_positions(client, command, [c["mjd"] for c in candidates])
    margin = fov / 60 / 2 * 1.1
    caught = []
    for c, pos in zip(candidates, positions):
        if pos and inside_with_margin(c["s_region"], pos[0], pos[1], margin):
            caught.append({**c, "ra": pos[0], "dec": pos[1]})

    # Passes: SPHEREx catches it in bursts a few months apart.
    passes, last = [], None
    for c in caught:
        if last is None or c["mjd"] - last > 20:
            passes.append([])
        passes[-1].append(c)
        last = c["mjd"]
    for i, group in enumerate(passes):
        for c in group:
            c["visit"] = i
    chosen = caught
    if len(caught) > MAX_FRAMES:  # an even sample, so every pass keeps its share
        picks = np.linspace(0, len(caught) - 1, MAX_FRAMES).round().astype(int)
        chosen = [caught[i] for i in sorted(set(picks))]

    prog.update(stage="Downloading the exposures…", done=0, total=len(chosen))

    async def one(c):
        try:
            gra, gdec, scale = timelapse.sky_grid(c["ra"], c["dec"], fov)
            async with timelapse._exposure_slots:
                shot = await timelapse.fetch_exposure(c, c["ra"], c["dec"], fov, gra, gdec)
            if shot is None:
                return None
            img = shot["image"] - np.nanmedian(shot["image"])
            finite = img[np.isfinite(img)]
            lo = float(np.percentile(finite, 5)) if finite.size else 0.0
            hi = float(np.percentile(finite, 99.7)) if finite.size else 1.0
            img = timelapse.fill_saturated(img, lo + 0.5 * (hi - lo))  # a bright asteroid's blown-out core: fill the hole
            # Is it actually visible? Something at the centre (within ~1 SPHEREx pixel) well above the noise.
            noise = float(1.4826 * np.median(np.abs(finite - np.median(finite)))) if finite.size else 1.0
            m = timelapse.GRID // 2
            reach = max(1, round(timelapse.NATIVE_ARCSEC / (fov * 60 / timelapse.GRID)))
            core = img[m - reach - 1:m + reach + 1, m - reach - 1:m + reach + 1]
            seen = bool(np.isfinite(core).any() and np.nanmax(core) > 5 * max(noise, 1e-9))
            return {"mjd": round(c["mjd"], 5), "seen": seen, "date": (timelapse.MJD0 + timedelta(days=c["mjd"])).strftime("%Y-%m-%d %H:%M"),
                    "det": c["det"], "wl": round(shot["wl"], 3), "pass": c["visit"], "ra": round(c["ra"], 6), "dec": round(c["dec"], 6),
                    "lo": lo, "hi": max(hi, lo + 1e-6), "image": base64.b64encode(img.astype("<f4").tobytes()).decode()}
        except Exception as e:  # one unreadable exposure must not sink the rest
            log.warning("track frame skipped: %r", e)
            return None
        finally:
            prog["done"] += 1

    frames = [f for f in await asyncio.gather(*(one(c) for c in chosen)) if f is not None]
    scale = fov * 60 / timelapse.GRID
    return {
        "name": label, "query": name, "fov_arcmin": fov, "size": timelapse.GRID, "scale_arcsec": scale,
        "frames": frames,
        "seen": sum(f["seen"] for f in frames),
        "passes": [{"id": i, "start": timelapse.mjd_to_date(g[0]["mjd"]), "end": timelapse.mjd_to_date(g[-1]["mjd"]), "caught": len(g)}
                   for i, g in enumerate(passes)],
        "searched": {"days_on_record": len(path), "observable_days": len(observable), "searches": len(samples),
                     "candidates": len(candidates), "caught": len(caught)},
        "path": [{"mjd": d["mjd"], "ra": round(d["ra"], 5), "dec": round(d["dec"], 5)} for d in path[::2]],
        "source": "Positions: NASA JPL Horizons. Images: NASA SPHEREx level-2 exposures (IRSA).",
    }


def line(obj) -> bytes:
    return json.dumps(obj).encode() + b"\n"


@router.get("/api/track")
async def track(q: str = Query(..., min_length=1, max_length=80, description="asteroid or comet, as JPL Horizons knows it"),
                fov: float = Query(12.0, description="width of each frame, arcminutes")):
    if fov not in FOV_CHOICES:
        raise HTTPException(400, f"fov must be one of {FOV_CHOICES}")
    name = q.strip().removeprefix("asteroid:").strip()
    key = "trk_" + hashlib.sha1(f"{name.lower()}|{fov}|{TRACK_VERSION}".encode()).hexdigest()[:20]
    path = CACHE / f"{key}.json"

    async def stream():
        try:
            if time.time() - path.stat().st_mtime < TTL:
                yield await asyncio.to_thread(path.read_bytes) + b"\n"
                return
        except OSError:
            pass
        task = _jobs.get(key)
        if task is None:
            _progress[key] = {"stage": "Starting…", "done": 0, "total": 0}

            async def run():
                result = await build_track(key, name, fov)
                body = json.dumps({"result": result}).encode()
                if result["frames"]:
                    CACHE.mkdir(parents=True, exist_ok=True)
                    await asyncio.to_thread(tiles._atomic_write, path, body)
                return body

            task = _jobs[key] = asyncio.create_task(run())
            task.add_done_callback(lambda t: (_jobs.pop(key, None), t.cancelled() or t.exception()))
        sent_stage = sent_progress = None
        while not task.done():
            p = _progress.get(key, {})
            if p.get("stage") != sent_stage:
                sent_stage = p.get("stage")
                yield line({"stage": sent_stage})
            if p.get("total") and (p["done"], p["total"]) != sent_progress:
                sent_progress = (p["done"], p["total"])
                yield line({"progress": list(sent_progress)})
            await asyncio.sleep(0.2)
        try:
            yield task.result() + b"\n"
        except HTTPException as e:
            yield line({"error": e.detail})
        except Exception as e:
            log.warning("track failed: %r", e)
            yield line({"error": str(e) or type(e).__name__})

    return StreamingResponse(stream(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
