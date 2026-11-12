/**
 * pixelname-life.js
 * Draws a short string in a 5x7 bitmap font as a grid of rounded cells, matching the
 * heat-grid background. A Game of Life runs across the whole grid, but only letter cells
 * are drawn; the simulation's heat shifts their brightness.
 *
 *   import { createPixelName } from './pixelname-life.js';
 *   createPixelName(h1, 'RYAN P SMITH');  // wraps at the last space when too narrow
 *
 * The container keeps its text for screen readers; the canvas is aria-hidden.
 */

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
};
const GH = 7, ADV = 6, SPACE = 3, LINE_GAP = 3;

function textWidth(s) {
  let w = 0;
  for (const ch of s) w += ch === ' ' ? SPACE : ADV;
  return Math.max(0, w - 1);
}

function rasterize(lines) {
  const cols = Math.max(...lines.map(textWidth));
  const rows = lines.length * GH + (lines.length - 1) * LINE_GAP;
  const mask = new Uint8Array(cols * rows);
  lines.forEach((line, li) => {
    let x = 0;
    const y0 = li * (GH + LINE_GAP);
    for (const ch of line) {
      if (ch === ' ') { x += SPACE; continue; }
      const g = FONT[ch];
      if (g) for (let y = 0; y < GH; y++) for (let i = 0; i < 5; i++)
        if (g[y][i] === '1') mask[(y0 + y) * cols + x + i] = 1;
      x += ADV;
    }
  });
  return { cols, rows, mask };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createPixelName(el, text, opts = {}) {
  const o = {
    maxPitch: 11,      // px per cell including gap, desktop ceiling
    minPitch: 5,       // below this, wrap onto two lines
    gapRatio: 0.2,     // gap as a share of pitch
    speed: 2.2,        // generations per second
    smoothing: 0.55,   // seconds
    glyphLo: 0.5,      // alpha of a cold glyph cell
    glyphHi: 1,        // alpha of a hot glyph cell
    ...opts,
  };
  const words = text.toUpperCase();

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.display = 'block';
  el.append(canvas);
  el.classList.add('is-pixel');
  const ctx = canvas.getContext('2d');

  const rand = mulberry32(7);
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const mqDark = matchMedia('(prefers-color-scheme: dark)');
  let ink = '0,0,0';
  const readInk = () => {
    const probe = getComputedStyle(el).color.match(/\d+(\.\d+)?/g) || [0, 0, 0];
    ink = probe.slice(0, 3).join(',');
  };

  let cols = 0, rows = 0, n = 0, mask, alive, buf, age, ghost, cur, tgt;
  let pitch = 0, dpr = 1, W = 0, H = 0;
  let raf = 0, lastT = 0, acc = 0, visible = true, hover = false;

  function layout() {
    const avail = el.parentElement.getBoundingClientRect().width;
    let lines = [words];
    let r = rasterize(lines);
    let p = Math.min(o.maxPitch, Math.floor(avail / r.cols));
    if (p < o.minPitch && words.includes(' ')) {
      const cut = words.lastIndexOf(' ');
      lines = [words.slice(0, cut), words.slice(cut + 1)];
      r = rasterize(lines);
      p = Math.min(o.maxPitch, Math.floor(avail / r.cols));
    }
    p = Math.max(3, p);
    const resized = r.cols !== cols || r.rows !== rows;
    cols = r.cols; rows = r.rows; n = cols * rows; mask = r.mask; pitch = p;
    if (resized) {
      alive = new Uint8Array(n); buf = new Uint8Array(n); age = new Uint8Array(n);
      ghost = new Float32Array(n); cur = new Float32Array(n); tgt = new Float32Array(n);
      for (let k = 0; k < n; k++) alive[k] = mask[k] || rand() < 0.12 ? 1 : 0;
      retarget(); cur.set(tgt);
    }
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = cols * pitch - Math.round(pitch * o.gapRatio);
    H = rows * pitch - Math.round(pitch * o.gapRatio);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  }

  function sow() {
    const ci = Math.floor(rand() * cols), cj = Math.floor(rand() * rows);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
      if (rand() < 0.5) alive[((cj + y) % rows) * cols + ((ci + x) % cols)] = 1;
  }

  function step() {
    let pop = 0, changes = 0;
    for (let j = 0; j < rows; j++) {
      const jm = ((j - 1 + rows) % rows) * cols, j0 = j * cols, jp = ((j + 1) % rows) * cols;
      for (let i = 0; i < cols; i++) {
        const im = (i - 1 + cols) % cols, ip = (i + 1) % cols;
        const nb = alive[jm + im] + alive[jm + i] + alive[jm + ip] + alive[j0 + im] +
                   alive[j0 + ip] + alive[jp + im] + alive[jp + i] + alive[jp + ip];
        const k = j0 + i, was = alive[k];
        const now = nb === 3 || (was && nb === 2) ? 1 : 0;
        buf[k] = now; pop += now; if (now !== was) changes++;
        age[k] = now ? (was ? Math.min(255, age[k] + 1) : 0) : 0;
        ghost[k] = was && !now ? 1 : ghost[k] * 0.6;
      }
    }
    [alive, buf] = [buf, alive];
    if (changes < n * 0.01 || pop < n * 0.06) { sow(); sow(); }
    else if (rand() < 0.3) sow();
    retarget();
  }

  function retarget() {
    for (let k = 0; k < n; k++)
      tgt[k] = alive[k] ? 1 - 0.45 * Math.min(age[k], 6) / 6 : ghost[k] * 0.55;
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const c = pitch - Math.round(pitch * o.gapRatio), r = Math.min(2, c * 0.22);
    // bucket by alpha so each fill is one path
    const buckets = new Map();
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (!mask[k]) continue; // only letter cells are drawn; Life still runs underneath
      const a = hover ? 1 : o.glyphLo + (o.glyphHi - o.glyphLo) * cur[k];
      const q = Math.round(a * 60);
      if (q <= 0) continue;
      let list = buckets.get(q);
      if (!list) buckets.set(q, (list = []));
      list.push(i * pitch, j * pitch);
    }
    for (const [q, list] of buckets) {
      ctx.fillStyle = `rgba(${ink},${(q / 60).toFixed(3)})`;
      ctx.beginPath();
      for (let p = 0; p < list.length; p += 2) ctx.roundRect(list[p], list[p + 1], c, c, r);
      ctx.fill();
    }
  }

  function frame(t) {
    raf = 0;
    const dt = Math.min(0.1, (t - (lastT || t)) / 1000);
    lastT = t;
    acc += dt * o.speed;
    if (acc >= 1) { step(); acc = 0; }
    const k = 1 - Math.exp(-dt / o.smoothing);
    for (let q = 0; q < n; q++) cur[q] += (tgt[q] - cur[q]) * k;
    draw();
    schedule();
  }
  function schedule() {
    if (!raf && visible && !mqReduce.matches) raf = requestAnimationFrame(frame);
  }

  canvas.title = 'Ryan P Smith. Hover for a solid view; the letters are a Game of Life.';
  canvas.addEventListener('mouseenter', () => { hover = true; draw(); });
  canvas.addEventListener('mouseleave', () => { hover = false; draw(); });
  readInk();
  layout();
  if (mqReduce.matches) { for (let q = 0; q < 6; q++) step(); cur.set(tgt); }
  draw();
  schedule();

  let rz = 0;
  new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => { layout(); draw(); }, 100); })
    .observe(el.parentElement);
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; lastT = 0; schedule(); })
    .observe(canvas);
  mqDark.addEventListener('change', () => { readInk(); draw(); });
  mqReduce.addEventListener('change', () => { draw(); schedule(); });
}
