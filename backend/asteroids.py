"""Asteroids (and comets) for Lumasphere.

  GET /api/asteroids?ra=&dec=&radius=&date=   -> known asteroids in that patch of sky on that date
  GET /api/asteroid-suggest?q=                -> asteroid / comet names for the search box

Where asteroids are comes from IMCCE's SkyBoT service: it holds the orbit of every known
asteroid and comet (1.4 million+) and answers "what was inside this circle at this moment".
SPHEREx orbits only 700 km up, so the Earth's centre is used as the observer; for anything
but a very close near-Earth asteroid that is the same to well under a SPHEREx pixel.

facts(name) adds size, orbit family and hazard flags from NASA JPL's Small-Body Database to an
asteroid found by the search (see main.py).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import OrderedDict
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException, Query

log = logging.getLogger("lumasphere.asteroids")

SKYBOT_URL = "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php"
SUGGEST_URL = "https://api.ssodnet.imcce.fr/quaero/1/sso/instant-search"
SBDB_URL = "https://ssd-api.jpl.nasa.gov/sbdb.api"
MJD_TO_JD = 2400000.5

router = APIRouter()
_client: httpx.AsyncClient | None = None

# SkyBoT's orbit family codes ("MB>Inner") in plain words.
CLASS_LABELS = {
    "NEA": "Near-Earth asteroid",
    "Hungaria": "Hungaria asteroid (inner edge of the main belt)",
    "Mars-Crosser": "Mars-crossing asteroid",
    "MB": "Main-belt asteroid",
    "Trojan": "Jupiter Trojan (shares Jupiter's orbit)",
    "Centaur": "Centaur (between Jupiter and Neptune)",
    "KBO": "Kuiper Belt object (beyond Neptune)",
    "Comet": "Comet",
    "Planet": "Planet",
    "Satellite": "Moon of a planet",
}
# JPL's orbit class codes, for the info card.
SBDB_CLASSES = {
    "ATE": "Near-Earth asteroid (Aten: crosses Earth's orbit from inside)",
    "APO": "Near-Earth asteroid (Apollo: crosses Earth's orbit)",
    "AMO": "Near-Earth asteroid (Amor: comes close to Earth's orbit)",
    "IEO": "Near-Earth asteroid (orbits entirely inside Earth's)",
    "MCA": "Mars-crossing asteroid",
    "IMB": "Main-belt asteroid (inner)",
    "MBA": "Main-belt asteroid",
    "OMB": "Main-belt asteroid (outer)",
    "TJN": "Jupiter Trojan (shares Jupiter's orbit)",
    "CEN": "Centaur (between Jupiter and Neptune)",
    "TNO": "Trans-Neptunian object (beyond Neptune)",
    "JFc": "Comet (Jupiter family)",
    "HTC": "Comet (Halley type)",
    "ETc": "Comet (Encke type)",
    "CTc": "Comet (Chiron type)",
    "COM": "Comet",
    "PAR": "Comet (on a one-way, parabolic path)",
    "HYP": "Object passing through the solar system (hyperbolic path)",
}


async def start() -> None:
    global _client
    _client = httpx.AsyncClient(timeout=30, headers={"User-Agent": "Lumasphere/1.0"}, follow_redirects=True)


async def stop() -> None:
    if _client is not None:
        await _client.aclose()


class TimedCache:
    def __init__(self, ttl: float, size: int = 500) -> None:
        self.ttl, self.size = ttl, size
        self._items: OrderedDict[str, tuple[float, object]] = OrderedDict()
        self._pending: dict[str, asyncio.Task] = {}

    async def get_or_make(self, key: str, make):
        hit = self._items.get(key)
        if hit and time.time() - hit[0] < self.ttl:
            return hit[1]
        task = self._pending.get(key)
        if task is None:  # two viewers asking for the same thing share one request
            task = self._pending[key] = asyncio.create_task(make())
            task.add_done_callback(lambda t: (self._pending.pop(key, None), t.cancelled() or t.exception()))
        value = await asyncio.shield(task)
        self._items[key] = (time.time(), value)
        self._items.move_to_end(key)
        while len(self._items) > self.size:
            self._items.popitem(last=False)
        return value


_cone_cache = TimedCache(ttl=7 * 86400, size=400)  # past dates never change; today's is fine for a week too
_suggest_cache = TimedCache(ttl=86400, size=500)
_facts_cache = TimedCache(ttl=86400, size=500)


def _sexagesimal(text: str, hours: bool) -> float:
    sign = -1.0 if text.strip().startswith("-") else 1.0
    a, b, c = (abs(float(x)) for x in text.replace("+", " ").replace("-", " ").split())
    value = a + b / 60 + c / 3600
    return sign * value * (15.0 if hours else 1.0)


def _family(code: str) -> str:
    head = (code or "").split(">")[0]
    return CLASS_LABELS.get(head, head or "Asteroid")


def _jd_for(date: str | None) -> tuple[float, str]:
    """`date` is an ISO date/time, an MJD number, or empty for now."""
    if not date:
        dt = datetime.now(timezone.utc)
    elif re.fullmatch(r"\d{5}(\.\d+)?", date):
        mjd = float(date)
        return mjd + MJD_TO_JD, datetime.fromtimestamp((mjd - 40587) * 86400, timezone.utc).strftime("%Y-%m-%d %H:%M")
    else:
        try:
            dt = datetime.fromisoformat(date.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(400, "date must look like 2025-11-13, 2025-11-13T06:00 or an MJD like 60992.25") from None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    jd = dt.timestamp() / 86400 + 2440587.5
    return jd, dt.strftime("%Y-%m-%d %H:%M")


async def cone(ra: float, dec: float, radius: float, jd: float) -> list[dict]:
    params = {"-ep": f"{jd:.5f}", "-ra": f"{ra:.6f}", "-dec": f"{dec:.6f}", "-rd": f"{radius:.5f}",
              "-mime": "json", "-output": "basic", "-loc": "500", "-objFilter": "111", "-from": "Lumasphere"}
    try:
        r = await _client.get(SKYBOT_URL, params=params, timeout=45)
    except httpx.HTTPError as e:
        raise HTTPException(502, "The asteroid service (IMCCE SkyBoT) did not answer. Try again in a moment.") from e
    if r.status_code == 204:
        return []  # "No Content": nothing known inside the circle
    if r.status_code != 200:
        raise HTTPException(502, f"The asteroid service (IMCCE SkyBoT) answered HTTP {r.status_code}.")
    text = r.text.strip()
    if not text.startswith("["):
        return []  # SkyBoT sends an empty answer when nothing is in the circle
    out = []
    for row in r.json():
        try:
            item = {
                "name": row["Name"],
                "number": row.get("Num"),
                "ra": round(_sexagesimal(row["RA (hms)"], hours=True), 6),
                "dec": round(_sexagesimal(row["DEC (dms)"], hours=False), 6),
                "vmag": row.get("VMag (mag)"),
                "family": _family(row.get("Class", "")),
                "class_code": row.get("Class", ""),
                # How fast it crosses the sky, arcseconds per hour (east, north).
                "rate_ra": row.get("dRA (arcsec/h)"),
                "rate_dec": row.get("dDEC (arcsec/h)"),
                "earth_au": row.get("dg (ua)"),
                "sun_au": row.get("dh (ua)"),
            }
        except (KeyError, ValueError, TypeError):
            continue
        item["label"] = f"({item['number']}) {item['name']}" if item["number"] else item["name"]
        out.append(item)
    out.sort(key=lambda a: a["vmag"] if isinstance(a["vmag"], (int, float)) else 99)
    return out


@router.get("/api/asteroids")
async def asteroids(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
                    radius: float = Query(0.25, gt=0, le=1, description="degrees"),
                    date: str | None = Query(None, description="ISO date/time or MJD; empty = now"),
                    limit: int = Query(80, ge=1, le=500)):
    """Known asteroids and comets inside a circle at one moment, brightest first."""
    jd, when = _jd_for(date)
    # Round the moment to 15 minutes so nearby requests share the cache; asteroids move at most
    # a few arcseconds in that time (except very close near-Earth ones).
    jd = round(jd * 96) / 96
    key = f"{ra:.4f}|{dec:.4f}|{radius:.4f}|{jd:.4f}"
    rows = await _cone_cache.get_or_make(key, lambda: cone(ra, dec, radius, jd))
    return {"date": when, "jd": jd, "total": len(rows), "asteroids": rows[:limit],
            "source": "IMCCE SkyBoT (positions computed from each object's known orbit)"}


async def _suggest(q: str) -> list[dict]:
    try:
        r = await _client.get(SUGGEST_URL, params={"q": q, "limit": 25}, timeout=8)
        r.raise_for_status()
        data = r.json().get("data", [])
    except (httpx.HTTPError, ValueError):
        return []
    out = []
    for d in data:
        if d.get("type") not in ("Asteroid", "Dwarf Planet", "Comet"):
            continue
        out.append({"name": d.get("name"), "title": d.get("title") or d.get("name"), "type": d.get("type"),
                    "family": _family((d.get("class") or [""])[0]) if d.get("type") == "Asteroid" else d.get("type")})
    return out[:8]


@router.get("/api/asteroid-suggest")
async def asteroid_suggest(q: str = Query(..., min_length=2, max_length=60)):
    """Asteroid, dwarf planet and comet names starting like `q`, for the search box."""
    q = q.strip()
    return {"items": await _suggest_cache.get_or_make(q.lower(), lambda: _suggest(q))}


async def _facts(name: str) -> dict:
    try:
        r = await _client.get(SBDB_URL, params={"sstr": name, "phys-par": "1"}, timeout=10)
        data = r.json()
    except (httpx.HTTPError, ValueError):
        return {}
    obj = data.get("object") or {}
    if not obj:
        return {}
    phys = {p.get("name"): p for p in data.get("phys_par", [])}
    out: dict = {}
    if code := (obj.get("orbit_class") or {}).get("code"):
        out["orbit_class"] = SBDB_CLASSES.get(code, (obj.get("orbit_class") or {}).get("name", code))
    if obj.get("pha"):
        out["hazard"] = "Potentially hazardous: larger than ~140 m and its orbit passes within 7.5 million km of Earth's"
    elif obj.get("neo"):
        out["hazard"] = "Near-Earth object (not on the potentially-hazardous list)"
    try:
        out["diameter_km"] = float(phys["diameter"]["value"])
    except (KeyError, TypeError, ValueError):
        pass
    try:
        out["albedo"] = float(phys["albedo"]["value"])
    except (KeyError, TypeError, ValueError):
        pass
    for key in ("spec_B", "spec_T"):  # SMASS / Tholen spectral type: what its surface is made of
        if key in phys and phys[key].get("value"):
            out["spectral_type"] = phys[key]["value"]
            break
    try:
        out["rotation_hours"] = float(phys["rot_per"]["value"])
    except (KeyError, TypeError, ValueError):
        pass
    if obj.get("fullname"):
        out["full_name"] = obj["fullname"]
    return out


async def facts(name: str) -> dict:
    """Size, orbit family and hazard flags for an asteroid or comet ({} if unknown)."""
    if _client is None or not name:
        return {}
    try:
        return await _facts_cache.get_or_make(name.lower(), lambda: _facts(name))
    except Exception:  # extra facts must never break the search itself
        log.exception("SBDB facts for %s failed", name)
        return {}
