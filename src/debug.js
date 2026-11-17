// Скрытая отладочная панель. Включается через ?debug=1 или Ctrl+Shift+D.
// Игровой логики здесь нет: только set() и emit().
// Каждый следующий этап добавляет свои кнопки через addSection().

import { state, set, emit, on } from './state.js';
import { t } from './i18n.js';
import {
  positionIds, labelOf, neighbors, distance, camerasFor, isBlind, panOf, validateGraph,
  cameraIds, cameraMeta, poseIds, PLAYER_POS,
} from './graph.js';
import * as audio from './audio.js';
import { deviceList } from './tickets.js';   // только чтение списка устройств

const sections = [];   // { id, titleKey, build }
const refreshers = []; // функции, обновляющие показания из state
let panel = null;
let body = null;
let toggleBtn = null;
let mounted = false;

// ---------- маленький помощник для DOM ----------
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) e.append(kid);
  return e;
}

const CSS = `
.dbg-toggle, .dbg-panel { position: fixed; z-index: 1000; font: 12px/1.3 system-ui, sans-serif; color: #cfe8cf; }
.dbg-toggle {
  top: calc(env(safe-area-inset-top, 0px) + 0.4rem); right: calc(env(safe-area-inset-right, 0px) + 0.4rem);
  min-width: 3rem; min-height: 2.4rem; padding: 0 0.6rem;
  background: #0b140b; border: 1px solid #3a5a3a; border-radius: 0.3rem; color: #9fdc9f; font: inherit; font-weight: 700;
}
.dbg-panel {
  top: calc(env(safe-area-inset-top, 0px) + 3.2rem); right: calc(env(safe-area-inset-right, 0px) + 0.4rem);
  width: 16.5rem; max-height: calc(100% - 4rem); overflow-y: auto;
  background: rgba(6, 12, 6, 0.92); border: 1px solid #3a5a3a; border-radius: 0.4rem; padding: 0.5rem;
  -webkit-user-select: none; user-select: none;
}
.dbg-panel[hidden] { display: none; }
.dbg-title { margin: 0 0 0.4rem; font-size: 13px; color: #9fdc9f; }
.dbg-section { margin: 0 0 0.6rem; padding-top: 0.4rem; border-top: 1px solid #1f3a1f; }
.dbg-section h3 { margin: 0 0 0.35rem; font-size: 12px; color: #7fb87f; font-weight: 600; }
.dbg-row { display: flex; align-items: center; gap: 0.4rem; margin: 0 0 0.35rem; }
.dbg-row > label { flex: 0 0 5.2rem; }
.dbg-row input[type=range] { flex: 1; min-width: 0; height: 1.8rem; }
.dbg-row output { flex: 0 0 2.2rem; text-align: right; font-variant-numeric: tabular-nums; }
.dbg-btns { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0 0 0.35rem; }
.dbg-btn, .dbg-row select {
  min-height: 2.2rem; padding: 0 0.6rem; font: inherit; color: #cfe8cf;
  background: #101810; border: 1px solid #3a5a3a; border-radius: 0.3rem;
}
.dbg-btn:active { background: #1d2d1d; }
.dbg-info { margin: 0 0 0.35rem; white-space: pre-wrap; color: #b9d9b9; font-size: 11px; }
.dbg-status { margin: 0 0 0.4rem; color: #9fdc9f; font-variant-numeric: tabular-nums; }
`;

function clockText(timeSec) {
  const m = Math.min(360, Math.floor(timeSec));
  const hour = Math.floor(m / 60);
  return `${hour === 0 ? 12 : hour}:${String(m % 60).padStart(2, '0')}`;
}

// ---------- элементы управления ----------
function button(labelKey, onPress) {
  return h('button', { class: 'dbg-btn', type: 'button', onpointerup: onPress }, t(labelKey));
}

function slider({ labelKey, path, min, max, step = 1 }) {
  let dragging = false;
  const out = h('output', {}, '');
  const input = h('input', { type: 'range', min, max, step });
  input.addEventListener('pointerdown', () => { dragging = true; });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('pointercancel', () => { dragging = false; });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = String(Math.round(v));
    set(path, v);
  });
  const sync = () => {
    if (dragging) return;
    const v = state[path];
    input.value = v;
    out.textContent = String(Math.round(v));
  };
  refreshers.push(sync);
  sync();
  return h('div', { class: 'dbg-row' }, h('label', {}, t(labelKey)), input, out);
}

