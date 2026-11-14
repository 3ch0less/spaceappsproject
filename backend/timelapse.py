"""SPHEREx time-lapse: how one patch of sky looked on each visit of the survey.

SPHEREx comes back to every spot about every six months ("a visit") and, during a visit,
photographs it roughly 20 times with each of its 6 detectors, each time through a slightly
different infrared colour. For a position and a detector this module

  1. asks IRSA which exposures cover the position            (image search, cached for a day)
  2. reads just the needed rows of each exposure              (HTTP range requests on NASA's
     public cloud copy of the level-2 images; ~0.5 MB instead of a 65 MB file)
  3. re-grids every exposure onto one north-up grid centred on the position
  4. combines the exposures of each visit into one clean image (median)
  5. measures the brightness at the position in every exposure (the spectrum / light curve)

and streams progress, then the result, as newline-delimited JSON:

    GET /api/timelapse?ra=..&dec=..&fov=6&det=2
      {"plan": {...}}                 which visits and exposures exist (all detectors)
      {"progress": [done, total]}     repeated while downloading
      {"result": {...}}               per-visit images + per-exposure photometry
      {"error": "..."}                instead of result if it could not be built

Results are cached on disk, so a repeat request answers at once.
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
import os
import time
import warnings
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

import tiles

log = logging.getLogger("lumasphere.timelapse")

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
# Data releases to search, most trusted first. Add the next release's collection name here
# (or in the environment) when IRSA publishes it.
COLLECTIONS = [c.strip() for c in os.environ.get("LUMASPHERE_SPHEREX_COLLECTIONS", "spherex_dr1,spherex_qr3").split(",") if c.strip()]
IRSA_BASE = "https://irsa.ipac.caltech.edu/"
CLOUD_BASE = os.environ.get("LUMASPHERE_SPHEREX_CLOUD", "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/").rstrip("/") + "/"
CACHE_DIR = tiles.CACHE_DIR / "timelapse"

NATIVE_ARCSEC = 6.15          # size of a SPHEREx detector pixel on the sky
GRID = 128                    # output images are GRID x GRID pixels
FOV_CHOICES = (3.0, 6.0, 12.0, 20.0)   # arcminutes
PLAN_TTL = 24 * 3600          # new exposures are published weekly
# A visit: the six detectors sweep over a spot within about 8 weeks, then nothing for ~4 months.
VISIT_GAP_DAYS = 60           # a pause this long starts a new visit
VISIT_MAX_DAYS = 100          # continuously observed fields (near the ecliptic poles) are cut into
VISIT_BIN_DAYS = 50           # chunks of about this length
MAX_PER_VISIT = 24            # exposures used per visit and detector
DOWNLOADS = 24                # parallel range requests
# Exposures worked on at once. Each needs two requests in a row (header, then rows); limiting
# whole exposures rather than single requests makes them finish one by one from the first
# second, instead of every header first and all the rows in a burst at the end. Measured
# downloads are bandwidth-bound (~6-12 MB/s to NASA's S3 copy), so more parallelism adds nothing.
EXPOSURES_AT_ONCE = 16
RESULT_TTL = 7 * 24 * 3600    # a finished time-lapse; new exposures are published weekly
RESULT_VERSION = 2            # bump when the result's contents change, so cached ones are rebuilt (2: halo)
APERTURE_ARCSEC = 12.0        # brightness is summed inside this radius...
ANNULUS_ARCSEC = (24.0, 40.0) # ...after subtracting the sky level measured in this ring
HALO_ARCSEC = (15.0, 30.0)    # saturated stars: their glow is measured in this ring instead...
HALO_SKY_ARCSEC = (60.0, 85.0) # ...against the sky out here, clear of the glow (fits in the 3' view)
MJD0 = datetime(1858, 11, 17)

router = APIRouter()
_client: httpx.AsyncClient | None = None
_slots = asyncio.Semaphore(DOWNLOADS)
_exposure_slots = asyncio.Semaphore(EXPOSURES_AT_ONCE)
_jobs: dict[str, "Job"] = {}
_wave_tables: dict[int, dict] = {}
_plan_memory: dict[str, tuple[float, dict]] = {}


async def start() -> None:
    global _client
    _client = httpx.AsyncClient(
        limits=httpx.Limits(max_connections=DOWNLOADS + 8, max_keepalive_connections=DOWNLOADS + 8, keepalive_expiry=60),
        timeout=httpx.Timeout(40, connect=8),
        headers={"User-Agent": "Lumasphere-timelapse/1.0"},
        follow_redirects=True,
    )
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


async def stop() -> None:
    for job in list(_jobs.values()):
        job.task.cancel()
    if _client:
        await _client.aclose()


def mjd_to_date(mjd: float) -> str:
    return (MJD0 + timedelta(days=mjd)).strftime("%Y-%m-%d")


# ---------------------------------------------------------------- 1. which exposures exist

async def find_exposures(ra: float, dec: float) -> list[tuple[int, str, float, str]]:
    """(release rank, file path, time, detector band) of every exposure covering the position.
    IRSA's image search (SIA) answers in 2-3 s; its catalog service (TAP) knows the same
    things, takes 5-15 s, and is the fallback."""

    async def sia(rank: int, collection: str):
        r = await _client.get(SIA_URL, params={"COLLECTION": collection, "POS": f"circle {ra:.6f} {dec:.6f} 0.0001",
                                               "RESPONSEFORMAT": "CSV"}, timeout=40)
        r.raise_for_status()
        return [(rank, row["access_url"].split("irsa.ipac.caltech.edu/", 1)[-1], float(row["t_min"]), row["energy_bandpassname"])
                for row in csv.DictReader(io.StringIO(r.text)) if row.get("access_url") and row.get("t_min")]

    try:
        found = await asyncio.gather(*(sia(i, c) for i, c in enumerate(COLLECTIONS)))
        rows = [row for part in found for row in part]
        if rows:
            return rows
    except (httpx.HTTPError, KeyError, ValueError) as e:
        log.warning("image search failed, falling back to the catalog service: %r", e)

    r = await _client.get(TAP_URL, timeout=90, params={"FORMAT": "csv", "QUERY": (
        "SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname "
        "FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid "
        f"WHERE 1 = CONTAINS(POINT('ICRS', {ra:.6f}, {dec:.6f}), p.poly)")})
    if r.status_code != 200:
        raise RuntimeError(f"the SPHEREx archive search failed (HTTP {r.status_code})")
    releases = [c.split("_", 1)[-1] for c in COLLECTIONS]
    out = []
    for row in csv.DictReader(io.StringIO(r.text)):
        release = row["uri"].split("/")[3] if row["uri"].startswith("ibe/data/spherex/") else ""
        out.append((releases.index(release) if release in releases else 9, row["uri"], float(row["time_bounds_lower"]), row["energy_bandpassname"] or ""))
    return out


def split_visits(times: list[float]) -> list[tuple[float, float]]:
    """Group sorted exposure times into visits: (start, end) pairs."""
    if not times:
        return []
    groups = [[times[0], times[0]]]
    for t in times[1:]:
        if t - groups[-1][1] > VISIT_GAP_DAYS:
            groups.append([t, t])
        else:
            groups[-1][1] = t
    visits = []
    for start, end in groups:
        span = end - start
        if span <= VISIT_MAX_DAYS:
            visits.append((start, end))
            continue
        pieces = math.ceil(span / VISIT_BIN_DAYS)
        step = span / pieces
        for i in range(pieces):
            visits.append((start + i * step, start + (i + 1) * step if i < pieces - 1 else end))
    return visits


async def get_plan(ra: float, dec: float) -> dict:
    key = f"{ra:.4f}_{dec:+.4f}"
    hit = _plan_memory.get(key)
    if hit and time.time() - hit[0] < PLAN_TTL:
        return hit[1]
    path = CACHE_DIR / f"plan_{key}.json"
    try:
        if time.time() - path.stat().st_mtime < PLAN_TTL:
            plan = json.loads(path.read_text())
            _plan_memory[key] = (path.stat().st_mtime, plan)
            return plan
    except (OSError, ValueError):
        pass

    rows = await find_exposures(ra, dec)
    best: dict[str, dict] = {}
    for rank, uri, mjd, band in rows:
        if "/level2/" not in uri or not uri.endswith(".fits") or not band[-1:].isdigit():
            continue
        # .../level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits -> the exposure's own name
        name = uri.rsplit("/", 1)[1].split("_spx")[0]
        cand = {"uri": uri, "mjd": mjd, "det": int(band[-1]), "rank": rank}
        if name not in best or cand["rank"] < best[name]["rank"]:  # same exposure in two releases
            best[name] = cand
    exposures = sorted(best.values(), key=lambda e: e["mjd"])
    visits = split_visits([e["mjd"] for e in exposures])
    for e in exposures:
        e["visit"] = next(i for i, (a, b) in enumerate(visits) if a <= e["mjd"] <= b + 1e-9)
        del e["rank"]
    plan = {
        "exposures": exposures,
        "visits": [
            {
                "id": i, "mjd_start": a, "mjd_end": b, "date_start": mjd_to_date(a), "date_end": mjd_to_date(b),
                "counts": {str(d): sum(1 for e in exposures if e["visit"] == i and e["det"] == d) for d in range(1, 7)},
            }
            for i, (a, b) in enumerate(visits)
        ],
        "detectors": {str(d): sum(1 for e in exposures if e["det"] == d) for d in range(1, 7)},
    }
    await asyncio.to_thread(tiles._atomic_write, path, json.dumps(plan).encode())
    _plan_memory[key] = (time.time(), plan)
    return plan


def public_plan(plan: dict) -> dict:
    """The plan without internal file paths: enough for the timeline."""
    return {
        "visits": plan["visits"],
        "detectors": plan["detectors"],
        "times": {str(d): [round(e["mjd"], 3) for e in plan["exposures"] if e["det"] == d] for d in range(1, 7)},
    }


# ---------------------------------------------------------------- 2. reading part of an exposure

async def read_range(uri: str, spec: str) -> bytes:
    """Bytes of a level-2 file; NASA's cloud copy first, IRSA itself as the fallback."""
    cloud = CLOUD_BASE + uri.split("ibe/data/spherex/", 1)[-1]
    last = None
    for url in (cloud, cloud, IRSA_BASE + uri):
        try:
            async with _slots:
                r = await _client.get(url, headers={"Range": f"bytes={spec}"})
            if r.status_code in (200, 206):
                return r.content
            last = f"HTTP {r.status_code}"
        except httpx.HTTPError as e:
            last = repr(e)
        await asyncio.sleep(0.3)
    raise RuntimeError(f"could not read {uri.rsplit('/', 1)[-1]}: {last}")


