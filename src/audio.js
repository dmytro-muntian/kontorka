// Звук (этап 8, раздел 12 мастер-промпта): каталог data/sounds.json, MP3 через Web Audio.
// Громкость, фильтр и панорама считаются по расстоянию позиции звука до игрока (graph.distance).

import { distance, panOf, PLAYER_POS } from './graph.js';

let ctx = null;
let master = null;
let masterVolume = 1;
let manuallyPaused = false;
const catalog = {};     // id -> { file, kind, loop, volume }
const buffers = {};     // id -> AudioBuffer
let ambient = [];       // [{ id, handle }]
const soundLoads = new Map(); // id -> Promise<AudioBuffer | null>
const htmlHandles = new Set();

// Вызывать только из обработчика касания.
export function init() {
  if (ctx) {
    if (!manuallyPaused) resumeContext();
    return ctx;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    console.warn('audio: Web Audio недоступен');
    return null;
  }
  ctx = new AC();
  resumeContext();
  watchContext();
  master = ctx.createGain();
  master.gain.value = masterVolume;
  master.connect(ctx.destination);
  // Тихий буфер: страховка для iOS, чтобы контекст точно проснулся.
  const buf = ctx.createBuffer(1, 1, 22050);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  decodeAll();
  return ctx;
}

// Полный экран, поворот экрана, сворачивание и звонки в телефоне могут остановить контекст
// (suspended, а на iPhone ещё interrupted). Будим его при любом таком событии и при любом касании.
function watchContext() {
  const wake = () => {
    if (!manuallyPaused) resumeContext();
  };
  ctx.addEventListener?.('statechange', () => {
    console.info(`audio: состояние ${ctx.state}`);
    wake();
  });
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, wake);
  for (const ev of ['orientationchange', 'pageshow', 'resize']) window.addEventListener(ev, wake);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  document.addEventListener('pointerdown', wake, true);
  document.addEventListener('touchstart', wake, { capture: true, passive: true });
}

function resumeContext() {
  if (!ctx || ctx.state === 'running') return;
  ctx.resume().catch((e) => console.warn('audio: не удалось возобновить AudioContext', e));
}

// Все id звуков (каталог + процедурные заглушки) для отладочной панели.
export function soundIds() {
  return [...new Set([...Object.keys(catalog), ...Object.keys(SYNTH)])]
    .map((id) => ({ id, kind: catalog[id]?.kind ?? 'world', loop: !!catalog[id]?.loop }));
}

export function getContext() {
  return ctx;
}

export function setPaused(paused) {
  manuallyPaused = paused;
  if (!ctx) return;
  const action = paused ? ctx.suspend() : ctx.resume();
  action.catch((e) => console.warn(`audio: не удалось ${paused ? 'приостановить' : 'возобновить'} контекст`, e));
}

export function setMasterVolume(value) {
  const volume = Number(value);
  if (!Number.isFinite(volume)) {
    console.warn('audio: громкость должна быть числом');
    return;
  }
  masterVolume = Math.max(0, Math.min(1, volume));
  if (master) master.gain.setTargetAtTime(masterVolume, ctx.currentTime, 0.02);
  for (const handle of htmlHandles) {
    handle._audio.volume = Math.min(1, masterVolume * (handle._opts.volume ?? 1) * (handle._def.volume ?? 1));
  }
}

// Читает каталог звуков (вызывается при загрузке игры, до касания).
export function loadCatalog(list) {
  list.forEach((s) => { catalog[s.id] = s; });
  if (ctx) decodeAll();
}

// Загрузка и декодирование MP3. Начинается после первого касания (нужен ctx).
// Каждый звук грузится один раз; звуки, добавленные в каталог позже, докачиваются.
const failed = [];
const MAX_PARALLEL_LOADS = 4;

