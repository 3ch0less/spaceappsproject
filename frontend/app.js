/* SkyShift frontend.
 *
 * The sky is rendered with Aladin Lite v3 using IRSA's SPHEREx DR1 all-sky HiPS cube
 * (102 wavelength frames). Search goes through our backend (/api/resolve), which knows
 * about stars & galaxies (SIMBAD), planets and asteroids (JPL Horizons) and coordinates.
 */

const ALADIN_URL = "https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js";
let A; // Aladin Lite, loaded in boot() so a failure can be shown on screen

// ------------------------------------------------------------------ config
// Swap this URL when a newer SPHEREx release is published; wavelengths are read from it.
const HIPS_URL = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube";
const API = location.protocol === "file:" ? "http://localhost:8000" : "";
const BLANK_FRAMES = new Set([50, 51]); // dichroic channels, empty in the HiPS cube
const START = { ra: 266.4168, dec: -29.0078, fov: 140 }; // centre of the Milky Way

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
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ------------------------------------------------------------------ state
let aladin, sphx;
let wavelengths = [];
let emRange = [0.743e-6, 5.009e-6]; // metres; read from the HiPS properties
let frame = 0;
let targetOverlay, targetCatalog, namesCatalog, gaiaCatalog;
let current = null; // last resolved target
let sweepTimer = null; // wavelength sweep animation
let drifting = false;  // slow auto-rotate on the welcome screen
let urlTimer;

// ------------------------------------------------------------------ boot
// Any crash shows up on screen instead of leaving a silent black page.
window.addEventListener("error", (e) => showFatal(e.error || e.message, true));
window.addEventListener("unhandledrejection", (e) => showFatal(e.reason, true));

function showFatal(err, soft = false) {
  const msg = String(err?.message || err || "Unknown error");
  if (soft && /Failed to fetch|AladinLiteLogger/.test(msg)) return; // Aladin's usage logger; harmless
  console.error(err);
  let help = "Try a hard refresh (Ctrl+Shift+R). If it keeps happening, open the browser console (F12) and send the error to the team.";
  if (/webgl/i.test(msg)) {
    help = "This sky viewer needs WebGL2 (3D graphics). In Chrome go to Settings → System, turn on “Use graphics acceleration when available”, relaunch, then check chrome://gpu shows WebGL2 as “Hardware accelerated”.";
  } else if (/import|module|dynamically/i.test(msg)) {
    help = "The sky viewer library couldn't be downloaded from cdn.jsdelivr.net. Check your internet connection or whether a network filter is blocking it.";
  }
  const box = $("#fatal");
  box.querySelector("p").textContent = help;
  box.querySelector("code").textContent = msg;
  box.hidden = false;
}