async def wavelength_table(det: int, uri: str) -> dict:
    """Every detector sits behind a filter whose colour changes across it. Each file ends with a
    small 9x9 table of (wavelength, bandwidth) over the detector; it is fixed per detector."""
    if det in _wave_tables:
        return _wave_tables[det]
    path = CACHE_DIR / f"wavelengths_d{det}.json"
    try:
        table = json.loads(path.read_text())
    except (OSError, ValueError):
        tail = await read_range(uri, "-11520")
        start = tail.rfind(b"XTENSION= 'BINTABLE'")
        if start < 0:
            raise RuntimeError("wavelength table not found")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            data = fits.BinTableHDU.fromstring(tail[start:]).data
        table = {"x": data["X"][0].tolist(), "y": data["Y"][0].tolist(), "values": data["VALUES"][0].tolist()}
        await asyncio.to_thread(tiles._atomic_write, path, json.dumps(table).encode())
    _wave_tables[det] = table
    return table


def wavelength_at(table: dict, x: float, y: float) -> tuple[float, float]:
    """(wavelength, bandwidth) in microns at detector pixel (x, y), 1-based like the table."""
    xs, ys, values = np.asarray(table["x"], float), np.asarray(table["y"], float), np.asarray(table["values"], float)
    ix = int(np.clip(np.searchsorted(xs, x) - 1, 0, len(xs) - 2))
    iy = int(np.clip(np.searchsorted(ys, y) - 1, 0, len(ys) - 2))
    fx = (x - xs[ix]) / (xs[ix + 1] - xs[ix])
    fy = (y - ys[iy]) / (ys[iy + 1] - ys[iy])
    v = (values[iy, ix] * (1 - fx) * (1 - fy) + values[iy, ix + 1] * fx * (1 - fy)
         + values[iy + 1, ix] * (1 - fx) * fy + values[iy + 1, ix + 1] * fx * fy)
    return float(v[0]), float(v[1])


