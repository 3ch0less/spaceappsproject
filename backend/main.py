"""Lumasphere backend.

Serves the frontend, the sky tiles and a small JSON API:
  GET /api/resolve?q=<anything>   -> where is it on the sky + what is it
  GET /api/survey                 -> wavelengths, tile URL and release of the SPHEREx map
  GET /hips/<version>/<frame>/... -> the sky tiles themselves, cached on disk (see tiles.py)
  GET /api/timelapse?ra=&dec=...  -> the same patch on each SPHEREx visit (see timelapse.py)
  GET /api/identify?ra=&dec=      -> what is at this spot (click on the map)
  GET /api/names/<level>/<band>/<cell> -> the best-known SIMBAD objects in one cell of the name grid ("Names" switch)
  GET /api/gaia?ra=&dec=&radius=  -> Gaia DR3 stars around a position ("Gaia stars" switches)
  GET /api/asteroids?ra=&dec=&radius=&date= -> known asteroids there on that date (see asteroids.py)
  GET /api/asteroid-suggest?q=    -> asteroid / comet names for the search box

Resolution order:
  1. Coordinates ("269.45 4.69", "17:57:48.5 +04:41:36", "08h55m10.8s -07d14m42s", "RA 269.45 Dec 4.69")
  2. Planets / Moon / Pluto      -> JPL Horizons (moves, so we also return its path)
  3. Stars, galaxies, nebulae... -> CDS Sesame (SIMBAD/NED/VizieR name resolver)
  4. Asteroids / comets          -> JPL Horizons small-body lookup

Run:  uvicorn main:app --reload --port 8000   (from the backend/ folder)
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
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
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import asteroids
import tiles
import timelapse
import track

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

# Sesame mirrors, tried in order (the main CDS URL redirects to a mirror that is sometimes slow).
SESAME_MIRRORS = [
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oI/SNV?",
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?",
]
HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
# SIMBAD's query service, tried side by side (Strasbourg is the original, Harvard the mirror).
SIMBAD_TAP = [
    "https://simbad.cds.unistra.fr/simbad/sim-tap/sync",
    "https://simbad.harvard.edu/simbad/sim-tap/sync",
]
# Gaia DR3: ESA's own archive first, IRSA's copy as the fallback.
GAIA_TAP = [
    ("https://gea.esac.esa.int/tap-server/tap/sync", "gaiadr3.gaia_source"),
    ("https://irsa.ipac.caltech.edu/TAP/sync", "gaia_dr3_source"),
]
GAIA_EPOCH = 2016.0  # Gaia DR3 positions are for this year

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
    http = httpx.AsyncClient(timeout=25, headers={"User-Agent": "Lumasphere/1.0"})
    await tiles.store.start()
    await timelapse.start()
    await asteroids.start()
    fast_stars.start()
    warm = asyncio.create_task(warm_connections())
    try:
        yield
    finally:
        warm.cancel()
        await asteroids.stop()
        await timelapse.stop()
        await tiles.store.stop()
        await http.aclose()


async def warm_connections() -> None:
    """Open the connections a map click needs while nobody is waiting: setting one up takes
    1-2 s, which otherwise lands on the first click after a restart."""
    probes = [http.get(SIMBAD_TAP[1], params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv",
                                              "QUERY": "SELECT TOP 1 main_id FROM basic"}, timeout=15),
              http.get(VIZIER_GAIA, params={"-source": "I/355/gaiadr3", "-c": "0 +0", "-c.rs": "1", "-out.max": "1"}, timeout=15),
              http.get(GAIA_TAP[0][0].rsplit("/", 1)[0] + "/availability", timeout=15)]
    await asyncio.gather(*probes, return_exceptions=True)


app = FastAPI(title="Lumasphere API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])
app.include_router(tiles.router)
app.include_router(timelapse.router)
app.include_router(asteroids.router)
app.include_router(track.router)


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
_TWO_NUMBERS = re.compile(r"^\s*([+\-]?\d+(?:\.\d+)?)[\s,]+([+\-]?\d+(?:\.\d+)?)\s*$")
# "RA 269.45 Dec 4.69", "ra=17:57:48 dec=+04:41:36", "α 269.45 δ 4.69": drop the labels.
_COORD_LABEL = re.compile(r"(?<![a-z])(?:right\s+ascension|r\.?a\.?|declination|decl?\.?|α|δ)(?![a-z])\s*[:=]?\s*", re.IGNORECASE)
# Typographic minus and prime marks (as copied from Wikipedia) -> the ASCII astropy reads.
_TYPOGRAPHY = str.maketrans({"−": "-", "–": "-", "′": "'", "″": '"', "’": "'", "”": '"'})


def normalize_coordinates(q: str) -> str:
    """Strip RA/Dec labels and fancy punctuation, so the result is plain coordinates if q was."""
    return _COORD_LABEL.sub(" ", q.translate(_TYPOGRAPHY)).strip()


def parse_coordinates(q: str) -> SkyCoord | None:
    text = normalize_coordinates(q).replace(",", " ")
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

def tidy_name(simbad_id: str) -> str:
    """SIMBAD writes "NAME Orion-KL", "* tet01 Ori C", "V* RW Aur", "M  42": keep just the name."""
    return re.sub(r"\s+", " ", re.sub(r"^(NAME|\*\*?|V\*) ", "", simbad_id.strip())).strip()


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
            out["name"] = tidy_name(line[5:])
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
    out["source"] = "CDS Sesame / SIMBAD"
    return describe(out)


def describe(out: dict, catalog_epoch: float = 2000.0) -> dict:
    """Turn raw catalog numbers (type code, proper motion, parallax) into what the info panel
    shows, and move fast stars from the catalog's year to where SPHEREx saw them."""
    otype = out.get("otype", "")
    out["kind"] = "deep-sky"
    out["type_label"] = OTYPE_LABELS.get(otype, f"Astronomical object (SIMBAD type {otype})" if otype else "Astronomical object")
    if "pm_ra_mas_yr" in out:
        total = (out["pm_ra_mas_yr"] ** 2 + out["pm_dec_mas_yr"] ** 2) ** 0.5
        out["pm_total_arcsec_yr"] = round(total / 1000, 3)
    plx = out.get("parallax_mas")
    if plx and plx > 0.2:  # smaller parallaxes (beyond ~16,000 light-years) are noise, not distances
        out["distance_ly"] = round(1000 / plx * 3.26156, 2)

    # Catalog positions are for a fixed year (2000 for SIMBAD). Fast stars have moved since
    # then, so also give where it should be in the SPHEREx images (mid-point of the survey).
    mid_year = survey_span()[2]
    if out.get("pm_total_arcsec_yr", 0) > 0.05:
        dt = mid_year - catalog_epoch
        cosd = max(1e-6, math.cos(math.radians(out["dec"])))
        out["catalog_ra"], out["catalog_dec"], out["catalog_epoch"] = out["ra"], out["dec"], catalog_epoch
        out["ra"] = (out["ra"] + out["pm_ra_mas_yr"] * dt / 3.6e6 / cosd) % 360
        out["dec"] = out["dec"] + out["pm_dec_mas_yr"] * dt / 3.6e6
        out["epoch"] = mid_year
        out["moved_arcsec_since_catalog"] = round(out["pm_total_arcsec_yr"] * dt, 1)
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
            "ra": coord.ra.deg % 360,
            "dec": coord.dec.deg,
            "kind": "coordinates",
            "type_label": "Sky position",
            "source": "coordinates",
        }
    key = q.lower()
    result = None
    if key.startswith("asteroid:"):
        # From the Asteroids layer or an asteroid suggestion: we already know it is a small body,
        # so skip SIMBAD (which could match a star of the same name).
        return await small_body(q.split(":", 1)[1].strip())
    if key in MAJOR_BODIES:
        cmd, label = MAJOR_BODIES[key]
        result = await solar_system(http, cmd, "planet", "Planet" if key not in ("sun", "moon", "pluto") else label)
    if result is None:
        result = await sesame(http, q)
    if result is None:
        result = await small_body(q)
    return result


