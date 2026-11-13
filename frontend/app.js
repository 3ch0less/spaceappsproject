/* SkyShift frontend.
 *
 * The sky is rendered with Aladin Lite v3. NASA's SPHEREx all-sky map has 102 wavelength
 * frames; our backend serves each frame as its own ordinary HiPS image survey (see
 * backend/tiles.py), cached on disk, and this file shows one frame at a time as an image
 * layer. Search goes through /api/resolve, which knows about stars & galaxies (SIMBAD),
 * planets and asteroids (JPL Horizons) and coordinates.
 */

// Keep in sync with the <link rel="modulepreload"> in index.html.
const ALADIN_URL = "https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js";
let A; // Aladin Lite, loaded in boot() so a failure can be shown on screen

// ------------------------------------------------------------------ config
const API = location.protocol === "file:" ? "http://localhost:8000" : "";
const START = { ra: 266.4168, dec: -29.0078, fov: 140 }; // centre of the Milky Way
const DEFAULT_WL = 1.66;        // µm: pretty Milky Way, dust mostly see-through
const SWEEP_MS = 160;           // fastest the wavelength sweep will step
const DRIFT_DEG_PER_S = 1.8;    // slow auto-rotate on the welcome screen

// The challenge's test targets plus a few crowd-pleasers.
const FEATURED = [
  { label: "Barnard's Star", q: "Barnard's Star", fov: 0.5,
    blurb: "The fastest-moving star in our sky, just 6 light-years away. It creeps about 10 arcseconds every year, enough to shift between SPHEREx's sky maps." },
  { label: "Epsilon Indi B", q: "eps Ind B", fov: 0.5,
    blurb: "A pair of brown dwarfs orbiting the star Epsilon Indi, 12 light-years away. Brown dwarfs are too heavy to be planets and too light to be stars. They glow mostly in infrared." },
  { label: "WISE 0855", q: "WISE J085510.83-071442.5", fov: 0.4, name: "WISE 0855−0714",
    blurb: "The coldest brown dwarf known, about as cold as the North Pole. Invisible to the eye, it only shows up at the longest infrared wavelengths. Try sliding toward 4.5 µm." },
  { label: "RW Aurigae", q: "RW Aur", fov: 0.5,
    blurb: "A young star still wrapped in its birth disk. Clumps of dust passing in front of it make it brighten and fade unpredictably." },
  { label: "R Draconis", q: "R Dra", fov: 0.5,
    blurb: "A pulsating giant star that swells and shrinks, changing brightness on an eight-month cycle." },
  { label: "Orion Nebula", q: "M42", fov: 2,
    blurb: "A stellar nursery 1,300 light-years away. Infrared light shines through its dust to reveal the newborn stars inside." },
  { label: "Andromeda Galaxy", q: "M31", fov: 4,
    blurb: "Our neighbour galaxy, 2.5 million light-years away, with about a trillion stars." },
  { label: "Jupiter", q: "Jupiter",
    blurb: "Planets wander against the stars. The line shows where Jupiter travelled while SPHEREx was mapping the sky." },
  { label: "Ceres", q: "Ceres",
    blurb: "The largest object in the asteroid belt, a dwarf planet 940 km across." },
];

// ------------------------------------------------------------------ dom helpers
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, text) => {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => (n[k] = v));
  if (text != null) n.textContent = text;
  return n;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ------------------------------------------------------------------ state
let aladin;
let survey;               // /api/survey: release version, tile URL, wavelengths, blank frames…
let wavelengths = [];     // µm, one per frame
let blankFrames = new Set();
let tileBase = "";        // absolute URL of the tile tree; frame k lives at `${tileBase}/${k}`
let frame = 0;            // the wavelength frame the UI is asking for
let colormap = "magma";
let targetOverlay, targetCatalog;
let current = null;       // last resolved target
let sweeping = false;     // wavelength sweep animation
let drifting = false;     // slow auto-rotate on the welcome screen
let urlTimer, viewTimer, searchTicket = 0;
const urlParams = new URLSearchParams(location.search);
const hasUrlState = [...urlParams.keys()].length > 0; // (URLSearchParams.size is missing in older Safari)

// ------------------------------------------------------------------ boot
// Any crash shows up on screen instead of leaving a silent black page.
window.addEventListener("error", (e) => showFatal(e.error || e.message, true));
window.addEventListener("unhandledrejection", (e) => showFatal(e.reason, true));