buildFeatured(); // UI first, so the page is usable-looking even if the sky fails
try {
  ({ default: A } = await import(ALADIN_URL));
  await A.init;
} catch (e) {
  showFatal(e);
  throw e;
}
sphx = A.imageHiPS(HIPS_URL, { name: "SPHEREx DR1", imgFormat: "png", colormap: "magma" });
aladin = A.aladin("#sky", {
  survey: sphx,
  fov: START.fov,
  target: `${START.ra} ${START.dec}`,
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

await loadWavelengths();
setFrame(pickInitialFrame(), false);
wireControls();
startIdleDrift();
applyUrlState();

// ------------------------------------------------------------------ wavelengths
async function loadWavelengths() {
  try {
    const txt = await (await fetch(`${HIPS_URL}/properties`)).text();
    const line = txt.split("\n").find((l) => l.startsWith("data_cube_crval3_arr"));
    wavelengths = line.split("=")[1].trim().split(/\s+/).map(Number);
    const prop = (k) => parseFloat(txt.split("\n").find((l) => l.startsWith(k + " "))?.split("=")[1]);
    emRange = [prop("em_min") || emRange[0], prop("em_max") || emRange[1]];
  } catch (e) {
    console.warn("Could not read wavelengths from HiPS properties", e);
    wavelengths = Array.from({ length: 102 }, (_, i) => 0.75 + (i * (5.0 - 0.75)) / 101);
  }
  $("#wl-slider").max = wavelengths.length - 1;
}

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

function setFrame(i, updateUrl = true) {
  // Skip the two empty dichroic frames.
  if (BLANK_FRAMES.has(i)) i = i > frame ? 52 : 49;
  frame = Math.max(0, Math.min(wavelengths.length - 1, i));
  sphx.setSliceNumber(aladinSliceFor(frame));
  const wl = wavelengths[frame];
  const band = Math.floor(frame / 17) + 1;
  $("#wl-slider").value = frame;
  $("#wl-label").textContent = `${wl.toFixed(2)} µm · detector ${band}`;
  $("#wl-hint").textContent = hintFor(wl);
  if (updateUrl) syncUrl();
}

// Aladin turns a slice number into a frequency (linear in wavelength), and its renderer
// then picks tile = floor((f - fMin) / (fMax - fMin) * depth). Invert that so the tile
// we get really is frame k (measured: asking for 34 naively loaded tile 23).
function aladinSliceFor(k) {
  const c = 299792458, D = wavelengths.length, [lo, hi] = emRange;
  const fMin = c / hi, fMax = c / lo;
  const f = fMin + ((k + 0.25) / D) * (fMax - fMin);
  return ((c / f - lo) / (hi - lo)) * D;
}

function pickInitialFrame() {
  const wl = parseFloat(new URLSearchParams(location.search).get("wl"));
  if (!wl) return 34; // ~1.66 µm: pretty Milky Way, dust mostly see-through
  let best = 0;
  wavelengths.forEach((w, i) => { if (Math.abs(w - wl) < Math.abs(wavelengths[best] - wl)) best = i; });
  return best;
}

function toggleSweep() {
  const btn = $("#wl-play");
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    btn.textContent = "▶";
    return;
  }
  btn.textContent = "❚❚";
  sweepTimer = setInterval(() => {
    let next = frame + 1;
    if (BLANK_FRAMES.has(next)) next = 52;
    if (next >= wavelengths.length) next = 0;
    setFrame(next, false);
  }, 160);
}

// ------------------------------------------------------------------ search
async function resolve(q) {
  const r = await fetch(`${API}/api/resolve?q=${encodeURIComponent(q)}`);
  if (!r.ok) {
    let msg = `Couldn't find “${q}”.`;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

async function search(q, featured = null) {
  q = q.trim();
  if (!q) return;
  stopIdleDrift();
  $("#welcome").hidden = true;
  $("#suggestions").hidden = true;
  $("#search-input").value = featured?.label || q;
  toast(`Looking for ${featured?.label || q}…`, 20000);
  try {
    const t = await resolve(q);
    if (featured?.name) t.name = featured.name;
    if (featured?.label && t.kind === "coordinates") t.name = featured.label;
    current = { ...t, query: q, blurb: featured?.blurb };
    $("#toast").hidden = true;
    showTarget(current, featured?.fov);
  } catch (e) {
    toast(e.message || "Search failed: is the backend running?", 5000);
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

  flyTo(t.ra, t.dec, fovFor(t, fovOverride));
  renderInfo(t);
  syncUrl();
  if ($("#tg-names").checked) refreshNames();
  if ($("#tg-gaia").checked) refreshGaia();
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
function refreshNames() {
  if (namesCatalog) aladin.removeOverlay(namesCatalog);
  const [ra, dec] = aladin.getRaDec();
  const radius = Math.min(1, aladin.getFov()[0] / 2);
  namesCatalog = A.catalogFromSimbad({ ra, dec }, radius, {
    name: "Names (SIMBAD)", onClick: "showPopup", color: "#a3f0c6", sourceSize: 10,
    displayLabel: true, labelColumn: "main_id", labelColor: "#d6ffe9", labelFont: "12px Inter, sans-serif",
    limit: 300,
  });
  aladin.addCatalog(namesCatalog);
}

function refreshGaia() {
  if (gaiaCatalog) aladin.removeOverlay(gaiaCatalog);
  const [ra, dec] = aladin.getRaDec();
  const radius = Math.min(0.25, aladin.getFov()[0] / 2);
  gaiaCatalog = A.catalogFromVizieR("I/355/gaiadr3", { ra, dec }, radius, {
    name: "Gaia DR3", onClick: "showTable", color: "#ffe08a", sourceSize: 8, shape: "cross", limit: 2000,
  });
  aladin.addCatalog(gaiaCatalog);
}

// ------------------------------------------------------------------ idle drift (slow auto-rotate on the welcome screen)
function startIdleDrift() {
  if (new URLSearchParams(location.search).size) return;
  drifting = true;
  const step = () => {
    if (!drifting) return;
    const [ra, dec] = aladin.getRaDec();
    aladin.gotoRaDec((ra + 0.03) % 360, dec);
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

function applyUrlState() {
  const p = new URLSearchParams(location.search);
  if (!p.size) return;
  $("#welcome").hidden = true;
  if (p.get("q")) {
    const f = FEATURED.find((x) => x.q === p.get("q"));
    search(p.get("q"), f || null).then(() => {
      if (p.get("fov")) setTimeout(() => aladin.zoomToFoV(parseFloat(p.get("fov")), 1), 3500);
    });
  } else if (p.get("ra") && p.get("dec")) {
    const ra = parseFloat(p.get("ra")), dec = parseFloat(p.get("dec"));
    aladin.gotoRaDec(ra, dec);
    aladin.setFoV(parseFloat(p.get("fov")) || 1);
  }
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

  $("#wl-slider").addEventListener("input", (e) => setFrame(+e.target.value));
  $("#wl-play").addEventListener("click", toggleSweep);

  document.querySelectorAll("#view-seg button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#view-seg button").forEach((x) => x.classList.toggle("on", x === b));
      aladin.setProjection(b.dataset.proj);
      if (b.dataset.proj === "AIT") aladin.setFoV(360);
      if (b.dataset.proj === "TAN" && aladin.getFov()[0] > 30) aladin.zoomToFoV(10, 1);
    }));

  $("#cmap").addEventListener("change", (e) => sphx.setColormap(e.target.value, { stretch: "asinh" }));

  $("#tg-names").addEventListener("change", (e) => (e.target.checked ? refreshNames() : namesCatalog && (aladin.removeOverlay(namesCatalog), namesCatalog = null)));
  $("#tg-gaia").addEventListener("change", (e) => (e.target.checked ? refreshGaia() : gaiaCatalog && (aladin.removeOverlay(gaiaCatalog), gaiaCatalog = null)));

  $("#welcome-close").addEventListener("click", () => ($("#welcome").hidden = true));
  $("#info-close").addEventListener("click", () => ($("#info").hidden = true));
  $("#act-zoom").addEventListener("click", () => current && aladin.zoomToFoV(Math.max(0.15, aladin.getFov()[0] / 3), 1.2));
  $("#act-share").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Link copied: anyone can open this exact view."); }
    catch { toast(location.href, 8000); }
  });

  aladin.on("positionChanged", () => { if (!drifting) syncUrl(); });
  aladin.on("zoomChanged", () => syncUrl());
}

// Handy for debugging in the browser console.
window.skyshift = { get aladin() { return aladin; }, get layer() { return sphx; }, setFrame, search };