function loadSound(def) {
  if (buffers[def.id]) return Promise.resolve(buffers[def.id]);
  if (soundLoads.has(def.id)) return soundLoads.get(def.id);
  const pending = (async () => {
    try {
      const res = await fetch(new URL(def.file, document.baseURI));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      buffers[def.id] = buffer;
      const i = failed.indexOf(def.id);
      if (i !== -1) failed.splice(i, 1);
      return buffer;
    } catch (e) {
      if (!failed.includes(def.id)) failed.push(def.id);
      console.error(`audio: не загрузился звук «${def.id}» (${def.file})`, e);
      return null;
    } finally {
      soundLoads.delete(def.id);
    }
  })();
  soundLoads.set(def.id, pending);
  return pending;
}

function decodeAll() {
  if (!ctx) return Promise.resolve();
  const todo = Object.values(catalog).filter((s) => s.file && !buffers[s.id]);
  let next = 0;
  const workers = Array.from({ length: Math.min(MAX_PARALLEL_LOADS, todo.length) }, async () => {
    while (next < todo.length) await loadSound(todo[next++]);
  });
  return Promise.all(workers).then(() => {
    console.info(`audio: загружено ${Object.keys(buffers).length} из ${Object.keys(catalog).length}`
      + (failed.length ? `, НЕ загрузились: ${failed.join(', ')}` : ''));
  });
}

const stopped = new WeakSet();

// play(soundId, { at, loop, volume }) -> handle { stop() } | null.
// at: позиция графа; без at звук играет «в голове» игрока.
export function play(soundId, opts = {}) {
  ensureSynth(soundId);
  const def = catalog[soundId];
  if (!def) {
    console.warn(`audio.play: звука «${soundId}» нет в каталоге`);
    return null;
  }
  if (manuallyPaused) {
    // На паузе Web Audio остановлен: играем через <audio>. Заглушки превращаются в маленький WAV.
    if (!opts.allowPaused || (!def.file && !SYNTH[soundId])) return null;
    return playPausedHtml(soundId, def, opts);
  }
  if (!ctx) return null;
  resumeContext();

  const handle = { stop() { stopHandle(handle); } };
  handle.finished = new Promise((resolve) => { handle._finish = resolve; });
  handle._id = soundId;
  handle._opts = opts;
  handle._def = def;
  const buf = buffers[soundId];
  if (!buf) {
    // Загрузка может завершиться ошибкой; повторяем её по запросу и используем синтез, если он доступен.
    loadSound(def).then((loaded) => {
      if (stopped.has(handle) || manuallyPaused) return;
      const fallback = loaded ? null : createSynthBuffer(soundId);
      if (loaded || fallback) startHandle(handle, loaded || fallback);
      else if (soundId === 'jumpscare') {
        console.error('audio: jumpscare.mp3 не загрузился, играет запасной синтез');
        const synth = playJumpscare();
        handle._src = { stop: () => synth?.stop() };
      } else finishHandle(handle);
    });
    return handle;
  }
  startHandle(handle, buf);
  return handle;
}

export function whenFinished(handle) {
  return handle?.finished ?? Promise.resolve();
}

function playPausedHtml(soundId, def, opts) {
  const src = new Audio(def.file ? new URL(def.file, document.baseURI).href : synthWavUrl(soundId));
  src.loop = opts.loop ?? def.loop ?? false;
  src.volume = Math.min(1, masterVolume * (opts.volume ?? 1) * (def.volume ?? 1));
  src.preload = 'auto';
  const handle = {
    _id: soundId,
    _opts: opts,
    _def: def,
    _audio: src,
    stop() { stopHandle(handle); },
  };
  htmlHandles.add(handle);
  src.addEventListener('ended', () => htmlHandles.delete(handle), { once: true });
  src.play().catch((e) => {
    htmlHandles.delete(handle);
    if (!stopped.has(handle)) console.warn(`audio: не удалось воспроизвести «${soundId}»`, e);
  });
  return handle;
}