# ---------------------------------------------------------------- 3. re-gridding

def sky_grid(ra0: float, dec0: float, fov_arcmin: float, size: int = GRID) -> tuple[np.ndarray, np.ndarray, float]:
    """RA/Dec of every output pixel: north up, east left, tangent-plane projection."""
    scale = fov_arcmin * 60 / size
    half = (size - 1) / 2
    j, i = np.mgrid[0:size, 0:size]
    xi = -(i - half) * scale / 206264.806
    eta = (half - j) * scale / 206264.806
    r0, d0 = math.radians(ra0), math.radians(dec0)
    den = math.cos(d0) - eta * math.sin(d0)
    ra = r0 + np.arctan2(xi, den)
    dec = np.arctan2(math.sin(d0) + eta * math.cos(d0), np.hypot(xi, den))
    return np.degrees(ra) % 360, np.degrees(dec), scale


def bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    ny, nx = img.shape
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    inside = (x0 >= 0) & (y0 >= 0) & (x0 < nx - 1) & (y0 < ny - 1)
    x0c, y0c = np.clip(x0, 0, nx - 2), np.clip(y0, 0, ny - 2)
    fx, fy = x - x0c, y - y0c
    v = (img[y0c, x0c] * (1 - fx) * (1 - fy) + img[y0c, x0c + 1] * fx * (1 - fy)
         + img[y0c + 1, x0c] * (1 - fx) * fy + img[y0c + 1, x0c + 1] * fx * fy)
    return np.where(inside, v, np.nan).astype(np.float32)


