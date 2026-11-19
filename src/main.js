// Единственный игровой цикл. Другие модули время берут только из события tick.

import { state, set, patch, emit, on, newNight, recalcLoad, tickTokens, save, load, resetSave } from './state.js';
import { loadLang, t } from './i18n.js';
import * as audio from './audio.js';
import * as desk from './ui/desk.js';
import * as recruitment from './ui/recruitment.js';
import { fadeThrough, isBusy } from './ui/fade.js';
import * as cameras from './ui/cameras.js';
import * as teams from './ui/teams.js';
import * as minigames from './ui/minigames.js';
import * as tickets from './tickets.js';
import * as glitches from './glitches.js';
import * as calls from './calls.js';
import * as graph from './graph.js';
import * as mr404 from './enemies/mr404.js';
import { initDebug } from './debug.js';

const ENEMY_MODULES = { mr404 };   // id врага из nights.json -> модуль src/enemies/<id>.js

const MAX_DT = 0.1; // секунды
const NIGHT_SEC = 360;
const SETTINGS_KEY = 'kontorka.settings.v1';

function detectDeviceLanguage() {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  const preferred = languages.find((language) => /^(?:de|ru)(?:-|$)/i.test(language));
  return preferred?.toLowerCase().startsWith('de') ? 'de' : 'ru';
}

let last = null;
let lastHour = 0;
let gamePaused = false;
let pausedShift = false;
let appCtx = null;
let nights = {};   // data/nights.json
let minigamesData = {};

function frame(now) {
  requestAnimationFrame(frame);
  if (document.hidden) {
    last = null;
    return;
  }
  if (gamePaused) {
    last = now;
    return;
  }
  if (last === null) {
    last = now;
    return;
  }
  const dt = Math.min((now - last) / 1000, MAX_DT);
  last = now;
  emit('tick', { dt });
}

// После возвращения на вкладку не копим большой dt.
document.addEventListener('visibilitychange', () => {
  last = null;
});

// ---------- время смены ----------
on('tick', ({ dt }) => {
  if (!state.running) return;

  const prev = state.time;
  const time = Math.min(NIGHT_SEC, prev + dt);
  set('time', time);

  const hour = Math.floor(time / 60);
  if (hour !== lastHour) {
    lastHour = hour;
    emit('clock:hour', { hour });
  }

  if (time >= NIGHT_SEC) {
    set('running', false);
    emit('night:end', { n: state.night });
  }
});

// ---------- намерения интерфейса ----------
on('intent:startShift', () => {
  if (state.running) return;
  if (state.progress.gameComplete) {
    emit('ending:show', { ending: state.flags.ending, score: state.mgScore });
    return;
  }
  if (state.progress.minigamePending !== null) {
    resumeMinigame();
    return;
  }
  launchNight();
});

on('intent:loadGame', () => {
  if (state.running || isBusy()) return;
  if (!load()) {
    emit('save:change', { available: false });
    return;
  }
  audio.init();
  fadeThrough(() => {
    if (state.progress.gameComplete) {
      emit('ending:show', { ending: state.flags.ending, score: state.mgScore });
    } else if (state.progress.minigamePending !== null) {
      resumeMinigame();
    } else {
      launchNight();
    }
  }, { in: 600 });
});

on('intent:pauseGame', () => {
  if (!state.running && state.progress.minigamePending === null) return;
  pausedShift = state.running;
  gamePaused = true;
  set('running', false);
  audio.setAmbient([]);
  audio.setPaused(true);
  emit('game:paused');
});

on('intent:resumeGame', () => {
  gamePaused = false;
  last = null;
  audio.setPaused(false);
  set('running', pausedShift);
  pausedShift = false;
  if (state.running) syncAmbient();
  emit('game:resumed');
});

on('intent:returnMainMenu', () => {
  if (isBusy()) return;
  gamePaused = false;
  pausedShift = false;
  last = null;
  if (state.running) set('running', false);
  emit('game:exit');
  stopHoldSound();
  if (lureSnd) { audio.stop(lureSnd); lureSnd = null; }
  if (alarm) { audio.stop(alarm); alarm = null; }
  if (state.camera !== null) {
    set('camera', null);
    emit('camera:close');
  }
  set('repairing', false);
  set('call.active', false);
  set('call.left', 0);
  recalcLoad();
  audio.setAmbient([]);
  audio.setPaused(true);
  save();
  fadeThrough(() => emit('game:menu'));
});

