// Единственное место, где живёт состояние игры.
// Читать можно через `state` (только чтение), менять только через set() и patch().

const SAVE_KEY = 'kontorka.save.v1';
const SAVE_VERSION = 2;
const TOKEN_RATE = 0.1;   // процентов в секунду на единицу нагрузки (стартовое значение для плейтеста)

function initial() {
  return {
    night: 1,
    time: 0,            // секунды ночи, 0–360
    running: false,     // идёт ли смена
    tokens: 100,        // проценты
    load: 1,
    appetite: 0,        // «аппетит» ИИ, переносится между ночами
    mgScore: { correct: 0, total: 0, weighted: 0, weightTotal: 0, pressure: 0 },
    sla: 70,
    tickets: [],
    enemies: {},
    brokenCams: [],
    camera: null,       // номер открытой камеры или null
    call: { active: false, left: 0, cooldown: 0, at: null }, // звонок-приманка: идёт, осталось, перезарядка (сек), позиция графа, куда звонят
    repairing: false,   // удерживается кнопка починки
    phone: { status: 'idle', kind: null, id: null, name: null, t: 0, sub: null }, // звонки в Teams (calls.js): status incoming | playing
    flags: { demoDone: false, ending: null, unlocked: [] },
    progress: { completedNight: 0, minigamePending: null, minigameIndex: 0, gameComplete: false, summary: null },
  };
}

const _state = initial();

// ---------- чтение только через прокси ----------
function readonly(obj) {
  return new Proxy(obj, {
    get(target, key) {
      const v = Reflect.get(target, key);
      return v && typeof v === 'object' ? readonly(v) : v;
    },
    set() {
      console.warn('state: только для чтения, используй set() или patch()');
      return true;
    },
    deleteProperty() {
      console.warn('state: только для чтения, используй set() или patch()');
      return true;
    },
  });
}
export const state = readonly(_state);

// ---------- события ----------
const handlers = new Map();

export function on(event, fn) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  return () => handlers.get(event)?.delete(fn);
}

export function emit(event, payload) {
  const set = handlers.get(event);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`Ошибка в обработчике "${event}":`, e);
    }
  }
}

// ---------- запись ----------
function walk(path) {
  const keys = path.split('.');
  const last = keys.pop();
  let obj = _state;
  for (const k of keys) {
    if (obj[k] === undefined || obj[k] === null) {
      console.warn(`state: нет пути "${path}"`);
      return null;
    }
    obj = obj[k];
  }
  return { obj, last };
}

export function set(path, value) {
  const w = walk(path);
  if (!w) return;
  if (w.obj[w.last] === value) return;
  w.obj[w.last] = value;
  notify(path, value);
}

// patch('tickets', list => [...list, t])
export function patch(path, fn) {
  const w = walk(path);
  if (!w) return;
  set(path, fn(w.obj[w.last]));
}

function notify(path, value) {
  if (path === 'tokens') emit('tokens:change', { value });
  else if (path === 'load') emit('load:change', { value, overload: value >= 5 });
  else if (path === 'sla') emit('sla:change', { value });
}

// ---------- ночь ----------
// Сбрасывает всё посменное; аппетит, счёт мини-игр и флаги остаются.
export function newNight(n, cfg = {}) {
  _state.night = n;
  _state.time = 0;
  _state.running = false;
  _state.tokens = cfg.startTokens ?? 100;
  _state.load = 1;
  _state.sla = cfg.startSla ?? 70;
  _state.tickets = [];
  _state.enemies = {};
  _state.brokenCams = [];
  _state.camera = null;
  _state.call = { active: false, left: 0, cooldown: 0 };
  _state.repairing = false;
  _state.phone = { status: 'idle', kind: null, id: null, name: null, t: 0, sub: null };
  emit('night:start', { n });
}