// ---------- встроенные разделы ----------
function buildShift(el) {
  const select = h('select', {});
  for (let n = 1; n <= 5; n++) select.append(h('option', { value: n }, String(n)));
  select.addEventListener('change', () => set('night', Number(select.value)));
  refreshers.push(() => {
    if (document.activeElement !== select) select.value = state.night;
  });
  select.value = state.night;

  const status = h('p', { class: 'dbg-status' }, '');
  refreshers.push(() => {
    status.textContent = t('debug.status', {
      n: state.night,
      clock: clockText(state.time),
      load: state.load,
      state: t(state.running ? 'debug.state.running' : 'debug.state.stopped'),
    });
  });

  const skip = (sec) => set('time', Math.min(360, Math.max(0, state.time + sec)));

  el.append(
    status,
    h('div', { class: 'dbg-row' }, h('label', {}, t('debug.night')), select),
    h('div', { class: 'dbg-btns' },
      button('debug.restart', () => {
        set('running', false);
        emit('intent:startShift');
      })),
    h('div', { class: 'dbg-btns' },
      button('debug.skip.10m', () => skip(10)),
      button('debug.skip.1h', () => skip(60)),
      button('debug.skip.end', () => set('time', 355))),
  );
}

function buildResources(el) {
  el.append(
    slider({ labelKey: 'debug.tokens', path: 'tokens', min: 0, max: 100 }),
    slider({ labelKey: 'debug.sla', path: 'sla', min: 0, max: 100 }),
    slider({ labelKey: 'debug.appetite', path: 'appetite', min: 0, max: 500 }),
  );
}

function buildGraph(el) {
  const issues = validateGraph();
  const check = h('p', { class: 'dbg-info' },
    issues.length
      ? [t('debug.graph.issues', { n: issues.length }), ...issues].join('\n')
      : t('debug.graph.ok'));

  const select = h('select', {});
  select.append(h('option', { value: '' }, t('debug.pos.none')));
  for (const id of positionIds()) select.append(h('option', { value: id }, t(labelOf(id))));
  const info = h('p', { class: 'dbg-info' }, '');

  select.addEventListener('change', () => {
    const id = select.value;
    if (!id) {
      info.textContent = '';
      emit('debug:highlight', { pos: null, neighbors: [] });
      return;
    }
    const nb = neighbors(id);
    const d = distance(id, 'desk');
    const cams = camerasFor(id);
    info.textContent = [
      `${t('debug.graph.neighbors')}: ${nb.map((n) => t(labelOf(n))).join(', ') || t('debug.graph.none')}`,
      `${t('debug.graph.distance')}: ${Number.isFinite(d) ? d : '∞'}`,
      `${t('debug.graph.cams')}: ${isBlind(id)
        ? t('debug.graph.blind')
        : cams.map((c) => t('debug.graph.camEntry', c)).join(', ')}`,
      `${t('debug.graph.pan')}: ${panOf(id)}`,
    ].join('\n');
    emit('debug:highlight', { pos: id, neighbors: nb });
  });

  el.append(h('div', { class: 'dbg-row' }, h('label', {}, t('debug.pos')), select), info, check);
}