function startHandle(handle, buf) {
  const { at, loop, volume } = handle._opts;
  const def = handle._def;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = loop ?? def.loop;
  // Нарезка: sprite — список [начало, конец] в секундах, играет случайный отрезок (шаги); loopStart/loopEnd — границы петли (клавиатура).
  let offset = 0;
  let dur;
  if (def.sprite?.length) {
    const [a, b] = def.sprite[Math.floor(Math.random() * def.sprite.length)];
    offset = a;
    dur = b - a;
    src.loop = false;
  } else if (src.loop && def.loopEnd) {
    src.loopStart = def.loopStart ?? 0;
    src.loopEnd = def.loopEnd;
  }
  // Шаги: высота меняется на ±5–8% при каждом воспроизведении, чтобы звук не повторялся (раздел 12).
  if (handle._id === 'step') src.playbackRate.value = 1 + (Math.random() < 0.5 ? -1 : 1) * (0.05 + Math.random() * 0.03);

  let node = src;
  let gainVal = (volume ?? 1) * (def.volume ?? 1);
  if (at) {
    const d = distance(at, PLAYER_POS);
    const steps = Number.isFinite(d) ? d : 6;
    gainVal *= Math.max(0.1, 1 - 0.2 * steps);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(500, 8000 - 1300 * steps);
    node.connect(lp);
    node = lp;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = panOf(at) || 0;
      node.connect(pan);
      node = pan;
    }
  }
  const g = ctx.createGain();
  g.gain.value = gainVal;
  // Нарезка с плавным входом и выходом (def.fade, сек), чтобы обрезок не щёлкал.
  if (def.sprite?.length && def.fade) {
    const now = ctx.currentTime;
    const len = dur / src.playbackRate.value;
    const f = Math.min(def.fade, len / 2);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gainVal, now + 0.02);
    g.gain.setValueAtTime(gainVal, now + len - f);
    g.gain.linearRampToValueAtTime(0, now + len);
  }
  node.connect(g);
  g.connect(master);
  src.onended = () => {
    try { g.disconnect(); } catch (e) { /* уже отключён */ }
    finishHandle(handle);
  };
  src.start(0);
  handle._src = src;
  handle._gain = g;
}

function stopHandle(handle) {
  stopped.add(handle);
  finishHandle(handle);
  if (handle._audio) {
    handle._audio.pause();
    handle._audio.currentTime = 0;
    htmlHandles.delete(handle);
    return;
  }
  try { handle._src?.stop(); } catch (e) { /* уже остановлен */ }
}

function finishHandle(handle) {
  if (handle._finished) return;
  handle._finished = true;
  handle._finish?.();
}

export function stop(handle) {
  handle?.stop?.();
}

// Фон: список id (петли). Меняет набор: лишнее гасит, недостающее запускает.
export function setAmbient(list) {
  const want = new Set(list);
  ambient = ambient.filter((a) => {
    if (want.has(a.id)) return true;
    stop(a.handle);
    return false;
  });
  list.forEach((id) => {
    if (ambient.some((a) => a.id === id)) return;
    const handle = play(id, { loop: true });
    if (handle) ambient.push({ id, handle });
  });
}

// ---------- процедурные заглушки для звуков, которых нет в assets/audio ----------
// Работают как обычные звуки каталога (позиция, фильтр, панорама). Чтобы заменить на свой файл,
// добавь запись с тем же id в data/sounds.json: каталог важнее заглушки.
const SYNTH = {
  teams_call: { volume: 0.5, make: makeRingtone },      // входящий звонок Teams (заглушка; свой teams_call.mp3 в sounds.json важнее)
  call_pickup: { volume: 0.9, make: makePickup },       // «трубку взяли»
  call_hangup: { volume: 0.85, make: makeHangup },      // «трубку положили»
  ticket_missed: { volume: 0.65, make: makeTicketMissed },
  cam_reboot: { volume: 0.55, make: makeCamReboot },
  tokens_zero: { volume: 0.75, make: makeTokensZero },
  power_out: { volume: 0.45, make: makePowerOut },
  whistle_mr404: { volume: 0.5, make: makeWhistle },
  laugh_mr404: { volume: 0.8, make: makeLaugh },
  warning_attack: { volume: 0.9, make: makeWarning },
  // звуки кнопок: три разных, по одному на группу интерфейса (меню и пауза, планшет, мини-игра)
  ui_click_menu: { volume: 0.6, make: makeClickMenu },
  ui_click_tablet: { volume: 0.6, make: makeClickTablet },
  ui_click_mg: { volume: 0.6, make: makeClickMg },
  // музыка паузы (петля): заглушка до своего amb_pause.mp3
  amb_pause: { volume: 0.5, loop: true, make: makePauseAmbient },
};

