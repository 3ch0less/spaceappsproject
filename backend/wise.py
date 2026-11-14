"""WISE reference image: the same patch of sky as NASA's WISE telescope saw it in 2010.

WISE photographed the whole sky in four infrared colours about 15 years before SPHEREx. Two
of them (3.4 and 4.6 microns) are colours SPHEREx sees too, so a WISE image of the patch the
time-lapse shows is a direct "before" picture: same place, same size, same orientation.

The AllWISE all-sky images are published as a HiPS: the sky cut into HEALPix tiles of
512 x 512 pixels. For a position this module works out which tiles the patch falls on,
downloads them (IRSA's copy first, CDS's as the fallback), and reads the patch out of them on
the grid the time-lapse uses.

    GET /api/wise?ra=..&dec=..&fov=6&band=1
      {"size": 256, "scale_arcsec": .., "band": 1, "wavelength_um": 3.4, "epoch": 2010.5,
       "range": {"lo", "hi", "noise"}, "image": <base64 float32, north up, east left>}

Results are cached on disk next to the time-lapses, so a repeat request answers at once.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import logging
import math
import os
import warnings
from collections import OrderedDict

import httpx
import numpy as np
from astropy.io import fits
from fastapi import APIRouter, HTTPException, Query, Response

import tiles
import timelapse

log = logging.getLogger("lumasphere.wise")

# Where the AllWISE HiPS lives, most trusted first. Each has W1 … W4 below it.
MIRRORS = [m.strip().rstrip("/") for m in os.environ.get(
    "LUMASPHERE_WISE_HIPS", "https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE,https://alasky.cds.unistra.fr/AllWISE").split(",") if m.strip()]
BANDS = {1: 3.4, 2: 4.6, 3: 12.0, 4: 22.0}   # WISE band -> wavelength in microns
EPOCH = 2010.5                # AllWISE combines exposures from January 2010 to February 2011
GRID = 256                    # output images are GRID x GRID pixels (WISE is sharper than SPHEREx)
SUPERSAMPLE = 2               # each output pixel is the mean of SUPERSAMPLE² looks into the tiles
TILE_BITS = 9                 # tiles are 2^9 = 512 pixels wide
MAX_ORDER = 8                 # deepest tile level: 1.6" pixels
TILES_KEPT = 24               # decoded tiles kept in memory (about 1 MB each)

router = APIRouter()
_tiles: OrderedDict[tuple[int, int, int], np.ndarray] = OrderedDict()
_tile_jobs: dict[tuple[int, int, int], asyncio.Task] = {}
_jobs: dict[str, asyncio.Task] = {}


# ---------------------------------------------------------------- where on the sky is which pixel

def healpix_face_xy(nside: int, ra: np.ndarray, dec: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """HEALPix base face (0-11) and integer (x, y) inside it for each position, in degrees.
    The nested pixel number is face * nside² + the bits of x and y interleaved (x in the even bits)."""
    z = np.sin(np.radians(dec))
    tt = (np.radians(ra) / (math.pi / 2)) % 4.0

    # The belt around the equator (|z| <= 2/3).
    t1, t2 = nside * (0.5 + tt), nside * z * 0.75
    jp, jm = np.floor(t1 - t2).astype(np.int64), np.floor(t1 + t2).astype(np.int64)
    ifp, ifm = jp // nside, jm // nside
    face_eq = np.where(ifp == ifm, (ifp & 3) + 4, np.where(ifp < ifm, ifp & 3, (ifm & 3) + 8))
    x_eq, y_eq = jm & (nside - 1), nside - (jp & (nside - 1)) - 1

    # The two polar caps. 1 - |z| is computed from the distance to the pole, which stays exact near it.
    ntt = np.minimum(3, tt.astype(np.int64))
    tp = tt - ntt
    tmp = nside * math.sqrt(6.0) * np.sin(np.radians(90.0 - np.abs(dec)) / 2)
    jp = np.minimum(nside - 1, (tp * tmp).astype(np.int64))
    jm = np.minimum(nside - 1, ((1.0 - tp) * tmp).astype(np.int64))
    north = z >= 0
    face_cap = np.where(north, ntt, ntt + 8)
    x_cap, y_cap = np.where(north, nside - jm - 1, jp), np.where(north, nside - jp - 1, jm)

    belt = np.abs(z) <= 2.0 / 3.0
    return np.where(belt, face_eq, face_cap), np.where(belt, x_eq, x_cap), np.where(belt, y_eq, y_cap)


def interleave(x: np.ndarray, y: np.ndarray, bits: int) -> np.ndarray:
    out = np.zeros_like(x)
    for b in range(bits):
        out |= (((x >> b) & 1) << (2 * b)) | (((y >> b) & 1) << (2 * b + 1))
    return out


def tile_lookup(order: int, ra: np.ndarray, dec: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For each position: the tile number at this order, and the (row, column) of its pixel in
    that tile's FITS image. In a HiPS FITS tile the HEALPix x runs down the rows and y along
    the columns (measured against Gaia star positions: no other orientation puts stars on stars)."""
    face, x, y = healpix_face_xy(1 << (order + TILE_BITS), ra, dec)
    tile = face * (1 << (2 * order)) + interleave(x >> TILE_BITS, y >> TILE_BITS, order)
    mask = (1 << TILE_BITS) - 1
    return tile, mask - (x & mask), y & mask


