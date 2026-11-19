// Стол, мониторы-слоты, часы Sony, стартовый экран и подсказка поворота.
// Только рисует и шлёт намерения. Игровой логики здесь нет.

import * as audio from '../audio.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------- часы Sony ----------
// Всё в координатах фото (1672x941). Параметры подобраны по цифрам «12:02» на снимке.
const CLOCK = {
  rotate: 5.25,   // базовая линия идёт вниз вправо
  skew: 5.5,      // наклон цифр (курсив)
  w: 23, h: 41.5, t: 3.1, gap: 0.2, // размеры цифры и толщина сегмента
  cells: [        // левый нижний угол каждой ячейки: d1 d2 d3 d4
    [1428.0, 714.2],
    [1458.6, 717.0],
    [1500.6, 720.0],
    [1532.6, 723.0],
  ],
  colon: [1491.0, 720.0],
};

// ---------- мониторы ----------
// Экран каждого монитора на фото это четырёхугольник (мониторы стоят чуть V-образно).
// Холст 640x376 растягивается на него матрицей matrix3d (перспективное преобразование).
// Углы (в px фото 1672x941): левый верх, правый верх, правый низ, левый низ.
export const PHOTO_W = 1672;
const CLOCK_GLITCH_SEC = 3;   // сколько секунд минуты на часах видны в глюке 3:33
export const MONITOR_SIZE = [640, 376];
export const MONITOR_QUADS = {
  left:  [[55.3, 138.6], [832.0, 149.4], [832.0, 593.3], [69.0, 601.6]],
  right: [[847.0, 149.5], [1614.2, 139.0], [1607.0, 600.7], [847.0, 593.6]],
};

// Прямоугольник w x h -> четырёхугольник quad, масштаб k (px сцены на px фото).
// Возвращает 16 чисел для CSS matrix3d (по столбцам).
export function monitorMatrix(quad, w, h, k = 1) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const hh = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;
  // единичный квадрат -> холст w x h, затем масштаб k для координат на выходе
  return [
    (k * a) / w, (k * d) / w, 0, g / w,
    (k * b) / h, (k * e) / h, 0, hh / h,
    0, 0, 1, 0,
    k * c, k * f, 0, 1,
  ];
}

function layoutMonitors() {
  if (!els.stage) return;
  const k = els.stage.clientWidth / PHOTO_W;
  if (!k) return;
  const [w, h] = MONITOR_SIZE;
  for (const [side, node] of [['left', els.monLeft], ['right', els.monRight]]) {
    node.style.transform = `matrix3d(${monitorMatrix(MONITOR_QUADS[side], w, h, k).join(',')})`;
    node.classList.add('is-ready');
  }
}

// ---------- главное меню: живой фон ----------
// Всё считается в координатах арта menu_background.jpeg (1376x768). Контейнер .menu-art
// масштабируется как object-fit: cover, поэтому слои не расходятся с картинкой.
// Если арт заменят, правятся только числа в MENU_ART.
const MENU_ART = {
  w: 1376, h: 768,
  // стекло ЭЛТ-монитора на арте: левый верх, правый верх, правый низ, левый низ (px арта)
  quad: [[1019.5, 422.5], [1247, 418.5], [1241.5, 611], [1015.5, 601]],
  glow: [1130, 512],   // центр свечения монитора
  embers: { right: [800, 200, 1376, 720], any: [250, 300, 1376, 740] },   // зоны искр: x0, y0, x1, y1
};
const MENU_TEX = [288, 240];     // «плоский» экран монитора (px холста), перспективу даёт matrix3d
const MENU_STATIC_W = 240;       // ширина зернистого холста статики на весь экран
const MENU_SMOKE = [240, 135];   // разрешение холста дыма (растягивается на весь арт)

const mfxStep = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };

// --- шум для дыма (value noise на тайле 128x128, бесшовный) ---
function mfxNoiseTile() {
  const a = new Float32Array(128 * 128);
  for (let i = 0; i < a.length; i++) a[i] = Math.random();
  return a;
}
function mfxNoise(a, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const x0 = xi & 127, x1 = (xi + 1) & 127, y0 = (yi & 127) << 7, y1 = ((yi + 1) & 127) << 7;
  const v00 = a[y0 + x0], v10 = a[y0 + x1], v01 = a[y1 + x0], v11 = a[y1 + x1];
  return v00 + (v10 - v00) * fx + (v01 - v00) * fy + (v00 - v10 - v01 + v11) * fx * fy;
}
function mfxFbm(a, x, y) {
  return 0.5 * mfxNoise(a, x, y) + 0.27 * mfxNoise(a, x * 2.03 + 5.2, y * 2.03 + 1.3)
    + 0.15 * mfxNoise(a, x * 4.1 + 9.7, y * 4.1 + 3.1) + 0.08 * mfxNoise(a, x * 8.3 + 2.4, y * 8.3 + 7.7);
}

// --- дым: два слоя шума с искажением координат, плывёт вправо и вверх, подсвечен монитором ---
function mfxDrawSmoke(fx, ts) {
  const s = fx.smoke;
  const { w, h, tile } = s;
  const d = s.img.data;
  const t = ts / 1000;
  const mx = MENU_ART.glow[0] / MENU_ART.w * w, my = MENU_ART.glow[1] / MENU_ART.h * h;
  const y0 = Math.floor(h * 0.3);   // выше дыма нет, эти строки остаются прозрачными
  for (let y = y0; y < h; y++) {
    const vm = mfxStep(0.32, 0.85, y / h);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const wx = mfxFbm(tile, x * 0.018 - t * 0.012 + 3.1, y * 0.03 + t * 0.01);
      const n = mfxFbm(tile, x * 0.026 - t * 0.03 + wx * 1.1, y * 0.04 + t * 0.018 + wx * 0.9 + 11.5);
      let a = mfxStep(0.4, 0.74, n) * vm;
      a *= 0.5 + 0.5 * mfxStep(0, 0.45, x / w);   // слева, под текстом меню, дым реже
      const dx = (x - mx) / 45, dy = (y - my) / 28;
      const gl = Math.exp(-(dx * dx + dy * dy) / 2);   // свет монитора на дыме
      a *= 0.62 + 0.5 * gl;
      d[i] = 168 + gl * 22; d[i + 1] = 198 + gl * 57; d[i + 2] = 186 + gl * 39;
      d[i + 3] = Math.min(255, a * 255 * 0.62);
    }
  }
  s.cx.putImageData(s.img, 0, 0);
}

// --- искры и пылинки ---
function mfxGlowSprite(stops) {
  const [c, cx] = makeCanvas(64, 64);
  const g = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [o, col] of stops) g.addColorStop(o, col);
  cx.fillStyle = g; cx.fillRect(0, 0, 64, 64);
  return c;
}
function mfxSpawn(p, initial) {
  const zone = p.dust ? MENU_ART.embers.any : (Math.random() < 0.7 ? MENU_ART.embers.right : MENU_ART.embers.any);
  p.x = rand(zone[0], zone[2]); p.y = rand(zone[1], zone[3]);
  p.d = p.dust ? rand(2.5, 6) : rand(7, 16);      // диаметр свечения (px арта)
  p.vx = rand(-3, 6); p.vy = -rand(p.dust ? 2 : 5, p.dust ? 7 : 16);
  p.life = rand(7, 16); p.age = initial ? rand(0, p.life) : 0;
  p.tw = rand(0, 6.28); p.twS = rand(1.2, 4); p.ph = rand(0, 6.28);
  p.sway = rand(5, 16); p.swayF = rand(0.3, 0.9);
  p.peak = p.dust ? rand(0.12, 0.3) : rand(0.4, 0.95);
  p.flare = 0;
}
function mfxInitEmbers(fx) {
  fx.sprites = {
    ember: mfxGlowSprite([[0, 'rgba(255,205,185,1)'], [0.12, 'rgba(255,90,70,0.95)'], [0.35, 'rgba(220,30,30,0.35)'], [1, 'rgba(160,0,0,0)']]),
    dust: mfxGlowSprite([[0, 'rgba(215,255,238,0.9)'], [0.3, 'rgba(170,230,205,0.3)'], [1, 'rgba(150,210,190,0)']]),
  };
  fx.embers = [];
  for (let i = 0; i < 48; i++) {
    const p = { dust: i >= 34 };
    mfxSpawn(p, true);
    fx.embers.push(p);
  }
}
function mfxDrawEmbers(fx, dt, ts) {
  const cx = fx.embCtx, sc = els.menuScale;
  if (!cx || !sc) return;
  cx.clearRect(0, 0, sc.W, sc.H);
  cx.globalCompositeOperation = 'lighter';
  const t = ts / 1000;
  for (const p of fx.embers) {
    if (dt > 0) {
      p.age += dt;
      if (p.age > p.life) mfxSpawn(p, false);
      p.x += (p.vx + Math.sin(t * p.swayF + p.ph) * p.sway) * dt;
      p.y += p.vy * dt;
      p.tw += p.twS * dt;
      p.flare = Math.max(0, p.flare - dt * 1.4);
      if (!p.dust && Math.random() < dt * 0.15) p.flare = 0.35;   // редкая яркая вспышка
    }
    const fade = Math.min(1, p.age / 1.2, (p.life - p.age) / 1.8);
    const a = Math.min(1, p.peak * fade * (0.6 + 0.4 * Math.sin(p.tw) + p.flare));
    if (a < 0.02) continue;
    const D = p.d * sc.s * (p.dust ? 1 : 1 + p.flare * 0.5);
    cx.globalAlpha = a;
    cx.drawImage(p.dust ? fx.sprites.dust : fx.sprites.ember, sc.ox + p.x * sc.s - D / 2, sc.oy + p.y * sc.s - D / 2, D, D);
  }
  cx.globalAlpha = 1;
  cx.globalCompositeOperation = 'source-over';
}

