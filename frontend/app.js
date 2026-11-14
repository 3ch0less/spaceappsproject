/* Lumasphere frontend.
 *
 * The sky is rendered with Aladin Lite v3. NASA's SPHEREx all-sky map has 102 wavelength
 * frames; our backend serves each frame as its own ordinary HiPS image survey (see
 * backend/tiles.py), cached on disk, and this file shows one frame at a time as an image
 * layer. Search goes through /api/resolve, which knows about stars & galaxies (SIMBAD),
 * planets and asteroids (JPL Horizons) and coordinates; clicking the map asks
 * /api/identify what is there. The selected object opens in the inspector panel, whose
 * time-lapse and spectrum live in timelapse.js.
 */

import { createTimelapse } from "./timelapse.js";
import { createNames } from "./names.js";
import { createStars } from "./stars.js";
import { createFollow } from "./follow.js";

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
// `what` is the one-line description in the target list; `test` marks the challenge's own test targets.
const FEATURED = [
  // `watch` and `det` come from checking Lumasphere's own time-lapses of each target (Nov 2026):
  // what really shows, in which detector, and what doesn't.
  { label: "Barnard's Star", q: "Barnard's Star", fov: 0.5, det: 2, test: true, what: "Fastest-moving star",
    blurb: "The fastest-moving star in our sky, just 6 light-years away. It creeps about 10 arcseconds every year, enough to shift between SPHEREx's sky maps.",
    watch: "Switch the time-lapse to Difference: the red-and-blue pair at the centre is the star itself, about 10″ further north after a year (1.6 SPHEREx pixels), just as its catalogued motion predicts. Other stars show faint pairs too, because the visits line up only to about 1″; Barnard's is far stronger. It is too bright to measure how bright it is below 3.8 µm (it saturates detectors 1–4)." },
  { label: "Epsilon Indi B", q: "eps Ind B", fov: 0.5, det: 6, test: true, what: "Brown dwarf pair",
    blurb: "A pair of brown dwarfs orbiting the star Epsilon Indi, 12 light-years away. Brown dwarfs are too heavy to be planets and too light to be stars. They glow mostly in infrared.",
    watch: "Clearest in detectors 5–6 (3.8–5 µm). In Difference mode it moves about 6″ south-east over 1.4 years, matching its catalogued motion. Its first visit (spring 2025) looks brighter or fainter than the later ones in several detectors, in both directions: treat that as image artifacts. Brown dwarfs vary by only a few percent, and from October 2025 on it is steady." },
  { label: "WISE 0855", q: "WISE J085510.83-071442.5", fov: 0.4, name: "WISE 0855−0714", det: 5, test: true, what: "Coldest brown dwarf known",
    blurb: "The coldest brown dwarf known, about as cold as the North Pole. Invisible to the eye, it only shows up at the longest infrared wavelengths. Try sliding toward 4.5 µm.",
    watch: "Only visible at 3.8–5 µm (detectors 5 and 6), as a faint dot at the centre. Between May 2025 and April 2026 it shifts about 8″ west, matching its catalogued motion. At shorter wavelengths it is too cold to show: any dot near the centre there is a background object (it doesn't move). Its brightness readings are too noisy to call a change." },
  { label: "RW Aurigae", q: "RW Aur", fov: 0.5, det: 2, test: true, what: "Young star that flickers",
    blurb: "A young star still wrapped in its birth disk. Clumps of dust passing in front of it make it brighten and fade unpredictably.",
    watch: "A real change, well beyond the measurement noise: between September 2025 and September 2026 it got 40–55% brighter at 0.75–1.6 µm (detectors 1–2) while fading by about half at 3.8–5 µm (detectors 5–6). Press “Load the other detectors” under the spectrum to see both." },
  { label: "R Draconis", q: "R Dra", fov: 0.5, det: 6, test: true, what: "Pulsating giant star",
    blurb: "A pulsating giant star that swells and shrinks, changing brightness on an eight-month cycle.",
    watch: "So bright that it saturates every SPHEREx detector, so its total brightness can't be measured. Judged from the glow around it instead (less certain), it faded to about 40% of its June 2025 level by mid-2026 at 2.4–5 µm (detectors 4 and 6). In Blink mode, watch the glow shrink." },
  { label: "Orion Nebula", q: "M42", fov: 2, what: "Stellar nursery",
    blurb: "A stellar nursery 1,300 light-years away. Infrared light shines through its dust to reveal the newborn stars inside." },
  { label: "Andromeda Galaxy", q: "M31", fov: 4, what: "Neighbor galaxy",
    blurb: "Our neighbor galaxy, 2.5 million light-years away, with about a trillion stars." },
  { label: "Jupiter", q: "Jupiter", what: "Planet on the move",
    blurb: "Planets wander against the stars. The line shows where Jupiter travelled while SPHEREx was mapping the sky." },
  { label: "Ceres", q: "Ceres", what: "Dwarf planet",
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
const svg = (tag, attrs = {}, text) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
// Swap the icon inside a button (the icons are the <symbol>s at the top of index.html).
const setIcon = (button, name) => button.querySelector("use").setAttribute("href", `#i-${name}`);
// Dates are written one way everywhere: 14 Nov 2026. This turns JPL Horizons' "2026-Nov-14" and
// plain "2026-11-14" inside any text into that.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const plainDates = (text) => String(text ?? "")
  .replace(/\b(\d{4})-([A-Z][a-z]{2})-(\d{2})\b/g, (_, y, m, d) => `${+d} ${m} ${y}`)
  .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => `${+d} ${MONTHS[m - 1]} ${y}`);
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
// Marks on the map, one fixed meaning each (the inspector's "On the map" key draws the same ones;
// keep in sync with --nasa-red, --mark-ghost, --mark-path, --mark-gaia and --mark-asteroid in style.css).
const MARK = { target: "#fc3d21", catalog: "#c9d6ec", path: "#7db3ff", gaia: "#ffc531", asteroid: "#c4a7ff" };
let targetOverlay, targetCatalog;
let timelapse;            // the flipbook + spectrum in the inspector (timelapse.js)
let follow, followCat;    // an asteroid followed through its exposures (follow.js) + its marker on the map
let names;                // object labels on the map (names.js)
let stars;                // Gaia stars on the map (stars.js)
let current = null;       // last resolved target
let sweeping = false;     // wavelength sweep animation
let drifting = false;     // slow auto-rotate on the welcome screen
let urlTimer, viewTimer, searchTicket = 0;
const urlParams = new URLSearchParams(location.search);
const hasUrlState = [...urlParams.keys()].length > 0; // (URLSearchParams.size is missing in older Safari)

// ------------------------------------------------------------------ boot
// A crash while the page is starting shows up on screen instead of leaving a silent black page.
// Once the sky is up, an uncaught error somewhere is not a reason to cover a working map with
// an error box: it goes to the console. (The things that really stop the sky, such as the
// backend or the tiles not answering or the graphics driver resetting, call showFatal themselves.)
let booted = false;
window.addEventListener("error", (e) => uncaught(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => uncaught(e.reason));

function uncaught(err) {
  const msg = String(err?.message || err || "");
  // Harmless whenever they happen:
  //  - "Script error." is all a browser says about an error in a script from another site
  //    (a browser extension, or the viewer library's own helpers). There is nothing to act on.
  //  - a background request that didn't get through (Aladin's usage logger, a catalog service
  //    being down) and a wavelength layer that failed to load (handled in swapLayers). Each
  //    browser words a failed request differently: Chrome "Failed to fetch", Safari
  //    "Load failed", Firefox "NetworkError when attempting to fetch resource".
  if (!msg || /^Script error\.?$|Failed to fetch|Load failed|NetworkError|AladinLiteLogger|^HiPS .* error|ResizeObserver loop/i.test(msg)) return;
  if (booted) return console.error("Lumasphere: uncaught error (the page keeps running)", err);
  showFatal(err);
}

function showFatal(err) {
  const msg = String(err?.message || err || "Unknown error");
  console.error(err);
  let command = "";
  let help = "Reload the page. If it keeps happening, open the browser console (F12) and send the error below to the team.";
  if (/webgl/i.test(msg)) {
    help = "This sky viewer needs WebGL2 (3D graphics). In Chrome go to Settings → System, turn on “Use graphics acceleration when available”, relaunch, then check chrome://gpu shows WebGL2 as “Hardware accelerated”.";
  } else if (/backend/i.test(msg)) {
    help = "The Lumasphere backend isn't answering. Start it from the backend/ folder with the command below, then reload this page.";
    command = "uvicorn main:app --port 8000";
  } else if (/import|module|dynamically/i.test(msg)) {
    help = "The sky viewer library couldn't be downloaded from cdn.jsdelivr.net. Check your internet connection or whether a network filter is blocking it.";
  }
  $("#fatal-help").textContent = help;
  $("#fatal-cmd").textContent = command;
  $("#fatal-cmd").hidden = !command;
  $("#fatal-detail").textContent = `Error: ${msg}`;
  $("#fatal-reload").onclick = () => location.reload();
  $("#fatal-close").onclick = () => ($("#fatal").hidden = true);
  $("#fatal").hidden = false;
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

// SPHEREx has 6 detector arrays, each covering an equal run of frames (0 if the map isn't cut that way).
const framesPerDetector = () => (Number.isInteger(wavelengths.length / 6) ? wavelengths.length / 6 : 0);

function updateWavelengthUi() {
  const wl = wavelengths[frame], per = framesPerDetector(), detector = per ? Math.floor(frame / per) + 1 : 0;
  const slider = $("#wl-slider");
  slider.value = frame;
  slider.setAttribute("aria-valuetext", `${wl.toFixed(2)} microns${detector ? `, detector ${detector}` : ""}`);
  $("#wl-label").textContent = wl.toFixed(2);
  $("#wl-det").textContent = detector ? `Infrared color, detector ${detector} of 6` : "Infrared color";
  $("#wl-hint").textContent = hintFor(wl);
  $(".wl-value").classList.toggle("loading", sky.shown.frame !== frame);
  document.querySelectorAll(".wl-span").forEach((g) => g.classList.toggle("on", +g.dataset.det === detector));
}

// The scale under the slider: one tick per frame, a taller one where each detector starts,
// labelled with its first wavelength. Frames with no data get no tick.
const THUMB_W = 11; // width of the slider's handle in style.css: the ticks are inset by half of it
function drawScale() {
  const box = $("#wl-ticks"), n = wavelengths.length, W = box.clientWidth;
  if (!W || n < 2) return;
  const H = 34, base = 19.5, per = framesPerDetector() || n;
  const x = (i) => Math.round(THUMB_W / 2 + (i / (n - 1)) * (W - THUMB_W)) + 0.5;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  root.append(svg("line", { x1: x(0), x2: x(n - 1), y1: base, y2: base, class: "wl-base" }));
  const spanW = (W - THUMB_W) / (n / per);
  const roomy = spanW > 92; // room for "D1" beside the wavelength
  for (let start = 0; start < n; start += per) {
    const g = svg("g", { class: "wl-span", "data-det": start / per + 1 });
    for (let i = start; i < Math.min(n, start + per); i++) {
      if (blankFrames.has(i)) continue;
      g.append(svg("line", { x1: x(i), x2: x(i), y1: i === start ? 4 : 11, y2: base, class: i === start ? "wl-edge" : "wl-tick" }));
    }
    // On a narrow scale, label every other detector, and never run into the label at the far end.
    const k = start / per, last = start + per >= n;
    if ((spanW > 34 || k % 2 === 0) && !(last && spanW < 76)) {
      g.append(svg("text", { x: x(start), y: H - 2, class: "wl-text" }, `${per < n && roomy ? `D${k + 1}  ` : ""}${wavelengths[start].toFixed(2)}`));
    }
    root.append(g);
  }
  root.append(svg("line", { x1: x(n - 1), x2: x(n - 1), y1: 4, y2: base, class: "wl-edge" }));
  root.append(svg("text", { x: x(n - 1), y: H - 2, class: "wl-text", "text-anchor": "end" }, `${wavelengths[n - 1].toFixed(2)} µm`));
  box.replaceChildren(root);
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
  timelapse.redraw(); // the time-lapse frames follow the same colour style
  follow.redraw();
}

async function toggleSweep() {
  const btn = $("#wl-play");
  if (sweeping) { sweeping = false; return; }
  sweeping = true;
  setIcon(btn, "pause");
  btn.setAttribute("aria-label", "Stop the sweep");
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
  setIcon(btn, "play");
  btn.setAttribute("aria-label", "Sweep through all infrared colors");
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
  // "NAME Upper Sco Association" (SIMBAD's form) and "asteroid:Psyche" read as the plain name.
  const shown = featured?.label || q.replace(/^(NAME\s+|asteroid:\s*)/i, "");
  $("#search-input").value = shown;
  toast(`Looking for ${shown}…`, 20000);
  try {
    const t = { ...(await resolve(q)) };
    if (ticket !== searchTicket) return; // a newer search took over
    if (t.kind === "planet") t.name = t.name.replace(/\s*\(\d+\)$/, ""); // "Jupiter (599)": the number is JPL's own ID
    if (featured?.name) t.name = featured.name;
    if (featured?.label && t.kind === "coordinates") t.name = featured.label;
    current = { ...t, query: q, blurb: featured?.blurb };
    $("#toast").hidden = true;
    showTarget(current, fovOverride || featured?.fov);
  } catch (e) {
    if (ticket === searchTicket) toast(e.message || "Search failed: is the backend running?", 5000);
  }
}

// An asteroid or comet whose name we already know (Asteroids layer, asteroid suggestion).
// The "asteroid:" prefix makes the backend skip the star catalogs, and keeps working in shared links.
function searchAsteroid(name, title) {
  return search(`asteroid:${name}`, { label: title || name, name: title || name });
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
  return FOV_BY_TYPE[t.otype] || 0.6;
}

// Starting zoom (degrees) for things much bigger than a star: a star association spans
// ten degrees or more, a molecular cloud several.
const FOV_BY_TYPE = {
  "As*": 14, "MoC": 4, "SFR": 3, "DNe": 1.5, "Cl*": 1.2, "OpC": 1.5, "GlC": 0.5,
  "HII": 1.2, "RNe": 0.8, "SNR": 1.5, "ISM": 2, "GrG": 1, "ClG": 1, "SCG": 4,
};

// Put an object in the inspector and mark it on the map. `fly: false` (a click on the map)
// leaves the camera where the user put it.
function showTarget(t, fovOverride, { fly = true } = {}) {
  // Markers & paths
  targetOverlay.removeAll();
  targetCatalog.removeAll();
  if (t.path?.length > 1) {
    targetOverlay.add(A.polyline(t.path.map((p) => [p.ra, p.dec]), { color: MARK.path, lineWidth: 2 }));
  }
  targetCatalog.addSources([A.source(t.ra, t.dec, { name: t.name })]);
  if (t.catalog_ra != null) {
    // Where catalogs put it in 2000 vs where SPHEREx saw it: the star has moved!
    targetOverlay.add(A.polyline([[t.catalog_ra, t.catalog_dec], [t.ra, t.dec]], { color: MARK.catalog, lineWidth: 1.5, lineDash: [4, 4] }));
    targetOverlay.add(A.circle(t.catalog_ra, t.catalog_dec, 0.004, { color: MARK.catalog, lineWidth: 1.5 }));
  }

  renderInfo(t);
  // A planet or asteroid is not at one place in the sky, so its time-lapse waits for a click.
  timelapse.show({ ...t, det: t.det || featuredMatch(t)?.det }, { auto: !t.moving });
  followCat.removeAll();
  follow.show(t); // asteroids and comets: follow them through the exposures that caught them
  if (fly) {
    const fov = fovFor(t, fovOverride);
    // Start fetching the destination's tiles now; the flight there takes a few seconds anyway.
    warm([frame], tilesAround(t.ra, t.dec, fov), true);
    flyTo(t.ra, t.dec, fov);
    for (const key in OVERLAYS) refreshOverlay(key, { ra: t.ra, dec: t.dec, fov }); // markers at the destination
  }
  syncUrl();
}

// A click on the map: find out what is there and inspect it.
async function inspectAt(ra, dec, radius) {
  const ticket = ++searchTicket;
  stopIdleDrift();
  $("#welcome").hidden = true;
  toast("Looking at this spot…", 15000);
  // How close a catalogued object must be to count as "what I clicked": about 1/60 of the view.
  radius ??= clamp((aladin.getFov()[0] * 3600) / 60, 8, 120);
  let t;
  try {
    const r = await fetch(`${API}/api/identify?ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&radius=${radius.toFixed(0)}`);
    if (!r.ok) throw new Error();
    t = await r.json();
  } catch {
    // Catalogs unreachable: the spot itself can still be inspected.
    t = { name: `${ra.toFixed(4)}° ${dec >= 0 ? "+" : ""}${dec.toFixed(4)}°`, ra, dec, kind: "coordinates", type_label: "Sky position", source: "coordinates" };
  }
  if (ticket !== searchTicket) return;
  $("#toast").hidden = true;
  // A named object can be found again by name; anything else by its coordinates.
  const query = t.source === "SIMBAD" ? t.name : `${t.ra.toFixed(5)} ${t.dec.toFixed(5)}`;
  current = { ...t, query };
  $("#search-input").value = t.kind === "coordinates" ? "" : t.name;
  showTarget(current, null, { fly: false });
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
function openInspector(open) {
  $("#info").hidden = !open;
  document.body.classList.toggle("has-panel", open);
  if (!open) { timelapse.clear(); follow.clear(); followCat.removeAll(); } // stops playback and any download in progress
}

// First letter of an asteroid's spectral class -> what its surface is like.
const SURFACE_TYPES = {
  C: "dark, carbon-rich", B: "dark, carbon-rich", F: "dark, carbon-rich", G: "dark, carbon-rich",
  S: "stony", Q: "fresh stony", K: "stony", L: "stony", A: "olivine-rich", V: "basalt, like Vesta's crust",
  M: "metallic", X: "metal or dark rock", E: "bright, enstatite-rich", P: "very dark, primitive",
  D: "very dark and red, primitive", T: "dark, primitive", R: "pyroxene-rich", O: "unusual stony",
};

// The featured target this is, if any: opened from its chip (same blurb), or found another way.
function featuredMatch(t) {
  return FEATURED.find((x) => t.blurb && x.blurb === t.blurb) || featuredFor(t);
}

// A featured target found some other way (typed in full, clicked on the map): match it by name.
function featuredFor(t) {
  const names = [t.name, ...(t.aliases || [])].map((n) => tidy(n));
  return FEATURED.find((f) => [f.q, f.label, f.name, ...(f.also || [])].some((n) => n && names.includes(tidy(n))));
}
const tidy = (n) => String(n).replace(/^(NAME|V\*|\*)\s+/i, "").replace(/\s+/g, " ").trim().toLowerCase();

function renderInfo(t) {
  openInspector(true);
  $(".insp-scroll").scrollTop = 0;
  $("#info-name").textContent = $("#info-band-name").textContent = t.name;
  $("#info-type").textContent = t.type_label || "";
  $("#info-blurb").textContent = t.blurb || "";
  // The challenge targets: what SPHEREx shows for each (checked against the data), however they were opened.
  const f = featuredMatch(t);
  if (f && !t.blurb) $("#info-blurb").textContent = f.blurb;
  $("#info-watch").hidden = !f?.watch;
  $("#info-watch").replaceChildren(...(f?.watch ? [el("strong", {}, "What to look for: "), document.createTextNode(f.watch)] : []));

  // The facts, one ruled cell each. A cell is { label, value, note?, wide? }; long values get a full row.
  const cells = [];
  const add = (label, value, note) => cells.push({ label, value, note, wide: String(value).length > 28 });
  if (t.distance_ly) add("Distance", t.distance_ly < 1000 ? `${t.distance_ly.toLocaleString()} light-years` : `${Math.round(t.distance_ly).toLocaleString()} light-years`);
  if (t.pm_total_arcsec_yr != null) {
    const yrsPerMoon = 1800 / t.pm_total_arcsec_yr; // full-moon width ≈ 1800″
    add("Moves across sky", `${t.pm_total_arcsec_yr.toFixed(2)}″ per year`, t.pm_total_arcsec_yr > 0.5 ? `A full-Moon width every ${Math.round(yrsPerMoon).toLocaleString()} years` : null);
  }
  if (t.moved_arcsec_since_catalog) {
    const m = t.moved_arcsec_since_catalog;
    add("Moved since 2000", m >= 60 ? `${(m / 60).toFixed(1)} arcminutes` : `${m}″`);
  }
  if (t.moving) add("Position for", `${plainDates(t.position_date)} UTC`);
  const ast = t.asteroid || {}; // asteroids and comets: from JPL's Small-Body Database
  if (ast.diameter_km) add("Size", ast.diameter_km >= 1 ? `${ast.diameter_km.toLocaleString(undefined, { maximumFractionDigits: 1 })} km across` : `${Math.round(ast.diameter_km * 1000)} m across`);
  if (ast.hazard) add("Near Earth?", ast.hazard);
  if (ast.spectral_type) add("Surface type", `${ast.spectral_type} (${SURFACE_TYPES[ast.spectral_type[0]] || "spectral class"})`);
  if (ast.rotation_hours) add("Spins once every", ast.rotation_hours >= 48 ? `${(ast.rotation_hours / 24).toFixed(1)} days` : `${ast.rotation_hours.toFixed(1)} hours`);
  if (ast.albedo) add("Reflects", `${Math.round(ast.albedo * 100)}% of sunlight`);
  add("Sky position", `RA ${t.ra.toFixed(4)}°  Dec ${t.dec < 0 ? "−" : "+"}${Math.abs(t.dec).toFixed(4)}°`);
  fillFacts($("#info-facts"), cells);

  // Key to the marks on the map, each drawn as it appears there.
  const key = [];
  if (t.catalog_ra != null) key.push(["target", `SPHEREx, ${t.epoch}`], ["catalog", "Catalogs, year 2000"]);
  if (t.path?.length > 1) {
    if (!key.length) key.push(["target", "Where it is now"]);
    key.push(["path", plainDates(t.path_label)]);
  }
  if (key.length) {
    const cell = el("div", { className: "fact wide" }), dd = el("dd", { className: "map-key" });
    for (const [mark, text] of key) {
      const item = el("span", {}, text);
      item.prepend(markSwatch(mark));
      dd.append(item);
    }
    cell.append(el("dt", {}, "On the map"), dd);
    $("#info-facts").append(cell);
  }

  // At the foot of the panel: its other names and where the facts come from.
  cells.length = 0;
  const aliases = (t.aliases || []).filter((a) => !a.startsWith("NAME")).slice(0, 3);
  if (aliases.length) add("Also known as", aliases.join(", "));
  add("Data from", t.source);
  fillFacts($("#info-ref"), cells);
}

// Lay facts out as ruled cells, two to a row; a long one (`wide`) takes a row to itself.
function fillFacts(list, cells) {
  list.replaceChildren();
  let column = 0; // 0 = a new row starts here, 1 = the right-hand cell of a row
  cells.forEach((c, i) => {
    // A short cell with nobody to sit beside takes the whole row instead of leaving a hole.
    const next = cells[i + 1];
    const wide = c.wide || (column === 0 && (!next || next.wide));
    column = wide ? 0 : 1 - column;
    const cell = el("div", { className: "fact" + (wide ? " wide" : "") });
    const dd = el("dd", {}, c.value);
    if (c.note) dd.append(el("small", {}, c.note));
    cell.append(el("dt", {}, c.label), dd);
    list.append(cell);
  });
}

// A small drawing of one of the map's marks, for the key in the inspector.
function markSwatch(mark) {
  const width = mark === "target" ? 14 : 24;
  const root = svg("svg", { width, height: 14, viewBox: `0 0 ${width} 14`, "aria-hidden": "true" });
  const stroke = { fill: "none", stroke: MARK[mark], "stroke-width": mark === "target" ? 2 : 1.5 };
  if (mark === "path") root.append(svg("path", { d: "M1 11 9 5l6 3 8-5", ...stroke, "stroke-width": 2 }));
  else {
    if (mark === "catalog") root.append(svg("path", { d: "M13 7h10", ...stroke, "stroke-dasharray": "3 3" }));
    root.append(svg("circle", { cx: 7, cy: 7, r: 5, ...stroke }));
  }
  return root;
}

// ------------------------------------------------------------------ overlays
// Known asteroids around the view centre (/api/asteroids), drawn as an Aladin catalog. Names and
// Gaia stars have their own modules (names.js, stars.js). `at` remembers where the last query was
// made so we only query again when the view has really moved away from it.
const OVERLAYS = {
  asteroids: {
    // Wider than maxFov the 1° search circle is a clump of diamonds in the middle: hide it (like Gaia).
    toggle: "#tg-asteroids", label: "Asteroids", maxRadius: 1, maxFov: 20, cat: null, at: null, request: null,
    service: "the asteroid service (IMCCE SkyBoT)",
    // Positions for right now: the all-sky map is many dates stacked together, and an asteroid
    // crosses a SPHEREx field in hours, so "now" is the one date that means something here.
    // Zoomed far out, the 1° search circle is a dot on the screen: only its brightest few, unlabelled.
    url: (ra, dec, radius, fov) => `${API}/api/asteroids?ra=${ra}&dec=${dec}&radius=${radius}&limit=${fov > 6 ? 12 : 60}`,
    labelsBelowFov: 6,
    rows: (data) => {
      if (!data.asteroids.length) toast("No known asteroids in this part of the sky right now. Try near the ecliptic (Jupiter, Ceres…).", 4000);
      // The object open in the panel already has its own label: don't name it twice.
      const isOpen = (a) => current?.moving && angularDistance(a.ra, a.dec, current.ra, current.dec) < 10 / 3600;
      return data.asteroids.filter((a) => !isOpen(a)).map((a) => [a.ra, a.dec, {
        name: a.label, type: a.family, mag: a.vmag, asteroid: a.name, title: a.label,
      }]);
    },
    style: {
      name: "Asteroids (SkyBoT)", color: MARK.asteroid, sourceSize: 11, shape: "rhomb",
      displayLabel: true, labelColumn: "name", labelColor: "#e6dcff", labelFont: "12px Archivo, sans-serif",
    },
  },
};

function removeCatalog(cat) {
  try { if (cat) aladin.removeOverlay(cat); } catch {}
}

// `where` = {ra, dec, fov} of the place to query; defaults to the current view.
async function refreshOverlay(key, where) {
  const o = OVERLAYS[key];
  if (!$(o.toggle).checked) return;
  if (!where) {
    const [ra, dec] = aladin.getRaDec();
    where = { ra, dec, fov: aladin.getFov()[0] };
  }
  o.request?.abort(); // only the newest place matters
  if (where.fov > o.maxFov) {
    // Too far out: take the markers away and come back when the view is zoomed in again.
    removeCatalog(o.cat);
    o.cat = o.request = null;
    o.at = { ra: where.ra, dec: where.dec, radius: where.fov / 2 };
    return;
  }
  const radius = Math.min(o.maxRadius, where.fov / 2);
  o.at = { ra: where.ra, dec: where.dec, radius, fov: where.fov };
  const request = (o.request = new AbortController());
  try {
    const r = await fetch(o.url(where.ra.toFixed(5), where.dec.toFixed(5), radius.toFixed(4), where.fov), { signal: request.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = o.rows(await r.json());
    if (o.request !== request) return; // switched off, or a newer query took over
    // A click on a marker opens that asteroid (asteroidAt, used by the click handler in wireControls).
    const labels = o.style.displayLabel && !(o.labelsBelowFov && where.fov > o.labelsBelowFov);
    const cat = A.catalog({ ...o.style, displayLabel: labels });
    cat.addSources(rows.map(([ra, dec, data]) => A.source(ra, dec, data)));
    removeCatalog(o.cat); // the old markers stayed until now, so they don't blink
    aladin.addCatalog(cat);
    o.cat = cat;
  } catch (e) {
    if (e.name === "AbortError" || o.request !== request) return;
    toast(`${o.label} couldn't be loaded: ${o.service || "the star catalog"} didn't answer. Switch it off and on to try again.`, 5000);
  }
}

// The asteroid marker under a click (screen pixels), if any. Checked here rather than through
// Aladin's marker callback so a click on a diamond always opens that asteroid.
function asteroidAt(x, y) {
  let best = null, bestD = 14; // px: a little more than the marker, easy to hit on a phone too
  for (const s of OVERLAYS.asteroids.cat?.sources || []) {
    const p = aladin.world2pix(s.ra, s.dec);
    if (!p) continue;
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d < bestD) [best, bestD] = [s, d];
  }
  return best && { ra: best.ra, dec: best.dec, data: best.data };
}

function clearOverlay(key) {
  const o = OVERLAYS[key];
  o.request?.abort();
  removeCatalog(o.cat);
  o.cat = o.at = o.request = null;
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
    const rescaled = radius > o.at.radius * 1.5 || radius < o.at.radius / 2
      || (o.labelsBelowFov && (fov > o.labelsBelowFov) !== (o.at.fov > o.labelsBelowFov)); // labels on/off
    const tooWide = fov > o.maxFov && o.cat; // zoomed out past the point where its markers make sense
    if (moved || rescaled || tooWide) refreshOverlay(key, { ra, dec, fov });
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
    // q = a named object, ra + dec = a position being inspected, view = only where the camera points.
    const p = new URLSearchParams();
    if (current?.kind === "coordinates") {
      p.set("ra", current.ra.toFixed(5));
      p.set("dec", current.dec.toFixed(5));
    } else if (current?.query) p.set("q", current.query);
    else {
      const [ra, dec] = aladin.getRaDec();
      p.set("view", `${ra.toFixed(5)}_${dec.toFixed(5)}`);
    }
    p.set("fov", aladin.getFov()[0].toFixed(3));
    p.set("wl", wavelengths[frame].toFixed(3));
    history.replaceState(null, "", `?${p}`);
  }, 400);
}

// ?ra=…&dec=… is a position to inspect: it opens the time-lapse of that patch, which is what
// lets other sites link to or embed one. Decimal degrees, or anything the search box accepts
// (?ra=08h55m10.8s&dec=-07d14m42s).
function urlPosition() {
  const ra = urlParams.get("ra")?.trim(), dec = urlParams.get("dec")?.trim();
  return ra && dec ? `${ra} ${dec}` : null;
}

// Where the camera starts. A link with a position or a saved view opens directly on that
// patch of sky (no detour via the Milky Way).
function initialView() {
  if (urlParams.get("q")) return START; // a named object: search() flies there
  const fov = parseFloat(urlParams.get("fov"));
  const onSky = (ra, dec) => Number.isFinite(ra) && Number.isFinite(dec) && Math.abs(dec) <= 90;
  if (urlPosition()) {
    const ra = Number(urlParams.get("ra")), dec = Number(urlParams.get("dec")); // NaN unless plain degrees
    return onSky(ra, dec) ? { ra, dec, fov: fov || fovFor({}) } : START;
  }
  const [ra, dec] = (urlParams.get("view") || "").split(/[_, ]+/).map(Number);
  return onSky(ra, dec) ? { ra, dec, fov: fov || 1 } : START;
}

function applyUrlState() {
  if (!hasUrlState) return;
  $("#welcome").hidden = true;
  const q = urlParams.get("q") || urlPosition();
  if (q) search(q, FEATURED.find((x) => x.q === q) || null, parseFloat(urlParams.get("fov")) || null);
}

// ------------------------------------------------------------------ wiring
function buildFeatured() {
  const box = $("#featured");
  const group = (title, items) => {
    box.append(el("h3", {}, title));
    items.forEach((f) => {
      const b = el("button", { className: "target", type: "button" });
      b.append(el("b", {}, f.label), el("span", {}, f.what));
      b.onclick = () => search(f.q, f);
      box.append(b);
    });
  };
  group("Challenge test targets", FEATURED.filter((f) => f.test));
  group("Also worth a look", FEATURED.filter((f) => !f.test));
}

function renderSuggestions(text) {
  const ul = $("#suggestions");
  const q = text.trim().toLowerCase();
  const items = FEATURED.filter((f) => !q || f.label.toLowerCase().includes(q));
  ul.replaceChildren();
  items.forEach((f) => {
    const li = el("li");
    li.append(el("span", {}, f.label), el("small", {}, f.what));
    li.onmousedown = (e) => { e.preventDefault(); search(f.q, f); };
    ul.append(li);
  });
  if (q) {
    const li = el("li");
    li.append(el("span", {}, `Search “${text.trim()}”`), el("small", {}, "name, or RA Dec like 05h35m -05d23m"));
    li.onmousedown = (e) => { e.preventDefault(); search(text); };
    ul.prepend(li);
  }
  ul.hidden = !ul.children.length;
  suggestNames(text.trim());
}

// Names as you type: SIMBAD's named objects (Upper Sco Association, Orion Nebula, Barnard's
// Loop…) and asteroids / comets, looked up by the backend. Added under the featured matches
// once they arrive; answers are remembered so typing back and forth is instant.
let suggestTimer, suggestTicket = 0;
const suggestions = new Map();
function suggestNames(q) {
  clearTimeout(suggestTimer);
  const ticket = ++suggestTicket;
  if (q.length < 2 || /^[\d\s.:+\-hdms°'"]+$/i.test(q)) return; // too short, or coordinates
  const show = (items) => {
    const ul = $("#suggestions");
    if (ticket !== suggestTicket || document.activeElement !== $("#search-input")) return;
    ul.querySelectorAll("li.found").forEach((li) => li.remove());
    const featured = new Set([...ul.querySelectorAll("li span")].map((s) => s.textContent.toLowerCase()));
    items.filter((it) => !featured.has(it.label.toLowerCase())).forEach((it) => {
      const li = el("li", { className: "found" });
      li.append(el("span", {}, it.label), el("small", {}, [it.kind, it.also && `= ${it.also}`].filter(Boolean).join(" · ")));
      li.onmousedown = (e) => { e.preventDefault(); search(it.query, { label: it.label, name: it.label }); };
      ul.append(li);
    });
    ul.hidden = !ul.children.length;
  };
  const key = q.toLowerCase();
  if (suggestions.has(key)) return show(suggestions.get(key));
  suggestTimer = setTimeout(async () => {
    try {
      const r = await fetch(`${API}/api/suggest?q=${encodeURIComponent(q)}`);
      if (!r.ok) return;
      const items = (await r.json()).items;
      suggestions.set(key, items);
      show(items);
    } catch {}
  }, 200);
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

  $("#tg-names").addEventListener("change", (e) => names.setEnabled(e.target.checked));
  $("#tg-gaia").addEventListener("change", (e) => stars.setEnabled(e.target.checked));
  $("#tg-asteroids").addEventListener("change", (e) => (e.target.checked ? refreshOverlay("asteroids") : clearOverlay("asteroids")));

  $("#welcome-close").addEventListener("click", () => ($("#welcome").hidden = true));
  $("#info-close").addEventListener("click", () => openInspector(false));
  aladin.on("click", (e) => {
    if (e.isDragging) return;
    const asteroid = asteroidAt(e.x, e.y);
    if (asteroid) return void searchAsteroid(asteroid.data.asteroid, asteroid.data.title); // look it up by name: its orbit, path, size
    const named = names.at(e.x, e.y) || stars.at(e.x, e.y);
    if (named) inspectAt(named.ra, named.dec, 5); // a name or a Gaia star's mark: that object, not its neighbour
    else if (Number.isFinite(e.ra) && Number.isFinite(e.dec)) inspectAt(e.ra, e.dec);
  });
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
    viewTimer = setTimeout(refreshOverlaysIfMoved, 800); // the asteroid markers, once the view is still
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
  showSimbadPointerControl: false, // it asks the CDS servers directly; clicking the map (inspectAt) does the same job through our backend
  // Aladin's status bar and coordinate readout are off: they are the only parts of its own
  // interface that carry tooltips, and its tooltip code can throw while the viewer is starting
  // ("null is not an object (evaluating 'A.innerHTML=\"\"')" in Safari), which left a black page.
  // The page shows loading and positions itself (the wavelength rail, the inspector).
  showCooLocation: false,
  showStatusBar: false,
  backgroundColor: "rgb(3,6,15)",
});

targetOverlay = A.graphicOverlay({ color: MARK.path, lineWidth: 2 });
aladin.addOverlay(targetOverlay);
targetCatalog = A.catalog({
  name: "Target", color: MARK.target, sourceSize: 26, shape: "circle",
});
aladin.addCatalog(targetCatalog);

// The selected object's name is a white tag beside its ring. (Aladin's own labels are bare text:
// they vanish on bright sky and among the Names. names.js keeps its labels clear of this tag.)
const targetTag = el("div", { className: "target-tag", hidden: true });
aladin.getParentDiv().append(targetTag);
let tagAt = "";
function placeTargetTag() {
  requestAnimationFrame(placeTargetTag);
  const t = document.body.classList.contains("has-panel") ? current : null;
  let p = null;
  if (t) { try { p = aladin.world2pix(t.ra, t.dec); } catch {} }
  const [w, h] = aladin.getSize();
  const at = p && p[0] >= 0 && p[0] <= w && p[1] >= 0 && p[1] <= h ? `${Math.round(p[0] + 18)}px, ${Math.round(p[1] - 10)}px|${t.name}` : "";
  if (at === tagAt) return;
  tagAt = at;
  targetTag.hidden = !at;
  if (!at) return;
  targetTag.textContent = t.name;
  targetTag.style.transform = `translate(${at.split("|")[0]})`;
}
placeTargetTag();

// The header strip of the inspector shows the object's name once its title has scrolled out of sight.
new IntersectionObserver(([entry]) => $(".insp-band").classList.toggle("scrolled", !entry.isIntersecting),
  { root: $(".insp-scroll"), rootMargin: "-36px 0px 0px 0px" }).observe($("#info-name"));

timelapse = createTimelapse({ api: API, colormap: () => colormap });
// While "Follow it" plays, a marker on the map shows where the object was in the current frame.
followCat = A.catalog({ name: "Following", color: MARK.target, sourceSize: 18, shape: "plus" });
aladin.addCatalog(followCat);
follow = createFollow({
  api: API, colormap: () => colormap,
  onFrame: (f) => { followCat.removeAll(); followCat.addSources([A.source(f.ra, f.dec, { name: f.date })]); },
});
names = createNames({
  api: API, aladin, target: () => (document.body.classList.contains("has-panel") ? current : null),
  avoid: ".topbar, .viewbar, .rail, .welcome, .inspector, .toast",
  onError: () => toast("Some names couldn't be loaded: the catalog didn't answer. They are retried as you move around.", 5000),
});
stars = createStars({
  api: API, aladin,
  onError: () => toast("Some Gaia stars couldn't be loaded: the star catalog didn't answer. They are retried as you move around.", 5000),
});
watchTiles();
new ResizeObserver(() => { drawScale(); updateWavelengthUi(); }).observe($("#wl-ticks"));
drawScale();
updateWavelengthUi();
wireControls();
startIdleDrift();
applyUrlState();
warmFeatured();
booted = true;

// Handy for debugging in the browser console.
window.lumasphere = { get aladin() { return aladin; }, get layer() { return sky.shown.hips; }, sky, survey, timelapse, names, stars, setFrame: showFrame, search, inspectAt, tilesInView, tilesAround, healpixTile };