def locate(header_bytes: bytes, ra: float, dec: float, fov_arcmin: float):
    """From the start of a file: its sky mapping, where our position falls, which rows we need."""
    end = header_bytes.find(b"END" + b" " * 77, 2880)
    if end < 0:
        raise RuntimeError("image header longer than expected")
    data_start = (end // 2880 + 1) * 2880
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        header = fits.Header.fromstring(header_bytes[2880:data_start])
        wcs = WCS(header)
        px, py = (float(v) for v in wcs.all_world2pix(ra, dec, 0, quiet=True))
    nx, ny = int(header["NAXIS1"]), int(header["NAXIS2"])
    if not (0 <= px < nx and 0 <= py < ny) or int(header.get("BITPIX", 0)) != -32:
        return None
    reach = int(fov_arcmin * 60 / NATIVE_ARCSEC / 2 * 1.45) + 3  # the patch may be rotated on the detector
    y0, y1 = max(0, int(py) - reach), min(ny, int(py) + reach + 1)
    return {
        "wcs": wcs, "px": px, "py": py, "nx": nx, "y0": y0, "y1": y1,
        "byte_range": f"{data_start + y0 * nx * 4}-{data_start + y1 * nx * 4 - 1}",
        "mjd": float(header.get("MJD-AVG") or header.get("MJD-OBS")),
    }


def regrid(raw: bytes, where: dict, gra: np.ndarray, gdec: np.ndarray) -> np.ndarray:
    rows = np.frombuffer(raw, dtype=">f4").reshape(where["y1"] - where["y0"], where["nx"]).astype(np.float32)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        x, y = where["wcs"].all_world2pix(gra.ravel(), gdec.ravel(), 0, quiet=True)
    return bilinear(rows, x, y - where["y0"]).reshape(gra.shape)


async def fetch_exposure(exp: dict, ra: float, dec: float, fov: float, gra, gdec) -> dict | None:
    head = await read_range(exp["uri"], "0-31679")
    where = await asyncio.to_thread(locate, head, ra, dec, fov)
    if where is None:
        return None
    raw = await read_range(exp["uri"], where["byte_range"])
    image = await asyncio.to_thread(regrid, raw, where, gra, gdec)
    if np.isfinite(image).mean() < 0.5:
        return None  # the position is too close to the edge of this exposure
    table = await wavelength_table(exp["det"], exp["uri"])
    wl, bw = wavelength_at(table, where["px"] + 1, where["py"] + 1)
    return {"mjd": where["mjd"], "visit": exp["visit"], "wl": wl, "bw": bw, "image": image}


# ---------------------------------------------------------------- 4 + 5. stacking and photometry

def fill_saturated(image: np.ndarray, bright: float) -> np.ndarray:
    """Very bright stars saturate the detector and come back as holes. Fill a hole that is
    surrounded by bright pixels with that brightness so the star looks like a star."""
    out = image.copy()
    for _ in range(4):
        holes = ~np.isfinite(out)
        if not holes.any():
            break
        padded = np.pad(out, 1, constant_values=np.nan)
        neighbours = np.stack([padded[1 + dy : 1 + dy + out.shape[0], 1 + dx : 1 + dx + out.shape[1]]
                               for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dy, dx) != (0, 0)])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            peak = np.nanmax(neighbours, axis=0)
        fill = holes & np.isfinite(peak) & (peak >= bright)
        if not fill.any():
            break
        out[fill] = peak[fill]
    return out