function showFatal(err, soft = false) {
  const msg = String(err?.message || err || "Unknown error");
  // Harmless: a background request that didn't get through (Aladin's usage logger, a catalog
  // service being down) and a wavelength layer that failed to load (handled in swapLayers).
  // Each browser words a failed request differently: Chrome "Failed to fetch", Safari
  // "Load failed", Firefox "NetworkError when attempting to fetch resource".
  if (soft && /Failed to fetch|Load failed|NetworkError|AladinLiteLogger|^HiPS .* error/i.test(msg)) return;
  console.error(err);
  let help = "Try a hard refresh (Ctrl+Shift+R). If it keeps happening, open the browser console (F12) and send the error to the team.";
  if (/webgl/i.test(msg)) {
    help = "This sky viewer needs WebGL2 (3D graphics). In Chrome go to Settings → System, turn on “Use graphics acceleration when available”, relaunch, then check chrome://gpu shows WebGL2 as “Hardware accelerated”.";
  } else if (/backend/i.test(msg)) {
    help = "The SkyShift backend isn't answering. Start it from the backend/ folder with “uvicorn main:app --port 8000”, then reload this page.";
  } else if (/import|module|dynamically/i.test(msg)) {
    help = "The sky viewer library couldn't be downloaded from cdn.jsdelivr.net. Check your internet connection or whether a network filter is blocking it.";
  }
  const box = $("#fatal");
  box.querySelector("p").textContent = help;
  box.querySelector("code").textContent = msg;
  box.hidden = false;
}

async function loadSurvey() {
  let r;
  try {
    r = await fetch(`${API}/api/survey`);
  } catch (e) {
    throw new Error(`Backend unreachable (${e.message})`);
  }
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch {}
    throw new Error(`Backend: ${detail}`);
  }
  return r.json();
}

// ------------------------------------------------------------------ wavelengths
function hintFor(wl) {
  if (wl < 0.95) return "Just past the red light your eyes can see";
  if (wl < 1.6) return "Near-infrared: starts to see through cosmic dust";
  if (wl < 2.4) return "Dust turns see-through, revealing the hidden heart of the Milky Way";
  if (wl < 2.85) return "Light from warm dust and cool stars";
  if (wl < 3.15) return "Water ice absorbs light here";
  if (wl < 3.45) return "Glow from soot-like PAH molecules. Methane makes brown dwarfs dark here";
  if (wl < 4.15) return "Hot dust around young stars shines";
  if (wl < 4.4) return "Carbon dioxide ice absorbs light here";
  if (wl < 4.6) return "Cold brown dwarfs glow brightest here";
  return "Carbon monoxide; the longest, coldest light SPHEREx sees";
}

// Nearest frame that has data, looking in `dir` first (some frames are empty in the map).
function usableFrame(i, dir = 1) {
  const n = wavelengths.length;
  i = clamp(Math.round(i), 0, n - 1);
  for (let step = 0; step < n && blankFrames.has(i); step++) {
    i += dir;
    if (i < 0 || i >= n) { dir = -dir; i = clamp(i, 0, n - 1); }
  }
  return i;
}
const nextFrame = (i) => usableFrame(i + 1 >= wavelengths.length ? 0 : i + 1, 1);

function pickInitialFrame() {
  const wl = parseFloat(urlParams.get("wl")) || DEFAULT_WL;
  let best = 0;
  wavelengths.forEach((w, i) => { if (Math.abs(w - wl) < Math.abs(wavelengths[best] - wl)) best = i; });
  return usableFrame(best);
}

function updateWavelengthUi() {
  const wl = wavelengths[frame];
  const perDetector = wavelengths.length / 6; // SPHEREx has 6 detector arrays
  const detector = Number.isInteger(perDetector) ? ` · detector ${Math.floor(frame / perDetector) + 1}` : "";
  $("#wl-slider").value = frame;
  $("#wl-label").textContent = `${wl.toFixed(2)} µm${detector}`;
  $("#wl-hint").textContent = hintFor(wl);
  $("#wl-label").classList.toggle("loading", sky.shown.frame !== frame);
}

// ------------------------------------------------------------------ wavelength layers
// Changing wavelength must never blank the sky. So the new frame's layer is put ON TOP of
// the one being shown, we wait until its tiles are actually on screen, and only then is the
// old layer removed. If the slider has moved on in the meantime we go straight to the
// newest request, so dragging stays responsive.
const FADE_MS = 230;          // Aladin fades each new tile in over 200 ms
const IMPATIENT_MS = 400;     // a layer with nothing to show yet is dropped after this if the user already wants another
const GIVE_UP_MS = 12000;