function launchNight() {
  gamePaused = false;
  pausedShift = false;
  last = null;
  audio.init();
  overloaded = false;
  warning = false;
  syncAmbient();
  newNight(state.night, nights[state.night] || {});
  lastHour = 0;
  set('running', true);
}

on('intent:newGame', () => {
  if (state.running || isBusy()) return;
  fadeThrough(() => {
    resetSave();
    set('night', 1);
    set('appetite', 0);
    set('mgScore', { correct: 0, total: 0, weighted: 0, weightTotal: 0, pressure: 0 });
    set('flags', { demoDone: false, ending: null, unlocked: [] });
    set('progress', { completedNight: 0, minigamePending: null, minigameIndex: 0, gameComplete: false, summary: null });
    recruitment.mount(document.getElementById('app'), appCtx);
  }, { in: 600 });
});

function gameForNight(night) {
  const expectedId = nights[night]?.minigame;
  const byId = expectedId && minigamesData.games?.[expectedId];
  if (byId) return byId;
  return Object.values(minigamesData.games ?? {}).find((game) => game.night === night) ?? null;
}

function minigameSummary() {
  return {
    tokens: Math.ceil(state.tokens),
    sla: Math.round(state.sla),
    resolved: state.tickets.filter((ticket) => ticket.outcome === 'resolved').length,
    missed: state.tickets.filter((ticket) => ticket.outcome === 'missed').length,
  };
}

function resumeMinigame() {
  const night = state.progress.minigamePending;
  const game = gameForNight(night);
  if (!game) {
    console.error(`minigame: нет данных мини-игры для ночи ${night}`);
    return;
  }
  if (state.progress.minigameIndex >= game.requests.length) {
    emit('minigame:complete', { night, game, score: state.mgScore });
    return;
  }
  emit('minigame:start', {
    night,
    game,
    index: state.progress.minigameIndex,
    summary: state.progress.summary ?? minigameSummary(),
    score: state.mgScore,
  });
}

on('night:end', ({ n, failed }) => {
  if (failed || state.progress.gameComplete) return;
  set('progress', {
    completedNight: n,
    minigamePending: n,
    minigameIndex: 0,
    gameComplete: false,
    summary: minigameSummary(),
  });
  save();
  const chime = audio.play('night_end_chime');
  audio.whenFinished(chime).then(() => fadeThrough(() => resumeMinigame(), { out: 900 }));
});

on('intent:minigameBegin', () => {
  if (state.progress.minigamePending === null) return;
  const game = gameForNight(state.progress.minigamePending);
  if (!game) {
    console.error(`minigame: нет данных мини-игры для ночи ${state.progress.minigamePending}`);
    return;
  }
  emit('minigame:question', {
    night: state.progress.minigamePending,
    game,
    index: state.progress.minigameIndex,
    score: state.mgScore,
  });
});

on('intent:minigameAnswer', ({ optionId = null, timeout = false } = {}) => {
  const night = state.progress.minigamePending;
  const game = gameForNight(night);
  const index = state.progress.minigameIndex;
  const request = game?.requests?.[index];
  if (!request) return;
  if (!timeout && !request.options?.some((option) => option.id === optionId)) return;

  let outcome = 'neutral';
  if (!request.decoy) {
    outcome = timeout
      ? (request.idleCorrect ? 'correct' : 'incorrect')
      : (optionId === request.correctOptionId ? 'correct' : 'incorrect');
  }
  const weight = game.weight ?? 0;
  if (weight > 0 && outcome !== 'neutral') {
    const score = { ...state.mgScore };
    score.total += 1;
    score.weightTotal += weight;
    const effects = minigamesData.effects ?? {};
    const pressureDelta = (effects.pressurePerWeight ?? 1) * weight;
    if (outcome === 'correct') {
      score.correct += 1;
      score.weighted += weight;
      score.pressure += pressureDelta;
      set('appetite', Math.max(0, state.appetite + (effects.correctAppetite ?? -2)));
    } else {
      score.pressure -= pressureDelta;
      set('appetite', Math.max(0, state.appetite + (effects.incorrectAppetite ?? 3)));
    }
    const limit = effects.pressureLimit ?? 10;
    score.pressure = Math.max(-limit, Math.min(limit, score.pressure));
    set('mgScore', score);
  }

  const nextIndex = index + 1;
  set('progress', { ...state.progress, minigameIndex: nextIndex });
  save();
  const isComplete = nextIndex >= game.requests.length;
  emit(isComplete ? 'minigame:complete' : 'minigame:answer', {
    night,
    outcome,
    index,
    nextIndex,
    game,
    score: state.mgScore,
  });
});

