// Левый монитор: карта камер (этап 3) и вид камеры (этап 4).
// Только рисует и шлёт намерения. Игровой логики здесь нет.

import {
  cameraIds, cameraMeta, mapOf, mapView, positionIds, isBlind, PLAYER_POS, camerasFor, spriteDef, labelOf,
} from '../graph.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HALLS = ['s_hall1', 's_hall2', 's_hall3'];   // сегменты одного зала: границы рисуем пунктиром
const NOISE_W = 128;
const NOISE_H = 96;
const NOISE_MS = 90;
const AUTO_LUMA = 0.22;      // к какой средней яркости подтягиваются тёмные кадры (0..1)
const AUTO_GAIN_MAX = 2.2;   // во сколько раз максимум можно осветлить кадр   // единственное исключение из правила про таймеры: шум на canvas раз в 80–100 мс

let offs = [];
let root = null;
let els = {};
let S = null;          // state
let T = null;          // t()
let E = null;          // emit()
let holdId = null;     // тикет, кнопку починки которого сейчас удерживают
let repairSig = '';    // что сейчас нарисовано в слое кнопок починки
let repairBtns = new Map();   // id тикета -> { btn, fill }
const rebootProgress = new Map();
let shown = null;      // номер камеры на экране или null (карта)
let noiseTimer = null;
let aiTextTtl = 0;
let camera12Ttl = 0;
let preload = [];
let last = {};         // последние тексты HUD, чтобы не трогать DOM зря
let gains = {};        // автояркость по камерам (из средней яркости кадра)
let tunes = {};        // ручная подстройка из отладочной панели
let sprOver = {};      // подстройка спрайтов из отладки: `${pos}:${cam}` -> {x, y, scale, pose}
let sprSig = '';       // что сейчас нарисовано в слое спрайтов
const VISIBLE = new Set(['idle', 'dash']);   // в других статусах враг пропадает с камер
const warned = new Set();
const LIGHT_K = 1.15;       // насколько враг ярче фона вокруг него (1 = ровно как фон)
let grids = {};            // сетка яркости 32x24 исходного кадра каждой камеры
let spriteInfo = {};       // картинка позы -> { ready, luma, aspect, img }
let spriteClean = {};      // `${src}|${edge}` -> dataURL картинки со срезанной каймой (или null)

function el(tag, className, parent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (parent) parent.appendChild(e);
  return e;
}