# ---------------------------------------------------------------- tiles

async def download_tile(band: int, order: int, ipix: int) -> np.ndarray:
    rel = f"W{band}/Norder{order}/Dir{ipix // 10000 * 10000}/Npix{ipix}.fits"
    width = 1 << TILE_BITS
    last = None
    for base in MIRRORS:
        for _ in range(2):
            try:
                r = await timelapse._client.get(f"{base}/{rel}", timeout=httpx.Timeout(45, connect=8))
                if r.status_code == 200 and r.content[:6] == b"SIMPLE":
                    def decode(raw: bytes = r.content) -> np.ndarray:
                        with warnings.catch_warnings():
                            warnings.simplefilter("ignore")
                            with fits.open(io.BytesIO(raw), memmap=False) as hdus:
                                return np.asarray(hdus[0].data, dtype=np.float32)
                    data = await asyncio.to_thread(decode)
                    if data.shape != (width, width):
                        raise ValueError(f"unexpected tile shape {data.shape}")
                    return data
                last = f"HTTP {r.status_code}"
            except (httpx.HTTPError, OSError, ValueError, TypeError) as e:
                last = repr(e)
            await asyncio.sleep(0.3)
    raise RuntimeError(f"could not read WISE tile {rel}: {last}")


async def get_tile(band: int, order: int, ipix: int) -> np.ndarray:
    """A decoded tile: from memory, or downloaded (requests for the same tile share one download)."""
    key = (band, order, ipix)
    if key in _tiles:
        _tiles.move_to_end(key)
        return _tiles[key]
    task = _tile_jobs.get(key)
    if task is None:
        task = _tile_jobs[key] = asyncio.create_task(download_tile(band, order, ipix))
        task.add_done_callback(lambda t: (_tile_jobs.pop(key, None), t.cancelled() or t.exception()))
    data = await asyncio.shield(task)
    _tiles[key] = data
    _tiles.move_to_end(key)
    while len(_tiles) > TILES_KEPT:
        _tiles.popitem(last=False)
    return data


# ---------------------------------------------------------------- the patch

def pick_order(fov: float) -> int:
    """The shallowest tile level whose pixels are still about as fine as the output's."""
    out_arcsec = fov * 60 / GRID
    for order in range(MAX_ORDER + 1):
        nside = 1 << (order + TILE_BITS)
        if math.sqrt(4 * math.pi / (12 * nside * nside)) * 206264.806 <= 1.2 * out_arcsec:
            return order
    return MAX_ORDER


