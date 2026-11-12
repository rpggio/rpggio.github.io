/**
 * heatgrid-life.js
 * A subtle, colorless Game of Life texture drawn as a GitHub-style heat grid,
 * where busy regions merge into larger 2x2 / 4x4 blocks.
 *
 * The texture is a single ink (white on dark, black on light) at low alpha,
 * so it only lightens or darkens whatever background sits behind it.
 *
 * Usage:
 *   import { createHeatGrid } from './heatgrid-life.js';
 *   const grid = createHeatGrid(document.querySelector('.hero'), { speed: 1, blockiness: 0.6 });
 *   grid.set({ mode: 'light' });   // change any option live
 *   grid.pause(); grid.play(); grid.reseed(); grid.destroy();
 *
 * The canvas is inserted as the first child of the container, absolutely positioned
 * to fill it. If the container is position: static it is set to relative.
 * Give your foreground content position: relative (or a z-index) to sit above it.
 */

export const DEFAULTS = Object.freeze({
  /* geometry */
  cellSize: 14,          // px, edge of one cell
  gap: 4,                // px between cells
  radius: 2.5,           // px corner radius

  /* simulation */
  speed: 0.9,            // Life generations per second (0 freezes the simulation)
  density: 0.16,         // 0..1 fraction alive on seed; also how full sown patches are
  activity: 0.5,         // 0..1 how often new patches are sown so the field never dies
  trail: 0.55,           // 0..1 how long dead cells linger as ghosts (per generation decay)
  aging: 0.4,            // 0..1 how much long-lived cells dim, creating heat-map levels
  levels: 4,             // quantize brightness to N levels like GitHub (0 = continuous)
  smoothing: 0.9,        // seconds, fade time between states

  /* merging */
  blockiness: 0.5,       // 0..1 share of the grid allowed to merge into bigger blocks
  mergeThreshold: 0.45,  // 0..1 how full a block must be before it merges
  maxBlock: 4,           // 1 (no merging), 2 or 4

  /* appearance */
  intensity: 0.22,       // alpha of the brightest cell
  emptyAlpha: 0.018,     // alpha of an empty cell (the faint lattice), 0 hides it
  mode: 'auto',          // 'dark' (white ink) | 'light' (black ink) | 'auto' (prefers-color-scheme)
  lightScale: 0.8,       // strength trim in light mode, black ink reads stronger

  /* runtime */
  seed: 1,               // deterministic block layout and initial state
  fps: 30,               // draw cap
  pauseOffscreen: true,
  respectReducedMotion: true, // render a still frame when the user prefers reduced motion
  zIndex: 0,
});

/* ---------- helpers ---------- */
function hash(x, y, s) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (s | 0) * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const ALPHA_STEPS = 400;