function ensureSynth(id) {
  if (catalog[id]) return;
  const buf = createSynthBuffer(id);
  if (!buf) return;
  buffers[id] = buf;
  catalog[id] = { id, file: null, kind: 'world', loop: !!SYNTH[id].loop, volume: SYNTH[id].volume };
}

// Заглушка -> WAV (16 бит, моно) для <audio>: нужна, пока игра на паузе и Web Audio остановлен.
const wavUrls = {};
function synthWavUrl(id) {
  if (wavUrls[id]) return wavUrls[id];
  const sr = 22050;
  const data = SYNTH[id].make(sr);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  const k = 0.8 / (peak || 1);
  const view = new DataView(new ArrayBuffer(44 + data.length * 2));
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + data.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i] * k)) * 32767, true);
  wavUrls[id] = URL.createObjectURL(new Blob([view], { type: 'audio/wav' }));
  return wavUrls[id];
}

function createSynthBuffer(id) {
  if (!SYNTH[id] || !ctx) return null;
  const key = `synth:${id}`;
  if (buffers[key]) return buffers[key];
  const sr = ctx.sampleRate;
  const data = SYNTH[id].make(sr);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  const buf = ctx.createBuffer(1, data.length, sr);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) ch[i] = data[i] / (peak || 1) * 0.8;
  buffers[key] = buf;
  return buf;
}

// Посвист: два наклонных тона с вибрато и лёгким шумом дыхания.
function makeWhistle(sr) {
  const n = Math.floor(sr * 1.6);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const k = t / 1.6;
    const f = (k < 0.45 ? 1700 + 900 * (k / 0.45) : 2600 - 1100 * ((k - 0.45) / 0.55))
      * (1 + 0.012 * Math.sin(2 * Math.PI * 6 * t));
    ph += 2 * Math.PI * f / sr;
    const env = Math.min(1, t / 0.08) * Math.min(1, (1.6 - t) / 0.25);
    out[i] = (Math.sin(ph) + 0.06 * (Math.random() * 2 - 1)) * env;
  }
  return out;
}

// Смех: пять низких «ха» с затухающим тоном; гармоники с формантами около 700 и 1200 Гц.
function makeLaugh(sr) {
  const n = Math.floor(sr * 2.0);
  const out = new Float32Array(n);
  const bursts = 6;
  for (let b = 0; b < bursts; b++) {
    const start = Math.floor(sr * (0.05 + b * 0.31));
    const len = Math.floor(sr * 0.22);
    const f0 = 150 - b * 7;
    const harm = [];
    for (let h = 1; h <= 24; h++) {
      const f = h * f0;
      const a = (Math.exp(-(((f - 700) / 300) ** 2)) + 0.6 * Math.exp(-(((f - 1200) / 400) ** 2))) / h ** 0.5;
      harm.push([f, a]);
    }
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.015) * Math.exp(-t * 11);
      let v = 0;
      for (const [f, a] of harm) v += a * Math.sin(2 * Math.PI * f * t * (1 - 0.15 * t));
      out[start + i] += (v + 0.15 * (Math.random() * 2 - 1)) * env;
    }
  }
  return out;
}