// --- помехи на мониторе ---
// Текстура: пиксели стекла прямо с фото, выпрямленные той же гомографией, что и CSS matrix3d.
// В покое кадр совпадает с оригиналом, в движении рвётся теми же кусками.
function mfxBuildTex(fx, img) {
  const m = fx.mon;
  const [W, H] = MENU_TEX;
  try {
    const q = MENU_ART.quad;
    const bx0 = Math.floor(Math.min(...q.map((p) => p[0]))) - 3, by0 = Math.floor(Math.min(...q.map((p) => p[1]))) - 3;
    const bw = Math.ceil(Math.max(...q.map((p) => p[0]))) + 3 - bx0, bh = Math.ceil(Math.max(...q.map((p) => p[1]))) + 3 - by0;
    const [, sx] = makeCanvas(bw, bh);
    sx.drawImage(img, bx0, by0, bw, bh, 0, 0, bw, bh);
    const src = sx.getImageData(0, 0, bw, bh).data;
    const mt = monitorMatrix(q, W, H, 1);
    const [tc, tx] = makeCanvas(W, H);
    const out = tx.createImageData(W, H);
    const o = out.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = x + 0.5, py = y + 0.5;
        const wd = mt[3] * px + mt[7] * py + 1;
        const X = Math.min(bw - 1.001, Math.max(0, (mt[0] * px + mt[4] * py + mt[12]) / wd - bx0 - 0.5));
        const Y = Math.min(bh - 1.001, Math.max(0, (mt[1] * px + mt[5] * py + mt[13]) / wd - by0 - 0.5));
        const x0 = X | 0, y0 = Y | 0, fx1 = X - x0, fy1 = Y - y0;
        const i00 = (y0 * bw + x0) * 4, i10 = i00 + 4, i01 = i00 + bw * 4, i11 = i01 + 4;
        const k = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx1;
          const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx1;
          o[k + c] = top + (bot - top) * fy1;
        }
        o[k + 3] = 255;
      }
    }
    tx.putImageData(out, 0, 0);
    m.tex = tc;
    m.c.hidden = REDUCE;   // при «уменьшить движение» остаётся статичное фото
  } catch (e) {
    console.warn('menu: не удалось подготовить текстуру монитора (нужен запуск через сервер)', e);
    m.tex = null;
    m.c.hidden = true;
    if (els.menuGlow) els.menuGlow.hidden = true;
  }
}

function mfxMonitorMask(W, H) {
  const [c, cx] = makeCanvas(W, H);
  const img = cx.createImageData(W, H);
  const r = 10, feather = 3.5;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = Math.abs(x + 0.5 - W / 2) - (W / 2 - r), py = Math.abs(y + 0.5 - H / 2) - (H / 2 - r);
      const dist = Math.hypot(Math.max(px, 0), Math.max(py, 0)) + Math.min(Math.max(px, py), 0) - r;
      const k = (y * W + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
      img.data[k + 3] = 255 * Math.min(1, Math.max(0, (-dist - 1.5) / feather));
    }
  }
  cx.putImageData(img, 0, 0);
  return c;
}

function mfxMonitorLines(W, H) {
  const [c, cx] = makeCanvas(W, H);
  cx.fillStyle = 'rgba(0,0,0,0.26)';
  for (let y = 0; y < H; y += 3) cx.fillRect(0, y, W, 1);
  const v = cx.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, H * 0.82);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.4)');
  cx.fillStyle = v; cx.fillRect(0, 0, W, H);
  const g = cx.createLinearGradient(0, 0, W * 0.6, H * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,0.07)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = g; cx.fillRect(0, 0, W, H);
  return c;
}

function mfxInitMonitor(fx, art) {
  const [W, H] = MENU_TEX;
  const [c, cx] = makeCanvas(W, H);
  c.className = 'menu-monitor-screen';
  c.hidden = true;
  c.style.width = `${W}px`; c.style.height = `${H}px`;
  c.style.transform = `matrix3d(${monitorMatrix(MENU_ART.quad, W, H, 1).join(',')})`;
  art.appendChild(c);
  const [nc, ncx] = makeCanvas(96, 80);
  fx.mon = { c, cx, W, H, tex: null, mask: mfxMonitorMask(W, H), lines: mfxMonitorLines(W, H),
    noise: nc, noiseCx: ncx, noiseImg: ncx.createImageData(96, 80), bands: [], slabs: [], roll: null, flick: 0,
    nextEv: 0, evUntil: 0, evType: 'burst', microAt: 0, microUntil: 0 };
}

// Помехи живут только на стекле монитора. level: 0 спокойный фон, 1 короткий срыв, 2 большой всплеск.
function mfxBand(W, H, level) {
  const r = Math.random();
  const type = r < 0.4 ? 'shift' : r < 0.65 ? 'swap' : r < 0.85 ? 'smear' : 'ghost';
  const h = type === 'smear' ? rand(6, 40) : rand(3, 30);
  const big = Math.random() < (level ? 0.45 : 0.3);
  return {
    type, h, y: rand(0, H - h), sy: rand(0, H - h), ghost: rand(4, 10) * (Math.random() < 0.5 ? -1 : 1),
    off: (Math.random() < 0.5 ? -1 : 1) * (big ? rand(30, 110) : rand(4, 26)) * (1 + 0.4 * level),
    ttl: rand(70, level ? 260 : 480),
  };
}

function mfxSlab(W, H, level) {
  const r = Math.random();
  const kind = r < 0.5 ? 'bright' : r < 0.75 ? 'streak' : 'dark';
  const s = { kind, ttl: rand(60, level ? 220 : 300), dots: [] };
  if (kind === 'bright') { s.w = rand(30, 120); s.h = rand(4, 14); s.color = '#e9fff6'; }
  else if (kind === 'streak') { s.w = rand(40, 170); s.h = rand(1, 2.2); s.color = '#f2fff9'; }
  else { s.w = rand(40, 150); s.h = rand(5, 18); s.color = '#040c0a'; }
  s.x = rand(-10, W - s.w + 10);
  s.y = rand(0, H - s.h);
  if (kind !== 'streak') {
    for (let i = 0; i < 9; i++) s.dots.push([Math.floor(rand(0, s.w - 2)), Math.floor(rand(0, s.h - 1))]);
  }
  return s;
}

function mfxTickMonitor(fx, dtMs) {
  const m = fx.mon;
  if (!m.tex) return;
  const { cx, W, H, tex } = m;
  const now = fx.t;

  // свой планировщик монитора: большой всплеск каждые 1,8–4,2 с, между ними частые короткие срывы
  if (now >= m.nextEv) {
    const r = Math.random();
    m.evType = r < 0.3 ? 'roll' : r < 0.5 ? 'drop' : 'burst';
    m.evUntil = now + rand(500, 1100);
    m.nextEv = now + rand(1800, 4200);
    if (m.evType === 'roll') m.roll = { p: 0, dur: rand(450, 800) };
  } else if (now >= m.microAt) {
    m.microUntil = now + rand(80, 200);
    m.microAt = now + rand(350, 1100);
  }
  const big = now < m.evUntil;
  const level = big ? 2 : now < m.microUntil ? 1 : 0;

  cx.globalCompositeOperation = 'source-over';
  cx.globalAlpha = 1;
  cx.clearRect(0, 0, W, H);

  // дрожь кадра по горизонтали (только внутри монитора) и вертикальный срыв (roll)
  const jx = level ? Math.round(rand(-1, 1) * (level === 2 ? 12 : 6)) : 0;
  const drawFrame = (dy) => {
    cx.drawImage(tex, jx, dy);
    if (jx) cx.drawImage(tex, jx - Math.sign(jx) * W, dy);
  };
  let rollY = 0;
  if (m.roll) {
    m.roll.p += dtMs / m.roll.dur;
    if (m.roll.p >= 1) m.roll = null;
    else rollY = Math.round(m.roll.p * m.roll.p * H);
  }
  if (rollY) {
    drawFrame(rollY);
    drawFrame(rollY - H);
    cx.fillStyle = 'rgba(0,0,0,0.85)';
    cx.fillRect(0, rollY - 5, W, 10);
  } else {
    drawFrame(0);
  }

  // горизонтальные разрывы кадра
  m.bands = m.bands.filter((b) => (b.ttl -= dtMs) > 0);
  const target = 10 + level * 8 + (m.roll ? 4 : 0);
  for (let k = 0; k < 3 && m.bands.length < target; k++) {
    if (Math.random() < 0.6) m.bands.push(mfxBand(W, H, level));
  }
  for (const b of m.bands) {
    const y = Math.round(b.y), h = Math.max(1, Math.round(b.h)), wrap = b.off - Math.sign(b.off) * W;
    if (b.type === 'smear') {
      // одна строка растянута вниз: «залипшая» развёртка
      const sy = Math.min(H - 1, Math.round(b.sy));
      cx.drawImage(tex, 0, sy, W, 1, b.off, y, W, h);
      cx.drawImage(tex, 0, sy, W, 1, wrap, y, W, h);
    } else if (b.type === 'swap') {
      const sy = Math.min(H - h, Math.round(b.sy));
      cx.drawImage(tex, 0, sy, W, h, b.off, y, W, h);
      cx.drawImage(tex, 0, sy, W, h, wrap, y, W, h);
    } else {
      cx.drawImage(tex, 0, y, W, h, b.off, y, W, h);
      cx.drawImage(tex, 0, y, W, h, wrap, y, W, h);
      if (b.type === 'ghost') {
        cx.globalCompositeOperation = 'lighter'; cx.globalAlpha = 0.45;
        cx.drawImage(tex, 0, y, W, h, b.off + b.ghost, y, W, h);
        cx.globalCompositeOperation = 'source-over'; cx.globalAlpha = 1;
      }
    }
  }

  // яркие и тёмные блоки «битой» картинки
  m.slabs = m.slabs.filter((s) => (s.ttl -= dtMs) > 0);
  if (m.slabs.length < 14 && Math.random() < (level ? 0.95 : 0.55)) m.slabs.push(mfxSlab(W, H, level));
  for (const s of m.slabs) {
    cx.fillStyle = s.color;
    cx.fillRect(Math.round(s.x), Math.round(s.y), Math.round(s.w), Math.max(1, Math.round(s.h)));
    cx.fillStyle = s.kind === 'dark' ? '#5c8f7d' : '#0a1a15';
    for (const [dx, dy] of s.dots) cx.fillRect(Math.round(s.x) + dx, Math.round(s.y) + dy, 2, 2);
  }

  // красные и голубые обрывки сигнала (раньше они рисовались на весь экран)
  if (level) {
    const n = level === 2 ? 12 : 4;
    for (let k = 0; k < n; k++) {
      const bw = rand(8, level === 2 ? 90 : 40);
      cx.fillStyle = Math.random() < 0.6 ? 'rgba(221,40,40,0.9)' : 'rgba(60,240,255,0.65)';
      cx.fillRect(Math.round(rand(0, W - bw)), Math.round(rand(0, H)), Math.round(bw), Math.random() < 0.5 ? 1 : 2);
    }
    if (level === 2) {
      cx.fillStyle = 'rgba(240,255,244,0.9)';
      for (let k = 0; k < 3; k++) {
        const len = rand(40, W * 0.7);
        cx.fillRect(Math.round(rand(0, W - len)), Math.round(rand(0, H)), Math.round(len), 1);
      }
    }
  }

  // зерно
  const nd = m.noiseImg.data;
  for (let i = 0; i < nd.length; i += 4) {
    const v = Math.random() * 255;
    nd[i] = v * 0.7; nd[i + 1] = v; nd[i + 2] = v * 0.85; nd[i + 3] = 255;
  }
  m.noiseCx.putImageData(m.noiseImg, 0, 0);
  cx.imageSmoothingEnabled = false;
  cx.globalCompositeOperation = 'lighter';
  cx.globalAlpha = level === 2 ? 0.65 : level === 1 ? 0.45 : 0.28;
  cx.drawImage(m.noise, 0, 0, W, H);
  cx.imageSmoothingEnabled = true;

  // на большом всплеске иногда вспыхивает весь экран монитора
  if (level === 2 && Math.random() < 0.1) {
    cx.globalAlpha = 0.45; cx.fillStyle = '#d8fff0'; cx.fillRect(0, 0, W, H);
  }

  // медленная светлая полоса развёртки
  const by = ((fx.t / 1000) * 0.11 % 1.5 - 0.25) * H;
  const g = cx.createLinearGradient(0, by - 22, 0, by + 22);
  g.addColorStop(0, 'rgba(200,255,230,0)'); g.addColorStop(0.5, 'rgba(200,255,230,0.1)'); g.addColorStop(1, 'rgba(200,255,230,0)');
  cx.globalAlpha = 1; cx.fillStyle = g; cx.fillRect(0, by - 22, W, 44);
  cx.globalCompositeOperation = 'source-over';

  // провал яркости (на «drop» экран мигает почти до чёрного), строки развёртки, виньетка, мягкий край стекла
  m.flick = m.evType === 'drop' && big ? (Math.random() < 0.75 ? 0.88 : 0.35) : (Math.random() < 0.07 ? rand(0.15, 0.4) : 0);
  if (m.flick) { cx.fillStyle = `rgba(0,0,0,${m.flick})`; cx.fillRect(0, 0, W, H); }
  cx.drawImage(m.lines, 0, 0);
  cx.globalCompositeOperation = 'destination-in';
  cx.drawImage(m.mask, 0, 0);
  cx.globalCompositeOperation = 'source-over';

  if (els.menuGlow) els.menuGlow.style.opacity = String(Math.min(1, Math.max(0.15, 0.62 * (1 - m.flick * 0.9) + (level ? 0.18 : 0))));
}