function makeLayer(k) {
  const url = `${tileBase}/${k}`;
  // Aladin reads the rest (tile size, depth, frame) from `${url}/properties`, which the
  // browser caches for good, so creating a layer costs no network round trip after the first.
  // seen: tiles that finished downloading; lastTile: when the latest good one did; bad: tiles that came back as errors
  const rec = { frame: k, hips: null, tilePrefix: `${url}/Norder`, seen: new Set(), lastTile: 0, bad: 0, failed: false, addedAt: performance.now() };
  rec.hips = A.HiPS(url, {
    name: `SPHEREx ${wavelengths[k].toFixed(2)} µm`,
    imgFormat: survey.format,
    colormap,
    errorCallback: () => {
      rec.failed = true;
      if (sky.shown === rec) showFatal(new Error("Backend: the sky tiles could not be loaded"));
    },
  });
  return rec;
}

const tileUrl = (k, order, ipix) =>
  `${tileBase}/${k}/Norder${order}/Dir${Math.floor(ipix / 10000) * 10000}/Npix${ipix}.${survey.format}`;

// Which tiles the current view needs (the same rule Aladin applies internally).
function tilesInView() {
  try {
    const w = aladin.view.wasm;
    const order = clamp(w.getNOrder(), survey.min_order, survey.max_order);
    return { order, pix: Array.from(w.getVisibleCells(order), (c) => Number(c.ipix)) };
  } catch {
    return null; // Aladin internals changed: we fall back to timing alone
  }
}

// The browser tells us whenever a tile finishes downloading; that is how we know a layer has arrived.
function watchTiles() {
  if (!("PerformanceObserver" in window)) return;
  new PerformanceObserver((list) => {
    for (const rec of [sky.pending, sky.shown]) {
      if (!rec) continue;
      for (const e of list.getEntries()) {
        // Only real tiles count; the big all-sky preview trails in later and isn't worth waiting for.
        if (!e.name.startsWith(rec.tilePrefix) || !e.name.includes("/Npix")) continue;
        rec.seen.add(e.name);
        if (e.responseStatus >= 400) rec.bad++;
        else rec.lastTile = performance.now();
      }
    }
  }).observe({ type: "resource" });
}

function layerOnScreen(rec) {
  const now = performance.now();
  if (!rec.lastTile) return now - rec.addedAt > 2500 && !("PerformanceObserver" in window);
  if (now - rec.lastTile < FADE_MS) return false;      // last tile is still fading in
  if (now - rec.lastTile > 1500) return true;          // nothing more is coming
  const view = tilesInView();
  return !view || view.pix.every((p) => rec.seen.has(tileUrl(rec.frame, view.order, p)));
}

function waitForLayer(rec) {
  return new Promise((resolve) => {
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      // Browsers pause drawing in background tabs; don't count that time against the layer.
      if (document.hidden) rec.addedAt += now - last;
      last = now;
      const age = now - rec.addedAt;
      if (rec.failed || (rec.bad && !rec.lastTile && age > 2000)) return resolve("failed");
      if (rec.hips.added) {
        if (layerOnScreen(rec)) return resolve("ready");
        // Once its tiles have started arriving it is quicker to finish than to start over.
        if (frame !== rec.frame && age > IMPATIENT_MS && !rec.lastTile) return resolve("unwanted");
      }
      if (age > GIVE_UP_MS) return resolve(rec.lastTile ? "ready" : "failed");
      setTimeout(tick, 40);
    };
    tick();
  });
}

function dropLayer(rec) {
  const name = rec.hips.layer;
  try { aladin.removeImageLayer(name); } catch (e) { console.warn("removeImageLayer", e); }
  try {
    // A layer that failed while being added leaves its name behind in Aladin's list.
    const names = aladin.view.overlayLayers, i = names.indexOf(name);
    if (i >= 0 && !aladin.view.imageLayers.has(name)) names.splice(i, 1);
  } catch {}
}

async function swapLayers() {
  while (sky.shown.frame !== frame) {
    const rec = makeLayer(frame);
    sky.pending = rec;
    warm([rec.frame], tilesInView(), true);
    aladin.setOverlayImageLayer(rec.hips, `wl-${++sky.count}`);
    const outcome = await waitForLayer(rec);
    sky.pending = null;
    if (outcome === "ready") {
      const old = sky.shown;
      sky.shown = rec;
      dropLayer(old);
    } else {
      // Aladin adds layers asynchronously; make sure it's really in before taking it out again.
      for (let i = 0; i < 50 && !rec.hips.added && !rec.failed; i++) await sleep(20);
      dropLayer(rec);
      if (outcome === "failed" && frame === rec.frame) {
        frame = sky.shown.frame; // stay on what we can show
        toast("That wavelength didn't load. Check your connection and try again.", 5000);
      }
    }
    updateWavelengthUi();
  }
  scheduleNeighbourWarm();
}