on('intent:minigameFinish', () => {
  const night = state.progress.minigamePending;
  if (night === null || state.progress.minigameIndex < (gameForNight(night)?.requests?.length ?? Infinity)) return;
  if (night < 5) {
    set('progress', { completedNight: night, minigamePending: null, minigameIndex: 0, gameComplete: false, summary: null });
    set('night', night + 1);
    save();
    fadeThrough(() => emit('minigame:close', { nextNight: night + 1 }));
    return;
  }
  const ratio = state.mgScore.weightTotal > 0 ? state.mgScore.weighted / state.mgScore.weightTotal : 0;
  const ending = ratio >= (minigamesData.goodEndingThreshold ?? 0.6) ? 'good' : 'bad';
  set('flags', { ...state.flags, demoDone: true, ending });
  set('progress', { completedNight: 5, minigamePending: null, minigameIndex: 0, gameComplete: true, summary: null });
  save();
  fadeThrough(() => emit('ending:show', { ending, score: state.mgScore, ratio }));
});

on('intent:endingClose', () => {
  if (!state.progress.gameComplete || isBusy()) return;
  fadeThrough(() => emit('minigame:close', { ending: state.flags.ending }));
});

// Открытие камеры: состояние и событие; вид рисует ui/cameras.js.
on('intent:openCamera', ({ id }) => {
  if (!state.running || state.tokens <= 0) return;
  if (state.repairing && state.camera !== id) set('repairing', false);   // кнопка починки осталась на прошлой камере
  set('camera', id);
  recalcLoad();
  emit('camera:open', { id });
});

on('intent:closeCamera', () => {
  if (state.camera === null) return;
  if (state.repairing) set('repairing', false);
  set('camera', null);
  recalcLoad();
  emit('camera:close');
});

// Конец смены закрывает камеру: на экране итога остаётся стол.
on('night:end', () => {
  if (state.camera === null) return;
  set('camera', null);
  recalcLoad();
  emit('camera:close');
});

// ---------- токены, звонок-приманка, починка (этап 5) ----------
const lureCfg = () => nights[state.night]?.enemies?.mr404?.lure ?? {};

on('tick', ({ dt }) => {
  if (!state.running) return;
  tickTokens(dt);

  if (state.call.active) {
    const left = state.call.left - dt;
    if (left <= 0) endCall();
    else set('call.left', left);
  } else if (state.call.cooldown > 0) {
    set('call.cooldown', Math.max(0, state.call.cooldown - dt));
  }
});

function endCall() {
  set('call.active', false);
  set('call.left', 0);
  set('call.cooldown', lureCfg().cooldownSec ?? 25);
  set('call.at', null);
  recalcLoad();
  emit('call:end', { id: 'lure', kind: 'lure' });
}

on('intent:call', () => {
  if (!state.running || state.tokens <= 0) return;
  // Звонок привязан к месту: звонит телефон в комнате открытой камеры, враг идёт туда сам.
  const at = state.camera !== null ? graph.cameraMeta(state.camera)?.pos : null;
  if (!at) return;
  // В окне атаки (враг на s_hall3 и виден на камерах) перезарядка приманки не действует (раздел 18).
  const dwelling = Object.values(state.enemies).some((e) => e.dwell);
  if (state.call.active || (state.call.cooldown > 0 && !dwelling)) return;
  if (dwelling) set('call.cooldown', 0);
  set('call.active', true);
  set('call.left', lureCfg().callSec ?? 8);
  set('call.at', at);
  recalcLoad();
  emit('call:start', { id: 'lure', kind: 'lure', at });
});

// Удержание кнопки починки даёт +1 к нагрузке. Прогресс тикета считает tickets.js.
on('intent:repairStart', () => {
  if (!state.running || state.tokens <= 0 || state.repairing) return;
  set('repairing', true);
  recalcLoad();
});

on('intent:repairEnd', () => {
  if (!state.repairing) return;
  set('repairing', false);
  recalcLoad();
});

// 0% токенов: камеры, звонок и починка отключаются; тикеты продолжают приходить.
on('tokens:change', ({ value }) => {
  if (value > 0 || !state.running) return;
  if (state.camera !== null) {
    set('camera', null);
    emit('camera:close');
  }
  if (state.call.active) endCall();
  set('repairing', false);
  recalcLoad();
});