function svg(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function onPress(node, fn) {
  node.addEventListener('pointerup', (e) => {
    if (e.button > 0) return;
    fn(e);
  });
}

// ---------- карта ----------
function buildMap(parent, ctx) {
  const { emit } = ctx;
  const view = mapView();
  if (!view) {
    console.warn('cameras: в rooms.json нет mapView');
    return null;
  }
  const [W, H] = view.size;

  const map = el('div', 'cam-map', parent);
  const canvas = svg('svg', { class: 'cam-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' }, map);

  // Контуры комнат
  els.rooms = {};
  for (const id of positionIds()) {
    const m = mapOf(id);
    if (!m) continue;
    const cls = HALLS.includes(id) ? 'room room--hall' : 'room';
    const shapes = [m, ...m.extra].map((r) =>
      svg('rect', { class: cls, x: r.x, y: r.y, width: r.w, height: r.h }, canvas));
    els.rooms[id] = shapes;
    if (isBlind(id) && id !== PLAYER_POS) {
      const wc = svg('text', { class: 'wc', x: m.x + m.w / 2, y: m.y + m.h / 2 }, canvas);
      wc.textContent = T('cams.map.wc');
    }
  }
  // Общий контур южного зала поверх пунктирных сегментов
  for (const poly of view.outlines) {
    svg('polygon', { class: 'outline', points: poly.map(([x, y]) => `${x},${y}`).join(' ') }, canvas);
  }
  // Двери: разрывы в стенах
  for (const d of view.doors) {
    svg('rect', { class: 'door', x: d.x, y: d.y, width: d.w, height: d.h }, canvas);
  }
  // Место игрока
  svg('rect', { class: 'you-box', x: view.you.x - 4, y: view.you.y - 4, width: 8, height: 8 }, canvas);
  const you = svg('text', { class: 'you-text', x: view.you.x, y: view.you.y - 9 }, canvas);
  you.textContent = T('cams.map.you');

  // Кнопки камер
  els.buttons = {};
  for (const cam of cameraIds()) {
    const meta = cameraMeta(cam);
    if (!meta.btn) continue;
    const btn = el('button', 'cam-btn', map);
    btn.type = 'button';
    btn.dataset.actionSound = 'camera';
    btn.style.left = `${meta.btn.x}px`;
    btn.style.top = `${meta.btn.y}px`;
    el('small', '', btn).textContent = T('cams.map.cam');
    el('span', '', btn).textContent = String(cam);
    btn.setAttribute('aria-label', T('cams.caption', { n: cam, name: T(meta.name) }));
    onPress(btn, () => emit('intent:openCamera', { id: cam }));
    els.buttons[cam] = btn;
  }

  els.camera12 = el('button', 'cam-btn cam-btn--phantom', map);
  els.camera12.type = 'button';
  els.camera12.tabIndex = -1;
  els.camera12.setAttribute('aria-hidden', 'true');
  els.camera12.hidden = true;
  els.camera12.style.left = `${W - 55}px`;
  els.camera12.style.top = `${H - 45}px`;
  el('small', '', els.camera12).textContent = T('cams.map.cam');
  el('span', '', els.camera12).textContent = '12';

  els.caption = el('div', 'cam-caption', map);
  return map;
}

// ---------- вид камеры ----------
function buildView(parent, ctx) {
  const { emit } = ctx;
  const view = el('div', 'cam-view', parent);

  els.frame = el('div', 'cam-frame', view);
  const feed = (els.feed = el('div', 'cam-feed', els.frame));           // фильтр действует на всё внутри
  const world = el('div', 'cam-world', feed);              // плавный дрейф «камеры»
  els.img = el('img', 'cam-img', world);
  els.img.alt = '';
  els.img.draggable = false;
  els.img.addEventListener('error', () => console.warn(`cameras: не загрузился кадр камеры ${shown}`));
  els.world = world;
  els.sprites = el('div', 'cam-sprites', world);            // этап 6

  els.noise = el('canvas', 'cam-noise', els.frame);
  els.noise.width = NOISE_W;
  els.noise.height = NOISE_H;
  els.noiseCtx = els.noise.getContext('2d');
  els.noiseData = els.noiseCtx.createImageData(NOISE_W, NOISE_H);
  els.noise32 = new Uint32Array(els.noiseData.data.buffer);
  els.noise.addEventListener('animationend', (e) => {
    if (e.animationName === 'cam-flash') els.frame.classList.remove('is-flash');
  });

  el('div', 'cam-roll', els.frame);
  el('div', 'cam-scan', els.frame);
  els.glitchText = el('div', 'cam-glitch-text', els.frame);
  els.glitchText.textContent = T('glitch.aiText');
  els.glitchText.hidden = true;

  // Сломанная камера
  els.error = el('div', 'cam-error', els.frame);
  els.error.hidden = true;
  el('div', 'cam-error__title', els.error).textContent = T('cams.broken.error');
  els.reboot = el('button', 'cam-error__btn', els.error);
  els.reboot.type = 'button';
  els.rebootLabel = el('span', '', els.reboot);
  els.rebootLabel.textContent = T('cams.broken.reboot');
  els.rebootProgress = svg('svg', {
    class: 'cam-error__progress',
    viewBox: '0 0 100 100',
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  }, els.reboot);
  const progressOutline = svg('rect', {
    x: 1, y: 1, width: 98, height: 98, rx: 4, pathLength: 100,
  }, els.rebootProgress);
  progressOutline.style.strokeDasharray = '100';
  progressOutline.style.strokeDashoffset = '100';
  onPress(els.reboot, () => {
    if (shown === null || els.reboot.disabled) return;
    emit('intent:reboot', { cam: shown });
  });

  // HUD
  const hud = el('div', 'cam-hud', els.frame);
  el('div', 'hud-rec', hud).textContent = T('cams.hud.rec');
  els.hudTime = el('div', 'hud-time', hud);
  els.hudName = el('div', 'hud-name', hud);

  // Панель ИИ-агента: звонок-приманка
  els.callAt = el('div', 'cam-call-at', els.frame);   // куда звонит агент (комната открытой камеры)
  els.call = el('button', 'cam-call', els.frame);
  els.call.type = 'button';
  els.call.dataset.actionSound = 'lure';
  onPress(els.call, () => {
    if (!els.call.disabled) emit('intent:call');
  });

  // Колонка справа: переключение камер и возврат на карту
  const side = el('div', 'cam-side', view);
  const grid = el('div', 'cam-grid', side);
  els.sbtns = {};
  for (const cam of cameraIds()) {
    const meta = cameraMeta(cam);
    const btn = el('button', 'cam-sbtn', grid);
    btn.type = 'button';
    btn.dataset.actionSound = 'camera';
    el('small', '', btn).textContent = T('cams.map.cam');
    el('span', '', btn).textContent = String(cam);
    btn.setAttribute('aria-label', T('cams.caption', { n: cam, name: T(meta.name) }));
    onPress(btn, () => emit('intent:openCamera', { id: cam }));
    els.sbtns[cam] = btn;
  }
  const back = el('button', 'cam-back', side);
  back.type = 'button';
  back.textContent = T('cams.back');
  onPress(back, () => emit('intent:closeCamera'));

  return view;
}

function drawNoise() {
  const buf = els.noise32;
  for (let i = 0; i < buf.length; i++) {
    const v = (Math.random() * 256) | 0;
    buf[i] = 0xff000000 | (v << 16) | (v << 8) | v;
  }
  els.noiseCtx.putImageData(els.noiseData, 0, 0);
}

function startNoise() {
  if (noiseTimer !== null) return;
  drawNoise();
  noiseTimer = setInterval(drawNoise, NOISE_MS);
}

function stopNoise() {
  if (noiseTimer === null) return;
  clearInterval(noiseTimer);
  noiseTimer = null;
}

function flash() {
  if (!els.frame) return;
  els.frame.classList.remove('is-flash');
  void els.frame.offsetWidth;           // перезапуск CSS-анимации
  els.frame.classList.add('is-flash');
}

const isBroken = (cam) => S.brokenCams.includes(cam);

function applyBroken(broken) {
  els.frame.classList.toggle('is-broken', broken);
  els.error.hidden = !broken;
  syncRebootButton();
}

function syncRebootButton() {
  const progress = shown === null ? undefined : rebootProgress.get(shown);
  const rebooting = progress !== undefined;
  els.reboot.disabled = rebooting;
  els.rebootLabel.textContent = T(rebooting ? 'cams.broken.rebooting' : 'cams.broken.reboot');
  els.reboot.classList.toggle('is-rebooting', rebooting);
  els.rebootProgress.firstElementChild.style.strokeDashoffset = String(100 * (1 - (progress ?? 0)));
}

function setText(key, node, text) {
  if (last[key] === text) return;
  last[key] = text;
  node.textContent = text;
}

function syncHud() {
  const hour = Math.min(6, Math.floor(S.time / 60));
  setText('time', els.hudTime, T('cams.hud.time', { h: hour === 0 ? 12 : hour }));
  syncCall();
}

function syncCall() {
  const c = S.call;
  const text = c.active ? T('agent.calling')
    : c.cooldown > 0 ? T('agent.cooldown', { s: Math.ceil(c.cooldown) })
    : T('agent.callButton');
  setText('call', els.call, text);
  const room = (c.active ? c.at : cameraMeta(S.camera)?.pos) ?? null;
  setText('callAt', els.callAt, room ? T(c.active ? 'agent.callingAt' : 'agent.callAt', { room: T(labelOf(room)) }) : '');
  const off = !S.running || S.tokens <= 0 || c.active || c.cooldown > 0;
  if (els.call.disabled !== off) els.call.disabled = off;
  els.call.classList.toggle('is-active', c.active);
}

// Яркость кадра: автоподтяжка тёмных кадров и ручная подстройка (rooms.json → tune, отладка)
function applyLook(cam) {
  if (!els.feed) return;
  const tune = { ...(cameraMeta(cam)?.tune || {}), ...(tunes[cam] || {}) };
  const b = (gains[cam] ?? 1) * (tune.brightness ?? 1);
  const c = tune.contrast ?? 1;
  els.feed.style.setProperty('--cam-b', b.toFixed(3));
  els.feed.style.setProperty('--cam-c', c.toFixed(3));
}

function measureGain(cam, im) {
  try {
    const cv = document.createElement('canvas');
    cv.width = 32;
    cv.height = 24;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(im, 0, 0, 32, 24);
    const d = cx.getImageData(0, 0, 32, 24).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    const mean = sum / (d.length / 4);
    gains[cam] = Math.min(AUTO_GAIN_MAX, Math.max(1, AUTO_LUMA / Math.max(mean, 0.01)));
    const grid = new Float32Array(32 * 24);
    for (let i = 0; i < grid.length; i++) {
      grid[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
    }
    grids[cam] = grid;
  } catch (e) {
    console.warn(`cameras: не удалось измерить яркость кадра ${cam}`, e);
  }
  if (shown === cam) applyLook(cam);
}

// ---------- спрайты врагов ----------
// Яркость врага подгоняется под освещение кадра вокруг него: тёмный угол даёт тёмную фигуру.
// Средняя яркость и пропорции картинки позы (по альфе), считаются один раз при загрузке.
function spriteStats(src) {
  const rec = spriteInfo[src];
  if (rec) return rec.ready ? rec : null;
  spriteInfo[src] = { ready: false, luma: 0.3, aspect: 0.4 };
  const im = new Image();
  im.onload = () => {
    const r = spriteInfo[src];
    if (!r) return;
    r.aspect = im.naturalWidth / im.naturalHeight;
    r.img = im;
    try {
      const w = 32;
      const h = Math.max(1, Math.round(w / r.aspect));
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(im, 0, 0, w, h);
      const d = cx.getImageData(0, 0, w, h).data;
      let sum = 0;
      let wsum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        sum += a * (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        wsum += a;
      }
      if (wsum > 0) r.luma = Math.max(0.05, sum / wsum);
    } catch (e) {
      console.warn('cameras: не удалось измерить яркость спрайта', e);
    }
    r.ready = true;
    sprSig = '';
    renderSprites();
  };
  im.src = src;
  return null;
}

// Убираем светлую кайму вокруг вырезанной фигуры: срезаем край альфы на edge px
// и затемняем две полоски у нового края. edge = 0 отключает обработку.
function minFilter(src, w, h, r) {
  if (r <= 0) return src;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 255;
      const b = Math.min(w - 1, x + r);
      for (let i = Math.max(0, x - r); i <= b; i++) { const v = src[y * w + i]; if (v < m) m = v; }
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    const b = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let j = Math.max(0, y - r); j <= b; j++) { const v = tmp[j * w + x]; if (v < m) m = v; }
      out[y * w + x] = m;
    }
  }
  return out;
}