async def small_body(name: str) -> dict | None:
    """Asteroid or comet: position + survey path from Horizons, size / family / hazard from SBDB."""
    if not name:
        return None
    # Trailing ';' tells Horizons to search small bodies. Both services are asked at once.
    found, extra = await asyncio.gather(
        solar_system(http, f"{name};", "small-body", "Asteroid"),
        asyncio.wait_for(asteroids.facts(name), 10),
        return_exceptions=True,
    )
    if isinstance(found, BaseException):
        raise found
    if found is None:
        return None
    extra = extra if isinstance(extra, dict) else {}  # the extra facts must never break the search
    if extra.get("orbit_class"):
        found["type_label"] = extra["orbit_class"]
    found["asteroid"] = extra
    return found


@app.get("/api/resolve")
async def resolve(q: str = Query(..., min_length=1, max_length=120)):
    q = q.strip()
    # Two plain numbers are degrees. Off the sky they must not fall through to the name lookup,
    # where "10 120" would quietly turn into asteroid 10 Hygiea.
    pair = _TWO_NUMBERS.match(normalize_coordinates(q))
    if pair and not (0 <= float(pair[1]) <= 360 and -90 <= float(pair[2]) <= 90):
        raise HTTPException(400, "Those coordinates are off the sky. Right ascension runs from 0 to 360 degrees, declination from -90 to +90.")
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


# ---------------------------------------------------------------- what is at this spot?

async def tap_csv(url: str, adql: str, timeout: float) -> list[dict]:
    """Run a catalog query. `timeout` is for the whole answer: a mirror that normally takes
    under a second has been seen to take 22, and the page must not wait for that."""
    request = http.get(url, params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql},
                       timeout=timeout, follow_redirects=True)
    try:
        r = await asyncio.wait_for(request, timeout)
    except asyncio.TimeoutError:
        raise httpx.ReadTimeout(f"no answer within {timeout:.0f} s") from None
    r.raise_for_status()
    if "," not in r.text.splitlines()[0]:
        raise httpx.HTTPError("not a CSV answer")
    return list(csv.DictReader(io.StringIO(r.text)))