/* ---------- factory ---------- */
export function createHeatGrid(container, options = {}) {
  if (!container) throw new Error('createHeatGrid: container element is required');
  const o = { ...DEFAULTS, ...options };

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: String(o.zIndex),
  });
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.prepend(canvas);
  const ctx = canvas.getContext('2d');

  let rand = mulberry32(o.seed);
  let W = 0, H = 0, dpr = 1, P = 0;
  let cols = 0, rows = 0, n = 0;
  let alive, buf, age, ghost, cur, tgt;
  let b2c = 0, b2r = 0, m2, m2t, e2;
  let b4c = 0, b4r = 0, m4, m4t, e4;
  let gen = 0, acc = 0;
  let running = true, visible = true, destroyed = false;
  let raf = 0, lastT = 0, lastDraw = 0;
  const buckets = Array.from({ length: ALPHA_STEPS + 1 }, () => []);

  const mqDark = matchMedia('(prefers-color-scheme: dark)');
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const isLight = () => (o.mode === 'auto' ? !mqDark.matches : o.mode === 'light');
  const still = () => o.respectReducedMotion && mqReduce.matches;

  /* ----- allocation, keeping state across resizes ----- */
  function build() {
    const r = container.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    P = o.cellSize + o.gap;

    const nc = Math.ceil((Math.ceil(W / P) + 1) / 4) * 4;
    const nr = Math.ceil((Math.ceil(H / P) + 1) / 4) * 4;
    const old = alive ? { cols, rows, alive, age, ghost, cur, tgt } : null;

    cols = nc; rows = nr; n = cols * rows;
    alive = new Uint8Array(n); buf = new Uint8Array(n); age = new Uint8Array(n);
    ghost = new Float32Array(n); cur = new Float32Array(n); tgt = new Float32Array(n);
    b2c = cols / 2; b2r = rows / 2; b4c = cols / 4; b4r = rows / 4;
    m2 = new Float32Array(b2c * b2r); m2t = new Float32Array(b2c * b2r); e2 = new Uint8Array(b2c * b2r);
    m4 = new Float32Array(b4c * b4r); m4t = new Float32Array(b4c * b4r); e4 = new Uint8Array(b4c * b4r);

    if (old) {
      const fill = { alive, age, ghost, cur, tgt };
      for (let j = 0; j < Math.min(rows, old.rows); j++)
        for (let i = 0; i < Math.min(cols, old.cols); i++) {
          const a = j * cols + i, b = j * old.cols + i;
          for (const key in fill) fill[key][a] = old[key][b];
        }
      // sow fresh area that wasn't covered before
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++)
        if (i >= old.cols || j >= old.rows) alive[j * cols + i] = rand() < o.density ? 1 : 0;
    } else {
      seedAll();
    }
    eligibility();
    retarget();
    if (!old) { cur.set(tgt); m2.set(m2t); m4.set(m4t); }
  }

  function seedAll() {
    rand = mulberry32(o.seed);
    for (let k = 0; k < n; k++) { alive[k] = rand() < o.density ? 1 : 0; age[k] = 0; ghost[k] = 0; }
    gen = 0;
  }

  function eligibility() {
    const b = clamp01(o.blockiness);
    for (let j = 0; j < b2r; j++) for (let i = 0; i < b2c; i++)
      e2[j * b2c + i] = o.maxBlock >= 2 && hash(i, j, o.seed * 31 + 7) < b ? 1 : 0;
    for (let j = 0; j < b4r; j++) for (let i = 0; i < b4c; i++)
      e4[j * b4c + i] = o.maxBlock >= 4 && hash(i, j, o.seed * 53 + 11) < b * 0.55 ? 1 : 0;
  }

  /* ----- simulation ----- */
  function sow(count) {
    const fill = Math.min(0.65, o.density * 2.8 + 0.1);
    for (let q = 0; q < count; q++) {
      const s = 5 + Math.floor(rand() * 4);
      const ci = Math.floor(rand() * cols), cj = Math.floor(rand() * rows);
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++)
        if (rand() < fill) alive[((cj + y) % rows) * cols + ((ci + x) % cols)] = 1;
    }
  }

  function step() {
    let changes = 0, pop = 0;
    const decay = clamp01(o.trail);
    for (let j = 0; j < rows; j++) {
      const jm = ((j - 1 + rows) % rows) * cols, j0 = j * cols, jp = ((j + 1) % rows) * cols;
      for (let i = 0; i < cols; i++) {
        const im = (i - 1 + cols) % cols, ip = (i + 1) % cols;
        const nb = alive[jm + im] + alive[jm + i] + alive[jm + ip] + alive[j0 + im] +
                   alive[j0 + ip] + alive[jp + im] + alive[jp + i] + alive[jp + ip];
        const k = j0 + i, was = alive[k];
        const now = nb === 3 || (was && nb === 2) ? 1 : 0;
        buf[k] = now;
        if (now !== was) changes++;
        pop += now;
        age[k] = now ? (was ? Math.min(255, age[k] + 1) : 0) : 0;
        ghost[k] = was && !now ? 1 : ghost[k] * decay;
        if (ghost[k] < 0.04) ghost[k] = 0;
      }
    }
    const t = alive; alive = buf; buf = t;
    gen++;

    const quiet = changes < n * 0.003 || pop < n * 0.02;
    if (quiet) sow(3);
    else if (rand() < o.activity * 0.25) sow(1);
    retarget();
  }

  function retarget() {
    const L = o.levels | 0, ag = clamp01(o.aging);
    for (let k = 0; k < n; k++) {
      let v = alive[k] ? 1 - ag * Math.min(age[k], 8) / 8 : ghost[k] * 0.6;
      if (L > 0) v = v <= 0.04 ? 0 : Math.ceil(v * L) / L;
      tgt[k] = v;
    }
    const thr = clamp01(o.mergeThreshold);
    for (let bj = 0; bj < b2r; bj++) for (let bi = 0; bi < b2c; bi++) {
      const b = bj * b2c + bi;
      if (!e2[b]) { m2t[b] = 0; continue; }
      const k = bj * 2 * cols + bi * 2;
      const avg = (tgt[k] + tgt[k + 1] + tgt[k + cols] + tgt[k + cols + 1]) / 4;
      m2t[b] = avg >= thr ? 1 : 0;
    }
    for (let bj = 0; bj < b4r; bj++) for (let bi = 0; bi < b4c; bi++) {
      const b = bj * b4c + bi;
      if (!e4[b]) { m4t[b] = 0; continue; }
      let s = 0;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) s += tgt[(bj * 4 + y) * cols + bi * 4 + x];
      m4t[b] = s / 16 >= thr * 0.6 ? 1 : 0;
    }
  }

  /* ----- drawing ----- */
  function push(x, y, w, h, a) {
    const b = Math.round(clamp01(a) * ALPHA_STEPS);
    if (b > 0) buckets[b].push(x, y, w, h);
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const light = isLight();
    const ink = light ? '0,0,0' : '255,255,255';
    const scale = light ? o.lightScale : 1;
    const lo = o.emptyAlpha * scale, hi = o.intensity * scale;
    const alpha = v => lo + (hi - lo) * v;
    const C = o.cellSize, g = o.gap;

    // single cells, faded out where a block has merged over them
    for (let j = 0; j < rows; j++) {
      const r2 = (j >> 1) * b2c, r4 = (j >> 2) * b4c;
      for (let i = 0; i < cols; i++) {
        const w = (1 - m2[r2 + (i >> 1)]) * (1 - m4[r4 + (i >> 2)]);
        if (w > 0.01) push(i * P, j * P, C, C, alpha(cur[j * cols + i]) * w);
      }
    }
    // 2x2 blocks
    for (let bj = 0; bj < b2r; bj++) for (let bi = 0; bi < b2c; bi++) {
      const m = m2[bj * b2c + bi] * (1 - m4[(bj >> 1) * b4c + (bi >> 1)]);
      if (m <= 0.01) continue;
      const k = bj * 2 * cols + bi * 2;
      const avg = (cur[k] + cur[k + 1] + cur[k + cols] + cur[k + cols + 1]) / 4;
      push(bi * 2 * P, bj * 2 * P, 2 * P - g, 2 * P - g, alpha(Math.pow(avg, 0.8)) * m);
    }
    // 4x4 blocks
    for (let bj = 0; bj < b4r; bj++) for (let bi = 0; bi < b4c; bi++) {
      const m = m4[bj * b4c + bi];
      if (m <= 0.01) continue;
      let s = 0;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) s += cur[(bj * 4 + y) * cols + bi * 4 + x];
      push(bi * 4 * P, bj * 4 * P, 4 * P - g, 4 * P - g, alpha(Math.pow(s / 16, 0.7)) * m);
    }

    const R = Math.min(o.radius, C / 2);
    for (let b = 1; b <= ALPHA_STEPS; b++) {
      const list = buckets[b];
      if (!list.length) continue;
      ctx.fillStyle = `rgba(${ink},${(b / ALPHA_STEPS).toFixed(4)})`;
      ctx.beginPath();
      for (let q = 0; q < list.length; q += 4) ctx.roundRect(list[q], list[q + 1], list[q + 2], list[q + 3], R);
      ctx.fill();
      list.length = 0;
    }
  }

  function ease(dt, snap) {
    const k = snap ? 1 : 1 - Math.exp(-dt / Math.max(0.05, o.smoothing));
    const km = snap ? 1 : 1 - Math.exp(-dt / Math.max(0.05, o.smoothing * 1.6));
    for (let q = 0; q < n; q++) cur[q] += (tgt[q] - cur[q]) * k;
    for (let q = 0; q < m2.length; q++) m2[q] += (m2t[q] - m2[q]) * km;
    for (let q = 0; q < m4.length; q++) m4[q] += (m4t[q] - m4[q]) * km;
  }

  function stillFrame() {
    for (let q = 0; q < 24; q++) step();
    ease(0, true);
    draw();
  }

  /* ----- loop ----- */
  function frame(t) {
    raf = 0;
    if (destroyed) return;
    const dt = Math.min(0.1, (t - (lastT || t)) / 1000);
    lastT = t;
    if (running && !still() && (visible || !o.pauseOffscreen)) {
      if (o.speed > 0) {
        acc += dt * o.speed;
        let guard = 0;
        while (acc >= 1 && guard++ < 4) { step(); acc -= 1; }
        if (acc >= 1) acc = 0;
      }
      ease(dt, false);
      if (t - lastDraw >= 1000 / o.fps - 1) { draw(); lastDraw = t; }
    }
    schedule();
  }
  function schedule() {
    if (!raf && !destroyed && running && !still() && (visible || !o.pauseOffscreen))
      raf = requestAnimationFrame(frame);
  }

  /* ----- observers ----- */
  let rzTimer = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => { build(); draw(); }, 120);
  });
  ro.observe(container);
  const io = new IntersectionObserver(es => {
    visible = es[0].isIntersecting;
    lastT = 0;
    schedule();
  }, { rootMargin: '100px' });
  io.observe(container);
  const onScheme = () => draw();
  const onReduce = () => (still() ? stillFrame() : schedule());
  mqDark.addEventListener('change', onScheme);
  mqReduce.addEventListener('change', onReduce);

  build();
  if (still()) stillFrame(); else { draw(); schedule(); }

  /* ----- public API ----- */
  const api = {
    canvas,
    get options() { return { ...o }; },
    get running() { return running; },
    /** Update any options live. */
    set(patch = {}) {
      const prev = { ...o };
      Object.assign(o, patch);
      if (o.cellSize !== prev.cellSize || o.gap !== prev.gap) build();
      if (o.seed !== prev.seed) { seedAll(); retarget(); }
      if (o.blockiness !== prev.blockiness || o.maxBlock !== prev.maxBlock || o.seed !== prev.seed) eligibility();
      if (['levels', 'aging', 'mergeThreshold', 'blockiness', 'maxBlock'].some(k => o[k] !== prev[k])) retarget();
      if (o.zIndex !== prev.zIndex) canvas.style.zIndex = String(o.zIndex);
      if (!running || still()) ease(0, true);
      draw();
      schedule();
      return api;
    },
    play() { running = true; lastT = 0; schedule(); return api; },
    pause() { running = false; return api; },
    /** Wipe and re-seed the simulation. */
    reseed(seed) {
      if (seed !== undefined) { o.seed = seed; eligibility(); }
      seedAll(); retarget();
      return api;
    },
    /** Advance one generation (handy while paused). */
    step() { step(); ease(0, true); draw(); return api; },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      ro.disconnect(); io.disconnect();
      mqDark.removeEventListener('change', onScheme);
      mqReduce.removeEventListener('change', onReduce);
      canvas.remove();
    },
  };
  return api;
}

export default createHeatGrid;