function cleanSprite(src, im, edge) {
  if (!im || edge <= 0) return null;
  const key = `${src}|${edge}`;
  if (key in spriteClean) return spriteClean[key];
  let url = null;
  try {
    const k = Math.min(1, 1024 / im.naturalHeight);
    const w = Math.max(1, Math.round(im.naturalWidth * k));
    const h = Math.max(1, Math.round(im.naturalHeight * k));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(im, 0, 0, w, h);
    const data = cx.getImageData(0, 0, w, h);
    const d = data.data;
    const a0 = new Uint8Array(w * h);
    for (let i = 0; i < a0.length; i++) a0[i] = d[i * 4 + 3];
    const r = Math.round(edge);
    const ae = minFilter(a0, w, h, r);
    const n1 = minFilter(a0, w, h, r + 1);
    const n2 = minFilter(a0, w, h, r + 3);
    for (let i = 0; i < ae.length; i++) {
      const o = i * 4;
      d[o + 3] = ae[i];
      if (!ae[i]) continue;
      const dark = n1[i] < 255 ? 0.35 : (n2[i] < 255 ? 0.7 : 1);
      if (dark < 1) { d[o] *= dark; d[o + 1] *= dark; d[o + 2] *= dark; }
    }
    cx.putImageData(data, 0, 0);
    url = cv.toDataURL('image/png');
  } catch (e) {
    console.warn('cameras: не удалось срезать кайму спрайта', e);
  }
  spriteClean[key] = url;
  return url;
}