// --- статика на весь экран: только лёгкое зерно и редкая строка, агрессивные помехи живут на мониторе ---
function mfxDrawStatic(fx) {
  const s = fx.stat;
  if (!s) return;
  const { w, h, u32 } = s;
  const calm = fx.reduced;
  const base = calm ? 0.03 : 0.055;
  const tear = new Set();                                  // 0–1 рваная строка
  if (!calm && Math.random() < 0.5) tear.add((Math.random() * h) | 0);
  let i = 0;
  for (let y = 0; y < h; y++) {
    const bd = (y / h - fx.bandPos) / 0.12;
    let k = fx.bandActive ? 1 + 0.8 * Math.exp(-bd * bd) : 1;   // бегущая светлая полоса
    if (!calm && Math.random() < 0.006) k *= 1.8;
    const torn = tear.has(y);
    if (torn) k *= 1.8;
    const a = Math.min(255, (base * k * 255) | 0);
    const lo = torn ? 150 : 70;
    const span = torn ? 105 : 170;
    for (let x = 0; x < w; x++) {
      const v = lo + ((Math.random() * span) | 0);
      u32[i++] = (a << 24) | (v << 16) | (v << 8) | v;
    }
  }
  s.cx.putImageData(s.img, 0, 0);
}

function mfxResizeStatic(fx, W, H) {
  const w = MENU_STATIC_W, h = Math.max(1, Math.round(w * H / W));
  const cv = els.menuStatic;
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  const img = cx.createImageData(w, h);
  fx.stat = { w, h, cx, img, u32: new Uint32Array(img.data.buffer) };
}

// Общий планировщик событий: всплеск помех, срыв кадра, провал яркости монитора.
function mfxFrame(ts) {
  const fx = els.menuFx;
  if (!fx) return;
  fx.raf = requestAnimationFrame(mfxFrame);
  const dtMs = Math.min(100, ts - fx.last);
  fx.last = ts;
  const visible = els.menu && !els.menu.hidden && !els.menu.classList.contains('is-pause-settings') && els.menuScale && fx.stat;
  if (!visible) return;
  fx.t = ts;

  if (fx.reduced) {   // «уменьшить движение»: один статичный кадр
    if (!fx.staticDone) {
      mfxDrawSmoke(fx, 4000); mfxDrawEmbers(fx, 0, 0); mfxDrawStatic(fx);
      fx.staticDone = true;
    }
    return;
  }

  // дым ~16 к/с: он медленный, больше не нужно
  fx.smokeAcc += dtMs;
  if (fx.smokeAcc >= 62) { fx.smokeAcc = 0; mfxDrawSmoke(fx, ts); }
  mfxDrawEmbers(fx, dtMs / 1000, ts);

  // монитор, статика и мерцание ~20 к/с, как грубая развёртка телевизора
  fx.tickAcc += dtMs;
  if (fx.tickAcc < 50) return;
  const tickMs = fx.tickAcc;
  fx.tickAcc = 0;

  if (!fx.bandActive && ts >= fx.nextBand) { fx.bandActive = true; fx.bandPos = -0.15; fx.bandSpeed = rand(0.14, 0.3); }
  if (fx.bandActive) {
    fx.bandPos += fx.bandSpeed * tickMs / 1000;
    if (fx.bandPos > 1.2) { fx.bandActive = false; fx.nextBand = ts + rand(3500, 8000); }
  }

  mfxTickMonitor(fx, tickMs);   // всплески, срывы и дрожь только на мониторе
  fx.statAcc += tickMs;
  if (fx.statAcc >= 60) { fx.statAcc = 0; mfxDrawStatic(fx); }

  // едва заметное мерцание кадра, без дрожи всей картинки
  const fl = Math.random() < 0.03 ? rand(0.03, 0.08) : 0;
  if (fl !== fx.flickLevel) { fx.flickLevel = fl; els.menuFlicker.style.opacity = String(fl); }
}

function mfxStart() {
  const art = els.menuArt;
  const now = performance.now();
  const fx = {
    reduced: REDUCE, raf: 0, last: now, t: 0, smokeAcc: 0, tickAcc: 0,
    statAcc: 0,
    nextBand: now + 2500, bandActive: false, bandPos: -1, bandSpeed: 0.3,
    flickLevel: 0, staticDone: false,
  };
  els.menuFx = fx;

  const [sw, sh] = MENU_SMOKE;
  const [sc, scx] = makeCanvas(sw, sh);
  sc.className = 'menu-smoke';
  art.appendChild(sc);
  fx.smoke = { c: sc, cx: scx, w: sw, h: sh, img: scx.createImageData(sw, sh), tile: mfxNoiseTile() };

  mfxInitMonitor(fx, art);
  els.menuGlow = el('div', 'menu-glow', art);
  mfxInitEmbers(fx);
  fx.embCtx = els.menuEmbers.getContext('2d');

  const img = els.menuImage;
  const build = () => mfxBuildTex(fx, img);
  if (img.complete && img.naturalWidth) build(); else img.addEventListener('load', build, { once: true });

  layoutMenuArt();
  fx.raf = requestAnimationFrame(mfxFrame);
}

function mfxStop() {
  if (els.menuFx) cancelAnimationFrame(els.menuFx.raf);
  els.menuFx = null;
}

// ---------- меню паузы: глитчи и помехи ----------
// Пока игра на паузе, tick не идёт, поэтому у эффекта свой rAF (как у mfxFrame). Стиль ИИ: красный, цифровой, агрессивный.
// Холст маленький и растянут на весь экран; текст глитчей рисует HTML-слой (els.pauseCode), а не холст.
const PAUSE_FX_W = 220;
const PAUSE_FX_TICK_MS = 45;     // ~22 к/с

function pauseFxStart() {
  const now = performance.now();
  els.pauseFx = {
    raf: 0, last: now, acc: 0, cw: 0, ch: 0, w: 0, h: 0, cx: null, img: null, u32: null, done: false,
    nextEvent: now + 1500, until: 0, type: 'burst', microAt: now + 600, microUntil: 0,
    nextBand: now + 1200, bandActive: false, bandPos: -1, bandSpeed: 0.3, codeUntil: 0,
  };
  els.pauseFx.raf = requestAnimationFrame(pauseFxFrame);
}

function pauseFxStop() {
  if (els.pauseFx) cancelAnimationFrame(els.pauseFx.raf);
  els.pauseFx = null;
}

function pauseFxResize(fx) {
  const W = els.pauseScreen.clientWidth, H = els.pauseScreen.clientHeight;
  if (!W || !H) return false;
  if (W === fx.cw && H === fx.ch) return true;
  fx.cw = W; fx.ch = H;
  const w = PAUSE_FX_W, h = Math.max(1, Math.round(w * H / W));
  const cv = els.pauseStatic;
  cv.width = w; cv.height = h;
  fx.cx = cv.getContext('2d');
  fx.img = fx.cx.createImageData(w, h);
  fx.u32 = new Uint32Array(fx.img.data.buffer);
  fx.w = w; fx.h = h; fx.done = false;
  return true;
}

function pauseFxDraw(fx, burst, ts) {
  const { w, h, u32 } = fx;
  const calm = REDUCE;
  const drop = burst && fx.type === 'drop' && ts < fx.until;
  const base = calm ? 0.04 : 0.06 + (burst ? 0.06 : 0);
  // красноватое зерно: канал R всегда сильнее G и B
  const tear = new Set();
  if (!calm) {
    const n = burst ? 1 + ((Math.random() * 3) | 0) : (Math.random() < 0.3 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const y0 = (Math.random() * h) | 0;
      const th = 1 + ((Math.random() * (burst ? 2 : 1)) | 0);
      for (let d = 0; d < th; d++) tear.add(Math.min(h - 1, y0 + d));
    }
  }
  let i = 0;
  for (let y = 0; y < h; y++) {
    const bd = (y / h - fx.bandPos) / 0.1;
    let k = fx.bandActive ? 1 + 1.0 * Math.exp(-bd * bd) : 1;
    const torn = tear.has(y);
    if (torn) k *= 1.8;
    const a = Math.min(255, (base * k * 255) | 0);
    for (let x = 0; x < w; x++) {
      const v = (torn ? 130 : 60) + ((Math.random() * (torn ? 125 : 170)) | 0);
      const g = (v * (torn ? 0.5 : 0.38)) | 0;
      u32[i++] = (a << 24) | (g << 16) | (g << 8) | v;   // ABGR: красный = младший байт
    }
  }
  if (!calm) {
    // «битые» блоки: красные и чёрные обрывки кадра
    const blocks = burst ? 3 : 0;
    for (let b = 0; b < blocks; b++) {
      if (!burst && Math.random() < 0.6) continue;
      const y = (Math.random() * h) | 0;
      const bw = 8 + ((Math.random() * 30) | 0);
      const x0 = (Math.random() * (w - bw)) | 0;
      const rows = 1;
      const color = Math.random() < 0.55 ? 0xd01818ff : 0xe6000000;
      for (let r = 0; r < rows && y + r < h; r++) {
        const row = (y + r) * w + x0;
        for (let x = 0; x < bw; x++) u32[row + x] = color;
      }
    }
  }
  if (drop) {
    // провал кадра: всё на миг темнеет
    for (let p = 0; p < u32.length; p++) if (((u32[p] >>> 24) & 255) < 190) u32[p] = 0x78000000 | (u32[p] & 0xff);
  }
  fx.cx.putImageData(fx.img, 0, 0);
}

