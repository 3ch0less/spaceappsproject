"""SPHEREx tile cache.

IRSA publishes the SPHEREx all-sky map as one HiPS *cube* (102 wavelength frames per tile
position). Aladin Lite's cube renderer re-downloads every visible tile twice a second and
has no low-resolution fallback while tiles load, which is what made the sky go black on
zoom. So instead we present each wavelength frame as an ordinary HiPS image survey:

    /hips/<version>/<frame>/Norder<o>/Dir<d>/Npix<n>.png   one tile
    /hips/<version>/<frame>/Norder3/Allsky.png             low-res preview of the whole sky
    /hips/<version>/<frame>/Moc.fits                       sky coverage
    /hips/<version>/<frame>/properties                     HiPS metadata (for other HiPS clients)
    /api/survey                                            what the frontend needs to know
    /api/warm                                              "you'll need these tiles soon"

Every file is fetched from IRSA at most once, then kept on disk (backend/.cache by default)
and served with a one-year immutable Cache-Control, so the browser keeps it too.
<version> comes from the release date in IRSA's properties file: when a new data release
lands, the version changes and every cache layer starts fresh on its own.

Settings (environment variables):
    SKYSHIFT_HIPS_URL    upstream HiPS cube (default: IRSA SPHEREx all-sky cube)
    SKYSHIFT_CACHE_DIR   where tiles are kept (default: backend/.cache)
    SKYSHIFT_CACHE_GB    disk budget; least recently used tiles are deleted beyond it (default 5)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import FileResponse

log = logging.getLogger("skyshift.tiles")

UPSTREAM = os.environ.get(
    "SKYSHIFT_HIPS_URL", "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube"
).rstrip("/")
CACHE_DIR = Path(os.environ.get("SKYSHIFT_CACHE_DIR") or Path(__file__).resolve().parent / ".cache")
CACHE_MAX_BYTES = int(float(os.environ.get("SKYSHIFT_CACHE_GB", "5")) * 1e9)

SURVEY_TTL = 15 * 60        # how often we look for a new data release (seconds)
MISSING_TTL = 60 * 60       # how long an upstream 404 is remembered
UPSTREAM_SLOTS = 16         # parallel downloads from IRSA (one connection each; IRSA is ~250 kB/s per connection)
WARM_SLOTS = 10             # of which look-ahead ("warm") downloads may use at most this many
WARM_MAX_TILES = 256        # per /api/warm call
RETRIES = 3

IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}
SHORT = {"Cache-Control": "public, max-age=300"}
NO_STORE = {"Cache-Control": "no-store"}


class UpstreamError(Exception):
    pass


@dataclass
class Survey:
    version: str
    title: str
    release_date: str
    wavelengths_um: list[float]
    blank_frames: list[int]
    min_order: int
    max_order: int
    tile_size: int
    frame: str
    format: str
    t_min_mjd: float | None = None
    t_max_mjd: float | None = None
    fetched_at: float = field(default=0.0)

    @property
    def depth(self) -> int:
        return len(self.wavelengths_um)

    def suffix(self, frame: int) -> str:
        # HiPS cube naming: frame 0 is Npix123.png, frame k>0 is Npix123_k.png
        return f"_{frame}" if frame else ""

    def date_range(self) -> tuple[str, str] | None:
        if self.t_min_mjd is None or self.t_max_mjd is None:
            return None
        mjd0 = datetime(1858, 11, 17)
        return tuple((mjd0 + timedelta(days=d)).strftime("%Y-%m-%d") for d in (self.t_min_mjd, self.t_max_mjd))

    def mid_year(self) -> float | None:
        if self.t_min_mjd is None or self.t_max_mjd is None:
            return None
        mid = datetime(1858, 11, 17) + timedelta(days=(self.t_min_mjd + self.t_max_mjd) / 2)
        start = datetime(mid.year, 1, 1)
        return mid.year + (mid - start).total_seconds() / (datetime(mid.year + 1, 1, 1) - start).total_seconds()

    def public(self) -> dict:
        return {
            "version": self.version,
            "tiles": f"/hips/{self.version}",
            "title": self.title,
            "release_date": self.release_date,
            "wavelengths_um": self.wavelengths_um,
            "blank_frames": self.blank_frames,
            "min_order": self.min_order,
            "max_order": self.max_order,
            "tile_size": self.tile_size,
            "frame": self.frame,
            "format": self.format,
            "date_range": self.date_range(),
        }


def parse_properties(text: str) -> dict[str, str]:
    props: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        props[key.strip()] = value.strip()
    return props


class TileStore:
    def __init__(self) -> None:
        self.client: httpx.AsyncClient | None = None
        self._survey: Survey | None = None
        self._survey_lock = asyncio.Lock()
        self._refreshing: asyncio.Task | None = None
        self._inflight: dict[str, asyncio.Task] = {}
        self._missing: dict[str, float] = {}
        self._slots = asyncio.Semaphore(UPSTREAM_SLOTS)
        self._warm_slots = asyncio.Semaphore(WARM_SLOTS)
        self._background: set[asyncio.Task] = set()
        self._disk_bytes = 0
        self._pruning = False
        self.stats = {"disk_hits": 0, "downloads": 0, "upstream_404": 0, "upstream_errors": 0, "bytes_downloaded": 0}

    # ------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        self.client = httpx.AsyncClient(
            limits=httpx.Limits(max_connections=UPSTREAM_SLOTS, max_keepalive_connections=UPSTREAM_SLOTS, keepalive_expiry=120),
            timeout=httpx.Timeout(15, connect=6),
            headers={"User-Agent": "SkyShift-tile-cache/1.0"},
            follow_redirects=True,
        )
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        self._survey = self._load_saved_survey()
        self._disk_bytes = await asyncio.to_thread(_tree_size, CACHE_DIR)
        # Don't block startup on IRSA: learn about the survey in the background.
        self._spawn(self._refresh_quietly())

    async def stop(self) -> None:
        for task in list(self._background) + list(self._inflight.values()):
            task.cancel()
        if self.client:
            await self.client.aclose()

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return task

    # ------------------------------------------------------------ survey metadata

    async def survey(self) -> Survey:
        s = self._survey
        if s is not None:
            if time.time() - s.fetched_at > SURVEY_TTL and (self._refreshing is None or self._refreshing.done()):
                self._refreshing = self._spawn(self._refresh_quietly())  # serve stale, refresh behind
            return s
        async with self._survey_lock:
            if self._survey is None:
                try:
                    self._survey = await self._fetch_survey()
                except (httpx.HTTPError, UpstreamError, ValueError) as e:
                    raise HTTPException(503, f"Can't reach the SPHEREx archive right now ({type(e).__name__}).") from e
            return self._survey

    async def _refresh_quietly(self) -> None:
        try:
            async with self._survey_lock:
                self._survey = await self._fetch_survey()
        except Exception as e:  # keep serving what we have (works offline from the disk cache)
            log.warning("Could not refresh survey metadata from %s: %r", UPSTREAM, e)
            if self._survey is not None:
                self._survey.fetched_at = time.time() - SURVEY_TTL + 60  # try again in a minute

    async def _fetch_survey(self) -> Survey:
        r = await self.client.get(f"{UPSTREAM}/properties")
        if r.status_code != 200:
            raise UpstreamError(f"properties -> HTTP {r.status_code}")
        p = parse_properties(r.text)
        release = p.get("hips_release_date") or p.get("hips_creation_date") or "unknown"
        version = re.sub(r"[^0-9A-Za-z]", "", release) or "v0"

        depth = int(p.get("hips_cube_depth", "1"))
        wavelengths = [float(x) for x in p.get("data_cube_crval3_arr", "").split()]
        if len(wavelengths) != depth:  # no per-frame list published: spread evenly over the band
            lo, hi = float(p.get("em_min", 0.75e-6)) * 1e6, float(p.get("em_max", 5.0e-6)) * 1e6
            wavelengths = [round(lo + (hi - lo) * (i + 0.5) / depth, 3) for i in range(depth)]

        formats = p.get("hips_tile_format", "png").split()
        fmt = next((f for f in ("png", "webp", "jpeg") if f in formats), formats[0])
        s = Survey(
            version=version,
            title=p.get("obs_title", "SPHEREx all-sky"),
            release_date=release,
            wavelengths_um=wavelengths,
            blank_frames=[],
            min_order=int(p.get("hips_order_min", "0")),
            max_order=int(p["hips_order"]),
            tile_size=int(p.get("hips_tile_width", "512")),
            frame=p.get("hips_frame", "equatorial"),
            format=fmt,
            t_min_mjd=float(p["t_min"]) if "t_min" in p else None,
            t_max_mjd=float(p["t_max"]) if "t_max" in p else None,
            fetched_at=time.time(),
        )
        old = self._survey
        if old is not None and old.version == version:
            s.blank_frames = old.blank_frames  # same release: no need to probe again
        else:
            s.blank_frames = await self._find_blank_frames(s)
            if old is not None:
                log.info("New SPHEREx release detected: %s -> %s", old.version, version)
        await asyncio.to_thread(self._save_survey, s)
        if old is not None and old.version != version:
            self._spawn(asyncio.to_thread(shutil.rmtree, CACHE_DIR / old.version, True))
        return s

    async def _find_blank_frames(self, s: Survey) -> list[int]:
        """Some frames are empty in the cube (the dichroic channels) and simply have no tiles."""
        async def is_blank(frame: int) -> bool:
            url = f"{UPSTREAM}/Norder{s.min_order}/Dir0/Npix0{s.suffix(frame)}.{s.format}"
            for attempt in range(RETRIES):
                try:
                    async with self._slots:
                        r = await self.client.head(url)
                    if r.status_code in (200, 404):
                        return r.status_code == 404
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.3 * (attempt + 1))
            return False  # unknown: assume it has data

        flags = await asyncio.gather(*(is_blank(k) for k in range(s.depth)))
        return [k for k, blank in enumerate(flags) if blank]

    def _load_saved_survey(self) -> Survey | None:
        try:
            data = json.loads((CACHE_DIR / "survey.json").read_text())
            if data.pop("upstream", None) != UPSTREAM:
                return None
            return Survey(**data)
        except (OSError, ValueError, TypeError):
            return None

    def _save_survey(self, s: Survey) -> None:
        _atomic_write(CACHE_DIR / "survey.json", json.dumps({**asdict(s), "upstream": UPSTREAM}).encode())

    # ------------------------------------------------------------ files

    def local_path(self, s: Survey, rel: str) -> Path:
        return CACHE_DIR / s.version / rel

    async def get(self, s: Survey, rel: str, *, warm: bool = False) -> bytes | Path | None:
        """Return a cached file's path, freshly downloaded bytes, or None if IRSA has no such file.
        Concurrent requests for the same file share one download."""
        path = self.local_path(s, rel)
        if path.is_file():
            self.stats["disk_hits"] += 1
            return path
        key = f"{s.version}/{rel}"
        seen_missing = self._missing.get(key)
        if seen_missing is not None:
            if time.time() - seen_missing < MISSING_TTL:
                return None
            del self._missing[key]
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._download(key, rel, path, warm))
            self._inflight[key] = task
            task.add_done_callback(lambda t, key=key: self._download_done(key, t))
        # shield: a browser that gives up must not cancel a download others are waiting for
        return await asyncio.shield(task)

    def _download_done(self, key: str, task: asyncio.Task) -> None:
        self._inflight.pop(key, None)
        if not task.cancelled():
            task.exception()  # mark as retrieved

    async def _download(self, key: str, rel: str, path: Path, warm: bool) -> bytes | None:
        if warm:
            async with self._warm_slots:
                return await self._download_now(key, rel, path)
        return await self._download_now(key, rel, path)

    async def _download_now(self, key: str, rel: str, path: Path) -> bytes | None:
        url = f"{UPSTREAM}/{rel}"
        last: Exception | None = None
        for attempt in range(RETRIES):
            try:
                async with self._slots:
                    r = await self.client.get(url)
                if r.status_code == 200:
                    data = r.content
                    await asyncio.to_thread(_atomic_write, path, data)
                    self.stats["downloads"] += 1
                    self.stats["bytes_downloaded"] += len(data)
                    self._account(len(data))
                    return data
                if r.status_code == 404:
                    self._missing[key] = time.time()
                    self.stats["upstream_404"] += 1
                    return None
                last = UpstreamError(f"HTTP {r.status_code}")
            except httpx.HTTPError as e:
                last = e
            await asyncio.sleep(0.25 * 3**attempt)
        self.stats["upstream_errors"] += 1
        log.warning("Giving up on %s: %r", url, last)
        raise UpstreamError(f"{rel}: {last!r}")

    # ------------------------------------------------------------ disk budget

    def _account(self, nbytes: int) -> None:
        self._disk_bytes += nbytes
        if self._disk_bytes > CACHE_MAX_BYTES and not self._pruning:
            self._pruning = True
            self._spawn(self._prune())

    async def _prune(self) -> None:
        try:
            keep = self._survey.version if self._survey else None
            self._disk_bytes = await asyncio.to_thread(_prune_tree, CACHE_DIR, int(CACHE_MAX_BYTES * 0.8), keep)
        finally:
            self._pruning = False

    # ------------------------------------------------------------ look-ahead

    def warm(self, s: Survey, rels: list[str]) -> int:
        """Start fetching files we expect to be asked for soon. Returns how many were not cached yet."""
        todo = [rel for rel in rels if not self.local_path(s, rel).is_file()]
        for rel in todo:
            self._spawn(self._warm_one(s, rel))
        return len(todo)

    async def _warm_one(self, s: Survey, rel: str) -> None:
        try:
            await self.get(s, rel, warm=True)
        except UpstreamError:
            pass


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _walk_files(root: Path):
    stack = [root]
    while stack:
        try:
            with os.scandir(stack.pop()) as it:
                for entry in it:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(Path(entry.path))
                    elif entry.is_file(follow_symlinks=False):
                        yield entry
        except OSError:
            continue


def _tree_size(root: Path) -> int:
    return sum(e.stat().st_size for e in _walk_files(root))


def _prune_tree(root: Path, target_bytes: int, keep_version: str | None) -> int:
    """Delete other releases first, then least-recently-used files, until we fit. Returns bytes left."""
    for child in root.iterdir():
        if child.is_dir() and child.name != keep_version:
            shutil.rmtree(child, ignore_errors=True)
    files = []
    for e in _walk_files(root):
        if e.name == "survey.json":
            continue
        st = e.stat()
        files.append((max(st.st_atime, st.st_mtime), st.st_size, e.path))
    total = sum(size for _, size, _ in files)
    files.sort()
    for _, size, path in files:
        if total <= target_bytes:
            break
        try:
            os.unlink(path)
            total -= size
        except OSError:
            pass
    log.info("Tile cache pruned to %.2f GB", total / 1e9)
    return total


store = TileStore()
router = APIRouter()

MEDIA_TYPES = {"png": "image/png", "jpeg": "image/jpeg", "jpg": "image/jpeg", "webp": "image/webp"}


async def _serve(s: Survey, rel: str, media_type: str) -> Response:
    try:
        found = await store.get(s, rel)
    except UpstreamError:
        return Response("The SPHEREx archive did not answer; try again shortly.", status_code=502, headers=NO_STORE)
    if found is None:
        return Response("No such tile.", status_code=404, headers=SHORT)
    if isinstance(found, Path):
        return FileResponse(found, media_type=media_type, headers=IMMUTABLE)
    return Response(found, media_type=media_type, headers=IMMUTABLE)


def _check_frame(s: Survey, frame: int) -> None:
    if not 0 <= frame < s.depth:
        raise HTTPException(404, f"Frame must be 0..{s.depth - 1}.")


def _tile_rel(s: Survey, frame: int, order: int, ipix: int) -> str:
    return f"Norder{order}/Dir{ipix // 10000 * 10000}/Npix{ipix}{s.suffix(frame)}.{s.format}"


@router.get("/api/survey")
async def survey_info(response: Response):
    response.headers["Cache-Control"] = "no-cache"
    return (await store.survey()).public()


@router.get("/api/cache")
async def cache_info():
    return {**store.stats, "disk_bytes": store._disk_bytes, "disk_budget_bytes": CACHE_MAX_BYTES,
            "in_flight": len(store._inflight), "cache_dir": str(CACHE_DIR)}


@router.get("/api/warm")
async def warm(
    frames: str = Query(..., pattern=r"^\d{1,4}(,\d{1,4}){0,15}$", description="comma-separated frame numbers"),
    order: int = Query(..., ge=0, le=29),
    pix: str = Query(..., pattern=r"^\d{1,12}(,\d{1,12}){0,127}$", description="comma-separated HEALPix tile numbers"),
    allsky: bool = False,
):
    """The frontend calls this just before it needs tiles (next wavelength in a sweep, the
    destination of a fly-to). It returns immediately; downloads continue in the background
    and the tile requests that follow simply join them."""
    s = await store.survey()
    if not s.min_order <= order <= s.max_order:
        raise HTTPException(400, "order out of range")
    npix = 12 * 4**order
    rels: list[str] = []
    for frame in dict.fromkeys(int(f) for f in frames.split(",")):
        if not 0 <= frame < s.depth or frame in s.blank_frames:
            continue
        if allsky:
            rels.append(f"Norder3/Allsky{s.suffix(frame)}.{s.format}")
        cells = [int(p) for p in dict.fromkeys(pix.split(",")) if int(p) < npix]
        rels += [_tile_rel(s, frame, order, p) for p in cells]
        if order - 3 >= s.min_order:
            # Aladin also asks for each tile's ancestor three levels up (its blurry stand-in).
            rels += [_tile_rel(s, frame, order - 3, p) for p in dict.fromkeys(c >> 6 for c in cells)]
    return {"scheduled": store.warm(s, rels[:WARM_MAX_TILES])}


@router.get("/hips/{version}/{frame}/Norder{order}/Dir{directory}/Npix{ipix}.{ext}")
async def tile(version: str, frame: int, order: int, directory: int, ipix: int, ext: str):
    s = await store.survey()
    _check_frame(s, frame)
    if ext != s.format or not s.min_order <= order <= s.max_order or not 0 <= ipix < 12 * 4**order:
        return Response("No such tile.", status_code=404, headers=SHORT)
    return await _serve(s, _tile_rel(s, frame, order, ipix), MEDIA_TYPES.get(s.format, "application/octet-stream"))


@router.get("/hips/{version}/{frame}/Norder3/Allsky.{ext}")
async def allsky(version: str, frame: int, ext: str):
    s = await store.survey()
    _check_frame(s, frame)
    if ext != s.format:
        return Response("No such file.", status_code=404, headers=SHORT)
    return await _serve(s, f"Norder3/Allsky{s.suffix(frame)}.{s.format}", MEDIA_TYPES.get(s.format, "application/octet-stream"))


@router.get("/hips/{version}/{frame}/Moc.fits")
async def moc(version: str, frame: int):
    s = await store.survey()
    _check_frame(s, frame)
    return await _serve(s, "Moc.fits", "application/fits")


@router.get("/hips/{version}/{frame}/properties")
async def properties(version: str, frame: int):
    """Each frame is a valid stand-alone HiPS, so any HiPS client can load it by URL."""
    s = await store.survey()
    _check_frame(s, frame)
    wl = s.wavelengths_um[frame]
    lines = {
        "creator_did": f"ivo://skyshift/spherex/{s.version}/frame{frame}",
        "obs_title": f"{s.title}: {wl:g} um (frame {frame})",
        "dataproduct_type": "image",
        "hips_version": "1.4",
        "hips_release_date": s.release_date,
        "hips_frame": s.frame,
        "hips_order": s.max_order,
        "hips_order_min": s.min_order,
        "hips_tile_width": s.tile_size,
        "hips_tile_format": s.format,
        "hips_status": "public mirror unclonable",
        "obs_regime": "Infrared",
        "em_min": f"{wl * 1e-6:.6e}",
        "em_max": f"{wl * 1e-6:.6e}",
        "prov_progenitor": UPSTREAM,
        # No moc_sky_fraction on purpose: Aladin skips drawing whatever lies under a layer
        # that claims to cover the whole sky, and the frontend relies on the previous
        # wavelength staying visible underneath while the next one loads.
    }
    body = "".join(f"{k:<20} = {v}\n" for k, v in lines.items())
    return Response(body, media_type="text/plain", headers=IMMUTABLE)
