/* SkyShift names: object labels on the map that behave like place names on a street map.
 *
 * Zoomed far out only the best-known objects are named, spread over the whole view; every
 * zoom step brings in the next tier, and at the closest zoom everything catalogued is there.
 * Two labels never overlap: the better-known one is written, the other waits (as a small dot)
 * until zooming in makes room. Every marker sits exactly on its object.
 *
 * How:
 *  - The sky is cut into a grid per zoom level (12 cells of 60° at level 0, each level halves
 *    the cell size; backend/main.py cuts it the same way). The backend returns the few
 *    best-known objects of a cell. Cells never change, so they are cached here, by the
 *    browser and on the backend's disk: panning back costs nothing.
 *  - Labels are drawn on our own canvas over the map. On every frame in which the view moved,
 *    objects are placed best-known first, and a label is only written where it is free.
 *
 *   const names = createNames({ api, aladin, target: () => current, avoid: ".search, .dock", onError });
 *   names.setEnabled(true);      // the "Names" switch
 *   names.at(x, y);              // the object whose marker or label is under a click, if any
 */

const MAX_LEVEL = 10;          // deepest grid level (cells of 3.5′); must match NAME_LEVELS in the backend
const CELLS_ACROSS = 3;        // a cell is about a third of the view's longer side: 6 to 12 cells cover a view
const MAX_CELLS = 48;          // never ask for more cells than this for one view
const KEEP_CELLS = 600;        // cells remembered in the page
const RETRY_MS = 20000;        // a cell that failed to load is tried again after this
const FONT = '500 12px Inter, system-ui, sans-serif';
const FONT_BIG = '600 13px Inter, system-ui, sans-serif';   // the best-known few of the view
const TARGET_FONT = '600 14px Inter, sans-serif';           // how app.js labels the selected object
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---------------------------------------------------------------- the grid
const cellHeight = (level) => 60 / 2 ** level; // degrees
function cellsInBand(level, band) {
  const h = cellHeight(level);
  return Math.max(1, Math.floor((360 * Math.cos(((-90 + band * h + h / 2) * Math.PI) / 180)) / h + 0.5));
}
function cellAt(level, ra, dec) {
  const h = cellHeight(level);
  const band = clamp(Math.floor((dec + 90) / h), 0, 3 * 2 ** level - 1);
  const count = cellsInBand(level, band);
  return `${level}/${band}/${clamp(Math.floor(((((ra % 360) + 360) % 360) / 360) * count), 0, count - 1)}`;
}
const levelFor = (fovDeg) => clamp(Math.round(Math.log2((60 * CELLS_ACROSS) / fovDeg)), 0, MAX_LEVEL);