// Средняя яркость исходного кадра там, где стоит фигура (область тела).
function localLuma(cam, x, y, hPct, wPct) {
  const g = grids[cam];
  if (!g) return 0.2;
  const clamp = (v) => Math.min(100, Math.max(0, v));
  const x0 = Math.floor((clamp(x - wPct * 0.35) / 100) * 31);
  const x1 = Math.ceil((clamp(x + wPct * 0.35) / 100) * 31);
  const y0 = Math.floor((clamp(y - hPct * 0.85) / 100) * 23);
  const y1 = Math.ceil((clamp(y - hPct * 0.05) / 100) * 23);
  let sum = 0;
  let n = 0;
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) { sum += g[j * 32 + i]; n++; }
  return n ? sum / n : 0.2;
}

// Кто виден на открытой камере, решают state.enemies и graph.camerasFor(); здесь только рисуем.
function renderSprites() {
  if (shown === null || !els.sprites) return;
  const list = [];
  for (const [eid, e] of Object.entries(S.enemies)) {
    if (!e || !VISIBLE.has(e.status ?? 'idle')) continue;
    const entry = camerasFor(e.pos).find((c) => c.cam === shown);
    if (!entry) continue;
    list.push({ eid, ...entry, ...(sprOver[`${e.pos}:${shown}`] || {}) });
  }
  const sig = shown + '|' + JSON.stringify(list);
  if (sig === sprSig) return;
  sprSig = sig;
  els.sprites.replaceChildren();
  for (const s of list) {
    const def = spriteDef(s.eid, s.pose);
    if (!def) {
      const key = `${s.eid}:${s.pose}`;
      if (!warned.has(key)) { warned.add(key); console.warn(`cameras: нет описания позы «${s.pose}» для ${s.eid}`); }
      continue;
    }
    const wrap = el('div', 'cam-spr', els.sprites);
    if (s.clip) {
      const { x1, y1, x2, y2 } = s.clip;
      wrap.style.clipPath = `inset(${y1}% ${100 - x2}% ${100 - y2}% ${x1}%)`;
    }
    const st = spriteStats(def.img) || { luma: 0.3, aspect: 0.4 };
    const hPct = def.h * s.scale;
    const wPct = hPct * 0.75 * st.aspect;        // кадр 4:3: высота в % высоты -> ширина в % ширины
    const local = localLuma(shown, s.x, s.y, hPct, wPct);
    // автояркость под освещение кадра (0,25…1), поверх неё ручной множитель light (можно ярче 1)
    const auto = Math.min(1, Math.max(0.25, (local * LIGHT_K) / st.luma));
    const b = Math.min(3, Math.max(0.05, auto * (s.light ?? 1)));
    // тень под ногами: фигура стоит на полу, а не висит над кадром
    const sh = el('div', 'cam-spr__shadow', wrap);
    sh.style.left = `${s.x}%`;
    sh.style.top = `${s.y}%`;
    sh.style.width = `${(wPct * 0.9).toFixed(1)}%`;
    const im = el('img', '', wrap);
    im.alt = '';
    im.draggable = false;
    im.src = cleanSprite(def.img, st.img, s.edge ?? 1) || def.img;
    im.style.left = `${s.x}%`;
    im.style.top = `${s.y}%`;
    im.style.height = `${hPct}%`;
    im.style.transform = `translate(${-(def.ax ?? 0.5) * 100}%, -100%)`;
    // мягче и темнее, как всё остальное в кадре камеры
    im.style.filter = `brightness(${b.toFixed(2)}) contrast(0.9) blur(0.5px)`;
  }
}

