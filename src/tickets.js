// Тикеты, рейтинг поддержки, поломка камер, починка и сообщения-давление (этап 7).
// Не трогает DOM. Время берёт только из update(dt) и state.time. Состояние пишет через set().
//
// Запись тикета в state.tickets:
//   { id, type, textKey, senderKey, button, cam, x, y, dev, holdSec,
//     openedAt, progress (0..1), done, outcome: 'resolved' | 'missed' | null, closedAt, pressured }
// Враги считают тикет открытым, если done !== true, а возраст берут из state.time - openedAt.

import { state, set, on, emit } from './state.js';
import { cameraIds } from './graph.js';

const DEFAULTS = {
  firstAtSec: 30, intervalSec: [50, 85], maxActive: 2, types: ['pc', 'printer', 'camera'],
  fastSec: 30, slowSec: 75, pressureAfterSec: 45,
  rating: { fast: 3, slow: 1, missed: -12 },
};

let data = null;          // data/tickets.json
let cfg = { ...DEFAULTS };
let list = [];            // собственная копия; в state пишется через publish()
let seq = 0;
let nextAt = Infinity;    // время ночи (сек), когда придёт следующий тикет
let holdId = null;        // тикет, кнопку которого сейчас удерживают
const rebooting = new Map();   // номер камеры -> сколько секунд осталось

const range = ([a, b]) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const find = (id) => list.find((tk) => tk.id === id);
const open = () => list.filter((tk) => !tk.done);

function publish() {
  set('tickets', list.map((tk) => ({ ...tk })));
}

// Данные загружает main.js один раз при запуске.
export function load(json) {
  data = json;
}

// Новая ночь: сбрасываем всё посменное и назначаем первый тикет.
export function start(nightCfg = {}) {
  cfg = { ...DEFAULTS, ...nightCfg, rating: { ...DEFAULTS.rating, ...(nightCfg.rating || {}) } };
  list = [];
  seq = 0;
  holdId = null;
  rebooting.clear();
  nextAt = cfg.firstAtSec;
  publish();
}

function clampSla(v) {
  return Math.max(0, Math.min(100, v));
}

// ---------- создание ----------
function freeDevices(type) {
  const def = data.types[type];
  if (def.devices === 'any') {
    const busy = new Set(open().filter((tk) => tk.type === 'camera').map((tk) => tk.cam));
    return cameraIds()
      .filter((cam) => !state.brokenCams.includes(cam) && !busy.has(cam))
      .map((cam) => ({ cam }));
  }
  const busy = new Set(open().filter((tk) => tk.type === type).map((tk) => tk.dev));
  return def.devices.map((d, i) => ({ ...d, dev: i })).filter((d) => !busy.has(d.dev));
}

function chooseType(forced) {
  if (forced) return data.types[forced] && freeDevices(forced).length ? forced : null;
  const pool = cfg.types.filter((ty) => data.types[ty] && freeDevices(ty).length);
  if (!pool.length) return null;
  let total = pool.reduce((s, ty) => s + (data.types[ty].weight ?? 1), 0);
  let r = Math.random() * total;
  for (const ty of pool) {
    r -= data.types[ty].weight ?? 1;
    if (r <= 0) return ty;
  }
  return pool[0];
}

export function spawn(forcedType = null, forcedDev = null) {
  if (!data) return null;
  const type = chooseType(forcedType);
  if (!type) return null;
  const def = data.types[type];
  const free = freeDevices(type);
  const device = forcedDev !== null ? (free.find((d) => d.dev === forcedDev) ?? pick(free)) : pick(free);
  const tk = {
    id: `t${++seq}`,
    type,
    textKey: pick(def.text),
    senderKey: pick(data.senders),
    button: def.button,
    cam: device.cam,
    x: device.x ?? null,
    y: device.y ?? null,
    dev: device.dev ?? null,
    holdSec: def.holdSec,
    openedAt: state.time,
    progress: 0,
    done: false,
    outcome: null,
    closedAt: null,
    pressured: false,
  };
  list.push(tk);
  if (type === 'camera') {
    set('brokenCams', [...state.brokenCams, tk.cam]);   // ломаем камеру
  }
  publish();
  emit('ticket:new', { id: tk.id });
  return tk;
}