function buildCameras(el) {
  const select = h('select', {});
  for (const id of cameraIds()) {
    select.append(h('option', { value: id }, t('cams.caption', { n: id, name: t(cameraMeta(id).name) })));
  }
  const cam = () => Number(select.value);

  // Подстройка кадра выбранной камеры: смотри вид, крути, значения из текста ниже копируй в rooms.json
  const tunes = {};
  const dump = h('p', { class: 'dbg-info' }, '');
  const current = () => tunes[cam()] ?? { brightness: 1, contrast: 1 };
  const tuneRow = (labelKey, field) => {
    const out = h('output', {}, '1');
    const input = h('input', { type: 'range', min: 0.2, max: 2.5, step: 0.05, value: 1 });
    input.addEventListener('input', () => {
      const cur = { ...current(), [field]: Number(input.value) };
      tunes[cam()] = cur;
      out.textContent = input.value;
      emit('debug:tune', { cam: cam(), ...cur });
      dump.textContent = Object.entries(tunes)
        .map(([c, v]) => `cam ${c}: "tune": { "brightness": ${v.brightness}, "contrast": ${v.contrast} }`)
        .join('\n');
    });
    select.addEventListener('change', () => {
      input.value = current()[field];
      out.textContent = String(input.value);
    });
    return h('div', { class: 'dbg-row' }, h('label', {}, t(labelKey)), input, out);
  };

  el.append(
    h('div', { class: 'dbg-row' }, h('label', {}, t('debug.cam')), select),
    h('div', { class: 'dbg-btns' },
      button('debug.cam.open', () => emit('intent:openCamera', { id: cam() })),
      button('debug.cam.close', () => emit('intent:closeCamera')),
      button('debug.cam.flash', () => emit('debug:flash'))),
    h('div', { class: 'dbg-btns' },
      button('debug.cam.break', () => {
        if (!state.brokenCams.includes(cam())) set('brokenCams', [...state.brokenCams, cam()]);
      }),
      button('debug.cam.fix', () => set('brokenCams', state.brokenCams.filter((c) => c !== cam())))),
    tuneRow('debug.cam.bright', 'brightness'),
    tuneRow('debug.cam.contrast', 'contrast'),
    dump,
  );
}

// Спрайты врага на камерах: поставить врага в позицию, открыть камеру, подогнать место и размер.
// Готовые строки копируются в cams нужной позиции в rooms.json.
function buildEnemies(el) {
  const ENEMY = 'mr404';
  const posSel = h('select', {});
  posSel.append(h('option', { value: '' }, t('debug.pos.none')));
  for (const id of positionIds()) if (id !== 'desk') posSel.append(h('option', { value: id }, t(labelOf(id))));
  const camSel = h('select', {});
  const poseSel = h('select', {});
  for (const p of poseIds(ENEMY)) poseSel.append(h('option', { value: p }, p));
  const dump = h('p', { class: 'dbg-info' }, '');
  const tuned = {};   // `${pos}:${cam}` -> запись для rooms.json
  let current = null; // запись, которую сейчас правим

  const fields = {};
  const row = (labelKey, field, min, max, step) => {
    const out = h('output', {}, '');
    const input = h('input', { type: 'range', min, max, step });
    input.addEventListener('input', () => {
      if (!current) return;
      current[field] = Number(input.value);
      out.textContent = input.value;
      push();
    });
    fields[field] = { input, out };
    return h('div', { class: 'dbg-row' }, h('label', {}, t(labelKey)), input, out);
  };

  const key = () => `${posSel.value}:${camSel.value}`;

  function push() {
    if (!current) return;
    current.pose = poseSel.value;
    tuned[key()] = { pos: posSel.value, ...current };
    emit('debug:sprite', { pos: posSel.value, cam: current.cam, x: current.x, y: current.y, scale: current.scale, pose: current.pose, light: current.light, edge: current.edge });
    dump.textContent = Object.values(tuned).map((e) =>
      `${e.pos}: { "cam": ${e.cam}, "slot": ${e.slot}, "x": ${e.x}, "y": ${e.y}, "scale": ${e.scale}, "pose": "${e.pose}"${e.light !== 1 ? `, "light": ${e.light}` : ''}${e.edge !== 1 ? `, "edge": ${e.edge}` : ''} }`).join('\n');
  }

  function loadEntry() {
    current = null;
    if (!posSel.value || !camSel.value) return;
    const entry = camerasFor(posSel.value).find((c) => c.cam === Number(camSel.value));
    if (!entry) return;
    current = { ...entry, ...(tuned[key()] || {}) };
    delete current.pos;
    current.light = current.light ?? 1;
    current.edge = current.edge ?? 1;
    for (const f of ['x', 'y', 'scale', 'light', 'edge']) {
      fields[f].input.value = current[f];
      fields[f].out.textContent = String(current[f]);
    }
    poseSel.value = current.pose;
  }

  function openCam() {
    if (camSel.value) emit('intent:openCamera', { id: Number(camSel.value) });
  }

  posSel.addEventListener('change', () => {
    const id = posSel.value;
    const from = Object.values(state.enemies)[0]?.pos ?? null;
    camSel.replaceChildren();
    emit('debug:enemy', { action: 'freeze', value: !!id });   // пока подбираем спрайт, ИИ не двигает врага
    if (!id) {
      set('enemies', {});
      emit('enemy:moved', { id: ENEMY, from, to: null });
      current = null;
      return;
    }
    for (const c of camerasFor(id)) {
      camSel.append(h('option', { value: c.cam }, t('cams.caption', { n: c.cam, name: t(cameraMeta(c.cam).name) })));
    }
    set('enemies', { [ENEMY]: { pos: id, status: 'idle' } });
    emit('enemy:moved', { id: ENEMY, from, to: id });
    loadEntry();
    openCam();
  });
  camSel.addEventListener('change', () => { loadEntry(); openCam(); });
  poseSel.addEventListener('change', push);

  el.append(
    h('div', { class: 'dbg-row' }, h('label', {}, t('debug.pos')), posSel),
    h('div', { class: 'dbg-row' }, h('label', {}, t('debug.cam')), camSel),
    h('div', { class: 'dbg-row' }, h('label', {}, t('debug.enemy.pose')), poseSel),
    row('debug.enemy.x', 'x', -60, 160, 0.5),
    row('debug.enemy.y', 'y', -60, 160, 0.5),
    row('debug.enemy.scale', 'scale', 0.1, 2.5, 0.02),
    row('debug.enemy.light', 'light', 0.2, 3, 0.05),
    row('debug.enemy.edge', 'edge', 0, 4, 1),
    dump,
  );
}