// Ask for wavelength frame i. Resolves (true = shown) once the sky has caught up.
function showFrame(i, updateUrl = true) {
  frame = usableFrame(i, i >= frame ? 1 : -1);
  updateWavelengthUi();
  if (updateUrl) syncUrl();
  sky.running ??= swapLayers()
    .catch((e) => { console.error(e); frame = sky.shown.frame; updateWavelengthUi(); })
    .finally(() => (sky.running = null));
  const wanted = frame;
  return sky.running.then(() => sky.shown.frame === wanted);
}

function setColormap(name) {
  colormap = name;
  for (const rec of [sky.shown, sky.pending]) rec?.hips.setColormap(name);
}

async function toggleSweep() {
  const btn = $("#wl-play");
  if (sweeping) { sweeping = false; return; }
  sweeping = true;
  btn.textContent = "❚❚";
  while (sweeping) {
    const started = performance.now(), before = frame;
    const next = nextFrame(frame);
    // Have the backend fetch the frames after this one while we show it.
    const ahead = [next];
    for (let i = 0; i < 4; i++) ahead.push(nextFrame(ahead.at(-1)));
    warm(ahead.slice(1), tilesInView());
    const ok = await showFrame(next, false);
    if (!ok && frame === before) break; // it could not load: stop instead of retrying forever
    await sleep(Math.max(0, SWEEP_MS - (performance.now() - started)));
  }
  sweeping = false;
  btn.textContent = "▶";
  syncUrl();
}

// ------------------------------------------------------------------ tile look-ahead
// Tell the backend which tiles we are about to need. It starts downloading them from IRSA
// right away (many in parallel), so they are on its disk by the time Aladin asks.
function warm(frames, view, allsky = false) {
  frames = [...new Set(frames)].filter((k) => !blankFrames.has(k));
  if (!view || !view.pix.length || !frames.length) return;
  const q = `frames=${frames.join(",")}&order=${view.order}&pix=${view.pix.slice(0, 128).join(",")}${allsky ? "&allsky=true" : ""}`;
  fetch(`${API}/api/warm?${q}`, { priority: "low" }).catch(() => {});
}

// Scrubbing the slider around a target should feel instant: once the view has been still for
// a moment, fetch the neighbouring wavelengths for it (only when that is a handful of tiles).
let neighbourTimer;
function scheduleNeighbourWarm() {
  clearTimeout(neighbourTimer);
  neighbourTimer = setTimeout(() => {
    const view = tilesInView();
    if (drifting || sweeping || !view || view.pix.length > 6) return;
    const around = [-2, -1, 1, 2].map((d) => frame + d).filter((k) => k >= 0 && k < wavelengths.length);
    warm(around, view);
  }, 900);
}

// HEALPix (nested scheme) tile that contains a sky position: the standard ang2pix algorithm.
function healpixTile(order, raDeg, decDeg) {
  const nside = 2 ** order;
  const z = Math.sin((decDeg * Math.PI) / 180), za = Math.abs(z);
  const tt = (((raDeg / 90) % 4) + 4) % 4;
  let face, ix, iy;
  if (za <= 2 / 3) {
    const t1 = nside * (0.5 + tt), t2 = nside * z * 0.75;
    const jp = Math.floor(t1 - t2), jm = Math.floor(t1 + t2);
    const ifp = Math.floor(jp / nside), ifm = Math.floor(jm / nside);
    face = ifp === ifm ? (ifp & 3) + 4 : ifp < ifm ? ifp & 3 : (ifm & 3) + 8;
    ix = jm & (nside - 1);
    iy = nside - (jp & (nside - 1)) - 1;
  } else {
    const ntt = Math.min(3, Math.floor(tt)), tp = tt - ntt, tmp = nside * Math.sqrt(3 * (1 - za));
    const jp = Math.min(nside - 1, Math.floor(tp * tmp)), jm = Math.min(nside - 1, Math.floor((1 - tp) * tmp));
    if (z >= 0) { face = ntt; ix = nside - jm - 1; iy = nside - jp - 1; }
    else { face = ntt + 8; ix = jp; iy = jm; }
  }
  let inFace = 0;
  for (let b = 0; b < order; b++) inFace += (((ix >> b) & 1) + 2 * ((iy >> b) & 1)) * 4 ** b;
  return face * nside * nside + inFace;
}