function pauseFxFrame(ts) {
  const fx = els.pauseFx;
  if (!fx) return;
  fx.raf = requestAnimationFrame(pauseFxFrame);
  const dt = Math.min(100, ts - fx.last);
  fx.last = ts;
  const screen = els.pauseScreen;
  if (!screen || screen.hidden || !pauseFxResize(fx)) return;

  if (REDUCE) {   // «уменьшить движение»: один спокойный кадр, без дрожи
    if (!fx.done) { pauseFxDraw(fx, false, ts); fx.done = true; }
    return;
  }

  if (ts >= fx.nextEvent) {
    const r = Math.random();
    fx.type = r < 0.15 ? 'drop' : 'burst';
    fx.until = ts + rand(200, 450);
    fx.nextEvent = ts + rand(5000, 10000);
    fx.codeUntil = ts + rand(250, 500);
    fx.codeShown = false;
  } else if (ts >= fx.microAt) {
    fx.microUntil = ts + rand(60, 140);
    fx.microAt = ts + rand(2500, 6000);
  }
  const burst = ts < fx.until || ts < fx.microUntil;

  fx.acc += dt;
  if (fx.acc < PAUSE_FX_TICK_MS) return;
  const tickMs = fx.acc;
  fx.acc = 0;

  if (!fx.bandActive && ts >= fx.nextBand) { fx.bandActive = true; fx.bandPos = -0.15; fx.bandSpeed = rand(0.18, 0.32); }
  if (fx.bandActive) {
    fx.bandPos += fx.bandSpeed * tickMs / 1000;
    if (fx.bandPos > 1.2) { fx.bandActive = false; fx.nextBand = ts + rand(3500, 8000); }
  }
  pauseFxDraw(fx, burst, ts);

  // панель дрожит и «срывается» на всплесках; заголовок расслаивается
  const big = ts < fx.until;
  if (big) {
    const amp = 1.5;
    els.pausePanel.style.transform = `translate(${rand(-amp, amp).toFixed(1)}px, 0)`;
  } else if (els.pausePanel.style.transform) {
    els.pausePanel.style.transform = '';
  }
  els.pauseTitle.classList.toggle('is-glitch', big);

  // обрывок служебного кода в случайном месте экрана
  const codeOn = ts < fx.codeUntil;
  if (codeOn && !fx.codeShown) {
    fx.codeShown = true;
    els.pauseCode.style.left = `${rand(4, 70).toFixed(0)}%`;
    els.pauseCode.style.top = `${rand(6, 90).toFixed(0)}%`;
  }
  els.pauseCode.style.opacity = codeOn ? String(rand(0.3, 0.6).toFixed(2)) : '0';
}

function layoutMenuArt() {
  const bd = els.menuBackdrop, art = els.menuArt, fx = els.menuFx;
  if (!bd || !art) return;
  const W = bd.clientWidth, H = bd.clientHeight;
  if (!W || !H) return;
  const s = Math.max(W / MENU_ART.w, H / MENU_ART.h);
  const ox = (W - MENU_ART.w * s) / 2, oy = (H - MENU_ART.h * s) / 2;
  art.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
  els.menuScale = { s, ox, oy, W, H };
  if (!fx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cv = els.menuEmbers;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  fx.embCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mfxResizeStatic(fx, W, H);
  fx.staticDone = false;
}

const DIGIT_SEGMENTS = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  A: 'abcefg', M: 'abcefm',   // m: добавочный центральный сегмент, нужен для буквы M
};

// Шесть точек сегмента в локальных координатах (y вверх) -> строка для SVG (y вниз).
function segmentPoints() {
  const { w, h, t, gap: g } = CLOCK;
  const c = t / 2;
  const L = c, R = w - c, B = c, M = h / 2, T = h - c;
  const horiz = (y) => [
    [L + c + g, y], [L + 2 * c + g, y + c], [R - 2 * c - g, y + c],
    [R - c - g, y], [R - 2 * c - g, y - c], [L + 2 * c + g, y - c],
  ];
  const vert = (x, ya, yb) => [
    [x, yb - c - g], [x + c, yb - 2 * c - g], [x + c, ya + 2 * c + g],
    [x, ya + c + g], [x - c, ya + 2 * c + g], [x - c, yb - 2 * c - g],
  ];
  const str = (pts) => pts.map(([x, y]) => `${x.toFixed(2)},${(-y).toFixed(2)}`).join(' ');
  return {
    a: str(horiz(T)), g: str(horiz(M)), d: str(horiz(B)),
    f: str(vert(L, M, T)), b: str(vert(R, M, T)),
    e: str(vert(L, B, M)), c: str(vert(R, B, M)),
    m: str(vert((L + R) / 2, M, T)),
  };
}

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function buildClock(parent) {
  const svg = svgEl('svg', { viewBox: '0 0 1672 941', preserveAspectRatio: 'none', class: 'clock-svg' }, parent);

  const defs = svgEl('defs', {}, svg);
  const filter = svgEl('filter', { id: 'clock-glow', x: '-20%', y: '-40%', width: '140%', height: '180%' }, defs);
  svgEl('feGaussianBlur', { stdDeviation: '1.8', result: 'blur' }, filter);
  const merge = svgEl('feMerge', {}, filter);
  svgEl('feMergeNode', { in: 'blur' }, merge);
  svgEl('feMergeNode', { in: 'SourceGraphic' }, merge);

  const root = svgEl('g', { filter: 'url(#clock-glow)' }, svg);
  const pts = segmentPoints();
  const { rotate, skew } = CLOCK;
  const cells = CLOCK.cells.map(([x, y]) => {
    const g = svgEl('g', { transform: `translate(${x} ${y}) rotate(${rotate}) skewX(${-skew})` }, root);
    const segs = {};
    for (const key of 'abcdefgm') segs[key] = svgEl('polygon', { class: 'seg', points: pts[key] }, g);
    return segs;
  });

  const [cx, cy] = CLOCK.colon;
  const cg = svgEl('g', { transform: `translate(${cx} ${cy}) rotate(${rotate}) skewX(${-skew})` }, root);
  const { h, t } = CLOCK;
  for (const k of [0.30, 0.68]) {
    svgEl('rect', { class: 'seg', x: 0, y: -(h * k + t / 2), width: t, height: t }, cg);
  }
  return { cells, colon: cg };
}

// Лицо часов Sony: «12AM», « 1AM» … « 6AM». Минут и двоеточия нет.
// На время глюка (ночь 5, 3:33) загораются минуты: « 3:33».
export function clockFace(timeSec, glitch = false) {
  if (glitch) return { chars: [' ', '3', '3', '3'], colon: true };
  const hour = Math.min(6, Math.floor(timeSec / 60));
  const s = String(hour === 0 ? 12 : hour).padStart(2, ' ');
  return { chars: [s[0], s[1], 'A', 'M'], colon: false };
}

// ---------- модуль ----------
let root = null;
let offs = [];
let els = {};
let shownText = '';
let menuAudioUnlocked = false;
let pauseMusic = null;
let tokensDashTtl = 0;

window.addEventListener('kontorka:disclaimer-accepted', () => {
  menuAudioUnlocked = true;
  if (!els.menu) return;
  startMenuMusic();
});

function el(tag, className, parent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (parent) parent.appendChild(e);
  return e;
}

function renderClock(state) {
  const base = els.morningWait ? 359 : state.time;   // утро: пока тишина, часы стоят на 5 AM
  const displayTime = els.clockBack > 0 ? Math.max(0, base - 60) : base;
  const face = clockFace(displayTime, els.clockGlitch > 0);
  const key = face.chars.join('') + (face.colon ? ':' : '');
  if (key === shownText) return;
  shownText = key;
  face.chars.forEach((ch, i) => {
    const lit = DIGIT_SEGMENTS[ch] || '';
    for (const k of 'abcdefgm') {
      els.cells[i][k].setAttribute('visibility', lit.includes(k) ? 'visible' : 'hidden');
    }
  });
  els.colon.setAttribute('visibility', face.colon ? 'visible' : 'hidden');
}

// Напряжение сцены 0..1: растёт к утру и при перегрузке сети. Только оформление (виньетка).
function updateTension(state) {
  const raw = state.running ? Math.min(1, (state.time / 360) * 0.7 + (state.load >= 5 ? 0.3 : 0)) : 0;
  const v = Math.round(raw * 50) / 50;
  if (v === els.tension) return;
  els.tension = v;
  els.stage.style.setProperty('--tension', String(v));
}

// Слои атмосферы. Всё в процентах сцены, поверх фото ничего не запекается.
function buildFxBelow(stage) {
  el('div', 'fx fx-grade', stage);
  el('div', 'fx fx-dawn', stage);                         // утро: холодный серо-голубой рассвет (класс is-dawn на сцене)
  const win = el('div', 'fx fx-window', stage);          // свет с улицы сквозь жалюзи
  els.fxWindow = win;
  el('div', 'fx-window__pass', win);                      // тень «проходит» за окном
  els.fxSpill = el('div', 'fx fx-spill', stage);          // свет мониторов на клавиатуре
  el('div', 'fx fx-vignette', stage);
}

function buildFxAbove(stage) {
  el('div', 'fx fx-led', stage);                          // индикатор веб-камеры сам горит красным
  el('div', 'fx fx-grain', stage);
}

// ---------- мерцание ----------
// На фото нет ламп, поэтому мерцают только реальные источники света:
// фонарь за окном (всегда, редко) и свет мониторов (только при перегрузке сети).
// Серия коротких импульсов с резкими краями. lvl: 1 = норма, меньше = темнее.
const rand = (a, b) => a + Math.random() * (b - a);
const REDUCE = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function makeFlicker(node, waitFn, planFn) {
  let wait = waitFn();
  let seq = [];
  let acc = 0;
  return (dt, enabled = true) => {
    if (REDUCE || !enabled) {
      if (seq.length) { seq = []; node.style.filter = ''; }
      return;
    }
    if (seq.length) {
      acc += dt;
      while (seq.length && acc >= seq[0].dur) { acc -= seq[0].dur; seq.shift(); }
      node.style.filter = seq.length ? `brightness(${seq[0].lvl.toFixed(2)})` : '';
      if (!seq.length) wait = waitFn();
    } else {
      wait -= dt;
      if (wait <= 0) { seq = planFn(); acc = 0; }
    }
  };
}