// Управление Мистером 404 во время ночи. Только emit: враг принимает команды через onEvent('debug:enemy').
function buildMr404(el) {
  const status = h('p', { class: 'dbg-status' }, '');
  refreshers.push(() => {
    const e = state.enemies.mr404;
    status.textContent = e
      ? t('debug.mr404.status', { pos: t(labelOf(e.pos)), status: e.status, dwell: e.dwell ? t('debug.mr404.dwell') : '' })
      : t('debug.mr404.absent');
  });

  const posSel = h('select', {});
  for (const id of positionIds()) if (id !== 'desk') posSel.append(h('option', { value: id }, t(labelOf(id))));

  let frozen = false;
  const freezeBtn = button('debug.mr404.freeze', () => {
    frozen = !frozen;
    freezeBtn.style.background = frozen ? '#3a5a3a' : '';
    emit('debug:enemy', { action: 'freeze', value: frozen });
  });

  el.append(
    status,
    h('div', { class: 'dbg-row' }, h('label', {}, t('debug.pos')), posSel),
    h('div', { class: 'dbg-btns' },
      button('debug.mr404.move', () => emit('debug:enemy', { action: 'move', pos: posSel.value })),
      button('debug.mr404.dashNow', () => emit('debug:enemy', { action: 'dashNow' })),
      button('debug.mr404.attackNow', () => emit('debug:enemy', { action: 'attackNow' })),
      button('debug.mr404.scare', () => emit('jumpscare', { enemyId: 'mr404' })),
      freezeBtn),
  );
}

function buildGlitches(el) {
  // Все эффекты вызываются через glitches.js, включая часы 3:33.
  const phantom = (action, variant) => emit('debug:glitch', { action, variant });
  const effect = (action) => emit('debug:glitch', { action });
  el.append(
    h('div', { class: 'dbg-btns' },
      button('debug.glitch.clock333', () => effect('clock333'))),
    h('div', { class: 'dbg-btns' },
      button('debug.glitch.phantomTyping', () => phantom('typing')),
      button('debug.glitch.phantomNotify', () => phantom('notify'))),
    h('div', { class: 'dbg-btns' },
      button('debug.glitch.chainNotify', () => phantom('chain', 'notifyFirst')),
      button('debug.glitch.chainTyping', () => phantom('chain', 'typingFirst'))),
    h('div', { class: 'dbg-btns' },
      button('debug.glitch.silhouette', () => effect('silhouette')),
      button('debug.glitch.cursorSwitch', () => effect('cursorSwitch')),
      button('debug.glitch.clockBack', () => effect('clockBack'))),
    h('div', { class: 'dbg-btns' },
      button('debug.glitch.aiText', () => effect('aiText')),
      button('debug.glitch.tokensDash', () => effect('tokensDash'))),
    h('div', { class: 'dbg-btns' },
      button('debug.glitch.unknownCall', () => effect('unknownCall')),
      button('debug.glitch.camera12', () => effect('camera12'))),
    h('p', { class: 'dbg-info' }, t('debug.glitch.hint')));
}