// Предупреждение: низкий гул с нарастающей пульсацией и поднимающимся тоном.
function makeWarning(sr) {
  const dur = 3.0;
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  let pulsePh = 0;
  let risePh = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const k = t / dur;
    pulsePh += 2 * Math.PI * (2 + 8 * k) / sr;
    const pulse = 0.55 + 0.45 * Math.max(0, Math.sin(pulsePh));
    risePh += 2 * Math.PI * (180 + 520 * k * k) / sr;
    const drone = Math.sin(2 * Math.PI * 55 * t) + 0.6 * Math.sin(2 * Math.PI * 82.5 * t);
    const rise = 0.35 * k * Math.sin(risePh);
    const env = Math.min(1, t / 0.2) * Math.min(1, (dur - t) / 0.1);
    out[i] = (drone * pulse + rise + 0.08 * k * (Math.random() * 2 - 1)) * env;
  }
  return out;
}

// Телефонные звуки (заглушки; свой файл с тем же id в sounds.json важнее).
function tone(out, sr, from, dur, freqs, amp = 1) {
  const a = Math.floor(from * sr);
  const n = Math.floor(dur * sr);
  for (let i = 0; i < n && a + i < out.length; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.01) * Math.min(1, (dur - t) / 0.01);
    let v = 0;
    for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
    out[a + i] += v / freqs.length * env * amp;
  }
}

function makeTicketMissed(sr) {
  const out = new Float32Array(Math.floor(sr * 0.85));
  tone(out, sr, 0.02, 0.22, [740, 587], 0.45);
  tone(out, sr, 0.3, 0.38, [587, 440], 0.4);
  return out;
}

function makeCamReboot(sr) {
  const out = new Float32Array(Math.floor(sr * 0.9));
  tone(out, sr, 0.02, 0.15, [330], 0.3);
  tone(out, sr, 0.22, 0.22, [494], 0.35);
  tone(out, sr, 0.5, 0.3, [659, 988], 0.4);
  return out;
}

function makeTokensZero(sr) {
  const dur = 0.9;
  const out = new Float32Array(Math.floor(sr * dur));
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = 150 - 100 * t / dur;
    const env = Math.exp(-t * 4);
    out[i] = (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * f * 0.5 * t)) * env;
  }
  return out;
}

function makePowerOut(sr) {
  const dur = 12.5;
  const out = new Float32Array(Math.floor(sr * dur));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const fade = Math.max(0, 1 - t / dur);
    const flicker = 0.55 + 0.45 * Math.max(0, Math.sin(2 * Math.PI * (1.4 + t * 0.15) * t));
    phase += 2 * Math.PI * (48 + 4 * Math.sin(2 * Math.PI * 0.3 * t)) / sr;
    const crackle = Math.random() < 0.0007 ? (Math.random() * 2 - 1) * 0.7 : 0;
    out[i] = (0.65 * Math.sin(phase) + 0.25 * Math.sin(phase * 1.5) + crackle) * flicker * fade;
  }
  return out;
}

// Кнопки меню и паузы: сухой «терминальный» тик с коротким писком вниз и низким стуком.
function makeClickMenu(sr) {
  const n = Math.floor(sr * 0.12);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += 2 * Math.PI * (1700 - 7000 * t) / sr;
    const beep = (Math.sin(ph) > 0 ? 1 : -1) * Math.exp(-t * 60) * 0.45;
    const tick = (Math.random() * 2 - 1) * Math.exp(-t * 420) * 0.7;
    const thud = Math.sin(2 * Math.PI * 90 * t) * Math.exp(-t * 38) * 0.5;
    out[i] = beep + tick + thud;
  }
  return out;
}

// Кнопки планшета: мягкое касание по стеклу: короткий звонкий тон и приглушённый удар пальца, потом лёгкий «отрыв».
function makeClickTablet(sr) {
  const n = Math.floor(sr * 0.16);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const tone = Math.sin(2 * Math.PI * (1900 - 2600 * t) * t) * Math.exp(-t * 70) * 0.5;
    const thump = Math.sin(2 * Math.PI * 170 * t) * Math.exp(-t * 55) * 0.55;
    const t2 = t - 0.07;
    const lift = t2 > 0 ? (Math.random() * 2 - 1) * Math.exp(-t2 * 500) * 0.18 : 0;
    out[i] = tone + thump + lift;
  }
  return out;
}

