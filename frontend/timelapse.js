/* Lumasphere time-lapse: the flipbook, its timeline and the spectrum chart in the inspector.
 *
 * SPHEREx returns to every spot about every six months. The backend (/api/timelapse)
 * turns each visit into one clean image per detector; this file plays those images like
 * a flipbook, so anything that moved or changed between visits jumps out, and plots the
 * brightness it measured in every single exposure.
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
function lut(name) {
  if (lutCache[name]) return lutCache[name];
  const stops = STOPS[name] || STOPS.magma, out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1), a = Math.floor(t), b = Math.min(stops.length - 1, a + 1), f = t - a;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = stops[a][c] + (stops[b][c] - stops[a][c]) * f;
  }
  return (lutCache[name] = out);
}

function decodeImage(b64, size) {
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
    specSec: $("#spec"), specChart: $("#spec-chart"), specLegend: $("#spec-legend"), specNote: $("#spec-note"),
    specHead: $("#spec-headline"), specAll: $("#spec-all"), specTable: $("#spec-table"), specTip: $("#spec-tip"),
  };
  const ctx = ui.canvas.getContext("2d");
  const small = document.createElement("canvas"); // one image pixel per sky pixel; scaled up onto the stage

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
    setPlaying(false);
    Object.assign(state, { data: {}, plan: null, visit: 0, loading: {}, errors: {}, gaia: null });
  }

  // ---------------------------------------------------------------- public
  function show(target, { auto = true } = {}) {
    reset();
    state.target = target;
    // Cold brown dwarfs only glow at the longest wavelengths; everything else is sharpest around 1.3 µm.
    state.det = /brown dwarf/i.test(target.type_label || "") ? 6 : 2;
    state.held = !auto;
    ui.section.hidden = ui.specSec.hidden = false;
    ui.gaia.checked = false;
    render();
    if (auto) load(state.det);
  }

  function clear() {
    reset();
    state.target = null;
    ui.section.hidden = ui.specSec.hidden = true;
  }

  // ---------------------------------------------------------------- drawing the frame
  function currentFrame() {
    const d = state.data[state.det];
    if (!d || !d.visits.length) return null;
    const v = d.visits[clamp(state.visit, 0, d.visits.length - 1)];
    return { d, v, ref: state.mode === "diff" ? d.visits[state.visit === 0 ? d.visits.length - 1 : 0] : null };
  }

  function drawFrame() {
    const size = ui.stage.clientWidth || 380, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (ui.canvas.width !== Math.round(size * dpr)) ui.canvas.width = ui.canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const f = currentFrame();
    if (!f) return;
    const { d, v, ref } = f, n = d.size;
    if (small.width !== n) small.width = small.height = n;
    const sctx = small.getContext("2d"), image = sctx.createImageData(n, n), px = image.data;
    const { lo, hi } = d.range, gain = Math.pow(4, 1 - ui.bright.value / 50); // slider right = brighter
    if (ref) {
      // Difference: mid-grey = unchanged, white = brighter than the other visit, black = fainter.
      const span = 25 * d.range.noise * gain;
      for (let i = 0; i < n * n; i++) {
        const diff = v.pixels[i] - ref.pixels[i];
        const g = Number.isFinite(diff) ? clamp(127.5 + (diff / span) * 127.5, 0, 255) : 127.5;
        px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = g; px[i * 4 + 3] = 255;
      }
    } else {
      // The usual astronomer's stretch: roughly linear for faint things near the noise level,
      // logarithmic for bright ones, so faint stars and a blazing one are visible together.
      const table = lut(colormap()), soft = 2.5 * d.range.noise * gain, norm = Math.asinh((hi - lo) / soft);
      for (let i = 0; i < n * n; i++) {
        const x = v.pixels[i];
        const s = Number.isFinite(x) ? clamp(Math.asinh(Math.max(0, x - lo) / soft) / norm, 0, 1) : 0;
        const c = Math.round(s * 255) * 3;
        px[i * 4] = table[c]; px[i * 4 + 1] = table[c + 1]; px[i * 4 + 2] = table[c + 2]; px[i * 4 + 3] = 255;
      }
    }
    sctx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small, 0, 0, size, size);
    drawOverlays(d, v, size);
  }

  // Sky offset (arcseconds east, north of the patch centre) -> canvas position.
  const toCanvas = (d, size, east, north) => [size / 2 - (east / d.scale_arcsec) * (size / d.size), size / 2 - (north / d.scale_arcsec) * (size / d.size)];

  function drawOverlays(d, v, size) {
    const t = state.target, year = mjdToYear(v.mjd), arcsecPerPx = (d.scale_arcsec * d.size) / size;
    ctx.lineCap = "butt";

    if (ui.gaia.checked && state.gaia) {
      // Each Gaia star is drawn where its measured motion puts it on this visit's date.
      const cosd = Math.cos((t.dec * Math.PI) / 180), dt = year - state.gaia.epoch;
      ctx.strokeStyle = "rgba(255, 197, 49, 0.9)"; ctx.lineWidth = 1.2; // Gaia gold, as on the map
      for (const s of state.gaia.stars) {
        const east = (s.ra - t.ra) * 3600 * cosd + ((s.pmra || 0) * dt) / 1000;
        const north = (s.dec - t.dec) * 3600 + ((s.pmdec || 0) * dt) / 1000;
        const [x, y] = toCanvas(d, size, east, north);
        if (x < 4 || y < 4 || x > size - 4 || y > size - 4) continue;
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
      }
    }

    if (ui.marker.checked) {
      // Where the catalog says the target should be on this date (its position plus its known motion).
      let east = 0, north = 0;
      if (t.pm_ra_mas_yr != null && t.epoch) {
        east = (t.pm_ra_mas_yr * (year - t.epoch)) / 1000;
        north = (t.pm_dec_mas_yr * (year - t.epoch)) / 1000;
      }
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
    renderStatus(); renderHud(); renderDetectors(); renderTrack(); renderSub(); drawFrame(); renderSpectrum();
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
      drawFrame();
    } catch {
      if (token !== state.token) return;
      ui.gaia.checked = false;
      ui.note.textContent = "The Gaia star catalog didn't answer. Try the switch again in a moment.";
    }
  }

  // ---------------------------------------------------------------- spectrum
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
      ui.specLegend.replaceChildren();
      ui.specTable.replaceChildren();
      ui.specHead.textContent = "";
      ui.specNote.textContent = !loaded
        ? "The spectrum appears once the time-lapse has loaded."
        : total ? "This object is too bright here: it saturates SPHEREx's detector, so its brightness can't be measured. Try another detector."
        : "No measurements at this spot yet.";
      return;
    }

    const W = ui.specChart.clientWidth || 380, H = 200, m = { l: 44, r: 10, t: 24, b: 30 };
    const all = list.flatMap((v) => v.points);
    // The plot spans the detectors that are loaded, so one detector's measurements fill its width
    // instead of huddling in a corner of the full 0.75–5 µm range.
    const dets = [...new Set(all.map((p) => p.det))].map((d) => DETECTORS[d - 1]);
    const lo = Math.min(...dets.map((d) => d.lo), ...all.map((p) => p.wl)), hi = Math.max(...dets.map((d) => d.hi), ...all.map((p) => p.wl));
    const x0 = lo - (hi - lo) * 0.04, x1 = hi + (hi - lo) * 0.04;
    const yMax = Math.max(...all.map((p) => p.flux)) * 1.12, yMin = Math.min(0, ...all.map((p) => p.flux));
    const X = (wl) => m.l + ((wl - x0) / (x1 - x0)) * (W - m.l - m.r);
    const Y = (f) => H - m.b - ((f - yMin) / (yMax - yMin || 1)) * (H - m.t - m.b);
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
      "aria-label": "Spectrum: brightness in millijansky against wavelength in microns, one line per visit" });

    // Recessive grid: 4 horizontal lines with values, and up to 8 wavelength marks.
    const stepRaw = (yMax - yMin) / 4, mag = 10 ** Math.floor(Math.log10(stepRaw)), yStep = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= stepRaw);
    const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$/, "");
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) {
      root.append(svg("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: v === 0 ? "sp-axis" : "sp-grid" }));
      root.append(svg("text", { x: m.l - 6, y: Y(v) + 3.5, class: "sp-label", "text-anchor": "end" }, fmt(v)));
    }
    const xStep = [0.1, 0.2, 0.5, 1].find((s) => (x1 - x0) / s <= 8) || 1;
    for (let k = Math.ceil(x0 / xStep - 1e-9); k * xStep <= x1 + 1e-9; k++) {
      const wl = k * xStep;
      root.append(svg("line", { x1: X(wl), x2: X(wl), y1: H - m.b, y2: H - m.b + 4, class: "sp-axis" }));
      root.append(svg("text", { x: X(wl), y: H - m.b + 16, class: "sp-label", "text-anchor": "middle" }, xStep < 1 ? wl.toFixed(1) : String(wl)));
    }
    root.append(svg("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: "sp-axis" }));
    root.append(svg("text", { x: W - m.r, y: H - 2, class: "sp-label", "text-anchor": "end" }, "wavelength (µm)"));
    root.append(svg("text", { x: 4, y: 10, class: "sp-label" }, "mJy"));

    // One line per visit and detector (a line never bridges a detector that isn't loaded).
    for (const v of list) {
      const byDet = new Map();
      for (const p of v.points) (byDet.get(p.det) || byDet.set(p.det, []).get(p.det)).push(p);
      for (const pts of byDet.values()) {
        if (pts.length > 1) root.append(svg("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${X(p.wl).toFixed(1)} ${Y(p.flux).toFixed(1)}`).join(""),
          class: "sp-line", stroke: colorOf(v.id), "stroke-dasharray": dashOf(v.id) }));
        for (const p of pts) root.append(svg("circle", { cx: X(p.wl), cy: Y(p.flux), r: pts.length > 1 ? 1.8 : 4, fill: colorOf(v.id), class: "sp-dot" }));
      }
    }

    // Hover: a hairline snaps to the nearest measured wavelength and lists every visit there.
    const hair = svg("line", { y1: m.t, y2: H - m.b, class: "sp-hair", visibility: "hidden" });
    const marks = svg("g", {});
    root.append(hair, marks);
    const wls = [...new Set(all.map((p) => p.wl))].sort((a, b) => a - b);
    const showAt = (clientX) => {
      const box = root.getBoundingClientRect(), wl = x0 + ((clientX - box.left - m.l) / (W - m.l - m.r)) * (x1 - x0);
      const near = wls.reduce((a, b) => (Math.abs(b - wl) < Math.abs(a - wl) ? b : a));
      hair.setAttribute("x1", X(near)); hair.setAttribute("x2", X(near)); hair.setAttribute("visibility", "visible");
      marks.replaceChildren();
      const rows = [];
      for (const v of list) {
        const p = v.points.reduce((a, b) => (Math.abs(b.wl - near) < Math.abs(a.wl - near) ? b : a));
        if (Math.abs(p.wl - near) > 0.06) continue;
        marks.append(svg("circle", { cx: X(p.wl), cy: Y(p.flux), r: 4.5, fill: colorOf(v.id), class: "sp-mark" }));
        rows.push({ v, p });
      }
      ui.specTip.replaceChildren(el("div", { className: "tip-head" }, `${near.toFixed(2)} µm`), ...rows.map(({ v, p }) => {
        const row = el("div", { className: "tip-row" });
        const key = el("i"); key.style.background = colorOf(v.id);
        row.append(key, el("b", {}, `${fmt(p.flux)} mJy`), el("span", {}, fmtDate(p.mjd, { day: "numeric", month: "short", year: "numeric" })));
        return row;
      }));
      ui.specTip.hidden = false;
      const left = clamp(X(near) + 16, 0, W - 170);
      ui.specTip.style.left = `${X(near) > W * 0.6 ? Math.max(0, X(near) - 176) : left}px`;
      // Sit in the half of the plot the points are not in, so the box never covers what it describes.
      const high = rows.reduce((sum, r) => sum + Y(r.p.flux), 0) / (rows.length || 1) < (m.t + H - m.b) / 2;
      ui.specTip.style.top = high ? "auto" : "14px";
      ui.specTip.style.bottom = high ? `${m.b + 12}px` : "auto";
    };
    root.addEventListener("pointermove", (e) => showAt(e.clientX));
    root.addEventListener("pointerleave", () => { hair.setAttribute("visibility", "hidden"); marks.replaceChildren(); ui.specTip.hidden = true; });
    ui.specChart.replaceChildren(root);

    // Legend: one entry per visit (identity is never colour alone: each has its date).
    ui.specLegend.replaceChildren(...list.map((v) => {
      const item = el("span", { className: "sp-key" });
      const line = svg("svg", { width: 22, height: 8, "aria-hidden": "true" });
      line.append(svg("line", { x1: 1, x2: 21, y1: 4, y2: 4, stroke: colorOf(v.id), "stroke-width": 2.5, "stroke-dasharray": dashOf(v.id) }));
      item.append(line, document.createTextNode(fmtDate(v.mjd, { month: "short", year: "numeric" })));
      return item;
    }));

    // Headline: did it change between visits? Compare visits detector by detector (same wavelengths).
    let headline = "";
    if (list.length > 1) {
      let best = null;
      for (const det of Object.keys(state.data).map(Number)) {
        const med = list.map((v) => {
          const f = v.points.filter((p) => p.det === det).map((p) => p.flux).sort((a, b) => a - b);
          return f.length >= 3 ? { v, m: f[Math.floor(f.length / 2)] } : null;
        }).filter(Boolean);
        if (med.length < 2) continue;
        const hiV = med.reduce((a, b) => (b.m > a.m ? b : a)), loV = med.reduce((a, b) => (b.m < a.m ? b : a));
        if (loV.m <= 0) continue;
        const change = hiV.m / loV.m - 1;
        if (!best || change > best.change) best = { change, hiV, loV, det };
      }
      if (best && best.change >= 0.1) {
        // Different colours can change in different directions, so name where the biggest change is.
        headline = `Changed between visits: up to ${Math.round(best.change * 100)}% brighter in ${fmtDate(best.hiV.v.mjd, { month: "short", year: "numeric" })} than in ${fmtDate(best.loV.v.mjd, { month: "short", year: "numeric" })}, at ${DETECTORS[best.det - 1].range}.`;
      } else if (best) {
        headline = "Steady: its brightness changed by less than 10% between visits.";
      }
    }
    ui.specHead.textContent = headline;
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
  ui.prev.addEventListener("click", () => { setPlaying(false); step(-1); });
  ui.next.addEventListener("click", () => { setPlaying(false); step(1); });
  ui.speed.addEventListener("change", () => state.playing && setPlaying(true));
  ui.bright.addEventListener("input", drawFrame);
  ui.marker.addEventListener("change", drawFrame);
  ui.gaia.addEventListener("change", () => (ui.gaia.checked && !state.gaia ? loadGaia() : drawFrame()));
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
  });
  ui.stage.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { setPlaying(false); step(-1); }
    else if (e.key === "ArrowRight") { setPlaying(false); step(1); }
    else if (e.key === " ") { e.preventDefault(); setPlaying(!state.playing); }
  });
  new ResizeObserver(() => state.target && (drawFrame(), renderTrack(), renderSpectrum())).observe(ui.stage);

  return { show, clear, redraw: drawFrame, state };
}