// The tiles a view centred on (ra, dec) with this field of view will need, before we are there.
function tilesAround(ra, dec, fov) {
  const size = aladin.getSize?.() || [innerWidth, innerHeight];
  // Aladin picks the first order whose tiles are at least as sharp as the screen.
  const order = clamp(Math.ceil(Math.log2((58.63 * size[0]) / (survey.tile_size * fov))), survey.min_order, survey.max_order);
  const halfW = fov / 2, halfH = (fov * size[1]) / size[0] / 2;
  const cosDec = Math.max(0.05, Math.cos((dec * Math.PI) / 180));
  const pix = new Set();
  for (let i = -4; i <= 4; i++) {
    for (let j = -4; j <= 4; j++) {
      const d = clamp(dec + (j / 4) * halfH, -90, 90);
      pix.add(healpixTile(order, ra + ((i / 4) * halfW) / cosDec, d));
    }
  }
  return { order, pix: [...pix] };
}

// ------------------------------------------------------------------ search
const resolved = new Map(); // query -> promise, so repeat searches (and the featured chips) are instant
function resolve(q) {
  const key = q.trim().toLowerCase();
  if (!resolved.has(key)) {
    const p = (async () => {
      const r = await fetch(`${API}/api/resolve?q=${encodeURIComponent(q)}`);
      if (!r.ok) {
        let msg = `Couldn't find “${q}”.`;
        try { msg = (await r.json()).detail || msg; } catch {}
        throw new Error(msg);
      }
      return r.json();
    })();
    resolved.set(key, p);
    p.catch(() => resolved.delete(key)); // let a failed lookup be retried
    setTimeout(() => resolved.delete(key), 10 * 60 * 1000); // planets move: don't keep answers forever
  }
  return resolved.get(key);
}

// Look the featured targets up in the background, so clicking a chip flies there immediately.
function warmFeatured() {
  const run = async () => {
    for (const f of FEATURED) {
      try { await resolve(f.q); } catch {}
    }
  };
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 1500)))(run);
}

async function search(q, featured = null, fovOverride = null) {
  q = q.trim();
  if (!q) return;
  const ticket = ++searchTicket;
  stopIdleDrift();
  $("#welcome").hidden = true;
  $("#suggestions").hidden = true;
  $("#search-input").value = featured?.label || q;
  toast(`Looking for ${featured?.label || q}…`, 20000);
  try {
    const t = { ...(await resolve(q)) };
    if (ticket !== searchTicket) return; // a newer search took over
    if (featured?.name) t.name = featured.name;
    if (featured?.label && t.kind === "coordinates") t.name = featured.label;
    current = { ...t, query: q, blurb: featured?.blurb };
    $("#toast").hidden = true;
    showTarget(current, fovOverride || featured?.fov);
  } catch (e) {
    if (ticket === searchTicket) toast(e.message || "Search failed: is the backend running?", 5000);
  }
}

function fovFor(t, override) {
  if (override) return override;
  if (t.path?.length > 1) {
    const ras = t.path.map((p) => p.ra), decs = t.path.map((p) => p.dec);
    // Handle paths crossing RA=0 by using unwrapped spread if smaller.
    const spreadRa = Math.min(Math.max(...ras) - Math.min(...ras),
      Math.max(...ras.map((r) => (r + 180) % 360)) - Math.min(...ras.map((r) => (r + 180) % 360)));
    const spread = Math.max(spreadRa * Math.cos((t.dec * Math.PI) / 180), Math.max(...decs) - Math.min(...decs));
    return Math.min(120, Math.max(3, spread * 1.4));
  }
  return 0.6;
}

function showTarget(t, fovOverride) {
  // Markers & paths
  targetOverlay.removeAll();
  targetCatalog.removeAll();
  if (t.path?.length > 1) {
    targetOverlay.add(A.polyline(t.path.map((p) => [p.ra, p.dec]), { color: "#7dd3fc", lineWidth: 2 }));
  }
  targetCatalog.addSources([A.source(t.ra, t.dec, { name: t.name })]);
  if (t.catalog_ra != null) {
    // Where catalogs put it in 2000 vs where SPHEREx saw it: the star has moved!
    targetOverlay.add(A.polyline([[t.catalog_ra, t.catalog_dec], [t.ra, t.dec]], { color: "#ffe08a", lineWidth: 2, lineDash: [4, 4] }));
    targetOverlay.add(A.circle(t.catalog_ra, t.catalog_dec, 0.004, { color: "#ffe08a", lineWidth: 1.5 }));
  }

  const fov = fovFor(t, fovOverride);
  // Start fetching the destination's tiles now; the flight there takes a few seconds anyway.
  warm([frame], tilesAround(t.ra, t.dec, fov), true);
  flyTo(t.ra, t.dec, fov);
  renderInfo(t);
  syncUrl();
  for (const key in OVERLAYS) refreshOverlay(key, { ra: t.ra, dec: t.dec, fov });
}