// Конец смены сбрасывает звонок и починку.
on('night:end', () => {
  set('call.active', false);
  set('call.left', 0);
  set('call.cooldown', 0);
  set('repairing', false);
  recalcLoad();
});

// ---------- враги (этап 6) ----------
// Враг сам решает, куда идти, и сообщает событиями; в state.enemies их отражает main.js.
let enemies = [];

function mirrorEnemy(id, patchObj) {
  const cur = {};
  for (const [k, v] of Object.entries(state.enemies)) cur[k] = { ...v };
  cur[id] = { status: 'idle', ...(cur[id] || {}), ...patchObj };
  set('enemies', cur);
}

on('enemy:moved', ({ id, to }) => {
  if (to === null) {
    const cur = {};
    for (const [k, v] of Object.entries(state.enemies)) if (k !== id) cur[k] = { ...v };
    set('enemies', cur);
    return;
  }
  mirrorEnemy(id, { pos: to });
});

on('enemy:status', ({ id, status, dwell = false }) => mirrorEnemy(id, { status, dwell }));

on('night:start', () => {
  enemies = [];
  const cfgs = nights[state.night]?.enemies ?? {};
  for (const [id, cfg] of Object.entries(cfgs)) {
    const mod = ENEMY_MODULES[id];
    if (!mod) { console.warn(`enemies: нет модуля для «${id}»`); continue; }
    enemies.push(mod.create(cfg, { state, graph, audio, emit, rng: Math.random }));
  }
});

on('tick', ({ dt }) => {
  if (!state.running) return;
  for (const e of enemies) e.update(dt);
});

// Враги получают звонки и команды отладки через onEvent, а не подписываются сами.
for (const name of ['call:start', 'call:end', 'debug:enemy']) {
  on(name, (payload) => enemies.forEach((e) => e.onEvent(name, payload)));
}

// Скример: смена заканчивается провалом. Кадр рисует ui/desk.js, потом стартовый экран «Смена провалена».
on('jumpscare', ({ enemyId }) => {
  console.info(`jumpscare: ${enemyId}`);
  set('running', false);
  emit('night:end', { n: state.night, failed: true });
});

on('night:end', () => { enemies = []; });

// Прослушанная запись ночи открывает привязанные к ней записи архива (flags.unlocked: 'call:<id>').
// Открывает только запись, прослушанная до конца: call:end story с outcome 'finished' (решено разработчиком).
on('call:end', ({ id, kind, outcome }) => {
  if (kind !== 'story' || outcome !== 'finished') return;
  patch('flags.unlocked', (list) => (list.includes(`call:${id}`) ? list : [...list, `call:${id}`]));
});

// ---------- тикеты (этап 7) ----------
// Создание, рейтинг, поломка камер, починка и перезагрузка живут в tickets.js; здесь только проводка.
on('night:start', () => tickets.start(nights[state.night]?.tickets ?? {}));

on('tick', ({ dt }) => {
  if (!state.running) return;
  tickets.update(dt);
});

// ---------- глюки (этап 9) ----------
// Условия и расписание решает glitches.js; UI-модули только показывают события.
const glitchMod = glitches.create({ state, emit, on, rng: Math.random });
on('night:start', () => glitchMod.start(nights[state.night] ?? {}));
on('tick', () => { if (state.running) glitchMod.update(); });
on('debug:glitch', (p) => glitchMod.debug(p, nights[state.night] ?? nights[1] ?? {}));