// Кнопки мини-игры: нажатие и отпускание «механической клавиши» офисной клавиатуры.
function makeClickMg(sr) {
  const n = Math.floor(sr * 0.15);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const down = ((Math.random() * 2 - 1) * Math.exp(-t * 520) * 0.7) + Math.sin(2 * Math.PI * 640 * t) * Math.exp(-t * 170) * 0.5;
    const t2 = t - 0.065;
    const up = t2 > 0 ? ((Math.random() * 2 - 1) * Math.exp(-t2 * 650) * 0.4) + Math.sin(2 * Math.PI * 880 * t2) * Math.exp(-t2 * 220) * 0.25 : 0;
    out[i] = down + up;
  }
  return out;
}

// Музыка паузы (заглушка, петля 12 с): тёмный гул с медленной биениями, тонкий призрачный тон и редкие щелчки статики.
// Частоты подобраны так, чтобы на 12 с приходилось целое число периодов: петля без щелчка на стыке.
function makePauseAmbient(sr) {
  const dur = 12;
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  const TAU = 2 * Math.PI;
  const tones = [[55, 0.5, 0], [55.25, 0.4, 1.3], [82.5, 0.3, 0.6], [110, 0.22, 2.1], [165, 0.12, 0.2], [329.5, 0.05, 1.7]];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const swell = 0.7 + 0.3 * Math.sin(TAU * t / 6 - 1.2);      // дыхание: 2 цикла за 12 с
    let v = 0;
    for (const [f, a, p] of tones) v += a * Math.sin(TAU * f * t + p);
    v *= swell;
    v += 0.03 * Math.sin(TAU * 1760 * t) * (0.5 + 0.5 * Math.sin(TAU * 0.25 * t));   // призрачный тон
    out[i] = v;
  }
  // редкие щелчки: детерминированно, чтобы петля всегда звучала одинаково
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let k = 0; k < 28; k++) {
    const start = Math.floor(rnd() * (n - sr * 0.02));
    const amp = 0.12 + rnd() * 0.2;
    const len = Math.floor(sr * (0.002 + rnd() * 0.006));
    for (let j = 0; j < len; j++) out[start + j] += (rnd() * 2 - 1) * amp * (1 - j / len);
  }
  return out;
}

// Рингтон Teams: две трели по четыре двойных тона, потом пауза.
function makeRingtone(sr) {
  const out = new Float32Array(Math.floor(sr * 2.4));
  for (let r = 0; r < 2; r++) {
    for (let k = 0; k < 4; k++) tone(out, sr, r * 0.9 + k * 0.1, 0.07, [880, 1320]);
  }
  return out;
}
function makePickup(sr) {
  const out = new Float32Array(Math.floor(sr * 0.25));
  for (let i = 0; i < out.length; i++) out[i] = (Math.random() * 2 - 1) * Math.exp(-i / sr * 60);
  tone(out, sr, 0.02, 0.05, [300]);
  return out;
}
function makeHangup(sr) {
  const out = new Float32Array(Math.floor(sr * 0.5));
  tone(out, sr, 0, 0.12, [480, 620], 0.8);
  tone(out, sr, 0.2, 0.12, [480, 620], 0.8);
  return out;
}