function pulses(n, dip, gap) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ dur: rand(0.03, 0.11), lvl: rand(dip[0], dip[1]) });
    if (i < n - 1) out.push({ dur: rand(gap[0], gap[1]), lvl: rand(0.9, 1) });
  }
  return out;
}

// ---------- отключение при 0% токенов ----------
// Ошибки на мониторах -> глюки -> экран гаснет -> попытка перезагрузки -> не включается. Игрок в темноте.
// Только оформление: длительности фаз считаются из tick, игровой логики здесь нет.
const SHUTDOWN_PHASES = [['error', 3], ['glitch', 2], ['off', 1.5], ['boot', 3.5], ['fail', 2], ['dead', Infinity]];
const SHUTDOWN_DELAY = { left: 0, right: 0.7 };   // правый монитор отстаёт: так живее
const BOOT_STALL_PCT = 72;                         // на каком проценте загрузка «зависает»

function buildShutdown(t) {
  const mons = [];
  for (const [side, node] of [['left', els.monLeft], ['right', els.monRight]]) {
    const root = el('div', 'sd', node);
    root.hidden = true;
    const err = el('div', 'sd-err', root);
    el('div', 'sd-err__title', err).textContent = t(`shutdown.${side}.title`);
    el('div', 'sd-err__text', err).textContent = t(`shutdown.${side}.text`);
    el('div', 'sd-err__code', err).textContent = t('shutdown.code');
    el('div', 'sd-line', root);
    const boot = el('div', 'sd-boot', root);
    el('div', 'sd-boot__title', boot).textContent = t('shutdown.boot');
    const fill = el('i', '', el('div', 'sd-bar', boot));
    el('div', 'sd-boot__fail', boot).textContent = t('shutdown.fail');
    mons.push({ root, node, fill, delay: SHUTDOWN_DELAY[side], phase: null });
  }
  return { mons, t: -1 };
}

function startShutdown() {
  if (els.sd.t < 0) els.sd.t = 0;
}

function resetShutdown() {
  const sd = els.sd;
  if (!sd) return;
  sd.t = -1;
  for (const m of sd.mons) {
    m.phase = null;
    m.root.hidden = true;
    m.root.dataset.phase = '';
    m.node.classList.remove('is-dead');
    m.fill.style.width = '0%';
  }
  els.stage.classList.remove('is-dark');
}

function updateShutdown(dt) {
  const sd = els.sd;
  if (!sd || sd.t < 0) return;
  sd.t += dt;
  for (const m of sd.mons) {
    const local = sd.t - m.delay;
    let phase = null;
    let at = 0;
    if (local >= 0) {
      let rest = local;
      for (const [name, dur] of SHUTDOWN_PHASES) {
        if (rest < dur) { phase = name; at = rest; break; }
        rest -= dur;
      }
    }
    if (phase !== m.phase) {
      m.phase = phase;
      m.root.hidden = phase === null;
      m.root.dataset.phase = phase || '';
      m.node.classList.toggle('is-dead', phase === 'off' || phase === 'dead');
    }
    if (phase === 'boot') {
      // загрузка идёт рывками и застревает
      const pct = BOOT_STALL_PCT * Math.min(1, at / 3.2);
      m.fill.style.width = `${Math.floor(pct / 6) * 6}%`;
    }
  }
  els.stage.classList.toggle('is-dark', sd.mons[0].phase === 'dead');
}

// ---------- скример ----------
// Только оформление: фазы считаются из tick. Игровую сторону (конец смены) решает main.js.
// Рисуется на canvas: спрайт scream.webp не показывается прямоугольником, а подготавливается (мягкие края,
// красная и голубая копии для сдвига каналов) и «вылетает» из темноты прямо в лицо игроку.
// Хронология: белая вспышка -> рывок вперёд (с перелётом) -> тряска, строб, глитч-полосы, сдвиг каналов,
// медленный наезд -> финальный удар (резкий наезд + красный экран) -> обрыв в чёрный, статика, пауза -> «Смена провалена».
// Звук: audio.play('jumpscare') без позиции (в голове игрока).
const SCARE_FLASH = 0.06;    // секунды
const SCARE_LUNGE = 0.22;
const SCARE_HOLD = 1.7;
const SCARE_SNAP = 0.16;     // последние секунды HOLD: финальный удар
const SCARE_BLACK = 0.8;
const SCARE_HOLD_AT = SCARE_FLASH + SCARE_LUNGE;
const SCARE_CUT_AT = SCARE_HOLD_AT + SCARE_HOLD;
const SCARE_END = SCARE_CUT_AT + SCARE_BLACK;
const SCARE_FACE = { x: 0.37, y: 0.27 };   // где на спрайте лицо (доли ширины и высоты)
const SCARE_SPRITES = new Map();           // enemyId -> { img, spr, red, cyan }

const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; };

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