// ---------- кнопки починки (этап 7) ----------
// На камере с устройством открытого тикета (ПК, принтер) в точке тикета стоит кнопка: её нужно удерживать.
// Отпустил раньше: прогресс сбросится (считает tickets.js). Кнопки едут вместе с дрейфом кадра.
function endHold() {
  if (holdId === null) return;
  const id = holdId;
  holdId = null;
  repairBtns.get(id)?.btn.classList.remove('is-hold');
  E('intent:repairEnd');
}

function renderRepair() {
  if (!els.world) return;
  const list = shown === null ? [] : S.tickets.filter(
    (tk) => !tk.done && tk.cam === shown && tk.type !== 'camera' && tk.x !== null && !isBroken(shown));
  const sig = `${shown}|${list.map((tk) => `${tk.id}:${tk.x}:${tk.y}`).join(',')}`;
  if (sig !== repairSig) {
    repairSig = sig;
    if (holdId !== null && !list.some((tk) => tk.id === holdId)) endHold();
    for (const { btn } of repairBtns.values()) btn.remove();
    repairBtns.clear();
    for (const tk of list) {
      const btn = el('button', 'cam-fix', els.world);
      btn.type = 'button';
      btn.style.left = `${tk.x}%`;
      btn.style.top = `${tk.y}%`;
      const fill = el('i', '', btn);
      el('span', '', btn).textContent = T(tk.button);
      btn.addEventListener('pointerdown', (e) => {
        if (e.button > 0 || holdId !== null) return;
        e.preventDefault();
        try { btn.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
        holdId = tk.id;
        btn.classList.add('is-hold');
        E('intent:repairStart', { ticketId: tk.id });
      });
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, endHold);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      repairBtns.set(tk.id, { btn, fill });
    }
  }
  for (const tk of list) {
    const r = repairBtns.get(tk.id);
    if (r) r.fill.style.width = `${(tk.progress * 100).toFixed(1)}%`;
  }
}

