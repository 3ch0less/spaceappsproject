/* Lumasphere time-lapse: the flipbook, its timeline and the spectrum chart in the inspector.
 *
 * SPHEREx returns to every spot about every six months. The backend (/api/timelapse)
 * turns each visit into one clean image per detector; this file plays those images like
 * a flipbook, so anything that moved or changed between visits jumps out, and plots the
 * brightness it measured in every single exposure. Below the flipbook, a fold-away panel shows
 * the same patch as NASA's WISE telescope saw it in 2010 (/api/wise): the "before" picture.
 *
 *   const tl = createTimelapse({ api, colormap: () => "magma" });
 *   tl.show(target);      // target: { ra, dec, name, pm_ra_mas_yr?, pm_dec_mas_yr?, epoch?, ... }
 *   tl.clear();
 */

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, text) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n[k] = v;
  if (text != null) n.textContent = text;
  return n;
};
const svg = (tag, attrs = {}, text) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// Swap the icon inside a button (the icons are the <symbol>s at the top of index.html).
const setIcon = (button, name) => button.querySelector("use").setAttribute("href", `#i-${name}`);
const MJD_UNIX = 40587; // MJD of 1970-01-01
const mjdToDate = (mjd) => new Date((mjd - MJD_UNIX) * 86400000);
// Dates are written one way everywhere: 26 Aug 2025, with three-letter months whatever the
// browser's locale would make of them. `opts` says which parts to include.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (mjd, opts = { day: "numeric", month: "short", year: "numeric" }) => {
  const d = mjdToDate(mjd);
  return [opts.day && d.getUTCDate(), opts.month && MONTHS[d.getUTCMonth()], opts.year && d.getUTCFullYear()].filter(Boolean).join(" ");
};
const mjdToYear = (mjd) => 2000 + (mjd - 51544.5) / 365.25;

// SPHEREx's six detectors, short to long wavelength.
const DETECTORS = [
  { id: 1, range: "0.75–1.1 µm", lo: 0.75, hi: 1.1 }, { id: 2, range: "1.1–1.6 µm", lo: 1.1, hi: 1.6 }, { id: 3, range: "1.6–2.4 µm", lo: 1.6, hi: 2.4 },
  { id: 4, range: "2.4–3.8 µm", lo: 2.4, hi: 3.8 }, { id: 5, range: "3.8–4.4 µm", lo: 3.8, hi: 4.4 }, { id: 6, range: "4.4–5.0 µm", lo: 4.4, hi: 5.0 },
];
const FOVS = [3, 6, 12, 20]; // arcminutes, must match the backend
// WISE's four bands. The first two are colours SPHEREx sees too (`det`: with which detector).
const WISE_BANDS = [
  { id: 1, wl: "3.4 µm", det: 4 }, { id: 2, wl: "4.6 µm", det: 6 }, { id: 3, wl: "12 µm" }, { id: 4, wl: "22 µm" },
];
const WISE_OPEN_KEY = "lumasphere.wise"; // remembers that the WISE panel was left open

// One colour per visit, in this fixed order. No red or orange: in this interface red means
// "you can press this" or "this is live". Validated on the chart's background (#050e22): the
// first three tell apart under colour-blindness in any pairing, neighbours in the list always
// do, and from the 4th on a visit also gets a dash pattern, since hue alone is not enough.
// Past the 6th, visits share a grey and differ by dash only.
const VISIT_COLORS = ["#3987e5", "#199e70", "#c98500", "#d55181", "#9085e9", "#008300"];
const VISIT_DASH = ["", "", "", "5 3", "2 3", "8 3 2 3", "1 3", "6 2"];
const visitColor = (i) => VISIT_COLORS[i] || "#8ca0c4";

// Colour tables for the images, matching the map's "colour style" choices.
const STOPS = {
  magma: [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]],
  viridis: [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]],
  redtemperature: [[0, 0, 0], [110, 0, 0], [220, 40, 0], [255, 150, 0], [255, 230, 120], [255, 255, 255]],
  grayscale: [[0, 0, 0], [255, 255, 255]],
};
const lutCache = {};
export function lut(name) {
  if (lutCache[name]) return lutCache[name];
  const stops = STOPS[name] || STOPS.magma, out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1), a = Math.floor(t), b = Math.min(stops.length - 1, a + 1), f = t - a;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = stops[a][c] + (stops[b][c] - stops[a][c]) * f;
  }
  return (lutCache[name] = out);
}

export function decodeImage(b64, size) {
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const img = new Float32Array(bytes.buffer);
  return img.length === size * size ? img : new Float32Array(size * size).fill(NaN);
}