// ---------- звуки ----------
// Прослушивание любого звука каталога: «в голове» или на позиции графа (громкость, фильтр и панорама по расстоянию).
function buildSounds(el) {
  const snd = h('select', {});
  const refill = () => {
    const cur = snd.value;
    snd.replaceChildren();
    for (const s of audio.soundIds()) {
      snd.append(h('option', { value: s.id }, `${s.id} · ${s.kind}${s.loop ? ' · петля' : ''}`));
    }
    if (cur) snd.value = cur;
  };
  refill();
  setTimeout(refill, 500);   // каталог звуков приходит после загрузки sounds.json

  const pos = h('select', {}, h('option', { value: '' }, t('debug.snd.nopos')));
  for (const id of positionIds()) {
    const d = distance(id, PLAYER_POS);
    pos.append(h('option', { value: id }, `${id} · ${t(labelOf(id))} · ${Number.isFinite(d) ? d : '∞'}`));
  }
  const loop = h('input', { type: 'checkbox' });
  const handles = [];
  const stopAll = () => { handles.splice(0).forEach((x) => audio.stop(x)); };

  el.append(
    h('div', { class: 'dbg-row' }, h('label', {}, t('debug.snd.sound')), snd),
    h('div', { class: 'dbg-row' }, h('label', {}, t('debug.snd.at')), pos),
    h('div', { class: 'dbg-row' }, h('label', {}, t('debug.snd.loop')), loop),
    h('div', { class: 'dbg-btns' },
      button('debug.snd.play', () => {
        audio.init();   // жест пользователя: звук можно включить и без «Начать смену»
        const opts = { ...(pos.value ? { at: pos.value } : {}), ...(loop.checked ? { loop: true } : {}) };
        const hd = audio.play(snd.value, opts);
        if (hd) handles.push(hd);
      }),
      button('debug.snd.stop', stopAll)),
    h('p', { class: 'dbg-info' }, t('debug.snd.hint')));
}