function showView(cam) {
  const meta = cameraMeta(cam);
  if (!meta) return;
  const changed = shown !== cam;
  if (changed) endHold();
  shown = cam;
  els.map.classList.add('is-hidden');
  els.view.classList.add('is-open');
  if (changed) {
    if (meta.img) els.img.src = meta.img;
    else {
      els.img.removeAttribute('src');
      console.warn(`cameras: у камеры ${cam} нет img в rooms.json`);
    }
    applyLook(cam);
    last = {};
    setText('name', els.hudName, T('cams.caption', { n: cam, name: T(meta.name) }));
    for (const [c, b] of Object.entries(els.sbtns)) b.classList.toggle('cam-sbtn--active', Number(c) === cam);
    els.broken = isBroken(cam);
    applyBroken(els.broken);
    syncHud();
    flash();
  }
  renderSprites();
  renderRepair();
  startNoise();
}

function hideView() {
  endHold();
  shown = null;
  els.map?.classList.remove('is-hidden');
  els.view?.classList.remove('is-open');
  els.sprites?.replaceChildren();
  sprSig = '';
  renderRepair();
  stopNoise();
}

// ---------- модуль ----------
export function mount(rootEl, ctx) {
  root = rootEl;
  S = ctx.state;
  T = ctx.t;
  E = ctx.emit;
  const { on } = ctx;

  els.map = buildMap(root, ctx);
  if (!els.map) return;
  els.view = buildView(root, ctx);

  // Кадры камер подгружаем заранее, чтобы переключение не мигало пустотой
  preload = cameraIds().map((cam) => {
    const src = cameraMeta(cam)?.img;
    if (!src) return null;
    const im = new Image();
    im.onload = () => measureGain(cam, im);
    im.src = src;
    return im;
  });

  const refresh = () => {
    const open = S.camera;
    for (const [cam, btn] of Object.entries(els.buttons)) {
      btn.classList.toggle('cam-btn--active', Number(cam) === open);
    }
    if (open) {
      const meta = cameraMeta(open);
      els.caption.textContent = T('cams.caption', { n: open, name: meta ? T(meta.name) : '' });
      showView(open);
    } else {
      els.caption.textContent = T('cams.map.hint');
      hideView();
    }
  };
  const resetGlitches = () => {
    aiTextTtl = 0;
    camera12Ttl = 0;
    els.glitchText.hidden = true;
    els.camera12.hidden = true;
    refresh();
    if (shown !== null) syncHud();
  };
  refresh();

  // Подсветка позиции из отладочной панели
  const highlight = ({ pos, neighbors = [] } = {}) => {
    for (const [id, shapes] of Object.entries(els.rooms)) {
      for (const r of shapes) {
        r.classList.toggle('room--hl', id === pos);
        r.classList.toggle('room--nb', id !== pos && neighbors.includes(id));
      }
    }
  };

  offs = [
    on('camera:open', refresh),
    on('camera:close', refresh),
    on('night:start', () => {
      rebootProgress.clear();
      resetGlitches();
      syncRebootButton();
    }),
    on('camera:rebooting', ({ cam, progress = 0 }) => {
      rebootProgress.set(cam, progress);
      if (shown === cam) syncRebootButton();
    }),
    on('camera:rebootProgress', ({ cam, progress }) => {
      rebootProgress.set(cam, progress);
      if (shown === cam) syncRebootButton();
    }),
    on('camera:rebooted', ({ cam }) => {
      rebootProgress.delete(cam);
      if (shown === cam) syncRebootButton();
    }),
    on('night:end', () => {
      rebootProgress.clear();
      syncRebootButton();
    }),
    on('debug:highlight', highlight),
    on('debug:flash', () => { if (shown !== null) flash(); }),
    on('debug:sprite', ({ pos, cam, x, y, scale, pose, light, edge }) => {
      sprOver[`${pos}:${cam}`] = { x, y, scale, pose, light, edge };
      renderSprites();
    }),
    on('debug:tune', ({ cam, brightness, contrast }) => {
      tunes[cam] = { brightness, contrast };
      if (shown === cam) applyLook(cam);
    }),
    on('glitch', ({ type, durationSec }) => {
      if (type === 'aiText') {
        aiTextTtl = durationSec ?? 0.12;
        els.glitchText.hidden = false;
      } else if (type === 'camera12') {
        camera12Ttl = durationSec ?? 1;
        els.camera12.hidden = false;
      }
    }),
    // Поломка камеры и HUD читаются из state раз в кадр; своих игровых таймеров нет.
    on('tick', ({ dt }) => {
      if (aiTextTtl > 0) {
        aiTextTtl = Math.max(0, aiTextTtl - dt);
        els.glitchText.hidden = aiTextTtl <= 0;
      }
      if (camera12Ttl > 0) {
        camera12Ttl = Math.max(0, camera12Ttl - dt);
        els.camera12.hidden = camera12Ttl <= 0;
      }
      if (shown === null) return;
      syncHud();
      renderSprites();
      renderRepair();
      const broken = isBroken(shown);
      if (broken !== els.broken) {
        els.broken = broken;
        applyBroken(broken);
      }
    }),
  ];
}

export function unmount() {
  stopNoise();
  offs.forEach((off) => off());
  offs = [];
  preload = [];
  aiTextTtl = 0;
  camera12Ttl = 0;
  if (root) root.replaceChildren();
  root = null;
  els = {};
  shown = null;
  last = {};
  gains = {};
  tunes = {};
  grids = {};
  spriteInfo = {};
  spriteClean = {};
  sprOver = {};
  sprSig = '';
  repairBtns = new Map();
  repairSig = '';
  rebootProgress.clear();
  holdId = null;
}