// Записи звонков (data/calls.json): audio.loadCalls(список) при загрузке игры.
const callDefs = {};
export function loadCalls(map) {
  Object.assign(callDefs, map);
}
// playCall(callId) -> handle { stop(), duration, failed, getTime() } | null.
// getTime() отсчитывается от фактического старта аудио, а не от нажатия «Принять».
export function playCall(callId) {
  const def = callDefs[callId];
  if (manuallyPaused || !def?.audio || !ctx) return null;
  if (ctx.state !== 'running') ctx.resume();
  const handle = {
    duration: null,
    failed: false,
    startedAt: null,
    _stopped: false,
    _src: null,
    getTime() { return this.startedAt === null ? null : Math.max(0, ctx.currentTime - this.startedAt); },
    stop() { this._stopped = true; try { this._src?.stop(); } catch (e) { /* уже остановлен */ } },
  };
  (async () => {
    try {
      if (!buffers[`call:${callId}`]) {
        const res = await fetch(new URL(def.audio, document.baseURI));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buffers[`call:${callId}`] = await ctx.decodeAudioData(await res.arrayBuffer());
      }
      const buf = buffers[`call:${callId}`];
      handle.duration = buf.duration;
      if (handle._stopped || manuallyPaused) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = def.volume ?? 1;
      src.connect(g);
      g.connect(master);
      handle.startedAt = ctx.currentTime;
      src.start(0);
      handle._src = src;
    } catch (e) {
      handle.failed = true;
      console.warn(`audio.playCall: запись «${def.audio}» не загрузилась, звонок идёт без звука`, e);
    }
  })();
  return handle;
}

// ---------- запасной синтез скримера (если jumpscare.mp3 не загрузился) ----------
function playJumpscare() {
  if (!ctx) return null;
  if (ctx.state !== 'running') ctx.resume();
  const t0 = ctx.currentTime;
  const DUR = 1.95;   // обрыв совпадает с чёрным экраном скримера

  const out = ctx.createGain();
  out.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor();
  out.connect(comp);
  comp.connect(master);

  // жёсткое искажение
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const x = (i / 512) - 1; curve[i] = Math.tanh(x * 6); }
  shaper.curve = curve;
  shaper.connect(out);

  // визг: две пилы с тритоновым интервалом, глиссандо вверх, дрожание частоты
  const screechGain = ctx.createGain();
  screechGain.gain.setValueAtTime(0.0001, t0);
  screechGain.gain.exponentialRampToValueAtTime(0.7, t0 + 0.03);
  screechGain.gain.setValueAtTime(0.7, t0 + DUR - 0.02);
  screechGain.gain.linearRampToValueAtTime(0, t0 + DUR);
  screechGain.connect(shaper);
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 23;
  lfoGain.gain.value = 60;
  lfo.connect(lfoGain);
  const oscs = [lfo];
  [1, 1.414].forEach((ratio) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(520 * ratio, t0);
    o.frequency.exponentialRampToValueAtTime(1500 * ratio, t0 + DUR);
    lfoGain.connect(o.frequency);
    o.connect(screechGain);
    oscs.push(o);
  });

  // удар: суб-бас
  const boom = ctx.createOscillator();
  const boomGain = ctx.createGain();
  boom.type = 'sine';
  boom.frequency.setValueAtTime(110, t0);
  boom.frequency.exponentialRampToValueAtTime(32, t0 + 0.7);
  boomGain.gain.setValueAtTime(1, t0);
  boomGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.9);
  boom.connect(boomGain);
  boomGain.connect(out);
  oscs.push(boom);

  // шумовой всплеск
  const len = Math.floor(ctx.sampleRate * DUR);
  const nb = ctx.createBuffer(1, len, ctx.sampleRate);
  const nd = nb.getChannelData(0);
  for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = nb;
  const nf = ctx.createBiquadFilter();
  nf.type = 'bandpass';
  nf.frequency.setValueAtTime(3000, t0);
  nf.frequency.exponentialRampToValueAtTime(800, t0 + 0.6);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.9, t0);
  ng.gain.exponentialRampToValueAtTime(0.12, t0 + 0.5);
  ng.gain.setValueAtTime(0.12, t0 + DUR - 0.02);
  ng.gain.linearRampToValueAtTime(0, t0 + DUR);
  noise.connect(nf);
  nf.connect(ng);
  ng.connect(out);

  oscs.forEach((o) => { o.start(t0); o.stop(t0 + DUR + 0.05); });
  noise.start(t0);
  noise.stop(t0 + DUR + 0.05);
  return { stop() { try { out.gain.setValueAtTime(0, ctx.currentTime); } catch (e) { /* уже остановлен */ } } };
}