// ---------- закрытие ----------
function close(tk, outcome) {
  tk.done = true;
  tk.outcome = outcome;
  tk.closedAt = state.time;
  tk.progress = outcome === 'resolved' ? 1 : tk.progress;
  if (holdId === tk.id) holdId = null;
  publish();
}

function resolve(tk) {
  const age = state.time - tk.openedAt;
  const bonus = age <= cfg.fastSec ? cfg.rating.fast : cfg.rating.slow;
  close(tk, 'resolved');
  set('sla', clampSla(state.sla + bonus));
  emit('ticket:resolved', { id: tk.id });
}

function miss(tk) {
  close(tk, 'missed');
  set('sla', clampSla(state.sla + cfg.rating.missed));
  emit('ticket:missed', { id: tk.id });
}

// ---------- удержание кнопки починки ----------
function stopHold() {
  if (holdId === null) return;
  const tk = find(holdId);
  holdId = null;
  if (tk && !tk.done && tk.progress > 0) {   // отпустил раньше: прогресс сброшен
    tk.progress = 0;
    publish();
    emit('ticket:progress', { id: tk.id, progress: 0 });
  }
}

on('intent:repairStart', ({ ticketId } = {}) => {
  const tk = find(ticketId);
  if (!tk || tk.done || tk.type === 'camera') return;
  holdId = tk.id;
});

on('intent:repairEnd', stopHold);

// Перезагрузка сломанной камеры (кнопка в окне камеры): holdSec секунд игрового времени.
on('intent:reboot', ({ cam } = {}) => {
  if (!state.running || state.tokens <= 0 || rebooting.has(cam) || !state.brokenCams.includes(cam)) return;
  const durationSec = data?.types?.camera?.holdSec ?? 2;
  rebooting.set(cam, durationSec);
  emit('camera:rebooting', { cam, durationSec });
});

// ---------- каждый кадр ----------
export function update(dt) {
  if (!state.running || !data) return;
  const now = state.time;

  // новый тикет
  if (now >= nextAt) {
    if (open().length < cfg.maxActive && spawn()) nextAt = now + range(cfg.intervalSec);
    else nextAt = now + 3;   // места нет или нечего ломать: пробуем чуть позже
  }

  // удержание кнопки
  if (holdId !== null) {
    const tk = find(holdId);
    if (!tk || tk.done || !state.repairing || state.camera !== tk.cam) {
      stopHold();
    } else {
      tk.progress = Math.min(1, tk.progress + dt / tk.holdSec);
      publish();
      emit('ticket:progress', { id: tk.id, progress: tk.progress });
      if (tk.progress >= 1) resolve(tk);
    }
  }

  // перезагрузка камер
  for (const [cam, left] of [...rebooting]) {
    if (left - dt > 0) { rebooting.set(cam, left - dt); continue; }
    rebooting.delete(cam);
    set('brokenCams', state.brokenCams.filter((c) => c !== cam));
    emit('camera:rebooted', { cam });
    const tk = open().find((x) => x.type === 'camera' && x.cam === cam);
    if (tk) resolve(tk);
  }

  // возраст: давление и пропуск
  for (const tk of open()) {
    const age = now - tk.openedAt;
    if (age >= cfg.slowSec) miss(tk);
    else if (age >= cfg.pressureAfterSec && !tk.pressured) {
      tk.pressured = true;
      publish();
      emit('ticket:pressure', { id: tk.id, key: pick(data.pressure) });
    }
  }
}

// ---------- отладка ----------
on('debug:ticket', (p = {}) => {
  if (!data) return;
  if (p.action === 'spawn') spawn(p.type ?? null, p.dev ?? null);
  else if (p.action === 'resolveAll') open().forEach(resolve);
  else if (p.action === 'tune') {   // подбор точки кнопки: правим данные и открытые тикеты этого устройства
    const def = data.types[p.type];
    const d = def?.devices?.[p.dev];
    if (!d) return;
    d.x = p.x;
    d.y = p.y;
    for (const tk of list) if (tk.type === p.type && tk.dev === p.dev) { tk.x = p.x; tk.y = p.y; }
    publish();
  }
});

// Список устройств для отладочной панели (только чтение).
export function deviceList(type) {
  const d = data?.types?.[type]?.devices;
  return Array.isArray(d) ? d.map((x, i) => ({ ...x, dev: i })) : [];
}

on('night:end', () => { holdId = null; rebooting.clear(); });