export function createTimelapse({ api, colormap }) {
  const ui = {
    section: $("#tl"), sub: $("#tl-sub"), stage: $("#tl-stage"), canvas: $("#tl-canvas"), hud: $("#tl-hud"),
    status: $("#tl-status"), statusText: $("#tl-status-text"), bar: $("#tl-bar"), retry: $("#tl-retry"),
    play: $("#tl-play"), prev: $("#tl-prev"), next: $("#tl-next"), track: $("#tl-track"),
    dets: $("#tl-dets"), mode: $("#tl-mode"), fov: $("#tl-fov"), speed: $("#tl-speed"), bright: $("#tl-bright"),
    gaia: $("#tl-gaia"), marker: $("#tl-marker"), note: $("#tl-note"),
    wise: $("#wise"), wStage: $("#wise-stage"), wCanvas: $("#wise-canvas"), wHud: $("#wise-hud"), wStatus: $("#wise-status"),
    wStatusText: $("#wise-status-text"), wBusy: $("#wise-busy"), wRetry: $("#wise-retry"), wBands: $("#wise-bands"), wNote: $("#wise-note"),
    specSec: $("#spec"), specChart: $("#spec-chart"), specLegend: $("#spec-legend"), specNote: $("#spec-note"),
    specHead: $("#spec-headline"), specAll: $("#spec-all"), specTable: $("#spec-table"), specTip: $("#spec-tip"), specReset: $("#spec-reset"), specHint: $("#spec-hint"),
  };
  const ctx = ui.canvas.getContext("2d");
  const small = document.createElement("canvas"); // one image pixel per sky pixel; scaled up onto the stage
  const wctx = ui.wCanvas.getContext("2d"), wsmall = document.createElement("canvas"); // the same pair for the WISE image

  const state = {
    target: null,
    fov: 6,
    det: 2,           // detector being shown
    data: {},         // detector -> result from the backend (decoded)
    plan: null,       // visits + exposure times for all detectors
    visit: 0,         // index into the shown detector's visits
    mode: "blink",    // "blink" | "diff"
    playing: false,
    timer: null,
    loading: {},      // detector -> { done, total, abort }
    errors: {},       // detector -> message
    gaia: null,       // { epoch, stars } for the current target + fov
    wise: { band: 1, data: {}, loading: {}, errors: {} }, // the WISE image of this patch, per band (loading: band -> AbortController)
    token: 0,         // bumped on every new target/fov so late answers are ignored
  };

  // ---------------------------------------------------------------- loading
  async function load(det, { show = true } = {}) {
    if (state.data[det] || state.loading[det]) { if (show && state.data[det]) selectDetector(det); return; }
    const token = state.token, t = state.target;
    const abort = new AbortController();
    state.loading[det] = { done: 0, total: 0, abort };
    delete state.errors[det];
    if (show) state.det = det;
    render();
    try {
      const url = `${api}/api/timelapse?ra=${t.ra.toFixed(5)}&dec=${t.dec.toFixed(5)}&fov=${state.fov}&det=${det}`;
      const r = await fetch(url, { signal: abort.signal });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `The time-lapse service answered ${r.status}`);
      // The answer arrives line by line: the plan, progress counts, then the result.
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "", result = null, error = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const text = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!text) continue;
          const msg = JSON.parse(text);
          if (token !== state.token) return;
          if (msg.plan) { state.plan = msg.plan; render(); }
          else if (msg.progress) { Object.assign(state.loading[det], { done: msg.progress[0], total: msg.progress[1] }); renderStatus(); renderDetectors(); }
          else if (msg.error) error = msg.error;
          else if (msg.result) result = msg.result;
        }
        if (done) break;
      }
      if (token !== state.token) return;
      if (error || !result) throw new Error(error || "The time-lapse service stopped before finishing.");
      result.visits.forEach((v) => (v.pixels = decodeImage(v.image, result.size), delete v.image));
      state.plan = result.plan || state.plan;
      state.data[det] = result;
      if (show && state.det === det) state.visit = 0;
    } catch (e) {
      if (e.name === "AbortError" || token !== state.token) return;
      state.errors[det] = /Failed to fetch|Load failed|NetworkError/i.test(e.message) ? "Couldn't reach the Lumasphere backend." : e.message;
    } finally {
      if (token === state.token) { delete state.loading[det]; render(); if (state.data[det] && state.det === det && !state.playing) autoPlay(); }
    }
  }

  function autoPlay() {
    const d = state.data[state.det];
    if (d && d.visits.length > 1 && !matchMedia("(prefers-reduced-motion: reduce)").matches) setPlaying(true);
  }

  function selectDetector(det) {
    state.det = det;
    const d = state.data[det];
    if (d) state.visit = clamp(state.visit, 0, Math.max(0, d.visits.length - 1));
    render();
  }

  function reset() {
    state.token++;
    for (const l of Object.values(state.loading)) l.abort.abort();
    for (const abort of Object.values(state.wise.loading)) abort.abort();
    setPlaying(false);
    Object.assign(state, { data: {}, plan: null, visit: 0, loading: {}, errors: {}, gaia: null, wise: { band: state.wise.band, data: {}, loading: {}, errors: {} } });
  }

  // ---------------------------------------------------------------- public
  function show(target, { auto = true } = {}) {
    reset();
    state.target = target;
    // Cold brown dwarfs only glow at the longest wavelengths; everything else is sharpest around 1.3 µm.
    // Measured on WISE 0855 and Epsilon Indi B: both are clearest in detector 5 (3.8-4.4 µm).
    // A featured target can name the detector that shows it best (app.js FEATURED).
    const cold = /brown dwarf/i.test(target.type_label || "");
    state.det = target.det || (cold ? 5 : 2);
    state.wise.band = cold ? 2 : 1;
    state.held = !auto;
    ui.section.hidden = ui.specSec.hidden = ui.wise.hidden = false;
    ui.gaia.checked = false;
    render();
    if (auto) load(state.det);
    if (ui.wise.open) loadWise();
  }

  function clear() {
    reset();
    state.target = null;
    ui.section.hidden = ui.specSec.hidden = ui.wise.hidden = true;
  }

  // ---------------------------------------------------------------- drawing the frame
  function currentFrame() {
    const d = state.data[state.det];
    if (!d || !d.visits.length) return null;
    const v = d.visits[clamp(state.visit, 0, d.visits.length - 1)];
    return { d, v, ref: state.mode === "diff" ? d.visits[state.visit === 0 ? d.visits.length - 1 : 0] : null };
  }

  // Size a canvas to its (square) stage and wipe it. Returns the stage's width in CSS pixels.
  function fitCanvas(canvas, ctx, stage) {
    const size = stage.clientWidth || 380, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(size * dpr)) canvas.width = canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    return size;
  }

  // Colour one image (`pixels`, with the backend's `d.range` and `d.size`) and draw it `size` wide.
  // Given `refPixels`, draws the difference from that image instead.
  function paint(ctx, scratch, d, pixels, refPixels, size) {
    const n = d.size;
    if (scratch.width !== n) scratch.width = scratch.height = n;
    const sctx = scratch.getContext("2d"), image = sctx.createImageData(n, n), px = image.data;
    const { lo, hi } = d.range, gain = Math.pow(4, 1 - ui.bright.value / 50); // slider right = brighter
    if (refPixels) {
      // Difference: mid-grey = unchanged, white = brighter than the other visit, black = fainter.
      const span = 25 * d.range.noise * gain;
      for (let i = 0; i < n * n; i++) {
        const diff = pixels[i] - refPixels[i];
        const g = Number.isFinite(diff) ? clamp(127.5 + (diff / span) * 127.5, 0, 255) : 127.5;
        px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = g; px[i * 4 + 3] = 255;
      }
    } else {
      // The usual astronomer's stretch: roughly linear for faint things near the noise level,
      // logarithmic for bright ones, so faint stars and a blazing one are visible together.
      const table = lut(colormap()), soft = 2.5 * d.range.noise * gain, norm = Math.asinh((hi - lo) / soft);
      for (let i = 0; i < n * n; i++) {
        const x = pixels[i];
        const s = Number.isFinite(x) ? clamp(Math.asinh(Math.max(0, x - lo) / soft) / norm, 0, 1) : 0;
        const c = Math.round(s * 255) * 3;
        px[i * 4] = table[c]; px[i * 4 + 1] = table[c + 1]; px[i * 4 + 2] = table[c + 2]; px[i * 4 + 3] = 255;
      }
    }
    sctx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(scratch, 0, 0, size, size);
  }

  function drawFrame() {
    const size = fitCanvas(ui.canvas, ctx, ui.stage);
    const f = currentFrame();
    if (!f) return;
    const { d, v, ref } = f;
    paint(ctx, small, d, v.pixels, ref && ref.pixels, size);
    drawOverlays(ctx, d, mjdToYear(v.mjd), size);
  }

  function drawWise() {
    if (!ui.wise.open || !state.target) return;
    const size = fitCanvas(ui.wCanvas, wctx, ui.wStage);
    const d = state.wise.data[state.wise.band];
    if (!d) return;
    paint(wctx, wsmall, d, d.pixels, null, size);
    // A planet or asteroid was somewhere else entirely in 2010: no marker for it here.
    drawOverlays(wctx, d, d.epoch, size, { marker: !state.target.moving });
  }
  const drawAll = () => { drawFrame(); drawWise(); };

  // Sky offset (arcseconds east, north of the patch centre) -> canvas position.
  const toCanvas = (d, size, east, north) => [size / 2 - (east / d.scale_arcsec) * (size / d.size), size / 2 - (north / d.scale_arcsec) * (size / d.size)];

  // Arcseconds east and north of the patch centre, on the flat (tangent-plane) grid the images use.
  function skyOffset(t, ra, dec) {
    const R = Math.PI / 180, d0 = t.dec * R, d1 = dec * R, dr = (ra - t.ra) * R;
    const cosc = Math.sin(d0) * Math.sin(d1) + Math.cos(d0) * Math.cos(d1) * Math.cos(dr);
    return [(Math.cos(d1) * Math.sin(dr) / cosc) * 206264.806,
      ((Math.cos(d0) * Math.sin(d1) - Math.sin(d0) * Math.cos(d1) * Math.cos(dr)) / cosc) * 206264.806];
  }

  // Where the catalog says the target was in `year`, relative to the patch centre (its position plus its known motion).
  function markerOffset(year) {
    const t = state.target;
    if (t.pm_ra_mas_yr == null || !t.epoch) return [0, 0];
    return [(t.pm_ra_mas_yr * (year - t.epoch)) / 1000, (t.pm_dec_mas_yr * (year - t.epoch)) / 1000];
  }

  // Marks drawn over an image `d` taken in `year`: Gaia stars, the target's marker, scale bar, compass.
  function drawOverlays(ctx, d, year, size, { marker = true } = {}) {
    const t = state.target, arcsecPerPx = (d.scale_arcsec * d.size) / size;
    ctx.lineCap = "butt";

    if (ui.gaia.checked && state.gaia) {
      // Each Gaia star is drawn where its measured motion puts it on this image's date.
      const dt = year - state.gaia.epoch;
      ctx.strokeStyle = "rgba(255, 197, 49, 0.9)"; ctx.lineWidth = 1.2; // Gaia gold, as on the map
      for (const s of state.gaia.stars) {
        const [e0, n0] = skyOffset(t, s.ra, s.dec);
        const east = e0 + ((s.pmra || 0) * dt) / 1000, north = n0 + ((s.pmdec || 0) * dt) / 1000;
        const [x, y] = toCanvas(d, size, east, north);
        if (x < 4 || y < 4 || x > size - 4 || y > size - 4) continue;
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
      }
    }

    if (marker && ui.marker.checked) {
      const [east, north] = markerOffset(year);
      const [x, y] = toCanvas(d, size, east, north), gap = 11, len = 9;
      ctx.lineCap = "butt";
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(x + dx * gap, y + dy * gap); ctx.lineTo(x + dx * (gap + len), y + dy * (gap + len)); }
      // Red like the object's ring on the map, over a dark edge so it shows on a bright star's glow too.
      ctx.strokeStyle = "rgba(3, 6, 15, 0.7)"; ctx.lineWidth = 4.5; ctx.stroke();
      ctx.strokeStyle = "#fc3d21"; ctx.lineWidth = 2; ctx.stroke();
    }

    // Scale bar (bottom right) and compass (bottom left).
    const barArcsec = [600, 300, 120, 60, 30, 10].find((a) => a / arcsecPerPx < size * 0.3) || 10;
    const barPx = barArcsec / arcsecPerPx, bx = size - 14 - barPx, by = size - 16;
    ctx.strokeStyle = ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by); ctx.stroke();
    ctx.font = "600 11px Archivo, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(barArcsec >= 60 ? `${barArcsec / 60}′` : `${barArcsec}″`, bx + barPx / 2, by - 4);
    const cx = 40, cy = size - 20;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 18); ctx.moveTo(cx, cy); ctx.lineTo(cx - 18, cy); ctx.stroke();
    ctx.textBaseline = "middle"; ctx.fillText("N", cx, cy - 25); ctx.fillText("E", cx - 25, cy);
  }

  // ---------------------------------------------------------------- panel pieces
  function renderStatus() {
    const d = state.data[state.det], l = state.loading[state.det], err = state.errors[state.det];
    let text = "", showBar = false, showRetry = false;
    if (l) {
      showBar = true;
      text = l.total ? `Downloading exposures… ${l.done} of ${l.total}` : "Finding SPHEREx exposures of this spot…";
      ui.bar.style.width = `${l.total ? Math.max(4, (l.done / l.total) * 100) : 4}%`;
    } else if (err) {
      text = err; showRetry = true;
    } else if (state.held && !d) {
      text = "This object moves across the sky, so one fixed patch doesn't follow it. You can still load the patch where it is today.";
      showRetry = true;
    } else if (d && !d.visits.length) {
      text = `SPHEREx has no usable exposures of this spot with detector ${state.det} yet.`;
    } else if (!d) {
      text = "Not loaded yet.";
      showRetry = true;
    }
    ui.status.hidden = !text;
    ui.statusText.textContent = text;
    ui.bar.parentElement.hidden = !showBar;
    ui.retry.hidden = !showRetry;
    ui.retry.textContent = err ? "Try again" : "Load time-lapse";
  }

  function renderHud() {
    const f = currentFrame();
    ui.hud.hidden = !f;
    if (!f) return;
    const { d, v, ref } = f, i = d.visits.indexOf(v) + 1;
    ui.hud.replaceChildren(
      el("strong", {}, ref ? `${fmtDate(v.mjd, { month: "short", year: "numeric" })} minus ${fmtDate(ref.mjd, { month: "short", year: "numeric" })}` : fmtDate(v.mjd)),
      el("span", {}, `Visit ${i} of ${d.visits.length}`),
      el("span", {}, `${v.n} exposure${v.n === 1 ? "" : "s"}`));
    if (v.n < 3) ui.hud.append(el("span", { className: "flag", title: "Fewer than three exposures: this frame is noisy" }, "Noisy"));
  }

  function renderDetectors() {
    ui.dets.replaceChildren(...DETECTORS.map(({ id, range }) => {
      const count = state.plan?.detectors?.[id], l = state.loading[id];
      const b = el("button", { type: "button", className: "tl-det" + (id === state.det ? " on" : "") + (state.data[id] ? " loaded" : "") + (l ? " loading" : "") });
      b.setAttribute("aria-pressed", id === state.det);
      b.title = state.data[id] ? `Detector ${id}: loaded` : `Detector ${id}: click to load${count != null ? ` (${count} exposures)` : ""}`;
      b.append(el("b", {}, `D${id}`), el("small", {}, l ? (l.total ? `${Math.round((l.done / l.total) * 100)}%` : "…") : range));
      b.disabled = count === 0;
      b.onclick = () => (state.data[id] ? selectDetector(id) : load(id));
      return b;
    }));
  }

  // The timeline: the whole survey left to right, a tick for every exposure of this detector,
  // a band for every visit. Click a visit to jump to it.
  function renderTrack() {
    const W = ui.track.clientWidth || 300, H = 54, padX = 10;
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "group", "aria-label": "Timeline of SPHEREx visits" });
    const plan = state.plan, d = state.data[state.det];
    if (!plan || !plan.visits.length) { ui.track.replaceChildren(root); return; }
    const t0 = plan.visits[0].mjd_start, t1 = plan.visits.at(-1).mjd_end, span = Math.max(30, t1 - t0);
    const lo = t0 - span * 0.04, hi = t1 + span * 0.04;
    const x = (mjd) => padX + ((mjd - lo) / (hi - lo)) * (W - 2 * padX);
    const axisY = 30;
    root.append(svg("line", { x1: padX, x2: W - padX, y1: axisY, y2: axisY, class: "tl-axis" }));

    // Month marks: label Januarys with the year, plus enough others to read the scale.
    const start = mjdToDate(lo), cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const months = (hi - lo) / 30.4, every = months > 30 ? 6 : months > 14 ? 3 : months > 7 ? 2 : 1;
    for (; cursor.getTime() / 86400000 + MJD_UNIX < hi; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
      const mjd = cursor.getTime() / 86400000 + MJD_UNIX, m = cursor.getUTCMonth(), major = m % every === 0;
      root.append(svg("line", { x1: x(mjd), x2: x(mjd), y1: axisY, y2: axisY + (major ? 5 : 3), class: "tl-axis" }));
      if (major) root.append(svg("text", { x: x(mjd), y: axisY + 17, class: "tl-tick" + (m === 0 ? " year" : "") },
        m === 0 ? String(cursor.getUTCFullYear()) : MONTHS[m]));
    }

    for (const mjd of plan.times?.[state.det] || []) root.append(svg("line", { x1: x(mjd), x2: x(mjd), y1: axisY - 9, y2: axisY - 1, class: "tl-exp" }));

    const shown = d?.visits || [];
    plan.visits.forEach((pv) => {
      const idx = shown.findIndex((v) => v.id === pv.id), active = idx >= 0 && idx === state.visit, has = idx >= 0;
      const xa = x(pv.mjd_start), xb = x(pv.mjd_end), w = Math.max(14, xb - xa), cx = (xa + xb) / 2;
      const g = svg("g", { class: "tl-visit" + (active ? " on" : "") + (has ? "" : " empty"), tabindex: has ? 0 : -1, role: "button",
        "aria-label": `Visit ${pv.id + 1}: ${pv.date_start} to ${pv.date_end}` });
      g.append(svg("rect", { x: Math.round(cx - w / 2) + 0.5, y: axisY - 13.5, width: Math.round(w), height: 16, class: "band" }));
      const pin = active ? 9 : 7;
      g.append(svg("rect", { x: cx - pin / 2, y: 9 - pin / 2, width: pin, height: pin, class: "pin" }));
      if (has) {
        g.addEventListener("click", () => { setPlaying(false); state.visit = idx; render(); });
        g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); g.dispatchEvent(new Event("click")); } });
      }
      g.append(svg("title", {}, `${fmtDate(pv.mjd_start, { day: "numeric", month: "short" })} – ${fmtDate(pv.mjd_end)}${has ? "" : " (no exposures with this detector)"}`));
      root.append(g);
    });
    ui.track.replaceChildren(root);
  }

  function renderSub() {
    const d = state.data[state.det], t = state.target;
    if (!d) { ui.sub.textContent = "SPHEREx revisits every spot about twice a year"; ui.note.textContent = ""; return; }
    const first = d.visits[0], last = d.visits.at(-1);
    ui.sub.textContent = d.visits.length > 1
      ? `${d.visits.length} visits, ${fmtDate(first.mjd, { month: "short", year: "numeric" })} – ${fmtDate(last.mjd, { month: "short", year: "numeric" })}`
      : d.visits.length ? "Only one visit so far" : "";
    let note = `Each frame combines the exposures of one visit taken with detector ${d.detector} (${DETECTORS[d.detector - 1].range}). `;
    if (t.pm_total_arcsec_yr > 0.3 && d.visits.length > 1) {
      const moved = (t.pm_total_arcsec_yr * (last.mjd - first.mjd)) / 365.25;
      note += `Catalogs say this star should move about ${moved.toFixed(1)}″ between the first and last visit: watch it against the still background stars.`;
    } else if (state.mode === "diff") {
      note += "Grey means nothing changed. A clean white dot beside a clean black one is something that moved; a lone white or black dot brightened or faded. Bright stars leave small smudges because no two visits line up perfectly.";
    } else {
      note += "Anything that jumps or flickers while the stars stay put is worth a closer look.";
    }
    ui.note.textContent = note;
  }

  function render() {
    renderStatus(); renderHud(); renderDetectors(); renderTrack(); renderSub(); drawFrame(); renderSpectrum(); renderWise();
    const d = state.data[state.det], many = !!d && d.visits.length > 1;
    ui.play.disabled = ui.prev.disabled = ui.next.disabled = !many;
    setIcon(ui.play, state.playing ? "pause" : "play");
    ui.play.setAttribute("aria-label", state.playing ? "Pause" : "Play");
  }

  // ---------------------------------------------------------------- playback
  function step(by) {
    const d = state.data[state.det];
    if (!d || !d.visits.length) return;
    state.visit = (state.visit + by + d.visits.length) % d.visits.length;
    renderHud(); renderTrack(); drawFrame();
  }
  function setPlaying(on) {
    clearInterval(state.timer);
    state.playing = on;
    if (on) state.timer = setInterval(() => step(1), +ui.speed.value);
    setIcon(ui.play, on ? "pause" : "play");
    ui.play.setAttribute("aria-label", on ? "Pause" : "Play");
  }

  // ---------------------------------------------------------------- Gaia stars on the frames
  async function loadGaia() {
    const t = state.target, token = state.token;
    try {
      const radius = Math.min(0.5, ((state.fov / 60) * 0.75)).toFixed(4);
      const r = await fetch(`${api}/api/gaia?ra=${t.ra.toFixed(5)}&dec=${t.dec.toFixed(5)}&radius=${radius}&limit=120`); // the 120 brightest
      if (!r.ok) throw new Error();
      const data = await r.json();
      if (token !== state.token) return;
      state.gaia = data;
      drawAll();
    } catch {
      if (token !== state.token) return;
      ui.gaia.checked = false;
      ui.note.textContent = "The Gaia star catalog didn't answer. Try the switch again in a moment.";
    }
  }

  // ---------------------------------------------------------------- WISE, 2010
  // The same patch as NASA's WISE telescope saw it, at the same size and orientation, so it
  // sits under the flipbook as the "before" picture. It follows the patch width, colour style,
  // brightness, marker and Gaia switches above; only its band is its own.
  async function loadWise(band = state.wise.band) {
    const w = state.wise, t = state.target, token = state.token;
    if (!t) return;
    w.band = band;
    if (w.data[band] || w.loading[band]) return renderWise();
    const abort = (w.loading[band] = new AbortController());
    delete w.errors[band];
    renderWise();
    try {
      const r = await fetch(`${api}/api/wise?ra=${t.ra.toFixed(5)}&dec=${t.dec.toFixed(5)}&fov=${state.fov}&band=${band}`, { signal: abort.signal });
      if (r.status === 404) throw new Error("This backend doesn't serve WISE images yet. Restart it to pick up the update.");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `The WISE service answered ${r.status}`);
      const d = await r.json();
      if (token !== state.token) return;
      d.pixels = decodeImage(d.image, d.size);
      delete d.image;
      w.data[band] = d;
    } catch (e) {
      if (e.name === "AbortError" || token !== state.token) return;
      w.errors[band] = /Failed to fetch|Load failed|NetworkError/i.test(e.message) ? "Couldn't reach the Lumasphere backend." : e.message;
    } finally {
      if (token === state.token) { delete w.loading[band]; renderWise(); }
    }
  }

  // Roughly when SPHEREx saw this patch: the latest loaded visit, else the object's own date, else today.
  function spherexYear() {
    const last = state.data[state.det]?.visits.at(-1);
    return last ? mjdToYear(last.mjd) : state.target.epoch || mjdToYear(Date.now() / 86400000 + MJD_UNIX);
  }

  function wiseNote(d) {
    const t = state.target, band = WISE_BANDS[d.band - 1], gap = spherexYear() - d.epoch;
    let note = `NASA's WISE telescope photographed the whole sky in 2010, about ${Math.round(gap)} years before SPHEREx. This is the same patch at the same size, north up, at ${band.wl}`;
    note += band.det ? `: a color SPHEREx sees too, with detector ${band.det}. ` : ": a longer wavelength than SPHEREx reaches, where cool dust glows and most stars fade. ";
    if (t.moving) {
      note += "This object travels across the sky and was somewhere else in 2010, so this shows what lies behind where it is today.";
    } else if (t.pm_total_arcsec_yr > 0.3) {
      const [east, north] = markerOffset(d.epoch), half = (d.scale_arcsec * d.size) / 2;
      note += `Catalogs say this star has moved about ${Math.round(t.pm_total_arcsec_yr * gap)}″ since then`;
      note += Math.abs(east) < half && Math.abs(north) < half
        ? ": the marker shows where it was in 2010."
        : ", which puts its 2010 position outside this patch. Choose a wider patch to find it.";
    } else {
      note += "Anything in one image and not the other has moved, brightened or faded since.";
    }
    if (d.range.saturated > 0.002) note += " The brightest parts overwhelmed WISE's detectors; they are filled in at full brightness.";
    return note;
  }

  function renderWise() {
    if (!state.target) return;
    const w = state.wise, d = w.data[w.band], busy = !!w.loading[w.band], err = w.errors[w.band];
    const focused = ui.wBands.contains(document.activeElement);
    ui.wBands.replaceChildren(...WISE_BANDS.map(({ id, wl, det }) => {
      const b = el("button", { type: "button", className: "tl-det" + (id === w.band ? " on" : "") + (w.data[id] ? " loaded" : "") + (w.loading[id] ? " loading" : "") });
      b.setAttribute("aria-pressed", id === w.band);
      b.title = `WISE band ${id}, ${wl}` + (det ? `: also seen by SPHEREx detector ${det}` : ": beyond SPHEREx's range");
      b.append(el("b", {}, `W${id}`), el("small", {}, w.loading[id] ? "…" : wl));
      b.onclick = () => loadWise(id);
      return b;
    }));
    if (focused) ui.wBands.children[w.band - 1].focus(); // the buttons were rebuilt: keep the keyboard where it was
    const text = busy ? "Fetching the WISE image of this patch…" : err || "";
    ui.wStatus.hidden = !text;
    ui.wStatusText.textContent = text;
    ui.wBusy.hidden = !busy;
    ui.wRetry.hidden = busy || !err;
    ui.wHud.hidden = !d;
    if (d) ui.wHud.replaceChildren(el("strong", {}, "2010"), el("span", {}, "WISE telescope"), el("span", {}, `Band ${d.band}, ${WISE_BANDS[d.band - 1].wl}`));
    ui.wNote.textContent = d ? wiseNote(d) : "";
    drawWise();
  }

  // ---------------------------------------------------------------- spectrum
  // Did it change between visits? Detector by detector (each detector sees the same colours on
  // every visit), visit median against visit median, and only a difference well beyond the
  // scatter of the measurements counts: a faint source's noise must not read as a change.
  // A star too bright to measure (saturated) is judged by the glow around it instead.
  function changeHeadline() {
    let best = null, tested = false;
    for (const det of Object.keys(state.data).map(Number)) {
      const d = state.data[det];
      const key = d.exposures.some((e) => e.flux != null) ? "flux" : "halo";
      const per = d.visits.map((v) => {
        const f = d.exposures.filter((e) => e.visit === v.id && e[key] != null).map((e) => e[key]).sort((a, b) => a - b);
        if (f.length < 3) return null;
        const mid = f[Math.floor(f.length / 2)];
        const mad = f.map((x) => Math.abs(x - mid)).sort((a, b) => a - b)[Math.floor(f.length / 2)];
        return { v, m: mid, se: (1.25 * 1.4826 * mad) / Math.sqrt(f.length) }; // standard error of a median
      }).filter(Boolean);
      if (per.length < 2) continue;
      tested = true;
      const hi = per.reduce((a, b) => (b.m > a.m ? b : a)), lo = per.reduce((a, b) => (b.m < a.m ? b : a));
      if (lo.m <= 0) continue;
      const change = hi.m / lo.m - 1, real = hi.m - lo.m > 3 * Math.hypot(hi.se, lo.se);
      // The glow around a saturated star depends on where the star fell on the detector, too:
      // steady Barnard's Star shows glow changes of up to 80%. Only a doubling counts there.
      const enough = key === "halo" ? 1.0 : 0.1;
      if (real && change >= enough && (!best || change > best.change)) best = { change, hi, lo, det, halo: key === "halo" };
    }
    if (!tested) return "";
    if (!best) return "No clear change: the differences between visits are within the measurement scatter.";
    // Different colours can change in different directions, so name where the biggest change is.
    const when = (v) => fmtDate(v.mjd, { month: "short", year: "numeric" });
    if (best.halo) {
      return `Probably changed: its glow was ${(best.change + 1).toFixed(1)}× as bright in ${when(best.hi.v)} as in ${when(best.lo.v)}, at ${DETECTORS[best.det - 1].range}`
        + " (too bright to measure directly, so this is judged from the light around it, which is less certain).";
    }
    return `Changed between visits: up to ${Math.round(best.change * 100)}% brighter in ${when(best.hi.v)} than in ${when(best.lo.v)}, at ${DETECTORS[best.det - 1].range}.`;
  }

  // Brightness of the target in every exposure, against that exposure's wavelength.
  // One line per visit: where the lines differ, the object changed between visits.
  function spectrumData() {
    const visits = new Map(); // visit id -> { id, mjd, points: [{wl, flux, err, det, mjd}] }
    let measured = 0, total = 0;
    for (const det of Object.keys(state.data).map(Number).sort()) {
      const d = state.data[det];
      for (const e of d.exposures) {
        total++;
        if (e.flux == null) continue;
        measured++;
        if (!visits.has(e.visit)) visits.set(e.visit, { id: e.visit, points: [] });
        visits.get(e.visit).points.push({ ...e, det });
      }
    }
    const list = [...visits.values()].sort((a, b) => a.id - b.id);
    for (const v of list) {
      v.points.sort((a, b) => a.wl - b.wl);
      v.mjd = v.points.reduce((s, p) => s + p.mjd, 0) / v.points.length;
    }
    return { list, measured, total };
  }

  function renderSpectrum() {
    const { list, measured, total } = spectrumData();
    const loaded = Object.keys(state.data).length, pending = Object.keys(state.loading).length;
    ui.specAll.hidden = loaded + pending >= 6 || !state.target || (!loaded && !pending);
    ui.specAll.querySelector("span").textContent = `Load the other ${6 - loaded - pending} detectors`;
    ui.specTip.hidden = true;
    const order = (state.plan?.visits || []).map((v) => v.id);
    const colorOf = (id) => visitColor(Math.max(0, order.indexOf(id)));
    const dashOf = (id) => VISIT_DASH[Math.max(0, order.indexOf(id))] || "";

    if (!measured) {
      ui.specChart.replaceChildren();
      ui.specReset.hidden = true;
      ui.specHint.textContent = "";
      ui.specLegend.replaceChildren();
      ui.specTable.replaceChildren();
      ui.specHead.textContent = changeHeadline();
      ui.specNote.textContent = !loaded
        ? "The spectrum appears once the time-lapse has loaded."
        : total ? "This object is too bright here: it saturates SPHEREx's detector, so its full brightness (and spectrum) can't be measured. Any change above is judged from the glow around it."
        : "No measurements at this spot yet.";
      return;
    }

    const W = ui.specChart.clientWidth || 380, H = 240, m = { l: 48, r: 12, t: 16, b: 30 };
    const all = list.flatMap((v) => v.points);
    // Wavelengths where exposures exist but none could be measured (saturated or off the image
    // edge): shaded, so a gap in the lines reads as "no data here", not as the object going dark.
    const gaps = [];
    {
      const exps = [];
      for (const det of Object.keys(state.data)) for (const e of state.data[det].exposures) exps.push(e);
      exps.sort((a, b) => a.wl - b.wl);
      // A run of skipped exposures with no measurement between them. Lone skips (one exposure off
      // the image edge) don't count, and a run never reaches past the measurements on either side.
      let run = [], prev = -Infinity;
      const close = (next) => {
        if (run.length >= 3) {
          const a = Math.max(run[0].wl - run[0].bw / 2, prev), b = Math.min(run.at(-1).wl + run.at(-1).bw / 2, next);
          if (b - a >= 0.06) gaps.push({ a, b });
        }
        run = [];
      };
      for (const e of exps) {
        if (e.flux == null) run.push(e);
        else { close(e.wl); prev = e.wl; }
      }
      close(Infinity);
    }
    // The full view spans the loaded detectors, so one detector's measurements fill its width
    // instead of huddling in a corner of the full 0.75–5 µm range.
    const dets = [...new Set(Object.keys(state.data).map(Number))].map((d) => DETECTORS[d - 1]);
    const lo = Math.min(...dets.map((d) => d.lo), ...all.map((p) => p.wl)), hi = Math.max(...dets.map((d) => d.hi), ...all.map((p) => p.wl));
    const full = { x0: lo - (hi - lo) * 0.03, x1: hi + (hi - lo) * 0.03 };
    const zoom = state.specZoom?.target === state.target ? state.specZoom : null;
    const { x0, x1 } = zoom || full;
    // Brightness range: from zero in the full view; hugging the visible points when zoomed in.
    const seen = all.filter((p) => p.wl >= x0 && p.wl <= x1);
    const fs = (seen.length ? seen : all).flatMap((p) => (zoom && p.err ? [p.flux - p.err, p.flux + p.err] : [p.flux]));
    let yMin = Math.min(...fs), yMax = Math.max(...fs);
    if (!zoom) { yMin = Math.min(0, yMin); yMax *= 1.08; }
    else { const pad = (yMax - yMin || Math.abs(yMax) * 0.1 || 1) * 0.12; yMin -= pad; yMax += pad; }
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const X = (wl) => m.l + ((wl - x0) / (x1 - x0)) * pw;
    const Y = (f) => H - m.b - ((f - yMin) / (yMax - yMin || 1)) * ph;
    const wlAt = (px) => x0 + ((px - m.l) / pw) * (x1 - x0);
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
      "aria-label": "Spectrum: brightness in millijansky against wavelength in microns, one line per visit. Drag across it to zoom in." });
    const clipId = "sp-clip";
    const defs = svg("defs");
    const clip = svg("clipPath", { id: clipId }); clip.append(svg("rect", { x: m.l, y: m.t - 6, width: pw, height: ph + 6 }));
    const hatch = svg("pattern", { id: "sp-hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
    hatch.append(svg("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "sp-hatch-line" }));
    defs.append(clip, hatch);
    root.append(defs);

    for (const g of gaps) {
      const a = Math.max(X(g.a), m.l), b = Math.min(X(g.b), W - m.r);
      if (b - a < 1) continue;
      const r = svg("rect", { x: a, y: m.t, width: b - a, height: ph, class: "sp-gap" });
      r.append(svg("title", {}, `${g.a.toFixed(2)}–${g.b.toFixed(2)} µm: not measured (too bright, so the detector saturated, or at the image edge)`));
      root.append(r);
      if (b - a > 96) root.append(svg("text", { x: (a + b) / 2, y: H - m.b - 10, class: "sp-gap-label", "text-anchor": "middle" }, "not measured"));
    }

    // Recessive grid: about 4 brightness lines, and wavelength marks at a round step.
    const nice = (raw) => { const mag = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw); };
    const yStep = nice((yMax - yMin) / 4);
    const num = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    const fmt = (v) => num.format(Math.abs(v) >= 100 ? Math.round(v) : Math.abs(v) >= 10 ? Math.round(v * 10) / 10 : v);
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9; v += yStep) {
      const y = Y(v);
      if (y < m.t - 1) continue;
      root.append(svg("line", { x1: m.l, x2: W - m.r, y1: y, y2: y, class: Math.abs(v) < yStep / 1e6 ? "sp-axis" : "sp-grid" }));
      root.append(svg("text", { x: m.l - 7, y: y + 3.5, class: "sp-label", "text-anchor": "end" }, fmt(Math.abs(v) < yStep / 1e6 ? 0 : v)));
    }
    const xStep = nice((x1 - x0) / 7);
    const xDec = Math.max(0, -Math.floor(Math.log10(xStep) + 1e-9) + (String(xStep).includes("25") ? 1 : 0));
    for (let k = Math.ceil(x0 / xStep - 1e-9); k * xStep <= x1 + 1e-9; k++) {
      const wl = k * xStep;
      root.append(svg("line", { x1: X(wl), x2: X(wl), y1: H - m.b, y2: H - m.b + 4, class: "sp-axis" }));
      root.append(svg("text", { x: X(wl), y: H - m.b + 16, class: "sp-label", "text-anchor": "middle" }, wl.toFixed(xDec)));
    }
    root.append(svg("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: "sp-axis" }));
    root.append(svg("text", { x: W - m.r, y: H - 2, class: "sp-label", "text-anchor": "end" }, "wavelength (µm)"));
    root.append(svg("text", { x: m.l - 7, y: m.t - 5, class: "sp-label", "text-anchor": "end" }, "mJy"));

    // One line per visit and detector (a line never bridges a detector that isn't loaded, or a gap).
    const plot = svg("g", { "clip-path": `url(#${clipId})` });
    root.append(plot);
    const gapBetween = (a, b) => gaps.some((g) => g.a > a.wl && g.b < b.wl);
    for (const v of list) {
      const color = colorOf(v.id);
      const byDet = new Map();
      for (const p of v.points) (byDet.get(p.det) || byDet.set(p.det, []).get(p.det)).push(p);
      for (const pts of byDet.values()) {
        const d = pts.map((p, i) => `${i && !gapBetween(pts[i - 1], p) ? "L" : "M"}${X(p.wl).toFixed(1)} ${Y(p.flux).toFixed(1)}`).join("");
        if (pts.length > 1) plot.append(svg("path", { d, class: "sp-line", stroke: color, "stroke-dasharray": dashOf(v.id) }));
        for (const p of pts) {
          // Error bars only where they are big enough to see (in practice, once zoomed in).
          if (p.err && Y(p.flux - p.err) - Y(p.flux + p.err) >= 3) {
            plot.append(svg("line", { x1: X(p.wl), x2: X(p.wl), y1: Y(p.flux - p.err), y2: Y(p.flux + p.err), class: "sp-err", stroke: color }));
          }
          // A measurement with no neighbours gets a ring, so it reads as a real point, not a stray mark.
          plot.append(svg("circle", { cx: X(p.wl), cy: Y(p.flux), r: pts.length > 1 ? (zoom ? 2.6 : 1.9) : 3.2, fill: color, class: pts.length > 1 ? "sp-dot" : "sp-dot lone" }));
        }
      }
    }

    // Hover: a hairline snaps to the nearest measured wavelength and lists every visit there.
    const hair = svg("line", { y1: m.t, y2: H - m.b, class: "sp-hair", visibility: "hidden" });
    const marks = svg("g", {});
    const brush = svg("rect", { y: m.t, height: ph, class: "sp-brush", visibility: "hidden" });
    root.append(hair, marks, brush);
    const wls = [...new Set(seen.map((p) => p.wl))].sort((a, b) => a - b);
    const hideTip = () => { hair.setAttribute("visibility", "hidden"); marks.replaceChildren(); ui.specTip.hidden = true; };
    const showAt = (px) => {
      if (!wls.length) return hideTip();
      const wl = wlAt(px);
      const near = wls.reduce((a, b) => (Math.abs(b - wl) < Math.abs(a - wl) ? b : a));
      hair.setAttribute("x1", X(near)); hair.setAttribute("x2", X(near)); hair.setAttribute("visibility", "visible");
      marks.replaceChildren();
      const rows = [];
      const tol = Math.max(0.004, Math.min(0.06, (x1 - x0) / 60));
      for (const v of list) {
        const p = v.points.reduce((a, b) => (Math.abs(b.wl - near) < Math.abs(a.wl - near) ? b : a));
        if (Math.abs(p.wl - near) > tol) continue;
        marks.append(svg("circle", { cx: X(p.wl), cy: Y(p.flux), r: 4.5, fill: colorOf(v.id), class: "sp-mark" }));
        rows.push({ v, p });
      }
      ui.specTip.replaceChildren(el("div", { className: "tip-head" }, `${near.toFixed(3)} µm`), ...rows.map(({ v, p }) => {
        const row = el("div", { className: "tip-row" });
        const key = el("i"); key.style.background = colorOf(v.id);
        row.append(key, el("b", {}, `${fmt(p.flux)}${p.err ? ` ±${fmt(p.err)}` : ""} mJy`), el("span", {}, fmtDate(p.mjd, { day: "numeric", month: "short", year: "numeric" })));
        return row;
      }));
      ui.specTip.hidden = false;
      ui.specTip.style.left = `${X(near) > W * 0.55 ? Math.max(0, X(near) - 202) : clamp(X(near) + 16, 0, W - 196)}px`;
      // Sit in the half of the plot the points are not in, so the box never covers what it describes.
      const high = rows.reduce((sum, r) => sum + Y(r.p.flux), 0) / (rows.length || 1) < (m.t + H - m.b) / 2;
      ui.specTip.style.top = high ? "auto" : "14px";
      ui.specTip.style.bottom = high ? `${m.b + 12}px` : "auto";
    };

    // Zoom: drag across the chart to pick a wavelength range; pinch (or ctrl + scroll) zooms
    // around the pointer; a sideways swipe pans; double-click or "Reset zoom" goes back.
    const MIN_SPAN = 0.01;
    const setView = (a, b) => {
      if (b - a < MIN_SPAN) { const c = (a + b) / 2; a = c - MIN_SPAN / 2; b = c + MIN_SPAN / 2; }
      if (b - a >= (full.x1 - full.x0) * 0.98) { state.specZoom = null; renderSpectrum(); return; }
      const shift = Math.max(0, full.x0 - a) - Math.max(0, b - full.x1);
      state.specZoom = { target: state.target, x0: a + shift, x1: b + shift };
      renderSpectrum();
    };
    const localX = (e) => (e.clientX - root.getBoundingClientRect().left) * (W / root.getBoundingClientRect().width);
    let drag = null;
    root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { from: clamp(localX(e), m.l, W - m.r), id: e.pointerId };
      root.setPointerCapture(e.pointerId);
    });
    root.addEventListener("pointermove", (e) => {
      const px = localX(e);
      if (!drag) return showAt(px);
      const to = clamp(px, m.l, W - m.r);
      if (Math.abs(to - drag.from) < 4) return;
      hideTip();
      brush.setAttribute("x", Math.min(drag.from, to)); brush.setAttribute("width", Math.abs(to - drag.from)); brush.setAttribute("visibility", "visible");
    });
    root.addEventListener("pointerup", (e) => {
      if (!drag) return;
      const to = clamp(localX(e), m.l, W - m.r), from = drag.from;
      drag = null; brush.setAttribute("visibility", "hidden");
      if (Math.abs(to - from) >= 8) setView(wlAt(Math.min(from, to)), wlAt(Math.max(from, to)));
    });
    root.addEventListener("pointercancel", () => { drag = null; brush.setAttribute("visibility", "hidden"); });
    root.addEventListener("pointerleave", () => drag || hideTip());
    root.addEventListener("dblclick", () => zoom && setView(full.x0, full.x1));
    root.addEventListener("wheel", (e) => {
      if (e.ctrlKey) { // trackpad pinch, or ctrl + scroll wheel
        e.preventDefault();
        const c = wlAt(clamp(localX(e), m.l, W - m.r)), k = Math.exp(clamp(e.deltaY, -50, 50) * 0.012);
        setView(c - (c - x0) * k, c + (x1 - c) * k);
      } else if (zoom && Math.abs(e.deltaX) > Math.abs(e.deltaY)) { // sideways swipe pans
        e.preventDefault();
        const d = (e.deltaX / pw) * (x1 - x0);
        setView(x0 + d, x1 + d);
      }
    }, { passive: false });
    ui.specChart.replaceChildren(root);
    ui.specReset.hidden = !zoom;
    ui.specHint.textContent = zoom
      ? `Showing ${x0.toFixed(3)}–${x1.toFixed(3)} µm. Double-click the chart to see it all again.`
      : "Drag across the chart to zoom in on a range of wavelengths.";

    // Legend: one entry per visit (identity is never colour alone: each has its date).
    ui.specLegend.replaceChildren(...list.map((v) => {
      const item = el("span", { className: "sp-key" });
      const line = svg("svg", { width: 22, height: 8, "aria-hidden": "true" });
      line.append(svg("line", { x1: 1, x2: 21, y1: 4, y2: 4, stroke: colorOf(v.id), "stroke-width": 2.5, "stroke-dasharray": dashOf(v.id) }));
      item.append(line, document.createTextNode(fmtDate(v.mjd, { month: "short", year: "numeric" })));
      return item;
    }));

    ui.specHead.textContent = changeHeadline();
    ui.specNote.textContent = `${measured} measurements from ${loaded} of 6 detectors. Brightness is summed within ${state.data[Object.keys(state.data)[0]].aperture_arcsec}″ of the source; treat values as approximate.`
      + (measured < total ? ` ${total - measured} exposures were skipped (saturated or at the image edge).` : "");

    // The same numbers as a table, for anyone who can't or would rather not read the chart.
    const table = el("table");
    const head = el("tr"); ["Date", "Detector", "Wavelength (µm)", "Brightness (mJy)", "±"].forEach((h) => head.append(el("th", {}, h)));
    table.append(head);
    for (const p of all.slice().sort((a, b) => a.mjd - b.mjd)) {
      const tr = el("tr");
      [fmtDate(p.mjd), `D${p.det}`, p.wl.toFixed(3), fmt(p.flux), p.err == null ? "" : fmt(p.err)].forEach((c) => tr.append(el("td", {}, c)));
      table.append(tr);
    }
    ui.specTable.replaceChildren(table);
  }

  // ---------------------------------------------------------------- wiring
  ui.fov.replaceChildren(...FOVS.map((f) => el("option", { value: f, selected: f === state.fov }, `${f}′ wide`)));
  ui.play.addEventListener("click", () => setPlaying(!state.playing));
  ui.specReset.addEventListener("click", () => { state.specZoom = null; renderSpectrum(); });
  ui.prev.addEventListener("click", () => { setPlaying(false); step(-1); });
  ui.next.addEventListener("click", () => { setPlaying(false); step(1); });
  ui.speed.addEventListener("change", () => state.playing && setPlaying(true));
  ui.bright.addEventListener("input", drawAll);
  ui.marker.addEventListener("change", drawAll);
  ui.gaia.addEventListener("change", () => (ui.gaia.checked && !state.gaia ? loadGaia() : drawAll()));
  // The WISE panel fetches nothing until it is opened; once opened it stays open for the next object.
  try { ui.wise.open = localStorage.getItem(WISE_OPEN_KEY) === "1"; } catch {}
  ui.wise.addEventListener("toggle", () => {
    try { localStorage.setItem(WISE_OPEN_KEY, ui.wise.open ? "1" : "0"); } catch {}
    if (ui.wise.open && state.target) loadWise();
  });
  ui.wRetry.addEventListener("click", () => loadWise());
  ui.retry.addEventListener("click", () => { state.held = false; load(state.det); });
  ui.specAll.addEventListener("click", () => DETECTORS.forEach(({ id }) => load(id, { show: false })));
  ui.mode.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    state.mode = b.dataset.mode;
    ui.mode.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    render();
  }));
  ui.fov.addEventListener("change", () => {
    const t = state.target, held = state.held;
    reset();
    state.fov = +ui.fov.value;
    state.target = t;
    render();
    if (t && !held) load(state.det);
    if (t && ui.wise.open) loadWise();
  });
  ui.stage.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { setPlaying(false); step(-1); }
    else if (e.key === "ArrowRight") { setPlaying(false); step(1); }
    else if (e.key === " ") { e.preventDefault(); setPlaying(!state.playing); }
  });
  new ResizeObserver(() => state.target && (drawFrame(), renderTrack(), renderSpectrum())).observe(ui.stage);
  new ResizeObserver(() => drawWise()).observe(ui.wStage);

  return { show, clear, redraw: drawAll, state };
}