export function createNames({ api, aladin, target, avoid = "", onError }) {
  const sky = aladin.getParentDiv();
  const canvas = document.createElement("canvas");
  canvas.className = "names-layer";
  canvas.setAttribute("aria-hidden", "true");
  sky.append(canvas);
  const ctx = canvas.getContext("2d");

  const cells = new Map();   // "level/band/cell" -> { objects } | { pending: AbortController } | { failedAt }
  const widths = new Map();  // label text -> width in pixels, per font
  const state = {
    enabled: false,
    level: 0,
    wanted: new Set(),       // cells the current view needs
    shown: [],               // objects being drawn, best-known first
    ra: [], dec: [],         // their positions, as the arrays Aladin's projection takes
    placed: [],              // last frame: { o, x, y, box|null } for hit-testing
    version: 0,              // bumped whenever `shown` changes
    drawn: "",               // what the last frame was drawn for
    timer: null, raf: 0, lastError: -Infinity, // when onError was last called (at most twice a minute)
  };

  // ---------------------------------------------------------------- which cells does the view need?
  function cellsInView(level) {
    const [w, h] = aladin.getSize();
    const ids = new Set();
    // Sample the screen on a grid finer than the cells and note the cell under every sample.
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
    let level = levelFor(Math.max(...aladin.getFov())); // [width, height] in degrees
    let ids = cellsInView(level);
    while (ids.size > MAX_CELLS && level > 0) ids = cellsInView(--level); // odd projections, very tall windows
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
      const r = await fetch(`${api}/api/names/${id}`, { signal: pending.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      cells.set(id, { objects: (await r.json()).objects });
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

  // The list to draw: everything in the wanted cells that has arrived. While some are still on
  // their way, what is already on screen stays, so the labels never blank between zoom levels.
  function rebuild() {
    const byName = new Map();
    let complete = true;
    for (const id of state.wanted) {
      const c = cells.get(id);
      if (!c || c.pending) complete = false;
      for (const o of c?.objects || []) if (!byName.has(o.name)) byName.set(o.name, o);
    }
    if (!complete) for (const o of state.shown) if (!byName.has(o.name)) byName.set(o.name, o);
    const list = [...byName.values()].sort((a, b) => b.refs - a.refs || (a.name < b.name ? -1 : 1));
    if (list.length === state.shown.length && list.every((o, i) => o === state.shown[i])) return;
    state.shown = list;
    state.ra = list.map((o) => o.ra);
    state.dec = list.map((o) => o.dec);
    state.version++;
  }

  // ---------------------------------------------------------------- drawing
  function textWidth(text, font) {
    const key = `${font}\n${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(text).width;
      if (document.fonts?.status !== "loading") widths.set(key, w); // don't remember widths of the fallback font
    }
    return w;
  }

  function project() {
    try {
      return aladin.view.wasm.worldToScreenVec(state.ra, state.dec); // all at once, as Aladin does for its own catalogs
    } catch {
      const xy = new Float64Array(state.ra.length * 2).fill(NaN);
      state.shown.forEach((o, i) => {
        const p = aladin.world2pix(o.ra, o.dec);
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

  // Where the page's own controls (search bar, dock, panels: the `avoid` selector) cover the map.
  function coveredAreas() {
    if (!avoid) return [];
    const origin = canvas.getBoundingClientRect(), areas = [];
    for (const el of document.querySelectorAll(avoid)) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) areas.push([r.left - origin.left - 6, r.top - origin.top - 6, r.right - origin.left + 6, r.bottom - origin.top + 6].map(Math.round));
    }
    return areas;
  }

  function draw(w, h, covered = []) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    state.placed = [];
    if (!state.enabled || !state.shown.length) return;

    // Boxes already taken, in a coarse grid so that a new label is only compared with its neighbours.
    const BIN = 96, bins = new Map();
    const eachBin = (b, fn) => {
      for (let gy = Math.floor(b[1] / BIN); gy <= Math.floor(b[3] / BIN); gy++) {
        for (let gx = Math.floor(b[0] / BIN); gx <= Math.floor(b[2] / BIN); gx++) if (fn(gx * 4096 + gy) === true) return true;
      }
      return false;
    };
    const take = (b) => {
      b = [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(w, b[2]), Math.min(h, b[3])];
      if (b[0] < b[2] && b[1] < b[3]) eachBin(b, (k) => { (bins.get(k) || bins.set(k, []).get(k)).push(b); });
    };
    const taken = (b) => eachBin(b, (k) => bins.get(k)?.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]));

    for (const area of covered) take(area); // no names under the search bar, the dock or a panel
    // The selected object has its own, bigger label (drawn by app.js): keep clear of it.
    const t = target();
    let tx = NaN, ty = NaN;
    if (t) {
      const p = aladin.world2pix(t.ra, t.dec);
      if (p) {
        [tx, ty] = p;
        take([tx - 16, ty - 16, tx + 16, ty + 16]);
        take([tx + 13, ty - 15, tx + 17 + textWidth(t.name || "", TARGET_FONT), ty + 6]);
      }
    }

    const xy = project(), n = state.shown.length, bigCount = Math.max(4, Math.round(n * 0.12));
    const labels = [], dots = [];
    for (let i = 0; i < n; i++) {
      const x = xy[2 * i], y = xy[2 * i + 1];
      if (!(x >= 0 && x <= w && y >= 0 && y <= h)) continue; // behind us or off the screen
      if (Math.abs(x - tx) < 4 && Math.abs(y - ty) < 4) continue; // the selected object itself
      if (!skyAt(x, y)) continue; // zoomed out past the whole sphere, Aladin places the far side around its rim
      const o = state.shown[i], big = i < bigCount, font = big ? FONT_BIG : FONT;
      const tw = textWidth(o.name, font), th = big ? 15 : 14;
      // Marker first, then the label beside it: right, left, below, above, whichever is free.
      const marker = [x - 5, y - 5, x + 5, y + 5];
      let box = null;
      if (!taken(marker)) {
        for (const [bx, by] of [[x + 8, y - th / 2], [x - 8 - tw, y - th / 2], [x - tw / 2, y + 7], [x - tw / 2, y - 7 - th]]) {
          const b = [bx - 4, by - 2, bx + tw + 4, by + th + 2];
          if (b[0] < 0 || b[2] > w || b[1] < 0 || b[3] > h || taken(b)) continue;
          box = b;
          break;
        }
      }
      if (box) {
        take(marker);
        take(box);
        labels.push({ o, x, y, box, big });
      } else dots.push({ o, x, y, box: null });
    }

    // Unnamed dots: there is something here, zoom in to read it. Not under somebody's label.
    ctx.fillStyle = "rgba(163, 240, 198, 0.55)";
    ctx.beginPath();
    for (const d of dots) {
      if (taken([d.x - 2, d.y - 2, d.x + 2, d.y + 2])) continue;
      ctx.moveTo(d.x + 1.6, d.y);
      ctx.arc(d.x, d.y, 1.6, 0, 6.2832);
      state.placed.push(d);
    }
    ctx.fill();

    // Markers, then the text with a dark edge so it reads on bright and dark sky alike.
    ctx.fillStyle = "#a3f0c6";
    ctx.strokeStyle = "rgba(4, 6, 13, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const l of labels) { ctx.moveTo(l.x + 3, l.y); ctx.arc(l.x, l.y, 3, 0, 6.2832); }
    ctx.stroke();
    ctx.fill();
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    for (const big of [true, false]) {
      ctx.font = big ? FONT_BIG : FONT;
      ctx.fillStyle = big ? "#ffffff" : "#d6ffe9";
      for (const l of labels) {
        if (l.big !== big) continue;
        const x = l.box[0] + 4, y = (l.box[1] + l.box[3]) / 2;
        ctx.strokeText(l.o.name, x, y);
        ctx.fillText(l.o.name, x, y);
      }
    }
    state.placed.unshift(...labels); // labels first: they win a click over a dot
  }

  // Runs while the switch is on. Draws only when something changed; asks for new cells a moment
  // after the view moved (and every so often during a long movement).
  function frame() {
    state.raf = state.enabled ? requestAnimationFrame(frame) : 0;
    const [w, h] = aladin.getSize(), [ra, dec] = aladin.getRaDec(), t = target();
    // The zoom factor as well as the field of view: zoomed out past the whole sky the field of
    // view stays at its maximum while the sky keeps shrinking, and the names must shrink with it.
    const view = `${ra},${dec},${aladin.getFov()[0]},${aladin.getZoomFactor?.()},${w},${h},${aladin.getProjectionName?.()}`;
    const covered = coveredAreas();
    const key = `${view}|${state.version}|${t ? `${t.ra},${t.dec},${t.name}` : ""}|${document.fonts?.status}|${covered}`;
    if (key === state.drawn) return;
    if (!state.drawn.startsWith(`${view}|`) && !state.timer) state.timer = setTimeout(update, 160);
    state.drawn = key;
    const started = performance.now();
    draw(w, h, covered);
    state.drawMs = performance.now() - started; // for the curious: window.skyshift.names.state.drawMs
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

  // The object whose label or marker is at this point of the map (view pixels), if any.
  function at(x, y) {
    if (!state.enabled) return null;
    for (const p of state.placed) {
      if (p.box && x >= p.box[0] && x <= p.box[2] && y >= p.box[1] && y <= p.box[3]) return p.o;
      if (Math.hypot(x - p.x, y - p.y) <= 7) return p.o;
    }
    return null;
  }

  return { setEnabled, at, state, cells };
}
