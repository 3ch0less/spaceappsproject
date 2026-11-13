"""SkyShift backend.

Serves the frontend, the sky tiles and a small JSON API:
  GET /api/resolve?q=<anything>   -> where is it on the sky + what is it
  GET /api/survey                 -> wavelengths, tile URL and release of the SPHEREx map
  GET /hips/<version>/<frame>/... -> the sky tiles themselves, cached on disk (see tiles.py)

Resolution order:
  1. Coordinates ("269.45 4.69", "17:57:48.5 +04:41:36", "08h55m10.8s -07d14m42s")
  2. Planets / Moon / Pluto      -> JPL Horizons (moves, so we also return its path)
  3. Stars, galaxies, nebulae... -> CDS Sesame (SIMBAD/NED/VizieR name resolver)
  4. Asteroids / comets          -> JPL Horizons small-body lookup

Run:  uvicorn main:app --reload --port 8000   (from the backend/ folder)
"""

from __future__ import annotations

import asyncio
import csv
import io
import math
import re
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import httpx
from astropy import units as u
from astropy.coordinates import SkyCoord
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import tiles

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

# Sesame mirrors, tried in order (the main CDS URL redirects to a mirror that is sometimes slow).
SESAME_MIRRORS = [
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oI/SNV?",
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?",
]
HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"

# Time span covered by the SPHEREx all-sky HiPS. These are only the fallback: the real values
# are read from the survey's properties file (t_min/t_max), so a new release updates them.
SPHEREX_START = "2025-04-24"
SPHEREX_END = "2026-05-14"
SPHEREX_MID_YEAR = 2025.84  # middle of that span, used to move fast stars to where SPHEREx saw them


def survey_span() -> tuple[str, str, float]:
    s = tiles.store._survey
    dates = s.date_range() if s else None
    if not dates:
        return SPHEREX_START, SPHEREX_END, SPHEREX_MID_YEAR
    return dates[0], dates[1], round(s.mid_year(), 2)

MAJOR_BODIES = {
    "sun": ("10", "Sun"),
    "mercury": ("199", "Mercury"),
    "venus": ("299", "Venus"),
    "moon": ("301", "Moon"),
    "mars": ("499", "Mars"),
    "jupiter": ("599", "Jupiter"),
    "saturn": ("699", "Saturn"),
    "uranus": ("799", "Uranus"),
    "neptune": ("899", "Neptune"),
    "pluto": ("999", "Pluto"),
}

# Friendly names for common SIMBAD object types.
OTYPE_LABELS = {
    "*": "Star",
    "**": "Double or multiple star",
    "PM*": "Fast-moving (high proper motion) star",
    "BY*": "Variable star (spotted red dwarf)",
    "BD*": "Brown dwarf",
    "BD?": "Brown dwarf candidate",
    "TT*": "Young variable star (T Tauri type)",
    "Or*": "Young variable star",
    "Y*O": "Very young star",
    "Mi*": "Pulsating giant star (Mira variable)",
    "LP*": "Long-period variable star",
    "V*": "Variable star",
    "RG*": "Red giant star",
    "WD*": "White dwarf",
    "C*": "Carbon star",
    "SN*": "Supernova",
    "Pl": "Exoplanet",
    "G": "Galaxy",
    "GiG": "Galaxy in a group",
    "SyG": "Seyfert galaxy (active center)",
    "AGN": "Active galactic nucleus",
    "QSO": "Quasar",
    "PN": "Planetary nebula",
    "HII": "Glowing gas cloud (HII region)",
    "RNe": "Reflection nebula",
    "SNR": "Supernova remnant",
    "MoC": "Molecular cloud",
    "DNe": "Dark nebula",
    "Cl*": "Star cluster",
    "OpC": "Open star cluster",
    "GlC": "Globular star cluster",
    "As*": "Group of stars",
    "X": "X-ray source",
}

http: httpx.AsyncClient  # one shared connection pool for the name resolvers (SIMBAD, Horizons)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global http
    http = httpx.AsyncClient(timeout=25, headers={"User-Agent": "SkyShift/1.0"})
    await tiles.store.start()
    try:
        yield
    finally:
        await tiles.store.stop()
        await http.aclose()