// ---------- тикеты (этап 7) ----------
// Принудительные тикеты и подбор точек кнопок починки: двигаешь ползунки, кнопка на камере едет сразу.
// Готовые строки копируются в data/tickets.json (devices).
function buildTickets(el) {
  const TYPES = ['pc', 'printer'];
  const spawn = (type, dev = null) => emit('debug:ticket', { action: 'spawn', type, dev });
  el.append(h('div', { class: 'dbg-btns' },
    button('debug.tk.spawn.pc', () => spawn('pc')),
    button('debug.tk.spawn.printer', () => spawn('printer')),
    button('debug.tk.spawn.camera', () => spawn('camera')),
    button('debug.tk.resolveAll', () => emit('debug:ticket', { action: 'resolveAll' }))));

  const typeSel = h('select', {});
  for (const ty of TYPES) typeSel.append(h('option', { value: ty }, ty));
  const devSel = h('select', {});
  const dump = h('p', { class: 'dbg-info' }, '');
  const fields = {};
  const row = (labelKey, field) => {
    const out = h('output', {}, '');
    const input = h('input', { type: 'range', min: 0, max: 100, step: 0.5 });
    input.addEventListener('input', () => {
      out.textContent = input.value;
      push();
    });
    fields[field] = { input, out };
    return h('div', { class: 'dbg-row' }, h('label', {}, t(labelKey)), input, out);
  };

  function push() {
    if (devSel.value === '') return;
    emit('debug:ticket', {
      action: 'tune', type: typeSel.value, dev: Number(devSel.value),
      x: Number(fields.x.input.value), y: Number(fields.y.input.value),
    });
    dump.textContent = deviceList(typeSel.value)
      .map((d) => `{"cam":${d.cam},"x":${d.x},"y":${d.y}}`).join(',\n');
  }

  function loadDevice() {
    const d = deviceList(typeSel.value).find((x) => x.dev === Number(devSel.value));
    if (!d) return;
    for (const f of ['x', 'y']) {
      fields[f].input.value = d[f];
      fields[f].out.textContent = String(d[f]);
    }
    dump.textContent = deviceList(typeSel.value)
      .map((x) => `{"cam":${x.cam},"x":${x.x},"y":${x.y}}`).join(',\n');
  }

  function fillDevices() {
    devSel.replaceChildren();
    for (const d of deviceList(typeSel.value)) devSel.append(h('option', { value: d.dev }, `CAM ${d.cam} · #${d.dev}`));
    loadDevice();
  }

  typeSel.addEventListener('change', fillDevices);
  devSel.addEventListener('change', loadDevice);

  el.append(
    h('div', { class: 'dbg-row' }, h('label', {}, t('debug.tk.type')), typeSel),
    h('div', { class: 'dbg-row' }, h('label', {}, t('debug.tk.device')), devSel),
    row('debug.tk.x', 'x'),
    row('debug.tk.y', 'y'),
    h('div', { class: 'dbg-btns' }, button('debug.tk.show', () => {
      const d = deviceList(typeSel.value).find((x) => x.dev === Number(devSel.value));
      if (!d) return;
      emit('intent:openCamera', { id: d.cam });
      spawn(typeSel.value, d.dev);
    })),
    h('p', { class: 'dbg-info' }, t('debug.tk.json')),
    dump);
  fillDevices();
  // список устройств появляется после загрузки data/tickets.json
  setTimeout(fillDevices, 500);
}

// ---------- публичный API ----------
// Следующие этапы вызывают addSection('enemies', 'debug.section.enemies', el => {...}).
export function addSection(id, titleKey, build) {
  sections.push({ id, titleKey, build });
  if (mounted) renderSection({ id, titleKey, build });
}

function renderSection(s) {
  const el = h('div', { class: 'dbg-section', 'data-id': s.id }, h('h3', {}, t(s.titleKey)));
  s.build(el);
  body.append(el);
}

function mount() {
  if (mounted) return;
  mounted = true;

  document.head.append(h('style', {}, CSS));

  toggleBtn = h('button', { class: 'dbg-toggle', type: 'button',
    onpointerup: () => { panel.hidden = !panel.hidden; } }, t('debug.toggle'));
  body = h('div', {});
  panel = h('div', { class: 'dbg-panel' }, h('h2', { class: 'dbg-title' }, t('debug.title')), body);
  document.body.append(toggleBtn, panel);

  for (const s of sections) renderSection(s);

  // Показания обновляем 4 раза в секунду из tick.
  let acc = 0;
  on('tick', ({ dt }) => {
    acc += dt;
    if (acc < 0.25) return;
    acc = 0;
    refreshers.forEach((fn) => fn());
  });
  refreshers.forEach((fn) => fn());

  // Для проверок из консоли.
  window.__kontorka = { state, set, emit, on, t };
}

addSection('shift', 'debug.section.shift', buildShift);
addSection('resources', 'debug.section.resources', buildResources);
addSection('graph', 'debug.section.graph', buildGraph);
addSection('cameras', 'debug.section.cameras', buildCameras);
addSection('enemies', 'debug.section.enemies', buildEnemies);
addSection('mr404', 'debug.section.mr404', buildMr404);
addSection('tickets', 'debug.section.tickets', buildTickets);
addSection('glitches', 'debug.section.glitches', buildGlitches);
addSection('sounds', 'debug.section.sounds', buildSounds);

export function initDebug() {
  if (new URLSearchParams(location.search).get('debug') === '1') {
    mount();
    return;
  }
  // Без ?debug=1 панель включается горячей клавишей Ctrl+Shift+D.
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') mount();
  });
}