// ---------- сохранение ----------
export function save() {
  const data = {
    v: SAVE_VERSION,
    night: _state.night,
    appetite: _state.appetite,
    mgScore: _state.mgScore,
    flags: _state.flags,
    progress: _state.progress,
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    emit('save:change', { available: true });
    return true;
  } catch (e) {
    console.warn('save: не удалось записать', e);
    return false;
  }
}

export function load() {
  let raw;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch (e) {
    console.warn('save: не удалось прочитать сохранение', e);
    return false;
  }
  if (!raw) return false;
  try {
    const d = JSON.parse(raw);
    if (![1, SAVE_VERSION].includes(d.v)) {
      console.warn('save: версия сохранения не совпадает, сохранение сброшено');
      resetSave();
      return false;
    }
    if (!Number.isInteger(d.night) || d.night < 1 || d.night > 5
      || !Number.isFinite(d.appetite) || d.appetite < 0
      || !d.mgScore || !Number.isFinite(d.mgScore.correct) || !Number.isFinite(d.mgScore.total)
      || !Number.isFinite(d.mgScore.weighted) || !d.flags || !Array.isArray(d.flags.unlocked)) {
      throw new Error('некорректная структура сохранения');
    }
    _state.night = d.night;
    _state.appetite = d.appetite;
    _state.mgScore = {
      correct: d.mgScore.correct,
      total: d.mgScore.total,
      weighted: d.mgScore.weighted,
      weightTotal: Number.isFinite(d.mgScore.weightTotal) ? d.mgScore.weightTotal : d.mgScore.total,
      pressure: Number.isFinite(d.mgScore.pressure) ? d.mgScore.pressure : 0,
    };
    _state.flags = {
      demoDone: d.flags.demoDone === true,
      ending: d.flags.ending === 'good' || d.flags.ending === 'bad' ? d.flags.ending : null,
      unlocked: d.flags.unlocked.filter((id) => typeof id === 'string'),
    };
    _state.progress = d.progress && Number.isInteger(d.progress.completedNight)
      && d.progress.completedNight >= 0 && d.progress.completedNight <= 5
      && (d.progress.minigamePending === null
        || (Number.isInteger(d.progress.minigamePending) && d.progress.minigamePending >= 1 && d.progress.minigamePending <= 5))
      && Number.isInteger(d.progress.minigameIndex) && d.progress.minigameIndex >= 0
      && typeof d.progress.gameComplete === 'boolean'
      ? {
        completedNight: Math.min(5, Math.max(0, d.progress.completedNight)),
        minigamePending: d.progress.minigamePending,
        minigameIndex: Math.max(0, d.progress.minigameIndex),
        gameComplete: d.progress.gameComplete,
        summary: d.progress.summary && ['tokens', 'sla', 'resolved', 'missed'].every(
          (key) => Number.isFinite(d.progress.summary[key]),
        ) ? d.progress.summary : null,
      }
      : { completedNight: Math.max(0, d.night - 1), minigamePending: null, minigameIndex: 0, gameComplete: false, summary: null };
    if (d.v === 1) save();
    emit('save:change', { available: true });
    return true;
  } catch (e) {
    console.warn('save: сохранение повреждено, сброшено', e);
    resetSave();
    return false;
  }
}

export function resetSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
    emit('save:change', { available: false });
  } catch (e) {
    console.warn('save: не удалось удалить сохранение', e);
  }
}

// Нагрузка по правилам раздела 5: фон 1, камера +1, звонок-приманка +2, починка +1.
export function recalcLoad() {
  set('load', 1
    + (_state.camera !== null ? 1 : 0)
    + (_state.call.active ? 2 : 0)
    + (_state.repairing ? 1 : 0));
}

// Списание токенов: нагрузка × 0,1% в секунду. Потраченное копится в аппетите ИИ.
export function tickTokens(dt) {
  if (!_state.running || _state.tokens <= 0) return;
  const spent = Math.min(_state.tokens, _state.load * TOKEN_RATE * dt);
  set('tokens', _state.tokens - spent);
  set('appetite', _state.appetite + spent);
}