function flyTo(ra, dec, fov) {
  const [curFov] = aladin.getFov();
  const [cra, cdec] = aladin.getRaDec();
  const far = angularDistance(cra, cdec, ra, dec) > curFov * 0.6;
  if (far && curFov < 60) {
    // Pull back, swing over, dive in: feels like flying across the sphere.
    aladin.zoomToFoV(70, 1, () => aladin.animateToRaDec(ra, dec, 1.6, () => aladin.zoomToFoV(fov, 1.6)));
  } else {
    aladin.animateToRaDec(ra, dec, far ? 1.8 : 0.8, () => aladin.zoomToFoV(fov, 1.8));
  }
}

function angularDistance(ra1, dec1, ra2, dec2) {
  const r = Math.PI / 180;
  const c = Math.sin(dec1 * r) * Math.sin(dec2 * r) + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.cos((ra1 - ra2) * r);
  return Math.acos(Math.min(1, Math.max(-1, c))) / r;
}

// ------------------------------------------------------------------ info card
function renderInfo(t) {
  $("#info").hidden = false;
  $("#info-kind").textContent = { planet: "Solar system", "small-body": "Solar system", coordinates: "Position", "deep-sky": "Beyond the solar system" }[t.kind] || t.kind;
  $("#info-name").textContent = t.name;
  $("#info-type").textContent = t.type_label || "";
  $("#info-blurb").textContent = t.blurb || "";

  const facts = $("#info-facts");
  facts.replaceChildren();
  const add = (k, v) => { facts.append(el("dt", {}, k), el("dd", {}, v)); };
  if (t.distance_ly) add("Distance", t.distance_ly < 1000 ? `${t.distance_ly.toLocaleString()} light-years` : `${Math.round(t.distance_ly).toLocaleString()} light-years`);
  if (t.pm_total_arcsec_yr != null) {
    const yrsPerMoon = 1800 / t.pm_total_arcsec_yr; // full-moon width ≈ 1800″
    add("Moves across sky", `${t.pm_total_arcsec_yr.toFixed(2)}″ per year` + (t.pm_total_arcsec_yr > 0.5 ? ` (a full-Moon width every ${Math.round(yrsPerMoon).toLocaleString()} yrs)` : ""));
  }
  if (t.moved_arcsec_since_catalog) {
    const m = t.moved_arcsec_since_catalog;
    add("Moved since 2000", m >= 60 ? `${(m / 60).toFixed(1)} arcminutes (yellow ring = year 2000, orange = SPHEREx ${t.epoch})` : `${m}″ (yellow ring = year 2000)`);
  }
  if (t.moving) add("Position for", `${t.position_date} UTC`);
  if (t.path?.length) add("Blue line", t.path_label);
  add("Sky position", `RA ${t.ra.toFixed(4)}°, Dec ${t.dec.toFixed(4)}°`);
  if (t.aliases?.length) add("Also known as", t.aliases.filter((a) => !a.startsWith("NAME")).slice(0, 3).join(", "));
  add("Data from", t.source);
}

// ------------------------------------------------------------------ overlays
// Catalog markers around the view centre. `at` remembers where the last query was made so
// we only query again when the view has really moved away from it.
const OVERLAYS = {
  names: {
    toggle: "#tg-names", maxRadius: 1, cat: null, at: null,
    load: (centre, radius, done) => A.catalogFromSimbad(centre, radius, {
      name: "Names (SIMBAD)", onClick: "showPopup", color: "#a3f0c6", sourceSize: 10,
      displayLabel: true, labelColumn: "main_id", labelColor: "#d6ffe9", labelFont: "12px Inter, sans-serif",
      limit: 300,
    }, done, done),
  },
  gaia: {
    toggle: "#tg-gaia", maxRadius: 0.25, cat: null, at: null,
    load: (centre, radius, done) => A.catalogFromVizieR("I/355/gaiadr3", centre, radius, {
      name: "Gaia DR3", onClick: "showTable", color: "#ffe08a", sourceSize: 8, shape: "cross", limit: 2000,
    }, done, done),
  },
};

function removeCatalog(cat) {
  try { if (cat) aladin.removeOverlay(cat); } catch {}
}

