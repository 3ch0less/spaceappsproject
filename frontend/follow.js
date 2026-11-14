/*
 * "Follow it": an asteroid or comet through SPHEREx's exposures (backend: /api/track).
 * Every frame is cut out centred on where NASA JPL says the object was at that exposure's
 * moment, so the object stays in the middle while the stars behind it change. Frames come
 * from different detectors (infrared colours), so each one gets its own brightness scale.
 */
import { lut, decodeImage } from "./timelapse.js";

const $ = (s) => document.querySelector(s);

export function createFollow({ api, colormap, onFrame = () => {} }) {
  const ui = {
    section: $("#fl"), sub: $("#fl-sub"), stage: $("#fl-stage"), canvas: $("#fl-canvas"), hud: $("#fl-hud"),
    status: $("#fl-status"), statusText: $("#fl-status-text"), progress: $("#fl-progress"), bar: $("#fl-bar"),
    go: $("#fl-go"), prev: $("#fl-prev"), play: $("#fl-play"), next: $("#fl-next"), slider: $("#fl-slider"), note: $("#fl-note"),
  };
  const ctx = ui.canvas.getContext("2d");
  const small = document.createElement("canvas");
  const state = { target: null, data: null, i: 0, timer: null, abort: null, token: 0 };
  const INTRO = "SPHEREx photographed it as it moved. Find every exposure that caught it and line them up on it.";

  function setStatus(text, { progress = null, button = null } = {}) {
    ui.status.hidden = text == null;
    ui.statusText.textContent = text || "";
    ui.progress.hidden = progress == null;
    if (progress != null) ui.bar.style.width = `${Math.max(4, progress * 100)}%`;
    ui.go.hidden = !button;
    if (button) ui.go.textContent = button;
  }

  function setControls(on) {
    for (const b of [ui.prev, ui.play, ui.next, ui.slider]) b.disabled = !on;
  }

  async function load() {
    const t = state.target, token = ++state.token;
    if (!t) return;
    state.abort?.abort();
    const abort = (state.abort = new AbortController());
    setStatus("Starting…", { progress: 0 });
    try {
      const q = (t.query || t.name).replace(/^asteroid:\s*/i, "");
      const r = await fetch(`${api}/api/track?q=${encodeURIComponent(q)}&fov=12`, { signal: abort.signal });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `The service answered ${r.status}`);
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "", result = null, error = null, stage = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const text = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!text || token !== state.token) continue;
          const msg = JSON.parse(text);
          if (msg.stage) { stage = msg.stage; setStatus(stage, { progress: 0.03 }); }
          else if (msg.progress) setStatus(`${stage.replace(/…$/, "")} ${msg.progress[0]} of ${msg.progress[1]}`, { progress: msg.progress[0] / Math.max(1, msg.progress[1]) });
          else if (msg.error) error = msg.error;
          else if (msg.result) result = msg.result;
        }
        if (done) break;
      }
      if (token !== state.token) return;
      if (error || !result) throw new Error(error || "The service stopped before finishing.");
      result.frames.forEach((f) => (f.pixels = decodeImage(f.image, result.size), delete f.image));
      state.data = result;
      state.i = 0;
      if (!result.frames.length) {
        const s = result.searched;
        setStatus(`SPHEREx didn't catch it clearly: ${s.candidates} exposures were near its path, ${s.caught} contained it away from the edges, and none could be read.`, { button: "Try again" });
        ui.note.textContent = "";
        return;
      }
      setStatus(null);
      setControls(true);
      ui.slider.max = result.frames.length - 1;
      const passes = result.passes.filter((p) => result.frames.some((f) => f.pass === p.id));
      ui.sub.textContent = `${result.frames.length} frames, ${passes.length} pass${passes.length === 1 ? "" : "es"}`;
      const seen = result.seen ?? result.frames.length, n = result.frames.length;
      // Say plainly when there is little to see: a faint comet far from the Sun is below SPHEREx's limit.
      const visibility = seen === n ? `It shows clearly at the centre in every frame. `
        : seen >= n / 2 ? `It shows clearly at the centre in ${seen} of ${n} frames; in the others it is too faint or lost in the glare. `
        : seen ? `Mostly too faint for SPHEREx: it stands out at the centre in only ${seen} of ${n} frames (marked "visible"). The cross hairs still show where it was. `
        : `Too faint for SPHEREx on these dates: nothing stands out at the centre in any frame. The cross hairs show where it was. `;
      ui.note.textContent = visibility
        + `Caught in ${result.searched.caught} exposures (${passes.map((p) => p.start === p.end ? p.start : `${p.start} to ${p.end}`).join("; ")}). `
        + `The object stays at the centre because each frame is cut out where NASA JPL says it was at that moment; the stars behind it change because it moved. `
        + `Frames span all six detectors, so brightness is scaled frame by frame. ${result.source}`;
      draw();
      setPlaying(!matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) {
      if (e.name === "AbortError" || token !== state.token) return;
      setStatus(/Failed to fetch|Load failed|NetworkError/i.test(e.message) ? "Couldn't reach the SkyShift backend." : e.message, { button: "Try again" });
    }
  }

  function draw() {
    const d = state.data;
    const size = ui.stage.clientWidth || 380, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (ui.canvas.width !== Math.round(size * dpr)) ui.canvas.width = ui.canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    if (!d || !d.frames.length) { ui.hud.hidden = true; return; }
    const f = d.frames[state.i], n = d.size, colors = lut(colormap());
    small.width = small.height = n;
    const sctx = small.getContext("2d"), image = sctx.createImageData(n, n), px = image.data;
    for (let k = 0; k < n * n; k++) {
      const v = f.pixels[k];
      const a = Number.isFinite(v) ? Math.sqrt(Math.min(1, Math.max(0, (v - f.lo) / (f.hi - f.lo)))) : 0;
      const c = Math.round(a * 255) * 3;
      px[k * 4] = colors[c]; px[k * 4 + 1] = colors[c + 1]; px[k * 4 + 2] = colors[c + 2]; px[k * 4 + 3] = 255;
    }
    sctx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small, 0, 0, size, size);
    // Cross hairs: where JPL says the object is (always the middle).
    const c = size / 2, gap = 12, len = 10;
    ctx.strokeStyle = "#7dd3fc"; ctx.lineWidth = 2; ctx.lineCap = "round";
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(c + dx * gap, c + dy * gap); ctx.lineTo(c + dx * (gap + len), c + dy * (gap + len)); }
    ctx.stroke();
    ui.hud.hidden = false;
    ui.hud.replaceChildren(
      Object.assign(document.createElement("strong"), { textContent: `${f.date} UTC` }),
      Object.assign(document.createElement("span"), { textContent: `frame ${state.i + 1} of ${d.frames.length} · detector ${f.det} · ${f.wl.toFixed(2)} µm${f.seen === false ? " · too faint here" : f.seen ? " · visible" : ""}` }),
    );
    ui.slider.value = state.i;
    onFrame(f);
  }

  function step(by) {
    const d = state.data;
    if (!d?.frames.length) return;
    state.i = (state.i + by + d.frames.length) % d.frames.length;
    draw();
  }

  function setPlaying(on) {
    clearInterval(state.timer);
    state.timer = on ? setInterval(() => step(1), 450) : null;
    ui.play.textContent = on ? "❚❚" : "▶";
    ui.play.setAttribute("aria-label", on ? "Pause" : "Play");
  }

  function reset() {
    state.token++;
    state.abort?.abort();
    setPlaying(false);
    state.data = null;
    state.i = 0;
    setControls(false);
    ui.note.textContent = "";
    ui.sub.textContent = "every frame centred on where it was";
    draw();
  }

  // Only asteroids and comets: planets are far too bright for SPHEREx's detectors.
  function show(t) {
    reset();
    state.target = t;
    const ok = !!t && t.moving && t.kind === "small-body";
    ui.section.hidden = !ok;
    if (ok) setStatus(INTRO, { button: "Follow it through SPHEREx's images" });
  }

  function clear() { show(null); }

  ui.go.addEventListener("click", load);
  ui.prev.addEventListener("click", () => { setPlaying(false); step(-1); });
  ui.next.addEventListener("click", () => { setPlaying(false); step(1); });
  ui.play.addEventListener("click", () => setPlaying(!state.timer));
  ui.slider.addEventListener("input", () => { setPlaying(false); state.i = +ui.slider.value; draw(); });
  ui.stage.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { setPlaying(false); step(1); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { setPlaying(false); step(-1); e.preventDefault(); }
    else if (e.key === " ") { setPlaying(!state.timer); e.preventDefault(); }
  });
  new ResizeObserver(() => draw()).observe(ui.stage);

  return { show, clear, redraw: draw, state };
}