// ---------- звуки интерфейса ----------
let alarm = null;
let holdSnd = null;   // петля починки, пока идёт прогресс удержания
let lureSnd = null;   // звонок-приманка
function stopHoldSound() { if (holdSnd) { audio.stop(holdSnd); holdSnd = null; } }
// tickets.js шлёт ticket:progress каждый кадр удержания, а при отпускании — progress 0.
on('ticket:progress', ({ progress }) => {
  if (progress > 0 && progress < 1) { if (!holdSnd) holdSnd = audio.play('repair_hold'); }
  else stopHoldSound();
});
// Звонок слышен там, где звонит телефон (at): громкость, фильтр и панорама по расстоянию до стола.
on('call:start', ({ kind, at }) => {
  if (kind !== 'lure') return;
  audio.stop(lureSnd);
  lureSnd = audio.play('agent_lure', at ? { at } : {});
});
on('call:end', ({ kind }) => { if (kind === 'lure' && lureSnd) { audio.stop(lureSnd); lureSnd = null; } });
on('camera:open', () => audio.play('cam_switch'));
const printerSnds = new Map();   // id тикета -> звук печати
// Принтер печатает на позиции устройства: игрок слышит, с какой стороны тикет (текст тикета места не называет).
on('ticket:new', ({ id }) => {
  const tk = state.tickets.find((x) => x.id === id);
  if (tk?.type !== 'printer') return;
  const at = graph.cameraMeta(tk.cam)?.pos;
  printerSnds.set(id, audio.play('printer_work', at ? { at } : {}));
});
// Звук печати длинный (около 36 с): когда тикет закрыт, принтер затихает.
on('ticket:resolved', ({ id }) => { audio.stop(printerSnds.get(id)); printerSnds.delete(id); });
on('ticket:missed', ({ id }) => { audio.stop(printerSnds.get(id)); printerSnds.delete(id); });
function stopPrinterSounds() {
  for (const handle of printerSnds.values()) audio.stop(handle);
  printerSnds.clear();
}
on('night:start', stopPrinterSounds);
on('night:end', stopPrinterSounds);
let shutdownSndPlayed = false;
on('night:start', () => {
  shutdownSndPlayed = false;
});
on('tokens:change', ({ value }) => {
  if (value > 0 || !state.running || shutdownSndPlayed) return;
  shutdownSndPlayed = true;
  audio.play('tokens_zero');
  audio.play('power_out');
});
on('ticket:new', () => audio.play('teams_ping'));
on('ticket:missed', () => audio.play('ticket_missed'));
const cameraRepairSounds = new Map();
function stopCameraRepairSounds() {
  for (const handle of cameraRepairSounds.values()) audio.stop(handle);
  cameraRepairSounds.clear();
}
on('camera:rebooting', ({ cam }) => {
  audio.stop(cameraRepairSounds.get(cam));
  cameraRepairSounds.set(cam, audio.play('repair_hold', { loop: true }));
});
on('camera:rebooted', ({ cam }) => {
  audio.stop(cameraRepairSounds.get(cam));
  cameraRepairSounds.delete(cam);
  audio.play('cam_reboot');
});
on('ticket:resolved', ({ id }) => {
  stopHoldSound();
  const tk = state.tickets.find((ticket) => ticket.id === id);
  if (tk?.type !== 'camera') audio.play('repair_done');
});
on('game:exit', stopCameraRepairSounds);
// Сообщение-давление: сначала слышна клавиатура на позиции устройства тикета, пока «печатает…», потом звук Teams.
on('ticket:pressure', ({ id, key }) => {
  const tk = state.tickets.find((x) => x.id === id);
  const at = tk ? graph.cameraMeta(tk.cam)?.pos : null;
  const sec = teams.typingSec(t(key));
  const kb = audio.play('keyboard', { ...(at ? { at } : {}), loop: true });
  setTimeout(() => { audio.stop(kb); if (state.running) audio.play('teams_pressure'); }, sec * 1000);
});
on('glitch', ({ source }) => { if (source === 'ai') audio.play('glitch_ai'); });
on('glitch', ({ type, target }) => {
  if (type === 'cursorSwitch' && Number.isInteger(target) && target >= 1 && target <= 11) {
    emit('intent:openCamera', { id: target });
  }
});
// Фон: гул и ночь всегда; напряжение при перегрузке сети и во время предупреждения об атаке; темнота с ночи 4.
let overloaded = false;
let warning = false;
function syncAmbient() {
  const list = ['amb_pc_hum', 'amb_night'];
  if (overloaded || warning) list.push('amb_tension');
  if (state.night >= 4) list.push('amb_dark');
  audio.setAmbient(list);
}
on('enemy:status', ({ status }) => { warning = status === 'warning'; if (state.running) syncAmbient(); });
on('load:change', ({ overload }) => {
  overloaded = overload;
  if (state.running) syncAmbient();
  if (overload && !alarm) alarm = audio.play('overload_alarm');
  else if (!overload && alarm) { audio.stop(alarm); alarm = null; }
});
// Шум открытой камеры (amb_cam_feed) и помехи сломанной камеры (cam_static): петли, пока камера открыта.
let feedSnd = null;
let staticSnd = null;
on('tick', () => {
  const open = state.running && state.camera !== null;
  const broken = open && state.brokenCams.includes(state.camera);
  if (open && !feedSnd) feedSnd = audio.play('amb_cam_feed');
  else if (!open && feedSnd) { audio.stop(feedSnd); feedSnd = null; }
  if (broken && !staticSnd) staticSnd = audio.play('cam_static');
  else if (!broken && staticSnd) { audio.stop(staticSnd); staticSnd = null; }
});

