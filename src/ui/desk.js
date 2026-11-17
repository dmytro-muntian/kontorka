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

function el(tag, className, parent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (parent) parent.appendChild(e);
  return e;
}

function renderClock(state) {
  const displayTime = els.clockBack > 0 ? Math.max(0, state.time - 60) : state.time;
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
    showStart('ui.shiftFailed', ctx);
    return;
  }
  sc.root.dataset.phase = sc.t < SCARE_FLASH ? 'flash' : sc.t < SCARE_CUT_AT ? 'show' : 'black';
  drawScare(sc, dt);
}

function showStart(titleKey, ctx) {
  els.startTitle.textContent = ctx.t(titleKey);
  els.start.hidden = false;
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

  // Стартовый экран
  els.start = el('div', 'start-screen', root);
  els.startTitle = el('h1', 'start-title', els.start);
  els.startHint = el('p', 'start-hint', els.start);
  els.startHint.textContent = t('ui.headphones');
  els.startBtn = el('button', 'start-btn', els.start);
  els.startBtn.type = 'button';
  els.startBtn.dataset.noUiClick = 'true';
  els.startBtn.textContent = t('ui.startShift');
  els.startTitle.textContent = t('ui.title');

  // Полный экран: на Android Chrome кнопка убирает панели браузера; на iPhone Safari API нет,
  // там показываем подсказку про запуск с главного экрана (manifest + мета-теги в index.html).
  const docEl = document.documentElement;
  const reqFs = docEl.requestFullscreen || docEl.webkitRequestFullscreen;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (!standalone) {
    if (reqFs) {
      els.fsBtn = el('button', 'start-btn start-btn--ghost', els.start);
      els.fsBtn.type = 'button';
      els.fsBtn.textContent = t('ui.fullscreen');
      els.fsBtn.addEventListener('pointerup', async (e) => {
        if (e.button > 0) return;
        try {
          await reqFs.call(docEl, { navigationUI: 'hide' });
          await screen.orientation?.lock?.('landscape').catch(() => {});
        } catch (err) { console.warn('fullscreen:', err); }
      });
      const syncFs = () => { els.fsBtn.hidden = !!(document.fullscreenElement || document.webkitFullscreenElement); };
      document.addEventListener('fullscreenchange', syncFs);
      document.addEventListener('webkitfullscreenchange', syncFs);
    } else {
      els.fsHint = el('p', 'start-hint start-hint--small', els.start);
      els.fsHint.textContent = t('ui.addToHome');
    }
  }

  // pointerup от касания — это жест, после которого браузер разрешает звук.
  els.startBtn.addEventListener('pointerup', (e) => {
    if (e.button > 0) return;
    emit('intent:startShift');
  });

  // Подсказка поворота (показывается CSS-ом в портретной ориентации)
  els.rotate = el('div', 'rotate-hint', root);
  els.rotate.textContent = t('ui.rotateHint');

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
      updateTension(state);
      els.flickWin(dt, state.running);
      els.flickSpill(dt, state.running && state.tokens > 0 && state.load >= 5);
      // читаем состояние каждый кадр: так сработает при любом способе обнуления (в т.ч. из отладки)
      if (state.running && state.tokens <= 0) startShutdown();
      else if (state.tokens > 0 && els.sd.t >= 0) resetShutdown();
      updateShutdown(dt);
      updateScare(dt, ctx);
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
      }
    }),
    on('camera:open', syncCam),
    on('camera:close', syncCam),
    on('night:start', () => {
      resetShutdown();
      resetScare();
      shownText = '';
      els.clockGlitch = 0;
      els.clockBack = 0;
      els.silhouetteTime = 0;
      els.glitchSilhouette.hidden = true;
      renderClock(state);
      syncCam();
      els.start.hidden = true;
    }),
    // Временно: полноценный экран итога появится на этапе 10.
    // После скримера (failed) стартовый экран покажет updateScare, когда кадр отыграет.
    on('night:end', (p) => { if (!p?.failed) showStart('ui.shiftOver', ctx); }),
  ];
}

export function unmount() {
  els.resizeObserver?.disconnect();
  offs.forEach((off) => off());
  offs = [];
  if (root) root.replaceChildren();
  root = null;
  els = {};
  shownText = '';
}