def assemble(size: int, lookup: tuple[np.ndarray, np.ndarray, np.ndarray], data: dict[int, np.ndarray]) -> tuple[np.ndarray, dict]:
    """Read the patch out of its tiles, then settle the display range the way the time-lapse does."""
    tile, row, col = lookup
    fine = np.full(tile.shape, np.nan, dtype=np.float32)
    for ipix, pixels in data.items():
        here = tile == ipix
        fine[here] = pixels[row[here], col[here]]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        image = np.nanmean(fine.reshape(size, SUPERSAMPLE, size, SUPERSAMPLE), axis=(1, 3))
        finite = image[np.isfinite(image)]
        if not finite.size:
            raise RuntimeError("WISE has no image of this spot")
        image = image - np.median(finite)   # the sky glow carries no information here
        finite = finite - np.median(finite)
        noise = float(1.4826 * np.median(np.abs(finite))) or 1e-6
        lo = -1.5 * noise
        hi = max(float(np.percentile(finite, 99.8)), lo + 12 * noise)
        # WISE covered the whole sky, so a hole is where something overwhelmed its detectors (the
        # core of a very bright star or nebula). Show it at full brightness, not as a black pit.
        holes = ~np.isfinite(image)
        image[holes] = hi
    return image.astype("<f4"), {"lo": lo, "hi": hi, "noise": noise, "saturated": round(float(holes.mean()), 4)}


async def build(key: str, ra: float, dec: float, fov: float, band: int) -> bytes:
    order = pick_order(fov)
    gra, gdec, _ = timelapse.sky_grid(ra, dec, fov, GRID * SUPERSAMPLE)
    lookup = await asyncio.to_thread(tile_lookup, order, gra, gdec)
    wanted = [int(t) for t in np.unique(lookup[0])]
    loaded = await asyncio.gather(*(get_tile(band, order, t) for t in wanted))
    image, rng = await asyncio.to_thread(assemble, GRID, lookup, dict(zip(wanted, loaded)))
    body = json.dumps({
        "ra": ra, "dec": dec, "fov_arcmin": fov, "size": GRID, "scale_arcsec": fov * 60 / GRID,
        "band": band, "wavelength_um": BANDS[band], "epoch": EPOCH, "range": rng,
        "image": base64.b64encode(image.tobytes()).decode(),
        "source": "NASA WISE, AllWISE atlas images (HiPS by CDS, served by IRSA)",
    }).encode()
    await asyncio.to_thread(tiles._atomic_write, timelapse.CACHE_DIR / f"{key}.json", body)
    return body


@router.get("/api/wise")
async def wise(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    fov: float = Query(6.0, description="field of view in arcminutes"),
    band: int = Query(1, ge=1, le=4, description="WISE band 1-4 (3.4, 4.6, 12, 22 microns)"),
):
    if fov not in timelapse.FOV_CHOICES:
        raise HTTPException(400, f"fov must be one of {timelapse.FOV_CHOICES}")
    ra, dec = round(ra, 5), round(dec, 5)
    key = "wise_" + hashlib.sha1(f"{ra:.5f}|{dec:.5f}|{fov}|{band}|{GRID}".encode()).hexdigest()[:20]
    path = timelapse.CACHE_DIR / f"{key}.json"
    try:
        body = await asyncio.to_thread(path.read_bytes)   # AllWISE is finished: a cached answer never goes stale
    except OSError:
        task = _jobs.get(key)
        if task is None:
            task = _jobs[key] = asyncio.create_task(build(key, ra, dec, fov, band))
            task.add_done_callback(lambda t: (_jobs.pop(key, None), t.cancelled() or t.exception()))
        try:
            body = await asyncio.shield(task)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("WISE image failed: %r", e)
            raise HTTPException(502, "The WISE image archive didn't answer. Try again in a moment.") from e
    return Response(body, media_type="application/json", headers={"Cache-Control": "public, max-age=86400"})