async def first_good(coros) -> list[dict] | None:
    """Run the same query against several mirrors; the first one that answers wins."""
    tasks = [asyncio.create_task(c) for c in coros]
    try:
        for done in asyncio.as_completed(tasks):
            try:
                return await done
            except (httpx.HTTPError, IndexError, ValueError):
                continue
        return None
    finally:
        for t in tasks:
            t.cancel()


def num(row: dict, key: str) -> float | None:
    try:
        return float(row[key])
    except (KeyError, TypeError, ValueError):
        return None


async def gaia_cone(ra: float, dec: float, radius_deg: float, limit: int,
                    mirrors=GAIA_TAP, timeout: float = 30) -> list[dict]:
    rows = None
    for url, table in mirrors:  # one after the other: the fallback is much slower
        adql = (f"SELECT TOP {limit} source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag FROM {table} "
                f"WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.6f}, {dec:.6f}, {radius_deg:.6f})) "
                "ORDER BY phot_g_mean_mag")
        try:
            rows = await tap_csv(url, adql, timeout=timeout)
            break
        except (httpx.HTTPError, IndexError, ValueError):
            continue
    if rows is None:
        raise HTTPException(502, "The Gaia archive did not answer. Try again in a moment.")
    return [{"id": r["source_id"], "ra": float(r["ra"]), "dec": float(r["dec"]), "pmra": num(r, "pmra"),
             "pmdec": num(r, "pmdec"), "parallax": num(r, "parallax"), "g": num(r, "phot_g_mean_mag")} for r in rows]


VIZIER_GAIA = "https://vizier.cfa.harvard.edu/viz-bin/asu-tsv"  # Harvard's VizieR mirror (CDS's own is often down)


async def vizier_gaia(ra: float, dec: float, radius_deg: float, limit: int, timeout: float) -> list[dict]:
    """Gaia DR3 stars around a position, brightest first, from VizieR's simple cone search.
    ~1.6 s, against ~2.8 s for ESA's archive: raced against it where a click is waiting."""
    params = {"-source": "I/355/gaiadr3", "-c": f"{ra:.6f} {dec:+.6f}", "-c.rs": f"{radius_deg * 3600:.2f}",
              "-out": "Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Plx,Gmag", "-sort": "Gmag", "-out.max": str(limit)}
    try:
        r = await asyncio.wait_for(http.get(VIZIER_GAIA, params=params, timeout=timeout), timeout)
    except asyncio.TimeoutError:
        raise httpx.ReadTimeout(f"VizieR: no answer within {timeout:.0f} s") from None
    r.raise_for_status()
    lines = [ln for ln in r.text.splitlines() if ln.strip() and not ln.startswith("#")]
    if not lines and "#Column" in r.text:
        return []  # no star in the circle: VizieR describes the columns but sends no table
    if not lines or not lines[0].startswith("Source"):
        raise httpx.HTTPError("not a VizieR table")
    cols = [c.strip() for c in lines[0].split("\t")]
    stars = []
    for ln in lines[3:]:  # after the header, units and dashes rows
        row = dict(zip(cols, (v.strip() for v in ln.split("\t"))))
        if num(row, "RA_ICRS") is None:
            continue
        stars.append({"id": row["Source"], "ra": num(row, "RA_ICRS"), "dec": num(row, "DE_ICRS"), "pmra": num(row, "pmRA"),
                      "pmdec": num(row, "pmDE"), "parallax": num(row, "Plx"), "g": num(row, "Gmag")})
    return stars


async def gaia_quick(ra: float, dec: float, radius_deg: float, limit: int, timeout: float = 6) -> list[dict]:
    """The same Gaia cone from VizieR (Harvard) and ESA side by side; the first answer wins."""
    async def esa():
        try:
            return await gaia_cone(ra, dec, radius_deg, limit, mirrors=GAIA_TAP[:1], timeout=timeout)
        except HTTPException as e:  # first_good() skips failed mirrors by their httpx error
            raise httpx.HTTPError(str(e.detail)) from None
    stars = await first_good([vizier_gaia(ra, dec, radius_deg, limit, timeout), esa()])
    if stars is None:
        raise HTTPException(502, "The Gaia archive did not answer. Try again in a moment.")
    return stars


class DayCache:
    """The last couple of hundred catalog answers, each kept for a day."""

    def __init__(self, size: int = 200) -> None:
        self._items: OrderedDict[str, tuple[float, dict]] = OrderedDict()
        self._size = size

    def get(self, key: str) -> dict | None:
        hit = self._items.get(key)
        return hit[1] if hit and time.time() - hit[0] < 86400 else None

    def put(self, key: str, value: dict) -> dict:
        self._items[key] = (time.time(), value)
        self._items.move_to_end(key)
        while len(self._items) > self._size:
            self._items.popitem(last=False)
        return value


_gaia_cache = DayCache()


@app.get("/api/gaia")
async def gaia(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
               radius: float = Query(0.05, gt=0, le=0.5, description="degrees"), limit: int = Query(300, ge=1, le=2000)):
    """Gaia DR3 stars around a position, brightest first, with their motion so the frontend
    can draw each one where it was on a given date."""
    key = f"{ra:.4f}|{dec:.4f}|{radius:.4f}|{limit}"
    return _gaia_cache.get(key) or _gaia_cache.put(
        key, {"epoch": GAIA_EPOCH, "stars": await gaia_cone(ra, dec, radius, limit), "source": "ESA Gaia DR3"})