def build(ra: float, dec: float, fov: float, det: int, scale: float, shots: list[dict], plan: dict) -> dict:
    """Turn the re-gridded exposures of one detector into per-visit images and photometry."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for s in shots:
            s["image"] = s["image"] - np.nanmedian(s["image"])  # remove the sky glow, which changes with the seasons

        yy, xx = np.mgrid[0:GRID, 0:GRID]
        half = (GRID - 1) / 2
        visits_out, stacks = [], {}
        for visit in plan["visits"]:
            group = [s for s in shots if s["visit"] == visit["id"]]
            if not group:
                continue
            cube = np.stack([s["image"] for s in group])
            stack = np.nanmedian(cube, axis=0) if len(group) >= 3 else np.nanmean(cube, axis=0)
            stacks[visit["id"]] = (stack, group)

        finite = np.concatenate([s[np.isfinite(s)] for s, _ in stacks.values()]) if stacks else np.array([0.0])
        median = float(np.median(finite))
        noise = float(1.4826 * np.median(np.abs(finite - median))) or 1e-6
        lo = median - 1.5 * noise
        hi = max(float(np.percentile(finite, 99.8)), lo + 12 * noise)

        exposures_out = []
        pixel_sr = (scale / 206264.806) ** 2
        for vid, (stack, group) in stacks.items():
            stack = fill_saturated(stack, lo + 0.5 * (hi - lo))
            # Where is the source in this visit? (a fast star is not exactly at the requested position)
            search = np.hypot(xx - half, yy - half) <= APERTURE_ARCSEC / scale
            cy, cx = half, half
            candidates = np.where(search & np.isfinite(stack), stack, -np.inf)
            if np.isfinite(candidates.max()) and candidates.max() > median + 5 * noise:
                cy, cx = (float(v) for v in np.unravel_index(int(np.argmax(candidates)), stack.shape))
            radius = np.hypot(xx - cx, yy - cy) * scale
            aperture = radius <= APERTURE_ARCSEC
            ring = (radius >= ANNULUS_ARCSEC[0]) & (radius <= ANNULUS_ARCSEC[1])
            halo_ring = (radius >= HALO_ARCSEC[0]) & (radius <= HALO_ARCSEC[1])
            far_ring = (radius >= HALO_SKY_ARCSEC[0]) & (radius <= HALO_SKY_ARCSEC[1])
            for s in group:
                img = s["image"]
                flux = err = halo = None
                if np.isfinite(img[aperture]).all() and np.isfinite(img[ring]).sum() > 20:
                    sky = float(np.nanmedian(img[ring]))
                    sigma = float(1.4826 * np.nanmedian(np.abs(img[ring] - sky)))
                    flux = float((img[aperture] - sky).sum() * pixel_sr * 1e9)        # MJy/sr -> mJy
                    err = float(sigma * math.sqrt(aperture.sum()) * pixel_sr * 1e9)
                elif np.isfinite(img[halo_ring]).mean() > 0.6 and np.isfinite(img[far_ring]).sum() > 20:
                    # Saturated: the detector gave up at the star's core, so there is no total to add
                    # up. The glow around the core scales with the star's brightness, so its average
                    # level (in MJy/sr) still says how much brighter or fainter the star got.
                    halo = float(np.nanmean(img[halo_ring]) - np.nanmedian(img[far_ring]))
                exposures_out.append({
                    "mjd": round(s["mjd"], 4), "visit": vid, "wl": round(s["wl"], 4), "bw": round(s["bw"], 4),
                    "flux": None if flux is None else round(flux, 4), "err": None if err is None else round(err, 4),
                    "halo": None if halo is None else round(halo, 4),
                })
            mjds = [s["mjd"] for s in group]
            visits_out.append({
                "id": vid, "mjd": float(np.mean(mjds)), "mjd_start": min(mjds), "mjd_end": max(mjds),
                "date": mjd_to_date(float(np.mean(mjds))), "n": len(group),
                "source_offset_arcsec": [round(-(cx - half) * scale, 2), round((half - cy) * scale, 2)],  # east, north
                "image": base64.b64encode(stack.astype("<f4").tobytes()).decode(),
            })

    wls = [e["wl"] for e in exposures_out]
    return {
        "ra": ra, "dec": dec, "fov_arcmin": fov, "size": GRID, "scale_arcsec": scale, "detector": det,
        "band_um": [round(min(wls), 3), round(max(wls), 3)] if wls else None,
        "range": {"lo": lo, "hi": hi, "noise": noise},
        "visits": visits_out,
        "exposures": sorted(exposures_out, key=lambda e: e["mjd"]),
        "aperture_arcsec": APERTURE_ARCSEC,
        "source": "NASA SPHEREx level-2 spectral images (IRSA)",
    }


# ---------------------------------------------------------------- jobs

class Job:
    """One time-lapse being built; several browsers asking for the same one share it."""

    def __init__(self, key: str, coro) -> None:
        self.key, self.done, self.total, self.plan, self.waiters = key, 0, 0, None, 0
        self.task = asyncio.create_task(coro(self))
        self.task.add_done_callback(lambda t: (_jobs.pop(key, None), t.cancelled() or t.exception()))


def result_path(key: str) -> Path:
    return CACHE_DIR / f"{key}.json"


async def run_job(job: Job, ra: float, dec: float, fov: float, det: int) -> bytes:
    plan = await get_plan(ra, dec)
    job.plan = public_plan(plan)
    chosen = []
    for visit in plan["visits"]:
        group = [e for e in plan["exposures"] if e["det"] == det and e["visit"] == visit["id"]]
        if len(group) > MAX_PER_VISIT:  # deep fields have hundreds per visit: take an even sample
            picks = np.linspace(0, len(group) - 1, MAX_PER_VISIT).round().astype(int)
            group = [group[i] for i in picks]
        chosen += group
    job.total = len(chosen)
    gra, gdec, scale = sky_grid(ra, dec, fov)

    async def one(exp):
        try:
            async with _exposure_slots:  # in visit order: the first visit's exposures finish first
                return await fetch_exposure(exp, ra, dec, fov, gra, gdec)
        except Exception as e:  # one unreadable exposure must not sink the whole time-lapse
            log.warning("exposure skipped: %r", e)
            return None
        finally:
            job.done += 1

    shots = [s for s in await asyncio.gather(*(one(e) for e in chosen)) if s is not None]
    if chosen and not shots:
        raise RuntimeError("none of the exposures could be read from the archive")
    result = await asyncio.to_thread(build, ra, dec, fov, det, scale, shots, plan)
    result["plan"] = job.plan
    body = json.dumps({"result": result}).encode()
    await asyncio.to_thread(tiles._atomic_write, result_path(job.key), body)
    return body


def line(obj) -> bytes:
    return json.dumps(obj).encode() + b"\n"


@router.get("/api/timelapse")
async def timelapse(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    fov: float = Query(6.0, description="field of view in arcminutes"),
    det: int = Query(2, ge=1, le=6, description="SPHEREx detector 1-6"),
):
    if fov not in FOV_CHOICES:
        raise HTTPException(400, f"fov must be one of {FOV_CHOICES}")
    ra, dec = round(ra, 5), round(dec, 5)
    key = "tl_" + hashlib.sha1(f"{ra:.5f}|{dec:.5f}|{fov}|{det}|{GRID}|{RESULT_VERSION}".encode()).hexdigest()[:20]

    async def stream():
        path = result_path(key)
        try:
            if time.time() - path.stat().st_mtime < RESULT_TTL:
                yield await asyncio.to_thread(path.read_bytes) + b"\n"
                return
        except OSError:
            pass
        job = _jobs.get(key)
        if job is None:
            job = _jobs[key] = Job(key, lambda j: run_job(j, ra, dec, fov, det))
        job.waiters += 1
        try:
            sent_plan, last = False, None
            while not job.task.done():
                if job.plan is not None and not sent_plan:
                    sent_plan = True
                    yield line({"plan": job.plan})
                if (job.done, job.total) != last and job.total:
                    last = (job.done, job.total)
                    yield line({"progress": list(last)})
                await asyncio.sleep(0.15)
            try:
                yield job.task.result() + b"\n"
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("time-lapse failed: %r", e)
                yield line({"error": str(e) or type(e).__name__})
        finally:
            job.waiters -= 1
            if job.waiters <= 0 and not job.task.done():
                job.task.cancel()  # nobody is waiting any more (the user moved on)

    return StreamingResponse(stream(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