// `where` = {ra, dec, fov} of the place to query; defaults to the current view.
function refreshOverlay(key, where) {
  const o = OVERLAYS[key];
  if (!$(o.toggle).checked) return;
  if (!where) {
    const [ra, dec] = aladin.getRaDec();
    where = { ra, dec, fov: aladin.getFov()[0] };
  }
  const radius = Math.min(o.maxRadius, where.fov / 2);
  const previous = o.cat;
  // The old markers stay until the new ones have arrived, so they don't blink.
  o.cat = o.load({ ra: where.ra, dec: where.dec }, radius, () => removeCatalog(previous));
  o.at = { ra: where.ra, dec: where.dec, radius };
  aladin.addCatalog(o.cat);
}

function clearOverlay(key) {
  const o = OVERLAYS[key];
  removeCatalog(o.cat);
  o.cat = o.at = null;
}

// After the view has been still for a moment, re-query overlays that it has moved away from.
function refreshOverlaysIfMoved() {
  if (drifting) return;
  const [ra, dec] = aladin.getRaDec();
  const fov = aladin.getFov()[0];
  for (const [key, o] of Object.entries(OVERLAYS)) {
    if (!$(o.toggle).checked || !o.at) continue;
    const radius = Math.min(o.maxRadius, fov / 2);
    const moved = angularDistance(ra, dec, o.at.ra, o.at.dec) > o.at.radius * 0.5;
    const rescaled = radius > o.at.radius * 1.5 || radius < o.at.radius / 2;
    if (moved || rescaled) refreshOverlay(key, { ra, dec, fov });
  }
}

// ------------------------------------------------------------------ idle drift (slow auto-rotate on the welcome screen)
function startIdleDrift() {
  if (hasUrlState) return;
  drifting = true;
  let last = performance.now();
  const step = (now) => {
    if (!drifting) return;
    const dt = Math.min(100, now - last); // same speed on 60 Hz and 120 Hz screens
    last = now;
    const [ra, dec] = aladin.getRaDec();
    aladin.gotoRaDec((ra + (DRIFT_DEG_PER_S * dt) / 1000) % 360, dec);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  ["pointerdown", "wheel", "touchstart", "keydown"].forEach((ev) =>
    window.addEventListener(ev, stopIdleDrift, { once: true, capture: true }));
}
function stopIdleDrift() { drifting = false; }

// ------------------------------------------------------------------ url state (shareable / embeddable links)
function syncUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const p = new URLSearchParams();
    if (current?.query) p.set("q", current.query);
    else {
      const [ra, dec] = aladin.getRaDec();
      p.set("ra", ra.toFixed(5));
      p.set("dec", dec.toFixed(5));
    }
    p.set("fov", aladin.getFov()[0].toFixed(3));
    p.set("wl", wavelengths[frame].toFixed(3));
    history.replaceState(null, "", `?${p}`);
  }, 400);
}

// ?ra=…&dec=…&fov=… opens directly on that patch of sky (no detour via the Milky Way).
function initialView() {
  const ra = parseFloat(urlParams.get("ra")), dec = parseFloat(urlParams.get("dec"));
  if (urlParams.get("q") || !Number.isFinite(ra) || !Number.isFinite(dec)) return START;
  return { ra, dec, fov: parseFloat(urlParams.get("fov")) || 1 };
}

function applyUrlState() {
  if (!hasUrlState) return;
  $("#welcome").hidden = true;
  const q = urlParams.get("q");
  if (q) search(q, FEATURED.find((x) => x.q === q) || null, parseFloat(urlParams.get("fov")) || null);
}

// ------------------------------------------------------------------ wiring
function buildFeatured() {
  const box = $("#featured");
  FEATURED.forEach((f) => {
    const b = el("button", { className: "chip", type: "button" }, f.label);
    b.onclick = () => search(f.q, f);
    box.append(b);
  });
}

function renderSuggestions(text) {
  const ul = $("#suggestions");
  const q = text.trim().toLowerCase();
  const items = FEATURED.filter((f) => !q || f.label.toLowerCase().includes(q));
  ul.replaceChildren();
  items.forEach((f) => {
    const li = el("li");
    li.append(el("span", {}, f.label), el("small", {}, f.q === f.label ? "" : "featured"));
    li.onmousedown = (e) => { e.preventDefault(); search(f.q, f); };
    ul.append(li);
  });
  if (q) {
    const li = el("li");
    li.append(el("span", {}, `Search “${text.trim()}”`), el("small", {}, "star, planet, asteroid, coordinates…"));
    li.onmousedown = (e) => { e.preventDefault(); search(text); };
    ul.prepend(li);
  }
  ul.hidden = !ul.children.length;
}