# ---------------------------------------------------------------- names on the map
# The "Names" switch works like the labels of a street map. The sky is cut into a grid for
# each zoom level: 12 cells of 60 degrees at level 0, and every level halves the cell size.
# Each cell holds its few best-known objects, so a wide view shows the famous things spread
# evenly over the sky, and zooming in brings in the next tier. A cell never changes, so it is
# fetched from SIMBAD once and kept on disk. frontend/names.js cuts the sky the same way.
NAME_LEVELS = 10                         # deepest level: cells of 3.5 arcminutes
NAMES_TTL = 30 * 86400                   # SIMBAD's ranking of what is well known shifts slowly
NAMES_DIR = tiles.CACHE_DIR / "names"
FAMOUS_LEVELS = 2                        # levels 0..2 are cut from one list of the sky's best-known objects
FAMOUS_COUNT = 20000                     # long enough that every cell of those levels gets its full share (measured: 28 at least)
_names_slots = asyncio.Semaphore(3)      # SIMBAD slows down clients that send more than a few queries a second; a view needs about ten cells
_names_pending: dict[str, asyncio.Task] = {}
_famous: list[dict] | None = None
_famous_lock = asyncio.Lock()


async def famous_objects() -> list[dict] | None:
    """SIMBAD's best-known objects over the whole sky, best first. One query of about 2 s, kept on
    disk; cells as wide as a constellation take minutes' worth of SIMBAD time if asked one by one."""
    global _famous
    async with _famous_lock:
        if _famous is None:
            path = NAMES_DIR / "famous.json"
            try:
                if time.time() - path.stat().st_mtime < NAMES_TTL:
                    _famous = json.loads(await asyncio.to_thread(path.read_text))
            except (OSError, ValueError):
                pass
        if _famous is None:
            adql = (f"SELECT TOP {FAMOUS_COUNT} main_id, otype, ra, dec, pmra, pmdec, nbref AS refs FROM basic "
                    "WHERE ra IS NOT NULL AND otype NOT IN ('Pl', 'Pl?') ORDER BY nbref DESC")
            rows = await first_good(tap_csv(url, adql, timeout=30) for url in SIMBAD_TAP)
            if rows:
                _famous = rows
                await asyncio.to_thread(tiles._atomic_write, path, json.dumps(rows).encode())
        return _famous


def names_per_cell(level: int) -> int:
    """Wide views get a short list per cell; the last levels list close to everything."""
    return {8: 16, 9: 30, 10: 60}.get(level, 10)


def name_cell(level: int, band: int, cell: int) -> tuple[float, float, float, float] | None:
    """(ra_min, ra_max, dec_min, dec_max) of a grid cell, or None if there is no such cell.
    Bands of equal height in declination, each cut into roughly square cells."""
    height = 60 / 2 ** level
    if not 0 <= band < 3 * 2 ** level:
        return None
    dec_min = -90 + band * height
    count = max(1, math.floor(360 * math.cos((dec_min + height / 2) * math.pi / 180) / height + 0.5))
    if not 0 <= cell < count:
        return None
    return cell * 360 / count, (cell + 1) * 360 / count, dec_min, dec_min + height