// Щелчок интерфейса на любой кнопке.
document.addEventListener('pointerdown', (e) => {
  const button = e.target.closest?.('button');
  if (!button || button.dataset.actionSound || e.target.closest?.('.dbg-panel, .dbg-toggle')) return;
  const overlay = button.closest('.main-menu, .pause-screen, .shift-failed, .mg-screen, .rc-root');
  if (button.dataset.noUiClick !== 'true' || overlay) {
    const paused = !!button.closest('.pause-screen, .main-menu.is-pause-settings');
    audio.play('ui_click', paused ? { allowPaused: true } : {});
  }
});
document.addEventListener('pointerover', (e) => {
  const button = e.target.closest?.('button');
  if (!button || button.disabled || (e.relatedTarget && button.contains(e.relatedTarget))
    || !button.closest('.main-menu, .pause-screen')) return;
  const paused = !!button.closest('.pause-screen, .main-menu.is-pause-settings');
  audio.play('ui_click', { volume: 0.3, ...(paused ? { allowPaused: true } : {}) });
});

on('night:end', () => {
  audio.setAmbient([]);
  stopHoldSound();
  stopCameraRepairSounds();
  if (lureSnd) { audio.stop(lureSnd); lureSnd = null; }
  if (alarm) { audio.stop(alarm); alarm = null; }
});

// ---------- запуск ----------
async function loadJSON(path) {
  const res = await fetch(new URL(path, document.baseURI));
  if (!res.ok) throw new Error(`Не удалось загрузить ${path} (${res.status})`);
  return res.json();
}

on('intent:recruitDone', () => {
  fadeThrough(() => {
    recruitment.unmount();
    launchNight();
  });
});

async function boot() {
  let settings = { language: detectDeviceLanguage(), languageAuto: true, volume: 0.8 };
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const languageAuto = stored.languageAuto === true
      || (stored.languageAuto === undefined && stored.language !== 'de');
    settings = {
      language: languageAuto
        ? detectDeviceLanguage()
        : (stored.language === 'de' ? 'de' : 'ru'),
      languageAuto,
      volume: Number.isFinite(stored.volume) ? Math.max(0, Math.min(1, stored.volume)) : 0.8,
    };
  } catch (e) {
    console.warn('settings: не удалось прочитать настройки', e);
  }
  await loadLang(settings.language);
  audio.setMasterVolume(settings.volume);
  graph.loadGraph(await loadJSON('data/rooms.json'));
  try {
    audio.loadCatalog(await loadJSON('data/sounds.json'));
  } catch (e) {
    console.warn('sounds.json не загружен, звука не будет', e);
  }
  try {
    nights = await loadJSON('data/nights.json');
  } catch (e) {
    console.warn('nights.json не загружен, берутся значения по умолчанию', e);
  }

  try {
    tickets.load(await loadJSON('data/tickets.json'));
  } catch (e) {
    console.warn('tickets.json не загружен, тикеты отключены', e);
  }
  try {
    calls.load(await loadJSON('data/calls.json'));
  } catch (e) {
    console.warn('calls.json не загружен, звонков не будет', e);
  }
  try {
    teams.setArchive(await loadJSON('data/teams-archive.json'));
  } catch (e) {
    console.warn('teams-archive.json не загружен, архив пуст', e);
  }
  try {
    minigamesData = await loadJSON('data/minigames.json');
  } catch (e) {
    console.error('minigames.json не загружен, переходы между ночами недоступны', e);
  }

  const hasSave = load();
  appCtx = { state, t, emit, on, settings, hasSave };
  desk.mount(document.getElementById('app'), appCtx);
  cameras.mount(document.getElementById('monitor-left'), appCtx);
  teams.mount(document.getElementById('monitor-right'), appCtx);
  minigames.mount(document.getElementById('app'), appCtx);
  initDebug();

  if (state.progress.gameComplete) {
    emit('ending:show', { ending: state.flags.ending, score: state.mgScore });
  }

  requestAnimationFrame(frame);
}

boot().catch((e) => console.error('Не удалось запустить игру:', e));