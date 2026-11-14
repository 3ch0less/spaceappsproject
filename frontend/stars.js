/* Gaia stars on the map, tiered like the names (names.js).
 *
 * Zoomed far out only the brightest stars are marked, spread over the whole view; every zoom
 * step brings in fainter ones. Two marks never crowd each other: the brighter star is drawn and
 * the other waits until zooming in makes room. So the view holds a readable number of marks at
 * every zoom, instead of thousands piled on its middle.
 *
 * How:
 *  - The same grid as the names (backend/main.py cuts it the same way). The backend returns the
 *    brightest Gaia DR3 stars of a cell, already moved to where SPHEREx saw them. Cells never
 *    change, so they are cached here, by the browser and on the backend's disk.
 *  - Marks are drawn on our own canvas over the map, brightest first, and only where there is
 *    room. It is redrawn only on frames in which the view moved.
 *
 *   const stars = createStars({ api, aladin, onError });
 *   stars.setEnabled(true);      // the "Gaia stars" switch
 *   stars.at(x, y);              // the star whose mark is under a click, if any
 */

import { cellAt, levelFor } from "./names.js";

const MAX_CELLS = 48;          // never ask for more cells than this for one view
const KEEP_CELLS = 600;        // cells remembered in the page
const RETRY_MS = 20000;        // a cell that failed to load is tried again after this
const MIN_GAP = 30;            // pixels kept free around every mark
const AREA_PER_MARK = 9500;    // one mark per this many square pixels of map, at most…
const MAX_MARKS = 150;         // …and never more than this
const GOLD = "#ffc531";        // --mark-gaia in style.css
const EDGE = "rgba(3, 6, 15, 0.75)"; // dark edge under each mark, so it shows on bright sky too