def separation(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    a1, d1, a2, d2 = (math.radians(v) for v in (ra1, dec1, ra2, dec2))
    c = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(a1 - a2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


async def load_name_cell(level: int, box: tuple[float, float, float, float]) -> list[dict]:
    ra_min, ra_max, dec_min, dec_max = box
    keep = names_per_cell(level)
    if level <= FAMOUS_LEVELS and (famous := await famous_objects()):
        inside = (r for r in famous if (a := num(r, "ra")) is not None and (d := num(r, "dec")) is not None
                  and ra_min <= a < ra_max and dec_min <= d < dec_max)
        return name_objects([r for _, r in zip(range(keep), inside)])
    # The circle around the cell lets SIMBAD use its sky index; the plain limits cut it down to
    # the cell itself, so a famous neighbour just outside cannot crowd this cell's own objects out.
    ra_c, dec_c = (ra_min + ra_max) / 2, (dec_min + dec_max) / 2
    radius = 1.01 * max(separation(ra_c, dec_c, r, d) for r in (ra_min, ra_max) for d in (dec_min, dec_max))
    where = (f"WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra_c:.6f}, {dec_c:.6f}, {radius:.6f})) = 1 "
             f"AND ra >= {ra_min:.7f} AND ra < {ra_max:.7f} AND dec >= {dec_min:.7f} AND dec < {dec_max:.7f} "
             "AND otype NOT IN ('Pl', 'Pl?')")  # planets sit exactly on their star: their labels would only pile up on it
    columns = f"SELECT TOP {keep} main_id, otype, ra, dec, pmra, pmdec"
    # SIMBAD can sort by "number of papers" two ways and each is slow where the other is fast
    # (measured: up to 30 s against under 1 s). Sorting on the bare column walks its popularity
    # list, quick when the circle is big; "nbref + 0" searches the circle first, quick when it is small.
    by_popularity = f"{columns}, nbref AS refs FROM basic {where} ORDER BY nbref DESC"
    by_place = f"{columns}, nbref + 0 AS refs FROM basic {where} ORDER BY refs DESC"
    rows = None
    for adql in ((by_popularity, by_place) if radius >= 1.5 else (by_place, by_popularity)):
        async with _names_slots:
            rows = await first_good(tap_csv(url, adql, timeout=9) for url in SIMBAD_TAP)
        if rows is not None:
            break
    if rows is None:
        raise HTTPException(502, "SIMBAD did not answer. Try again in a moment.")
    return name_objects(rows)


def name_objects(rows: list[dict]) -> list[dict]:
    """SIMBAD rows -> what the map draws: tidy name, position when SPHEREx looked, how well known."""
    years = survey_span()[2] - 2000.0  # SIMBAD positions are for the year 2000; fast stars have moved since
    objects = []
    for r in rows:
        at_ra, at_dec = num(r, "ra"), num(r, "dec")
        if at_ra is None or at_dec is None:
            continue
        pm_ra, pm_dec = num(r, "pmra") or 0.0, num(r, "pmdec") or 0.0
        if math.hypot(pm_ra, pm_dec) > 50:  # same rule as describe(): faster than 0.05 arcsec a year
            at_ra = (at_ra + pm_ra * years / 3.6e6 / max(1e-6, math.cos(math.radians(at_dec)))) % 360
            at_dec += pm_dec * years / 3.6e6
        objects.append({"name": tidy_name(r["main_id"]), "ra": round(at_ra, 6), "dec": round(at_dec, 6),
                        "type": OTYPE_LABELS.get(r.get("otype", ""), ""), "refs": int(num(r, "refs") or 0)})
    return objects


@app.get("/api/names/{level}/{band}/{cell}")
async def names(level: int, band: int, cell: int, response: Response):
    """The best-known named objects in one cell of the name grid, most written-about first."""
    box = name_cell(level, band, cell) if 0 <= level <= NAME_LEVELS else None
    if box is None:
        raise HTTPException(404, "There is no such cell in the name grid.")
    response.headers["Cache-Control"] = "public, max-age=86400"
    key = f"{level}/{band}_{cell}"
    path = NAMES_DIR / f"{key}.json"
    try:
        if time.time() - path.stat().st_mtime < NAMES_TTL:
            return json.loads(await asyncio.to_thread(path.read_text))
    except (OSError, ValueError):
        pass
    task = _names_pending.get(key)  # neighbouring browsers (or a double request) share one SIMBAD query
    if task is None:
        task = _names_pending[key] = asyncio.create_task(load_name_cell(level, box))
        task.add_done_callback(lambda t: (_names_pending.pop(key, None), t.cancelled() or t.exception()))
    result = {"objects": await asyncio.shield(task), "source": "SIMBAD"}
    await asyncio.to_thread(tiles._atomic_write, path, json.dumps(result).encode())
    return result


# ---------------------------------------------------------------- Gaia stars on the map
# The "Gaia stars" switch uses the same grid as the names. Each cell holds its brightest Gaia
# stars, so a wide view shows the bright stars spread evenly over the sky and zooming in brings
# in fainter ones, instead of thousands of markers piled on the middle of the view. Gaia DR3
# never changes, so a cell is fetched once and kept on disk. frontend/stars.js draws them.
STARS_DIR = tiles.CACHE_DIR / "stars"
STARS_PER_CELL = {9: 40, 10: 100}  # the usual 24, and more in the last two levels: there is no deeper level to bring the rest in
# Down to level 7 a cell is found through a brightness limit, which the archive answers in about
# two seconds whatever the cell's size (measured; searching a wide cell by position alone takes
# over a minute in the Milky Way). The limits are generous: even the emptiest sky fills its cell.
# From level 8 on the cells are small enough to search by position, with no limit at all.
STAR_MAG_LIMIT = {0: 6.5, 1: 7.5, 2: 9.0, 3: 10.5, 4: 12.0, 5: 13.0, 6: 14.5, 7: 16.0}
_stars_slots = asyncio.Semaphore(4)  # a view needs about ten cells; the archive is happy with a few at a time
_stars_pending: dict[str, asyncio.Task] = {}


async def load_star_cell(level: int, box: tuple[float, float, float, float]) -> list[dict]:
    ra_min, ra_max, dec_min, dec_max = box
    where = f"ra >= {ra_min:.7f} AND ra < {ra_max:.7f} AND dec >= {dec_min:.7f} AND dec < {dec_max:.7f}"
    if level in STAR_MAG_LIMIT:
        where += f" AND phot_g_mean_mag < {STAR_MAG_LIMIT[level]}"
    else:
        ra_c, dec_c = (ra_min + ra_max) / 2, (dec_min + dec_max) / 2
        radius = 1.01 * max(separation(ra_c, dec_c, r, d) for r in (ra_min, ra_max) for d in (dec_min, dec_max))
        where = f"1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra_c:.6f}, {dec_c:.6f}, {radius:.6f})) AND {where}"
    rows = None
    for url, table in GAIA_TAP:  # one after the other: the fallback is much slower
        adql = (f"SELECT TOP {STARS_PER_CELL.get(level, 24)} source_id, ra, dec, pmra, pmdec, phot_g_mean_mag FROM {table} "
                f"WHERE {where} ORDER BY phot_g_mean_mag")
        try:
            async with _stars_slots:
                rows = await tap_csv(url, adql, timeout=20)
            break
        except (httpx.HTTPError, IndexError, ValueError):
            continue
    if rows is None:
        raise HTTPException(502, "The Gaia archive did not answer. Try again in a moment.")
    years = survey_span()[2] - GAIA_EPOCH  # Gaia measured each star in 2016; put it where SPHEREx saw it
    stars = []
    for r in rows:
        at_ra, at_dec = num(r, "ra"), num(r, "dec")
        if at_ra is None or at_dec is None:
            continue
        at_ra = (at_ra + (num(r, "pmra") or 0.0) * years / 3.6e6 / max(1e-6, math.cos(math.radians(at_dec)))) % 360
        at_dec += (num(r, "pmdec") or 0.0) * years / 3.6e6
        stars.append({"id": r["source_id"], "ra": round(at_ra, 6), "dec": round(at_dec, 6), "g": num(r, "phot_g_mean_mag")})
    return stars


@app.get("/api/stars/{level}/{band}/{cell}")
async def stars(level: int, band: int, cell: int, response: Response):
    """The brightest Gaia DR3 stars in one cell of the name grid, brightest first."""
    box = name_cell(level, band, cell) if 0 <= level <= NAME_LEVELS else None
    if box is None:
        raise HTTPException(404, "There is no such cell in the grid.")
    response.headers["Cache-Control"] = "public, max-age=604800"
    key = f"{level}/{band}_{cell}"
    path = STARS_DIR / f"{key}.json"
    try:
        return json.loads(await asyncio.to_thread(path.read_text))
    except (OSError, ValueError):
        pass
    task = _stars_pending.get(key)  # a double request shares one archive query
    if task is None:
        task = _stars_pending[key] = asyncio.create_task(load_star_cell(level, box))
        task.add_done_callback(lambda t: (_stars_pending.pop(key, None), t.cancelled() or t.exception()))
    result = {"stars": await asyncio.shield(task), "source": "ESA Gaia DR3"}
    await asyncio.to_thread(tiles._atomic_write, path, json.dumps(result).encode())
    return result


# ---------------------------------------------------------------- search suggestions
_suggest_cache = DayCache(500)


def _case_variants(text: str) -> list[str]:
    """SIMBAD's name search is case-sensitive, so try the ways a name is usually written."""
    words = text.split(" ")
    title = " ".join(w[:1].upper() + w[1:] for w in words)
    # "rw aur" -> "RW Aur", "v1647 ori" -> "V1647 Ori": variable-star names
    star = " ".join([words[0].upper()] + [w[:1].upper() + w[1:] for w in words[1:]])
    return list(dict.fromkeys([text, title, star, text[:1].upper() + text[1:], text.upper()]))


@app.get("/api/suggest")
async def suggest(q: str = Query(..., min_length=2, max_length=60)):
    """Names for the search box as you type: SIMBAD's proper names ("Upper Sco Association",
    "Orion Nebula", "Barnard's Loop") and designations, best-known first, plus asteroid and
    comet names. Each part has a short time limit; a slow catalog just leaves its part out."""
    text = re.sub(r"[%_]", "", " ".join(q.split()))  # LIKE wildcards would only widen the search
    key = text.lower()
    hit = _suggest_cache.get(key)
    if hit:
        return hit

    async def simbad_names() -> list[dict]:
        if len(text) < 3:
            return []
        # SIMBAD writes proper names as "NAME Upper Sco Association", variable stars as
        # "V* RW Aur" and named stars as "* eps Ind"; designations ("HD 4128") as they are.
        patterns = []
        for v in _case_variants(text.replace("'", "''")):
            patterns += [f"id LIKE '{prefix}{v}%'" for prefix in ("NAME ", "", "V* ", "* ")]
        adql = ("SELECT TOP 60 id, main_id, otype, ra, dec, nbref + 0 AS refs FROM ident JOIN basic ON oid = oidref "
                f"WHERE ({' OR '.join(dict.fromkeys(patterns))}) AND ra IS NOT NULL ORDER BY refs DESC")
        rows = await first_good(tap_csv(url, adql, timeout=4) for url in SIMBAD_TAP)
        objects: dict[str, list[dict]] = {}  # main_id -> its names that matched, best-known object first
        for r in rows or []:
            objects.setdefault(r["main_id"], []).append(r)
        out = []
        for main_id, matched in list(objects.items())[:6]:
            main = tidy_name(main_id)
            names_matched = [tidy_name(r["id"]) for r in matched]
            # Show the object's own name when it matches what was typed, else the first name that did.
            label = main if main in names_matched else names_matched[0]
            out.append({"label": label, "query": main_id.strip(), "kind": OTYPE_LABELS.get(matched[0].get("otype", ""), ""),
                        "also": main if main.lower() != label.lower() else ""})
        return out

    async def small_bodies() -> list[dict]:
        try:
            items = (await asyncio.wait_for(asteroids.asteroid_suggest(text), 4))["items"]
        except (asyncio.TimeoutError, HTTPException):
            return []
        # The name index also matches digits inside catalog numbers ("m42" -> asteroid 224202):
        # keep only names that really contain what was typed.
        typed = text.lower().replace(" ", "")
        items = [a for a in items if typed in a["title"].lower().replace(" ", "")]
        return [{"label": a["title"], "query": f"asteroid:{a['name']}", "kind": a["family"] or a["type"], "asteroid": True}
                for a in items[:4]]

    named, bodies = await asyncio.gather(simbad_names(), small_bodies())
    return _suggest_cache.put(key, {"items": named + bodies})


class FastStars:
    """Every star SIMBAD knows to cross the sky faster than 0.5 arcsec a year (~5,600 of them),
    kept on disk. Catalogs give their position for the year 2000, which can be arcminutes from
    where SPHEREx saw them, so a click near one must be checked against where it has moved to.
    Looking them up here takes microseconds; asking Gaia on every click took ~3 s.
    Slower stars have drifted at most ~13 arcsec since 2000, which the normal nearest-object
    search already covers."""

    MIN_PM_MAS_YR = 500
    PATH = tiles.CACHE_DIR / "fast_stars.csv"
    MAX_AGE_S = 30 * 86400  # SIMBAD gains new fast stars slowly: refresh monthly

    def __init__(self) -> None:
        self.rows: list[dict] | None = None  # None until loaded: identify() falls back to asking Gaia

    def start(self) -> None:
        self._task = asyncio.create_task(self._load())  # never delays startup

    def _parse(self, text: str) -> list[dict]:
        rows = []
        for r in csv.DictReader(io.StringIO(text)):
            ra, dec, pmra, pmdec = num(r, "ra"), num(r, "dec"), num(r, "pmra"), num(r, "pmdec")
            if None in (ra, dec, pmra, pmdec) or r.get("otype") in ("Pl", "Pl?"):  # planets sit on their star
                continue
            rows.append({"main_id": r["main_id"], "otype": r.get("otype", ""), "ra": ra, "dec": dec,
                         "pmra": pmra, "pmdec": pmdec, "plx_value": num(r, "plx_value")})
        return rows

    async def _load(self) -> None:
        try:
            if self.PATH.exists():
                self.rows = self._parse(await asyncio.to_thread(self.PATH.read_text, encoding="utf-8"))
                if time.time() - self.PATH.stat().st_mtime < self.MAX_AGE_S:
                    return
            adql = ("SELECT main_id, otype, ra, dec, pmra, pmdec, plx_value FROM basic "
                    f"WHERE pmra * pmra + pmdec * pmdec > {self.MIN_PM_MAS_YR ** 2} AND ra IS NOT NULL")
            rows = await first_good(tap_csv(url, adql, timeout=90) for url in SIMBAD_TAP)
            if not rows:
                return
            buf = io.StringIO()
            writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
            self.PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.PATH.with_suffix(".tmp")
            await asyncio.to_thread(tmp.write_text, buf.getvalue(), encoding="utf-8")
            tmp.replace(self.PATH)
            self.rows = self._parse(buf.getvalue())
        except Exception as e:  # without the list, clicks still work (the Gaia way)
            print(f"[lumasphere] fast-star list not loaded: {e!r}")

    def near(self, ra: float, dec: float, within_arcsec: float, year: float) -> dict | None:
        """The fast star whose position in `year` is closest to (ra, dec), if within range."""
        if self.rows is None:
            return None
        best, best_sep = None, within_arcsec
        cos0 = math.cos(math.radians(dec))
        dt = year - 2000.0
        for s in self.rows:
            if abs(s["dec"] - dec) > 0.6:  # Barnard's star, the fastest, moved < 0.1 deg since 2000
                continue
            cosd = max(1e-6, math.cos(math.radians(s["dec"])))
            now_ra = s["ra"] + s["pmra"] * dt / 3.6e6 / cosd
            now_dec = s["dec"] + s["pmdec"] * dt / 3.6e6
            d_ra = (now_ra - ra + 180) % 360 - 180
            sep = math.hypot(d_ra * cos0, now_dec - dec) * 3600
            if sep <= best_sep:
                best, best_sep = s, sep
        return best


fast_stars = FastStars()


@app.get("/api/identify")
async def identify(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                   radius: float = Query(20, gt=0, le=600, description="how far to look, arcseconds")):
    """Nearest known object to a clicked position: SIMBAD first, then the nearest Gaia star,
    otherwise just the coordinates. Same shape as /api/resolve."""
    key = f"identify|{ra:.5f}|{dec:.5f}|{radius:.0f}"
    hit = _cache.get(key)
    if hit is not None:
        return hit[1]
    r_deg = radius / 3600
    mid_year = survey_span()[2]

    def simbad_nearest(at_ra: float, at_dec: float, within_deg: float):
        adql = ("SELECT TOP 1 main_id, otype, ra, dec, pmra, pmdec, plx_value, "
                f"DISTANCE(POINT('ICRS', ra, dec), POINT('ICRS', {at_ra:.6f}, {at_dec:.6f})) AS dist FROM basic "
                f"WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {at_ra:.6f}, {at_dec:.6f}, {within_deg:.6f})) = 1 "
                "AND otype NOT IN ('Pl', 'Pl?') ORDER BY dist")  # a star, not the planets listed at its position
        return first_good(tap_csv(url, adql, timeout=8) for url in SIMBAD_TAP)

    def from_simbad(rows) -> dict | None:
        if not rows or num(rows[0], "ra") is None:
            return None
        row = rows[0]
        out = {"name": tidy_name(row["main_id"]), "ra": float(row["ra"]), "dec": float(row["dec"]),
               "otype": row.get("otype", ""), "aliases": [], "source": "SIMBAD"}
        if num(row, "pmra") is not None and num(row, "pmdec") is not None:
            out["pm_ra_mas_yr"], out["pm_dec_mas_yr"] = num(row, "pmra"), num(row, "pmdec")
        if num(row, "plx_value") is not None:
            out["parallax_mas"] = num(row, "plx_value")
        return describe(out)

    def from_gaia(star: dict) -> dict:
        out = {"name": f"Gaia DR3 {star['id']}", "ra": star["ra"], "dec": star["dec"], "aliases": [], "source": "ESA Gaia DR3"}
        if star["pmra"] is not None and star["pmdec"] is not None:
            out["pm_ra_mas_yr"], out["pm_dec_mas_yr"] = star["pmra"], star["pmdec"]
        if star["parallax"] is not None:
            out["parallax_mas"] = star["parallax"]
        described = describe(out, catalog_epoch=GAIA_EPOCH)
        described["type_label"] = "Star" + (f" (Gaia brightness G = {star['g']:.1f})" if star["g"] is not None else "")
        return described

    def moved(star: dict, to_year: float) -> tuple[float, float]:
        dt = to_year - GAIA_EPOCH
        cosd = max(1e-6, math.cos(math.radians(star["dec"])))
        return (star["ra"] + (star["pmra"] or 0) * dt / 3.6e6 / cosd) % 360, star["dec"] + (star["pmdec"] or 0) * dt / 3.6e6

    async def fast_star_here() -> dict | None:
        """Catalogs list a fast star where it was years ago, which can be arcminutes away from
        where it is in the SPHEREx images. Look for nearby fast movers and bring them forward."""
        adql = (f"SELECT TOP 20 source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag FROM {GAIA_TAP[0][1]} "
                f"WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.6f}, {dec:.6f}, 0.15)) "
                "AND pmra * pmra + pmdec * pmdec > 40000 ORDER BY phot_g_mean_mag")  # faster than 0.2 arcsec / year
        try:
            rows = await tap_csv(GAIA_TAP[0][0], adql, timeout=8)
        except (httpx.HTTPError, IndexError, ValueError):
            return None
        for r in rows:
            star = {"id": r["source_id"], "ra": float(r["ra"]), "dec": float(r["dec"]), "pmra": num(r, "pmra"),
                    "pmdec": num(r, "pmdec"), "parallax": num(r, "parallax"), "g": num(r, "phot_g_mean_mag")}
            now_ra, now_dec = moved(star, mid_year)
            sep = math.hypot((now_ra - ra) * math.cos(math.radians(dec)), now_dec - dec) * 3600
            if sep <= max(radius, 15):
                return star
        return None

    result = None
    fast = fast_stars.near(ra, dec, max(radius, 15), mid_year)
    if fast is not None:
        result = from_simbad([fast])  # the list holds its SIMBAD record: no query needed
    elif fast_stars.rows is None:
        # The fast-star list is still downloading (first start only): ask Gaia, the slow way.
        mover = await fast_star_here()
        if mover is not None:
            old_ra, old_dec = moved(mover, 2000.0)  # SIMBAD lists it where it was in 2000
            result = from_simbad(await simbad_nearest(old_ra, old_dec, 10 / 3600)) or from_gaia(mover)
    if result is None:
        # Ask Gaia for the nearest star at the same time as SIMBAD, so an unnamed spot waits for
        # one answer instead of two in a row. ESA only, and briefly: its fallback (IRSA) takes
        # 20-40 s, and a click that waits that long is worse than plain coordinates.
        gaia_task = asyncio.create_task(gaia_quick(ra, dec, min(r_deg, 10 / 3600), 1, timeout=6))
        gaia_task.add_done_callback(lambda t: t.cancelled() or t.exception())
        try:
            result = from_simbad(await simbad_nearest(ra, dec, r_deg))
            if result is None:
                try:
                    stars = await gaia_task
                except (HTTPException, httpx.HTTPError):
                    stars = []
                if stars:
                    result = from_gaia(stars[0])
        finally:
            gaia_task.cancel()
    if result is None:
        result = {"name": f"{ra:.4f}° {dec:+.4f}°", "ra": ra, "dec": dec, "kind": "coordinates",
                  "type_label": "Sky position (no catalogued object here)", "source": "coordinates"}
    result["clicked"] = {"ra": ra, "dec": dec}
    _cache.put(key, result)
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