// Мягкие края (низ вырезан ровно, голова и рука упираются в край файла), красная и голубая копии.
function prepSprite(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const [base, b] = makeCanvas(w, h);
  b.drawImage(img, 0, 0);
  b.globalCompositeOperation = 'destination-out';
  const fade = (x0, y0, x1, y1, rect) => {
    const g = b.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    b.fillStyle = g;
    b.fillRect(...rect);
  };
  fade(0, h * 0.72, 0, h, [0, h * 0.72, w, h * 0.28]);        // низ: растворяется в темноте
  fade(w * 0.03, 0, 0, 0, [0, 0, w * 0.03, h]);               // левый край
  fade(w * 0.95, 0, w, 0, [w * 0.95, 0, w * 0.05, h]);        // правый край
  fade(0, h * 0.02, 0, 0, [0, 0, w, h * 0.02]);               // верх
  const tint = (color) => {
    const [c, g] = makeCanvas(w, h);
    g.drawImage(base, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(base, 0, 0);
    return c;
  };
  return { spr: base, red: tint('#ff2020'), cyan: tint('#20ffff'), w, h };
}

function loadScareSprite(enemyId) {
  let rec = SCARE_SPRITES.get(enemyId);
  if (rec) return rec;
  rec = { ready: false };
  SCARE_SPRITES.set(enemyId, rec);
  const img = new Image();
  img.onload = () => Object.assign(rec, prepSprite(img), { ready: true });
  img.onerror = () => console.warn(`scare: нет кадра assets/img/enemies/${enemyId}/scream.webp`);
  img.src = `assets/img/enemies/${enemyId}/scream.webp`;
  return rec;
}

function buildScare(parent) {
  const rootEl = el('div', 'scare', parent);
  rootEl.hidden = true;
  const cv = el('canvas', 'scare-cv', rootEl);
  const noise = el('canvas', 'scare-noise', rootEl);
  noise.width = 128; noise.height = 72;
  const ng = noise.getContext('2d');
  el('div', 'scare-tint', rootEl);
  loadScareSprite('mr404');   // заранее, чтобы кадр не грузился в момент атаки
  return { root: rootEl, cv, g: cv.getContext('2d'), noise, ng, nImg: ng.createImageData(128, 72),
    t: -1, enemyId: null, glitch: 0 };
}

function startScare(enemyId) {
  const sc = els.scare;
  if (!sc || sc.t >= 0) return;
  sc.enemyId = enemyId;
  loadScareSprite(enemyId);
  sc.t = 0;
  sc.glitch = 0;
  sc.root.hidden = false;
  sc.root.dataset.phase = 'flash';
  audio.play?.('jumpscare');
  if (!REDUCE) navigator.vibrate?.([70, 30, 110, 30, 260]);
}

function resetScare() {
  const sc = els.scare;
  if (!sc) return;
  sc.t = -1;
  sc.root.hidden = true;
  sc.root.dataset.phase = '';
  sc.noise.style.opacity = 0;
}

function drawScareNoise(sc, opacity) {
  sc.noise.style.opacity = opacity;
  if (opacity <= 0) return;
  const d = sc.nImg.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  sc.ng.putImageData(sc.nImg, 0, 0);
}

function drawScare(sc, dt) {
  const cv = sc.cv, g = sc.g;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const W = Math.max(2, Math.round(cv.clientWidth * dpr));
  const H = Math.max(2, Math.round(cv.clientHeight * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  const t = sc.t;

  // 1. белая вспышка (при «уменьшить движение» чёрная)
  if (t < SCARE_FLASH) {
    g.fillStyle = REDUCE ? '#000' : '#fff';
    g.fillRect(0, 0, W, H);
    drawScareNoise(sc, 0);
    return;
  }
  // 4. обрыв в чёрный: короткая статика, потом тишина
  if (t >= SCARE_CUT_AT) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    drawScareNoise(sc, REDUCE || t > SCARE_CUT_AT + 0.14 ? 0 : 0.7);
    return;
  }

  const inLunge = t < SCARE_HOLD_AT;
  const snapQ = Math.max(0, (t - (SCARE_CUT_AT - SCARE_SNAP)) / SCARE_SNAP);   // 0..1 в финальном ударе
  let s, lift, shake;
  if (inLunge) {
    const x = (t - SCARE_FLASH) / SCARE_LUNGE;
    const e = REDUCE ? x : easeOutBack(x);
    s = 0.5 + 0.5 * e;
    lift = (1 - Math.min(1, e)) * 0.22;      // вылетает снизу
    shake = REDUCE ? 0 : 0.02 * (1 - x) + 0.008;
  } else {
    const k = (t - SCARE_HOLD_AT) / SCARE_HOLD;
    s = 1 + 0.2 * k;
    lift = 0;
    shake = REDUCE ? 0 : 0.008 + 0.012 * k;
  }
  if (snapQ > 0) { s *= 1 + 0.6 * snapQ * snapQ; if (!REDUCE) shake += 0.045 * snapQ; }

  // глитч-всплески и строб (только в удержании)
  let burst = false, dark = false, lightning = false;
  if (!REDUCE && !inLunge) {
    sc.glitch -= dt;
    if (sc.glitch <= 0 && Math.random() < dt * 4) sc.glitch = rand(0.05, 0.16);
    burst = sc.glitch > 0 || snapQ > 0;
    const r = Math.random();
    dark = r < 0.08;
    lightning = r > 0.95;
  }

  // фон: красное зарево за фигурой, пульсирует
  const fx = W * 0.5, fy = H * 0.4;
  const pulse = 0.5 + 0.5 * Math.sin(t * 38);
  const glow = Math.min(1, (0.3 + 0.25 * pulse + 0.3 * snapQ) * (lightning ? 2.2 : 1));
  const bg = g.createRadialGradient(fx, fy, 0, fx, fy, H * 0.95);
  bg.addColorStop(0, `rgba(160,10,10,${glow})`);
  bg.addColorStop(1, 'rgb(0,0,0)');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  // фигура
  const rec = SCARE_SPRITES.get(sc.enemyId);
  if (rec?.ready) {
    const base = Math.max(1.25 * H / rec.h, 1.05 * W / rec.w);
    const jx = rand(-1, 1) * shake * H, jy = rand(-1, 1) * shake * H;
    const rot = REDUCE ? 0 : rand(-1, 1) * shake * 1.3;
    const px = fx + jx, py = H * (0.4 + lift) + jy;
    const place = (img, dx, dy, alpha, comp) => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = comp;
      g.globalAlpha = alpha;
      g.translate(px + dx, py + dy);
      g.rotate(rot);
      g.scale(base * s, base * s);
      g.translate(-SCARE_FACE.x * rec.w, -SCARE_FACE.y * rec.h);
      g.drawImage(img, 0, 0);
    };
    place(rec.spr, 0, 0, dark ? 0.2 : 1, 'source-over');
    if (burst) {   // сдвиг цветовых каналов
      const d = W * (0.006 + 0.012 * Math.random());
      place(rec.red, d, rand(-2, 2), 0.5, 'lighter');
      place(rec.cyan, -d, rand(-2, 2), 0.5, 'lighter');
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    if (burst) {   // горизонтальные полосы, сдвинутые в сторону
      const n = 3 + ((Math.random() * 4) | 0);
      for (let i = 0; i < n; i++) {
        const y = rand(0, H * 0.9), bh = rand(H * 0.02, H * 0.12), off = rand(-0.08, 0.08) * W;
        g.drawImage(cv, 0, y, W, bh, off, y, W, bh);
      }
    }
  }

  // виньетка темнеет и краснеет к финалу
  const vg = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, `rgba(40,0,0,${0.6 + 0.35 * snapQ})`);
  g.fillStyle = vg;
  g.fillRect(0, 0, W, H);
  if (snapQ > 0) {
    g.fillStyle = `rgba(210,0,0,${0.35 * snapQ})`;
    g.fillRect(0, 0, W, H);
  }

  drawScareNoise(sc, REDUCE ? 0 : 0.1 + (burst ? 0.2 : 0) + 0.4 * snapQ);
}

function updateScare(dt, ctx) {
  const sc = els.scare;
  if (!sc || sc.t < 0) return;
  sc.t += dt;
  if (sc.t >= SCARE_END) {
    resetScare();
    showShiftFailed(ctx, sc.enemyId);
    return;
  }
  sc.root.dataset.phase = sc.t < SCARE_FLASH ? 'flash' : sc.t < SCARE_CUT_AT ? 'show' : 'black';
  drawScare(sc, dt);
}

// ---------- музыка главного меню ----------
// Браузер разрешает звук после подтверждения дисклеймера или касания на меню.
// Играет через audio.play (петля «в голове»), на старте смены гасится.
function startMenuMusic() {
  if (!menuAudioUnlocked || els.menuMusic || !els.menu || els.menu.hidden
    || els.musicBlocked    // идёт ночь, утро или итог смены: музыка меню только после возврата в меню
    || els.menu.classList.contains('is-pause-settings')) return;
  audio.init();   // создаёт контекст при первом показе меню
  els.menuMusic = audio.play('amb_menu', { loop: true }) || null;
}

function stopMenuMusic() {
  if (els.menuMusic) audio.stop?.(els.menuMusic);
  els.menuMusic = null;
}

function startPauseMusic() {
  if (!menuAudioUnlocked || pauseMusic) return;
  // отдельный трек паузы; если звука нет ни в каталоге, ни среди заглушек, играет музыка меню
  pauseMusic = audio.play('amb_pause', { loop: true, volume: 0.7, allowPaused: true })
    || audio.play('amb_menu', { loop: true, volume: 0.65, allowPaused: true })
    || null;
}

function stopPauseMusic() {
  if (pauseMusic) audio.stop?.(pauseMusic);
  pauseMusic = null;
}

function showStart(titleKey, ctx) {
  els.menuNotice.textContent = titleKey === 'ui.shiftFailed' ? ctx.t(titleKey) : '';
  showMainMenu(ctx);
}

function updatePauseButton() {
  if (els.pauseButton) els.pauseButton.hidden = !els.gameActive || els.paused;
}

// Экран «Смена провалена». После скримера врага с записанной цитатой цитата звучит на этом экране,
// кнопка возврата в меню открывается, когда она договорила (или через запасное время, если звука нет).
const FAILED_QUOTES = { mr404: 'mr404_quote' };
const FAILED_BUTTON_NO_QUOTE_MS = 3500;
const FAILED_BUTTON_AFTER_QUOTE_MS = 1200;
const FAILED_BUTTON_MAX_MS = 25000;
let failedTimer = 0;
let failedQuote = null;

function unlockFailedButton() {
  clearTimeout(failedTimer);
  failedTimer = 0;
  els.failedScreen.classList.add('is-ready');
  els.failedButton.disabled = false;
  els.failedButton.focus?.({ preventScroll: true });
}

function hideShiftFailed() {
  clearTimeout(failedTimer);
  failedTimer = 0;
  if (failedQuote) { audio.stop?.(failedQuote); failedQuote = null; }
  els.failedScreen.hidden = true;
  els.failedScreen.classList.remove('is-ready');
}

function showShiftFailed(ctx, enemyId) {
  els.gameActive = false;
  els.stage.inert = true;
  document.querySelector('.mg-screen')?.setAttribute('inert', '');
  els.menu.hidden = true;
  els.pauseScreen.hidden = true;
  els.failedTitle.textContent = ctx.t('ui.shiftFailed');
  els.failedTitle.dataset.text = ctx.t('ui.shiftFailed');
  els.failedLine.textContent = ctx.t('ui.failed.line');
  els.failedButton.textContent = ctx.t('ui.failed.menu');
  els.failedGhost.style.backgroundImage = enemyId ? `url("assets/img/enemies/${enemyId}/scream.webp")` : '';
  els.failedScreen.classList.remove('is-ready');
  els.failedButton.disabled = true;
  els.failedScreen.hidden = false;
  updatePauseButton();
  clearTimeout(failedTimer);
  if (failedQuote) audio.stop?.(failedQuote);
  const quoteId = FAILED_QUOTES[enemyId];
  const mine = quoteId ? (audio.play?.(quoteId, { volume: 1 }) ?? null) : null;
  failedQuote = mine;
  if (mine) {
    audio.whenFinished(mine).then(() => {
      if (failedQuote !== mine || els.failedScreen.hidden) return;
      clearTimeout(failedTimer);
      failedTimer = setTimeout(unlockFailedButton, FAILED_BUTTON_AFTER_QUOTE_MS);
    });
    failedTimer = setTimeout(unlockFailedButton, FAILED_BUTTON_MAX_MS);   // запас, если запись не договорила
  } else {
    failedTimer = setTimeout(unlockFailedButton, FAILED_BUTTON_NO_QUOTE_MS);
  }
}

function showMainMenu(ctx) {
  els.musicBlocked = false;
  stopPauseMusic();
  audio.setPaused(false);
  els.gameActive = false;
  els.stage.inert = true;
  document.querySelector('.mg-screen')?.setAttribute('inert', '');
  els.menu.style.zIndex = '';
  els.menu.classList.remove('is-pause-settings');
  els.pauseScreen.hidden = true;
  hideShiftFailed();
  els.paused = false;
  els.menu.hidden = false;
  els.settingsPanel.hidden = true;
  els.menuMain.hidden = false;
  updatePauseButton();
  syncMenu(ctx.state, ctx.t);
  startMenuMusic();
}

function showPauseMenu() {
  stopMenuMusic();
  startPauseMusic();
  els.stage.inert = true;
  els.menu.style.zIndex = '';
  els.menu.classList.remove('is-pause-settings');
  els.settingsPanel.hidden = true;
  els.menuMain.hidden = false;
  const minigameScreen = document.querySelector('.mg-screen');
  if (minigameScreen) minigameScreen.inert = true;
  els.menu.hidden = true;
  els.paused = true;
  els.pauseScreen.hidden = false;
  updatePauseButton();
  els.pauseResumeBtn.focus();
}

function showSettings(returnTo) {
  els.settingsReturn = returnTo;
  els.menu.style.zIndex = returnTo === 'pause' ? '41' : '';
  els.menu.classList.toggle('is-pause-settings', returnTo === 'pause');
  els.pauseScreen.hidden = true;
  els.menu.hidden = false;
  els.menuMain.hidden = true;
  els.settingsPanel.hidden = false;
}

function syncMenu(state, t) {
  const pending = state.progress.minigamePending !== null;
  const hasProgress = state.night > 1 || pending || state.progress.gameComplete;
  els.menuDemo.textContent = t('ui.demo');
  els.menuTitle.textContent = t('ui.title');
  els.menuSubtitle.textContent = t('menu.subtitle');
  els.loadBtn.textContent = els.hasSave
    ? t('menu.loadNight', { n: state.night })
    : t('menu.load');
  els.loadBtn.disabled = !els.hasSave;
  els.menuStatus.textContent = state.progress.gameComplete
    ? t(state.flags.ending === 'good' ? 'minigame.ending.good' : 'minigame.ending.bad')
    : hasProgress ? t('ui.continueNight', { n: state.night }) : '';
}

function persistSettings() {
  try {
    localStorage.setItem('kontorka.settings.v1', JSON.stringify(els.settings));
  } catch (e) {
    console.warn('settings: не удалось сохранить настройки', e);
  }
}

export function mount(rootEl, ctx) {
  root = rootEl;
  const { state, t, emit, on } = ctx;

  // Фон-подложка для полей по бокам
  const backdrop = el('img', 'backdrop', root);
  backdrop.src = 'assets/img/desk/desk.webp';
  backdrop.alt = '';
  backdrop.draggable = false;

  // Сцена
  els.stage = el('div', 'stage', root);
  const img = el('img', 'desk-photo', els.stage);
  img.src = 'assets/img/desk/desk.webp';
  img.alt = '';
  img.draggable = false;

  buildFxBelow(els.stage);

  els.monLeft = el('div', 'mon', els.stage);
  els.monLeft.id = 'monitor-left';
  els.monRight = el('div', 'mon', els.stage);
  els.monRight.id = 'monitor-right';
  els.sd = buildShutdown(t);
  els.glitchSilhouette = el('div', 'glitch-silhouette', els.monLeft);
  els.glitchSilhouette.hidden = true;
  el('span', '', els.glitchSilhouette);
  layoutMonitors();
  if (typeof ResizeObserver !== 'undefined') {
    els.resizeObserver = new ResizeObserver(layoutMonitors);
    els.resizeObserver.observe(els.stage);
  } else {
    window.addEventListener('resize', layoutMonitors);
  }

  const clock = buildClock(els.stage);
  els.cells = clock.cells;
  els.colon = clock.colon;
  els.clockGlitch = 0;
  els.clockBack = 0;
  els.silhouetteTime = 0;
  buildFxAbove(els.stage);
  renderClock(state);

  // фонарь за окном: редко и неровно, к утру чаще
  els.flickWin = makeFlicker(els.fxWindow,
    () => rand(8, 35) * (1 - 0.5 * (els.tension || 0)),
    () => pulses(2 + Math.floor(Math.random() * 4), [0.15, 0.6], [0.04, 0.25]));
  // свет мониторов: только при перегрузке сети, часто и коротко
  els.flickSpill = makeFlicker(els.fxSpill,
    () => rand(0.4, 1.8),
    () => pulses(1 + Math.floor(Math.random() * 3), [0.3, 0.7], [0.03, 0.12]));

  els.scare = buildScare(root);

  // Главное меню. Фоновая сцена временная и будет заменена готовым артом.
  els.menu = el('section', 'main-menu', root);
  els.stage.inert = true;
  els.menu.setAttribute('aria-label', t('menu.title'));
  els.menuBackdrop = el('div', 'menu-backdrop', els.menu);
  els.menuShake = el('div', 'menu-shake', els.menuBackdrop);
  els.menuArt = el('div', 'menu-art', els.menuShake);
  els.menuImage = el('img', 'menu-background', els.menuArt);
  els.menuImage.src = 'assets/img/menu/menu_background.jpeg';
  els.menuImage.alt = '';
  els.menuImage.draggable = false;
  els.menuEmbers = el('canvas', 'menu-embers', els.menuShake);
  els.menuStatic = el('canvas', 'menu-static', els.menuBackdrop);
  els.menuFlicker = el('div', 'menu-flicker', els.menuBackdrop);
  for (const n of [els.menuEmbers, els.menuStatic, els.menuFlicker]) n.setAttribute('aria-hidden', 'true');
  layoutMenuArt();
  mfxStart();
  if (typeof ResizeObserver !== 'undefined') {
    els.menuResizeObserver = new ResizeObserver(layoutMenuArt);
    els.menuResizeObserver.observe(els.menuBackdrop);
  } else {
    window.addEventListener('resize', layoutMenuArt);
  }
  els.menu.addEventListener('pointerdown', () => {
    if (els.menu.classList.contains('is-pause-settings')) return;
    menuAudioUnlocked = true;
    audio.init();
    startMenuMusic();
  });
  const menuPanel = el('div', 'menu-panel', els.menu);
  els.hasSave = ctx.hasSave;
  els.menuMain = el('div', 'menu-main', menuPanel);
  els.menuDemo = el('span', 'menu-demo', els.menuMain);
  els.menuTitle = el('h1', 'menu-title', els.menuMain);
  els.menuSubtitle = el('p', 'menu-subtitle', els.menuMain);
  els.menuNotice = el('p', 'menu-notice', els.menuMain);
  els.menuStatus = el('p', 'menu-status', els.menuMain);
  const menuActions = el('div', 'menu-actions', els.menuMain);
  els.newGameBtn = el('button', 'menu-button menu-button--primary', menuActions);
  els.newGameBtn.type = 'button';
  els.newGameBtn.dataset.noUiClick = 'true';
  els.newGameBtn.textContent = t('menu.newGame');
  els.loadBtn = el('button', 'menu-button', menuActions);
  els.loadBtn.type = 'button';
  els.loadBtn.dataset.noUiClick = 'true';
  els.settingsBtn = el('button', 'menu-button menu-button--quiet', menuActions);
  els.settingsBtn.type = 'button';
  els.settingsBtn.dataset.noUiClick = 'true';
  els.settingsBtn.textContent = t('menu.settings');

  els.settingsPanel = el('div', 'menu-settings', menuPanel);
  els.settingsPanel.hidden = true;
  const settingsTitle = el('h2', 'menu-settings-title', els.settingsPanel);
  settingsTitle.textContent = t('menu.settings');
  const settingsForm = el('div', 'menu-settings-form', els.settingsPanel);
  els.settings = { ...ctx.settings };

  const volumeLabel = el('label', 'menu-setting', settingsForm);
  const volumeText = el('span', '', volumeLabel);
  volumeText.textContent = t('menu.volume');
  const volumeControl = el('div', 'menu-volume-control', volumeLabel);
  els.volumeSlider = el('input', 'menu-range', volumeControl);
  els.volumeSlider.type = 'range';
  els.volumeSlider.min = '0';
  els.volumeSlider.max = '1';
  els.volumeSlider.step = '0.01';
  els.volumeSlider.value = String(els.settings.volume);
  els.volumeSlider.setAttribute('aria-label', t('menu.volume'));
  els.volumeValue = el('output', 'menu-volume-value', volumeControl);
  els.volumeValue.textContent = `${Math.round(els.settings.volume * 100)}%`;

  const languageLabel = el('label', 'menu-setting', settingsForm);
  const languageText = el('span', '', languageLabel);
  languageText.textContent = t('menu.language');
  els.languageSelect = el('select', 'menu-select', languageLabel);
  for (const [value, key] of [['ru', 'menu.language.ru'], ['de', 'menu.language.de']]) {
    const option = el('option', '', els.languageSelect);
    option.value = value;
    option.textContent = t(key);
  }
  els.languageSelect.value = els.settings.language;

  els.menuFsBtn = el('button', 'menu-button menu-button--quiet', els.settingsPanel);
  els.menuFsBtn.type = 'button';
  els.menuFsBtn.dataset.noUiClick = 'true';
  els.menuFsBtn.textContent = t('ui.fullscreen');
  const docEl = document.documentElement;
  const reqFs = docEl.requestFullscreen || docEl.webkitRequestFullscreen;
  if (!reqFs || window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) {
    els.menuFsBtn.hidden = true;
  } else {
    els.menuFsBtn.addEventListener('pointerup', async (event) => {
      if (event.button > 0) return;
      try {
        await reqFs.call(docEl, { navigationUI: 'hide' });
        await window.screen.orientation?.lock?.('landscape').catch(() => {});
      } catch (err) { console.warn('fullscreen:', err); }
    });
  }
  els.backBtn = el('button', 'menu-button menu-button--quiet', els.settingsPanel);
  els.backBtn.type = 'button';
  els.backBtn.dataset.noUiClick = 'true';
  els.backBtn.textContent = t('menu.back');

  els.pauseScreen = el('section', 'pause-screen', root);
  els.pauseScreen.hidden = true;
  els.pauseScreen.setAttribute('role', 'dialog');
  els.pauseScreen.setAttribute('aria-modal', 'true');
  els.pauseScreen.setAttribute('aria-label', t('menu.pause.title'));
  const pauseImage = el('img', 'pause-background', els.pauseScreen);
  pauseImage.src = 'assets/img/menu/pause_background.jpeg';
  pauseImage.alt = '';
  pauseImage.draggable = false;
  el('div', 'pause-effects', els.pauseScreen);
  els.pauseStatic = el('canvas', 'pause-static', els.pauseScreen);
  els.pauseStatic.setAttribute('aria-hidden', 'true');
  els.pauseCode = el('div', 'pause-code', els.pauseScreen);
  els.pauseCode.setAttribute('aria-hidden', 'true');
  els.pauseCode.textContent = t('shutdown.code');
  const pausePanel = el('div', 'pause-panel', els.pauseScreen);
  els.pausePanel = pausePanel;
  const pauseTitle = el('h1', 'menu-title pause-title', pausePanel);
  els.pauseTitle = pauseTitle;
  pauseTitle.textContent = t('menu.pause.title');
  const pauseActions = el('div', 'menu-actions', pausePanel);
  els.pauseResumeBtn = el('button', 'menu-button menu-button--primary', pauseActions);
  els.pauseResumeBtn.type = 'button';
  els.pauseResumeBtn.dataset.noUiClick = 'true';
  els.pauseResumeBtn.textContent = t('menu.pause.resume');
  els.pauseSettingsBtn = el('button', 'menu-button menu-button--quiet', pauseActions);
  els.pauseSettingsBtn.type = 'button';
  els.pauseSettingsBtn.dataset.noUiClick = 'true';
  els.pauseSettingsBtn.textContent = t('menu.settings');
  els.pauseMainMenuBtn = el('button', 'menu-button menu-button--quiet', pauseActions);
  els.pauseMainMenuBtn.type = 'button';
  els.pauseMainMenuBtn.dataset.noUiClick = 'true';
  els.pauseMainMenuBtn.textContent = t('menu.pause.mainMenu');

  els.failedScreen = el('section', 'shift-failed', root);
  els.failedScreen.hidden = true;
  els.failedScreen.setAttribute('role', 'alertdialog');
  els.failedScreen.setAttribute('aria-modal', 'true');
  els.failedGhost = el('div', 'shift-failed__ghost', els.failedScreen);
  const failedBlood = el('div', 'shift-failed__blood', els.failedScreen);
  // [x %, ширина px, длина % высоты, задержка с, длительность с]: разной толщины и скорости, без ровного ритма
  const DRIPS = [[4, 3, 22, 0.4, 13], [9, 7, 38, 0, 17], [15, 4, 27, 2.1, 15], [23, 9, 54, 0.9, 21], [31, 3, 18, 3.4, 12],
    [38, 5, 36, 1.6, 16], [47, 8, 63, 0.2, 23], [53, 3, 24, 2.8, 14], [61, 6, 44, 1.2, 18], [68, 4, 30, 4.0, 15],
    [76, 9, 58, 0.6, 22], [83, 3, 20, 2.4, 13], [89, 6, 41, 1.9, 17], [95, 4, 28, 3.1, 14]];
  for (const [x, w, len, delay, dur] of DRIPS) {
    const drip = el('i', '', failedBlood);
    drip.style.cssText = `--x:${x}%;--w:${w}px;--len:${len}%;--delay:${delay}s;--dur:${dur}s`;
  }
  el('div', 'shift-failed__pool', els.failedScreen);
  els.failedTitle = el('h1', 'shift-failed__title', els.failedScreen);
  els.failedLine = el('p', 'shift-failed__line', els.failedScreen);
  els.failedButton = el('button', 'shift-failed__button', els.failedScreen);
  els.failedButton.type = 'button';
  els.failedButton.addEventListener('pointerup', (event) => {
    if (event.button > 0 || els.failedButton.disabled) return;
    emit('intent:returnMainMenu');
  });
  els.failedButton.addEventListener('click', (event) => {
    if (event.detail === 0 && !els.failedButton.disabled) emit('intent:returnMainMenu');
  });

  els.clockShift = el('div', 'clock-shift', root);
  els.clockShift.hidden = true;
  els.clockShift.setAttribute('aria-live', 'polite');
  const shiftCard = el('div', 'clock-shift__card', els.clockShift);
  els.clockShiftLabel = el('span', 'clock-shift__label', shiftCard);
  els.clockShiftTime = el('strong', 'clock-shift__time', shiftCard);
  const shiftTrack = el('div', 'clock-shift__track', shiftCard);
  el('span', 'clock-shift__time-in', shiftTrack).textContent = '00:00';
  el('i', '', shiftTrack);
  el('span', 'clock-shift__time-out', shiftTrack).textContent = '06:00';
  els.clockShiftStatus = el('span', 'clock-shift__status', shiftCard);
  els.clockShiftSlots = el('div', 'clock-shift__slots', shiftCard);
  els.clockShiftProgress = el('span', 'clock-shift__progress', shiftCard);

  els.paused = false;
  els.settingsReturn = 'main';

  const handleEscape = (event) => {
    if (event.key !== 'Escape' || event.repeat) return;
    if (event.target?.closest?.('input, select, textarea, [contenteditable="true"]')) return;
    if (!els.settingsPanel.hidden) {
      event.preventDefault();
      if (els.settingsReturn === 'pause') showPauseMenu();
      else showMainMenu(ctx);
      return;
    }
    if (els.paused) {
      event.preventDefault();
      emit('intent:resumeGame');
    } else if (state.running || els.gameActive) {
      event.preventDefault();
      emit('intent:pauseGame');
    }
  };
  els.handleEscape = handleEscape;
  window.addEventListener('keydown', handleEscape);
  syncMenu(state, t);

  els.newGameBtn.addEventListener('pointerup', (event) => {
    if (event.button > 0) return;
    audio.init();
    emit('intent:newGame');
  });
  els.loadBtn.addEventListener('pointerup', (event) => {
    if (event.button > 0 || els.loadBtn.disabled) return;
    audio.init();
    emit('intent:loadGame');
  });
  els.settingsBtn.addEventListener('pointerup', (event) => {
    if (event.button > 0) return;
    showSettings('main');
  });
  els.backBtn.addEventListener('pointerup', (event) => {
    if (event.button > 0) return;
    if (els.settingsReturn === 'pause') showPauseMenu();
    else showMainMenu(ctx);
  });
  els.pauseResumeBtn.addEventListener('pointerup', (event) => {
    if (event.button > 0) return;
    emit('intent:resumeGame');
  });
  els.pauseSettingsBtn.addEventListener('pointerup', (event) => {
    if (event.button > 0) return;
    showSettings('pause');
  });
  els.pauseMainMenuBtn.addEventListener('pointerup', (event) => {
    if (event.button > 0) return;
    emit('intent:returnMainMenu');
  });
  els.volumeSlider.addEventListener('input', () => {
    els.settings.volume = Number(els.volumeSlider.value);
    els.volumeValue.textContent = `${Math.round(els.settings.volume * 100)}%`;
    audio.setMasterVolume(els.settings.volume);
    persistSettings();
  });
  els.languageSelect.addEventListener('change', () => {
    els.settings.language = els.languageSelect.value;
    els.settings.languageAuto = false;
    persistSettings();
    window.location.reload();
  });

  // Подсказка поворота (показывается CSS-ом в портретной ориентации)
  els.rotate = el('div', 'rotate-hint', root);
  els.rotate.textContent = t('ui.rotateHint');

  els.pauseButton = el('button', 'pause-button', root);
  els.pauseButton.type = 'button';
  const pauseIcon = el('span', 'pause-button__icon', els.pauseButton);
  pauseIcon.setAttribute('aria-hidden', 'true');
  el('i', '', pauseIcon);
  el('i', '', pauseIcon);
  els.pauseButton.setAttribute('aria-label', t('menu.pause.title'));
  els.pauseButton.title = t('menu.pause.title');
  els.pauseButton.hidden = true;
  els.pauseButton.addEventListener('pointerup', (event) => {
    if (event.button > 0) return;
    emit('intent:pauseGame');
  });

  els.shiftHud = el('div', 'shift-hud', root);
  els.shiftHud.hidden = true;
  const tokenRow = el('div', 'shift-hud__row', els.shiftHud);
  el('span', 'shift-hud__label', tokenRow).textContent = t('ui.hud.tokens');
  els.hudTokens = el('strong', 'shift-hud__value', tokenRow);
  const loadRow = el('div', 'shift-hud__row', els.shiftHud);
  el('span', 'shift-hud__label', loadRow).textContent = t('ui.hud.load');
  els.hudLoad = el('strong', 'shift-hud__value', loadRow);
  els.hudLoadBar = el('span', 'shift-hud__bar', els.shiftHud);
  els.hudLoadSegments = [];
  for (let i = 0; i < 5; i++) {
    els.hudLoadSegments.push(el('i', i < 2 ? 'lv-g' : i < 4 ? 'lv-y' : 'lv-r', els.hudLoadBar));
  }

  const syncCam = () => els.stage.classList.toggle('is-cam', state.camera !== null);
  offs = [
    on('tick', ({ dt }) => {
      if (els.clockGlitch > 0) els.clockGlitch = Math.max(0, els.clockGlitch - dt);
      if (els.clockBack > 0) els.clockBack = Math.max(0, els.clockBack - dt);
      if (els.silhouetteTime > 0) {
        els.silhouetteTime = Math.max(0, els.silhouetteTime - dt);
        els.glitchSilhouette.hidden = els.silhouetteTime <= 0;
      }
      renderClock(state);
      els.shiftHud.hidden = !state.running;
      if (state.running) {
        els.hudTokens.textContent = tokensDashTtl > 0 ? '—' : `${Math.ceil(state.tokens)}%`;
        const load = Math.round(state.load * 10) / 10;
        els.hudLoad.textContent = `${load} / 5`;
        els.hudLoad.classList.toggle('is-over', state.load >= 5);
        const lit = Math.min(5, Math.max(0, Math.round(state.load)));
        els.hudLoadSegments.forEach((segment, i) => segment.classList.toggle('is-lit', i < lit));
      }
      if (tokensDashTtl > 0) tokensDashTtl = Math.max(0, tokensDashTtl - dt);
      updateTension(state);
      els.flickWin(dt, state.running);
      els.flickSpill(dt, state.running && state.tokens > 0 && state.load >= 5);
      // читаем состояние каждый кадр: так сработает при любом способе обнуления (в т.ч. из отладки)
      if (state.running && state.tokens <= 0) startShutdown();
      else if (state.tokens > 0 && els.sd.t >= 0) resetShutdown();
      updateShutdown(dt);
      updateScare(dt, ctx);
    }),
    // Утро (main.js ведёт ход, здесь только оформление): часы 5 AM → 6 AM, рассвет, табель смен.
    on('morning:start', () => {
      els.musicBlocked = true;
      stopMenuMusic();
      els.morningWait = true;
      shownText = '';
      els.stage.classList.remove('is-dawn');
      els.stage.classList.add('is-morning');
      renderClock(state);
    }),
    on('morning:flip', () => {
      els.morningWait = false;
      els.clockBack = 0.22;       // часы на миг дёргаются назад и только потом встают на 6 AM
      shownText = '';
      renderClock(state);
      els.stage.classList.add('is-dawn');
    }),
    on('morning:card', ({ n }) => {
      els.clockShiftLabel.textContent = ctx.t('ui.hourShift.label');
      els.clockShiftTime.textContent = ctx.t('ui.hourShift.final');
      els.clockShiftStatus.textContent = ctx.t('ui.hourShift.status');
      els.clockShiftSlots.textContent = '';
      for (let k = 1; k <= 5; k += 1) el('i', k <= n ? 'is-done' : '', els.clockShiftSlots);
      els.clockShiftProgress.textContent = ctx.t('morning.card.progress', { n });
      els.clockShift.hidden = false;
      els.clockShift.classList.add('is-final');
    }),
    on('jumpscare', ({ enemyId }) => startScare(enemyId)),
    on('glitch', ({ type, durationSec }) => {
      if (type === 'clock333') {
        els.clockGlitch = durationSec ?? CLOCK_GLITCH_SEC;
        renderClock(state);
      } else if (type === 'clockBack') {
        els.clockBack = durationSec ?? 2.4;
        renderClock(state);
      } else if (type === 'silhouette') {
        els.silhouetteTime = durationSec ?? 0.45;
        els.glitchSilhouette.hidden = false;
      } else if (type === 'tokensDash') {
        tokensDashTtl = durationSec ?? 0.8;
      }
    }),
    on('camera:open', syncCam),
    on('camera:close', syncCam),
    on('night:start', () => {
      els.musicBlocked = true;
      stopPauseMusic();
      stopMenuMusic();
      els.gameActive = true;
      updatePauseButton();
      els.stage.inert = false;
      els.pauseScreen.hidden = true;
      els.paused = false;
      resetShutdown();
      resetScare();
      shownText = '';
      els.clockGlitch = 0;
      els.clockBack = 0;
      els.morningWait = false;
      els.stage.classList.remove('is-morning', 'is-dawn');
      els.silhouetteTime = 0;
      els.glitchSilhouette.hidden = true;
      hideShiftFailed();
      els.clockShift.hidden = true;
      els.clockShift.classList.remove('is-final');
      tokensDashTtl = 0;
      renderClock(state);
      syncCam();
      els.menu.hidden = true;
    }),
    on('night:end', ({ failed }) => {
      els.musicBlocked = true;
      stopMenuMusic();
      if (failed) return;
      els.gameActive = false;
      updatePauseButton();
    }),
    on('game:paused', showPauseMenu),
    on('game:resumed', () => {
      stopPauseMusic();
      els.stage.inert = false;
      const minigameScreen = document.querySelector('.mg-screen');
      if (minigameScreen) minigameScreen.inert = false;
      els.pauseScreen.hidden = true;
      els.paused = false;
      updatePauseButton();
    }),
    on('game:menu', () => showMainMenu(ctx)),
    on('minigame:start', () => { els.clockShift.hidden = true; }),
    on('minigame:start', () => { els.gameActive = true; updatePauseButton(); }),
    on('minigame:complete', () => { els.gameActive = true; updatePauseButton(); }),
    on('minigame:close', () => { els.gameActive = false; updatePauseButton(); }),
    on('ending:show', () => { els.gameActive = false; updatePauseButton(); }),
    on('minigame:close', () => showStart('ui.title', ctx)),
    on('save:change', ({ available }) => {
      els.hasSave = available;
      syncMenu(state, t);
    }),
  ];
  pauseFxStart();
  if (menuAudioUnlocked) startMenuMusic();
}

export function unmount() {
  stopMenuMusic();
  stopPauseMusic();
  if (els.handleEscape) window.removeEventListener('keydown', els.handleEscape);
  window.removeEventListener('resize', layoutMenuArt);
  mfxStop();
  pauseFxStop();
  els.menuResizeObserver?.disconnect();
  els.resizeObserver?.disconnect();
  offs.forEach((off) => off());
  offs = [];
  if (root) root.replaceChildren();
  root = null;
  els = {};
  shownText = '';
}