app = FastAPI(title="SkyShift API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])
app.include_router(tiles.router)


class ResolveCache:
    """Small in-memory cache for /api/resolve. Things that move (planets, asteroids) are kept
    for 10 minutes, fixed stars and galaxies for a day, failed lookups for a minute."""

    MOVING, FIXED, NOT_FOUND, MAX_ITEMS = 600, 86400, 60, 2000

    def __init__(self) -> None:
        self._items: OrderedDict[str, tuple[float, dict | None]] = OrderedDict()
        self._pending: dict[str, asyncio.Task] = {}

    def get(self, key: str):
        hit = self._items.get(key)
        if hit is None:
            return None
        if time.time() > hit[0]:
            del self._items[key]
            return None
        self._items.move_to_end(key)
        return hit

    def put(self, key: str, result: dict | None) -> None:
        ttl = self.NOT_FOUND if result is None else self.MOVING if result.get("moving") else self.FIXED
        self._items[key] = (time.time() + ttl, result)
        self._items.move_to_end(key)
        while len(self._items) > self.MAX_ITEMS:
            self._items.popitem(last=False)


_cache = ResolveCache()


# ---------------------------------------------------------------- coordinates

_COORD_HINT = re.compile(r"^[\s0-9+\-.:hdms°'\"]+$", re.IGNORECASE)


def parse_coordinates(q: str) -> SkyCoord | None:
    text = q.strip().replace(",", " ")
    if not _COORD_HINT.match(text) or not re.search(r"\d", text):
        return None
    parts = text.split()
    try:
        if len(parts) == 2 and all(re.fullmatch(r"[+\-]?\d+(\.\d+)?", p) for p in parts):
            return SkyCoord(float(parts[0]) * u.deg, float(parts[1]) * u.deg, frame="icrs")
        return SkyCoord(text, unit=(u.hourangle, u.deg), frame="icrs")
    except Exception:
        return None


# ---------------------------------------------------------------- Sesame (SIMBAD etc.)

async def sesame(client: httpx.AsyncClient, name: str) -> dict | None:
    text = None
    for mirror in SESAME_MIRRORS:
        try:
            r = await client.get(mirror + quote(name), follow_redirects=True, timeout=8)
            r.raise_for_status()
            text = r.text
            break
        except httpx.HTTPError:
            continue
    if text is None:
        return None
    out: dict = {"aliases": []}
    for line in text.splitlines():
        if line.startswith("%J "):
            nums = line[3:].split("=")[0].split()
            out["ra"], out["dec"] = float(nums[0]), float(nums[1])
        elif line.startswith("%I.0 "):
            out["name"] = line[5:].replace("NAME ", "").strip()
        elif line.startswith("%C.0 "):
            out["otype"] = line[5:].strip()
        elif line.startswith("%P "):
            pm = line[3:].split()
            out["pm_ra_mas_yr"], out["pm_dec_mas_yr"] = float(pm[0]), float(pm[1])
        elif line.startswith("%X "):
            out["parallax_mas"] = float(line[3:].split()[0])
        elif line.startswith("%I "):
            out["aliases"].append(line[3:].strip())
    if "ra" not in out:
        return None

    otype = out.get("otype", "")
    out["kind"] = "deep-sky"
    out["type_label"] = OTYPE_LABELS.get(otype, f"Astronomical object (SIMBAD type {otype})" if otype else "Astronomical object")
    if "pm_ra_mas_yr" in out:
        total = (out["pm_ra_mas_yr"] ** 2 + out["pm_dec_mas_yr"] ** 2) ** 0.5
        out["pm_total_arcsec_yr"] = round(total / 1000, 3)
    plx = out.get("parallax_mas")
    if plx and plx > 0:
        out["distance_ly"] = round(1000 / plx * 3.26156, 2)

    # SIMBAD positions are for the year 2000. Fast stars have moved since then, so also
    # give where it should be in the SPHEREx images (mid-point of the survey).
    mid_year = survey_span()[2]
    if out.get("pm_total_arcsec_yr", 0) > 0.05:
        dt = mid_year - 2000.0
        cosd = max(1e-6, math.cos(math.radians(out["dec"])))
        out["catalog_ra"], out["catalog_dec"], out["catalog_epoch"] = out["ra"], out["dec"], 2000.0
        out["ra"] = (out["ra"] + out["pm_ra_mas_yr"] * dt / 3.6e6 / cosd) % 360
        out["dec"] = out["dec"] + out["pm_dec_mas_yr"] * dt / 3.6e6
        out["epoch"] = mid_year
        out["moved_arcsec_since_catalog"] = round(out["pm_total_arcsec_yr"] * dt, 1)
    out["source"] = "CDS Sesame / SIMBAD"
    return out


# ---------------------------------------------------------------- JPL Horizons

async def horizons_positions(client: httpx.AsyncClient, command: str, start: str, stop: str, step: str):
    params = {
        "format": "json",
        "COMMAND": f"'{command}'",
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "OBSERVER",
        "CENTER": "'500@399'",  # geocenter
        "START_TIME": f"'{start}'",
        "STOP_TIME": f"'{stop}'",
        "STEP_SIZE": f"'{step}'",
        "QUANTITIES": "'1'",  # astrometric RA/Dec
        "ANG_FORMAT": "DEG",
        "CSV_FORMAT": "YES",
    }
    r = await client.get(HORIZONS_URL, params=params)
    r.raise_for_status()
    result = r.json().get("result", "")
    if "$$SOE" not in result:
        return None, result
    body = result.split("$$SOE")[1].split("$$EOE")[0]
    points = []
    for row in csv.reader(io.StringIO(body.strip())):
        cells = [c.strip() for c in row]
        nums = []
        for c in cells[1:]:
            try:
                nums.append(float(c))
            except ValueError:
                pass
        if len(nums) >= 2:
            points.append({"date": cells[0], "ra": nums[0], "dec": nums[1]})
    header = re.search(r"Target body name:\s*(.+?)\s{2,}", result)
    return points, (header.group(1).strip() if header else command)


_MATCH_ROW = re.compile(r"^\s*(\d+)\s+(-?\d+)?\s+(\S.*?)\s{2,}(.*)$")


def pick_from_matches(listing: str) -> str | None:
    """Horizons returns a table when a name matches several bodies (e.g. every
    apparition of comet Halley). Pick a sensible one and return a new COMMAND."""
    if "Matching small-bodies" not in listing:
        return None
    rows = [m.groups() for line in listing.splitlines() if (m := _MATCH_ROW.match(line))]
    comets = [r for r in rows if int(r[0]) >= 90_000_000]
    if comets:
        # "CAP" = the apparition closest to today.
        return f"DES={comets[-1][2].strip()};CAP;"
    if rows:
        return f"{rows[0][0]};"
    return None


async def solar_system(client: httpx.AsyncClient, command: str, kind: str, label: str) -> dict | None:
    now = datetime.now(timezone.utc)
    today, tomorrow = now.strftime("%Y-%m-%d %H:%M"), (now + timedelta(days=1)).strftime("%Y-%m-%d %H:%M")
    start, end, _ = survey_span()

    async def both(cmd: str):
        # Position today and the path during the survey, asked for at the same time.
        (points, found_name), (track, _) = await asyncio.gather(
            horizons_positions(client, cmd, today, tomorrow, "1d"),
            horizons_positions(client, cmd, start, end, "4d"),
        )
        return points, found_name, track

    points_now, name, path = await both(command)
    if not points_now and (retry := pick_from_matches(name)):
        command = retry
        points_now, name, path = await both(command)
    if not points_now:
        return None
    if name.startswith("DES=") or name.endswith(";"):
        name = name.removeprefix("DES=").split(";")[0]
    if command.startswith("DES=") or "(" in name and "/" in name:
        label = "Comet"
    return {
        "name": name,
        "ra": points_now[0]["ra"],
        "dec": points_now[0]["dec"],
        "kind": kind,
        "type_label": label,
        "moving": True,
        "position_date": points_now[0]["date"],
        "path": path or [],
        "path_label": f"Its path across the sky while SPHEREx was mapping ({start} to {end})",
        "source": "NASA JPL Horizons",
    }


# ---------------------------------------------------------------- API

async def lookup(q: str) -> dict | None:
    coord = parse_coordinates(q)
    if coord is not None:
        return {
            "name": q,
            "ra": coord.ra.deg,
            "dec": coord.dec.deg,
            "kind": "coordinates",
            "type_label": "Sky position",
            "source": "coordinates",
        }
    key = q.lower()
    result = None
    if key in MAJOR_BODIES:
        cmd, label = MAJOR_BODIES[key]
        result = await solar_system(http, cmd, "planet", "Planet" if key not in ("sun", "moon", "pluto") else label)
    if result is None:
        result = await sesame(http, q)
    if result is None:
        # Asteroid / comet: trailing ';' tells Horizons to search small bodies.
        result = await solar_system(http, f"{q};", "small-body", "Asteroid")
    return result


@app.get("/api/resolve")
async def resolve(q: str = Query(..., min_length=1, max_length=120)):
    q = q.strip()
    key = q.lower()
    hit = _cache.get(key)
    if hit is None:
        # Two people (or a double click) asking for the same thing share one lookup.
        task = _cache._pending.get(key)
        if task is None:
            task = asyncio.create_task(lookup(q))
            _cache._pending[key] = task
            task.add_done_callback(lambda t: (_cache._pending.pop(key, None), t.cancelled() or t.exception()))
        try:
            result = await asyncio.shield(task)
        except httpx.HTTPError as e:
            raise HTTPException(502, "The catalog services (SIMBAD / JPL Horizons) did not answer. Try again in a moment.") from e
        _cache.put(key, result)
    else:
        result = hit[1]
    if result is None:
        raise HTTPException(404, f"Couldn't find \"{q}\". Try a star name, planet, asteroid, or coordinates.")
    return result


@app.get("/api/health")
def health():
    return {"ok": True}


class Frontend(StaticFiles):
    # We change the frontend constantly during the hackathon: browsers must re-check it
    # (cheap: an unchanged file is answered with "304 Not Modified").
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# Frontend (mounted last so /api and /hips routes win).
app.mount("/", Frontend(directory=FRONTEND_DIR, html=True), name="frontend")