export function createStars({ api, aladin, onError }) {
  const sky = aladin.getParentDiv();
  const canvas = document.createElement("canvas");
  canvas.className = "names-layer"; // same placement as the names: over the map, clicks pass through
  canvas.setAttribute("aria-hidden", "true");
  sky.insertBefore(canvas, sky.querySelector(".names-layer")); // under the names, so a name is never crossed out
  const ctx = canvas.getContext("2d");

  const cells = new Map();   // "level/band/cell" -> { stars } | { pending: AbortController } | { failedAt }
  const state = {
    enabled: false,
    level: 0,
    wanted: new Set(),       // cells the current view needs
    shown: [],               // stars being considered, brightest first
    ra: [], dec: [],         // their positions, as the arrays Aladin's projection takes
    placed: [],              // last frame: { s, x, y } of the marks drawn, for hit-testing
    version: 0,              // bumped whenever `shown` changes
    drawn: "",               // what the last frame was drawn for
    timer: null, raf: 0, lastError: -Infinity,
  };

  // ---------------------------------------------------------------- which cells does the view need?
  function cellsInView(level) {
    const [w, h] = aladin.getSize();
    const ids = new Set();
    const nx = 15, ny = Math.max(9, Math.round((15 * h) / w));
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        let pos;
        try { pos = aladin.pix2world((i / nx) * (w - 1), (j / ny) * (h - 1), "icrs"); } catch { continue; }
        if (pos && Number.isFinite(pos[0]) && Number.isFinite(pos[1])) ids.add(cellAt(level, pos[0], pos[1]));
      }
    }
    return ids;
  }

  function update() {
    state.timer = null;
    if (!state.enabled) return;
    let level = levelFor(Math.max(...aladin.getFov()));
    let ids = cellsInView(level);
    while (ids.size > MAX_CELLS && level > 0) ids = cellsInView(--level);
    state.level = level;
    state.wanted = ids;
    for (const [id, c] of cells) {
      if (c.pending && !ids.has(id)) { c.pending.abort(); cells.delete(id); } // the view has moved on
    }
    const now = performance.now();
    for (const id of ids) {
      const c = cells.get(id);
      if (!c || (c.failedAt && now - c.failedAt > RETRY_MS)) load(id);
    }
    rebuild();
  }

  async function load(id) {
    const pending = new AbortController();
    cells.delete(id);
    cells.set(id, { pending });
    try {
      const r = await fetch(`${api}/api/stars/${id}`, { signal: pending.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      cells.set(id, { stars: (await r.json()).stars });
    } catch (e) {
      if (e.name === "AbortError" || cells.get(id)?.pending !== pending) return;
      cells.set(id, { failedAt: performance.now() });
      if (performance.now() - state.lastError > 30000) { state.lastError = performance.now(); onError?.(); }
    }
    for (const old of cells.keys()) { // forget the cells seen longest ago
      if (cells.size <= KEEP_CELLS) break;
      if (!state.wanted.has(old)) cells.delete(old);
    }
    if (state.wanted.has(id)) rebuild();
  }

  // Everything in the wanted cells that has arrived, brightest first. While some cells are still
  // on their way, what is already on screen stays, so the marks never blank between zoom levels.
  function rebuild() {
    const byId = new Map();
    let complete = true;
    for (const id of state.wanted) {
      const c = cells.get(id);
      if (!c || c.pending) complete = false;
      for (const s of c?.stars || []) if (!byId.has(s.id)) byId.set(s.id, s);
    }
    if (!complete) for (const s of state.shown) if (!byId.has(s.id)) byId.set(s.id, s);
    const list = [...byId.values()].sort((a, b) => (a.g ?? 99) - (b.g ?? 99) || (a.id < b.id ? -1 : 1));
    if (list.length === state.shown.length && list.every((s, i) => s === state.shown[i])) return;
    state.shown = list;
    state.ra = list.map((s) => s.ra);
    state.dec = list.map((s) => s.dec);
    state.version++;
  }

  // ---------------------------------------------------------------- drawing
  function project() {
    try {
      return aladin.view.wasm.worldToScreenVec(state.ra, state.dec); // all at once, as Aladin does for its own catalogs
    } catch {
      const xy = new Float64Array(state.ra.length * 2).fill(NaN);
      state.shown.forEach((s, i) => {
        const p = aladin.world2pix(s.ra, s.dec);
        if (p) { xy[2 * i] = p[0]; xy[2 * i + 1] = p[1]; }
      });
      return xy;
    }
  }

  // Is there sky at this point of the map, or the empty background around it?
  function skyAt(x, y) {
    try {
      const pos = aladin.pix2world(x, y, "icrs");
      return !!pos && Number.isFinite(pos[0]) && Number.isFinite(pos[1]);
    } catch { return false; }
  }

  function draw(w, h) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    state.placed = [];
    if (!state.enabled || !state.shown.length) return;

    // Brightest first; a star is marked only if no brighter one already sits within MIN_GAP of
    // it. Taken positions are kept in a coarse grid, so each star is compared with its neighbours only.
    const limit = Math.min(MAX_MARKS, Math.max(24, Math.round((w * h) / AREA_PER_MARK)));
    const taken = new Map(), key = (gx, gy) => gx * 4096 + gy;
    const xy = project();
    for (let i = 0; i < state.shown.length && state.placed.length < limit; i++) {
      const x = xy[2 * i], y = xy[2 * i + 1];
      if (!(x >= 0 && x <= w && y >= 0 && y <= h) || !skyAt(x, y)) continue; // behind us, off the screen, or past the sky's rim
      const gx = Math.floor(x / MIN_GAP), gy = Math.floor(y / MIN_GAP);
      let free = true;
      for (let dy = -1; dy <= 1 && free; dy++) {
        for (let dx = -1; dx <= 1 && free; dx++) {
          for (const p of taken.get(key(gx + dx, gy + dy)) || []) {
            if (Math.abs(p.x - x) < MIN_GAP && Math.abs(p.y - y) < MIN_GAP) { free = false; break; }
          }
        }
      }
      if (!free) continue;
      const mark = { s: state.shown[i], x: Math.round(x), y: Math.round(y) };
      (taken.get(key(gx, gy)) || taken.set(key(gx, gy), []).get(key(gx, gy))).push(mark);
      state.placed.push(mark);
    }

    // The brightest few of the view get a larger cross. Each cross is drawn twice: a dark edge, then gold.
    const big = Math.max(3, Math.round(state.placed.length * 0.15));
    const cross = (marks, arm) => {
      ctx.beginPath();
      for (const m of marks) { ctx.moveTo(m.x - arm, m.y); ctx.lineTo(m.x + arm, m.y); ctx.moveTo(m.x, m.y - arm); ctx.lineTo(m.x, m.y + arm); }
      ctx.stroke();
    };
    ctx.lineCap = "butt";
    for (const [marks, arm, width] of [[state.placed.slice(0, big), 7, 2], [state.placed.slice(big), 4.5, 1.5]]) {
      ctx.strokeStyle = EDGE; ctx.lineWidth = width + 2; cross(marks, arm + 1);
      ctx.strokeStyle = GOLD; ctx.lineWidth = width; cross(marks, arm);
    }
  }

  // Runs while the switch is on. Draws only when something changed; asks for new cells a moment
  // after the view moved (and every so often during a long movement).
  function frame() {
    state.raf = state.enabled ? requestAnimationFrame(frame) : 0;
    const [w, h] = aladin.getSize(), [ra, dec] = aladin.getRaDec();
    const view = `${ra},${dec},${aladin.getFov()[0]},${aladin.getZoomFactor?.()},${w},${h},${aladin.getProjectionName?.()}`;
    const drawnFor = `${view}|${state.version}`;
    if (drawnFor === state.drawn) return;
    if (!state.drawn.startsWith(`${view}|`) && !state.timer) state.timer = setTimeout(update, 160);
    state.drawn = drawnFor;
    const started = performance.now();
    draw(w, h);
    state.drawMs = performance.now() - started;
  }

  // ---------------------------------------------------------------- public
  function setEnabled(on) {
    state.enabled = on;
    state.drawn = "";
    if (on) {
      update();
      if (!state.raf) state.raf = requestAnimationFrame(frame);
    } else {
      clearTimeout(state.timer);
      state.timer = null;
      for (const [id, c] of cells) if (c.pending) { c.pending.abort(); cells.delete(id); }
      state.shown = []; state.ra = []; state.dec = []; state.wanted = new Set(); state.version++;
      draw(...aladin.getSize());
    }
  }

  // The star whose mark is at this point of the map (view pixels), if any.
  function at(x, y) {
    if (!state.enabled) return null;
    for (const p of state.placed) if (Math.hypot(x - p.x, y - p.y) <= 9) return { ra: p.s.ra, dec: p.s.dec, name: `Gaia DR3 ${p.s.id}` };
    return null;
  }

  return { setEnabled, at, state, cells };
}