function wireControls() {
  const input = $("#search-input");
  $("#search").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = FEATURED.find((x) => x.label.toLowerCase() === input.value.trim().toLowerCase());
    search(f ? f.q : input.value, f || null);
  });
  input.addEventListener("focus", () => renderSuggestions(input.value));
  input.addEventListener("input", () => renderSuggestions(input.value));
  input.addEventListener("blur", () => ($("#suggestions").hidden = true));

  $("#wl-slider").addEventListener("input", (e) => showFrame(+e.target.value));
  $("#wl-play").addEventListener("click", toggleSweep);

  document.querySelectorAll("#view-seg button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#view-seg button").forEach((x) => x.classList.toggle("on", x === b));
      aladin.setProjection(b.dataset.proj);
      if (b.dataset.proj === "AIT") aladin.setFoV(360);
      if (b.dataset.proj === "TAN" && aladin.getFov()[0] > 30) aladin.zoomToFoV(10, 1);
    }));

  $("#cmap").addEventListener("change", (e) => setColormap(e.target.value));

  for (const key in OVERLAYS) {
    $(OVERLAYS[key].toggle).addEventListener("change", (e) => (e.target.checked ? refreshOverlay(key) : clearOverlay(key)));
  }

  $("#welcome-close").addEventListener("click", () => ($("#welcome").hidden = true));
  $("#info-close").addEventListener("click", () => ($("#info").hidden = true));
  $("#act-zoom").addEventListener("click", () => current && aladin.zoomToFoV(Math.max(0.15, aladin.getFov()[0] / 3), 1.2));
  $("#act-share").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link copied: anyone can open this exact view."); }
    catch { toast(location.href, 8000); }
  });

  const viewChanged = () => {
    if (drifting) return;
    syncUrl();
    scheduleNeighbourWarm();
    clearTimeout(viewTimer);
    viewTimer = setTimeout(refreshOverlaysIfMoved, 800);
  };
  aladin.on("positionChanged", viewChanged);
  aladin.on("zoomChanged", viewChanged);

  // If the graphics driver resets (laptop sleep, GPU switch) the sky cannot recover by itself.
  document.querySelectorAll("#sky canvas").forEach((c) =>
    c.addEventListener("webglcontextlost", () => showFatal("WebGL context lost: the graphics driver was reset. Reload the page.")));
}

// ------------------------------------------------------------------ start
// (Last in the file: everything above must be defined before the page starts running.)
buildFeatured(); // UI first, so the page is usable-looking even if the sky fails
try {
  // The viewer library and the survey description download side by side.
  [{ default: A }, survey] = await Promise.all([import(ALADIN_URL), loadSurvey()]);
  await A.init;
} catch (e) {
  showFatal(e);
  throw e;
}
wavelengths = survey.wavelengths_um;
blankFrames = new Set(survey.blank_frames);
tileBase = `${API || location.origin}${survey.tiles}`;
$("#wl-slider").max = wavelengths.length - 1;
frame = pickInitialFrame();

// The first wavelength layer goes in with the viewer; later ones are swapped in by showFrame().
const sky = { shown: makeLayer(frame), pending: null, running: null, count: 0 };
const startView = initialView();
aladin = A.aladin("#sky", {
  survey: sky.shown.hips,
  fov: startView.fov,
  target: `${startView.ra} ${startView.dec}`,
  projection: "SIN",
  cooFrame: "ICRSd",
  showReticle: false,
  showZoomControl: false,
  showFullscreenControl: false,
  showLayersControl: false,
  showFrame: false,
  showCooGridControl: false,
  showProjectionControl: false,
  showSettingsControl: false,
  showShareControl: false,
  showSimbadPointerControl: true,
  showCooLocation: true,
  showStatusBar: true,
  backgroundColor: "rgb(4,6,13)",
});

targetOverlay = A.graphicOverlay({ color: "#7dd3fc", lineWidth: 2 });
aladin.addOverlay(targetOverlay);
targetCatalog = A.catalog({
  name: "Target", color: "#ff8a3d", sourceSize: 26, shape: "circle",
  displayLabel: true, labelColumn: "name", labelColor: "#ffd9bd", labelFont: "600 14px Inter, sans-serif",
});
aladin.addCatalog(targetCatalog);

watchTiles();
updateWavelengthUi();
wireControls();
startIdleDrift();
applyUrlState();
warmFeatured();

// Handy for debugging in the browser console.
window.skyshift = { get aladin() { return aladin; }, get layer() { return sky.shown.hips; }, sky, survey, setFrame: showFrame, search, tilesInView, tilesAround, healpixTile };
