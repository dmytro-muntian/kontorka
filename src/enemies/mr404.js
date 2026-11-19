// Мистер 404: единственный враг демо (раздел 8 и 18 мастер-промпта).
// Не трогает DOM и state: решает, куда идти, и сообщает событиями enemy:moved, enemy:status, jumpscare.
// Читает из state: sla, load, appetite, time, tickets. Реакции на звонок получает через onEvent('call:start').
//
// ID звуков, которые этот враг просит у audio.play() (появятся на этапе 8; пока audio.play нет, вызовы пропускаются):
// step, whistle_mr404, laugh_mr404, warning_attack, glass_knock, door_open, door_slam, toilet_water (имена каталога, раздел 12),
// (цитата mr404_quote здесь не играет: её запускает ui/desk.js на экране «Смена провалена» после скримера этого врага)
//
// Допущение до этапа 7: тикет в state.tickets считается открытым, если у него нет done: true;
// возраст в секундах берётся из tk.age или считается как state.time - tk.openedAt.

export const id = 'mr404';

const DEFAULTS = {
  startDelaySec: 35, pauseSec: [20, 35], minPauseSec: 8,
  dashSteps: [2, 3], stepIntervalSec: [1.0, 1.8],
  hourFactor: [1.0, 0.85, 0.7], overloadFactor: 0.8, openTicketFactor: 0.9,
  appetiteFactorMax: 0.3,
  toiletStaySec: [15, 25], breakChance: 0.05, breakSec: [20, 30],
  // Приманка ослаблена (плейтест: звонить можно было везде и постоянно): дальше «усталость» врага от частых звонков
  // (fatigueWindowSec), перезарядка и цена в токенах (tokenCost, читает main.js) лежат в nights.json.
  lure: { callSec: 8, cooldownSec: 45, reactSec: [1, 2], stepSec: [2.2, 3.2], maxStepsGood: 4, maxStepsMid: 2,
    lingerGoodSec: 8, lingerMidSec: 4, fatigueWindowSec: 90, tokenCost: 2 },
  attack: { dwellSec: 10, warningToJumpscareSec: [3, 5] },
  slaGood: 60, slaBad: 40, whistleChancePer10s: 0.1,
  doorKnockSec: [1.8, 2.6],   // пауза между стуком и входом с южного этажа в зал
  // 0% токенов (раздел 18, «Токены закончились»): он идёт прямо к s_hall3 вместо обычного маршрута, окна отпугивания нет,
  // на стадии предупреждения звучит обычное warning_attack, потом скример.
  dark: { travelSec: [8, 12], minStepSec: 0.8, maxStepSec: 4, warningToJumpscareSec: [5, 8] },
};

const KNOCK_BEFORE_SEC = 6;          // стук в стеклянную дверь за 6 с до появления
const TICKET_AGED_SEC = 30;          // тикет старше этого повышает активность врага
const BREAK_FROM = new Set(['n_floor', 'front', 'n_hall']);   // откуда он может уйти на перерыв
const LAUGH_REARM_SLA = 50;          // смех снова только после того, как рейтинг поднимется выше этого

export function create(cfg, ctx) {
  const { state, graph, audio, emit, rng } = ctx;
  const C = {
    ...DEFAULTS, ...cfg,
    lure: { ...DEFAULTS.lure, ...(cfg?.lure || {}) },
    attack: { ...DEFAULTS.attack, ...(cfg?.attack || {}) },
    dark: { ...DEFAULTS.dark, ...(cfg?.dark || {}) },
  };

  const R = (a, b) => a + rng() * (b - a);
  const range = (pair) => R(pair[0], pair[1]);
  const rint = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const play = (sound, at, opts) => audio.play?.(sound, { ...(at ? { at } : {}), ...(opts || {}) });
  let waterHandle = null;     // петля toilet_water, пока он в туалете

  const enemy = { id, pos: null, status: 'idle', update, onEvent, forceMove };

  // 'absent' (ещё не пришёл) | 'pause' | 'dash' | 'lured' (идёт на звонок) | 'dwell' | 'toilet' | 'break' | 'warning' | 'dead'
  // | 'dark' (0% токенов: идёт к s_hall3 вслепую; потом обычная стадия 'warning' с цитатой)
  let mode = 'absent';
  let frozen = false;       // отладка: остановить ИИ, пока подбираются спрайты
  let timer = 0;            // обратный отсчёт текущего режима
  let stepTimer = 0;        // до следующего шага рывка
  let dashLeft = 0;
  let appearT = 0;
  let knocked = false;
  let doorKnocked = false;  // уже постучал в дверь s_floor → s_hall3 и ждёт, чтобы войти
  let trail = [];           // пройденный путь, нужен приманке (отступить назад по маршруту)
  let returning = false;    // идёт из туалета обратно: s_floor → s_hall3 (транзитом) → s_hall2
  let goFloor = false;      // на s_hall3 выпало «идти в туалет», а не атаковать
  let pauseMul = 1;         // 0,9 после звонка при плохом рейтинге, действует на следующую паузу
  let whistleAcc = 0;
  let laughArmed = true;
  let darkPath = [];        // оставшиеся шаги до s_hall3 при 0% токенов
  let darkStep = 1.5;       // интервал между этими шагами

  // ---------- вспомогательное ----------
  function setStatus(status, dwell = false) {
    enemy.status = status;
    emit('enemy:status', { id, status, dwell });
  }

  function moveTo(to) {
    const from = enemy.pos;
    enemy.pos = to;
    emit('enemy:moved', { id, from, to });
  }

  // Дверь между южным этажом и залом стеклянная: входя в зал с этажа, он сначала стучит.
  const needsKnock = (from, to) => from === 's_floor' && to === 's_hall3' && !doorKnocked;
  function knockAtDoor() {
    doorKnocked = true;
    play('glass_knock', 's_floor');
    return range(C.doorKnockSec);
  }

  function walkTo(to) {
    doorKnocked = false;
    trail.push(to);
    if (trail.length > 32) trail.shift();
    moveTo(to);
    play('step', to);
  }

  function trimTrailTo(pos) {
    const i = trail.lastIndexOf(pos);
    if (i >= 0) trail.length = i + 1;
    else trail.push(pos);
  }

  function ticketAge(tk) {
    if (typeof tk.age === 'number') return tk.age;
    if (typeof tk.openedAt === 'number') return state.time - tk.openedAt;
    return 0;
  }

  // Пауза между рывками (раздел 18): базовая 20–35 с с коэффициентами, минимум 8 с, плюс добавка от приманки.
  function calcPause(add = 0) {
    const hour = Math.min(5, Math.floor(state.time / 60));
    let m = C.hourFactor[Math.min(C.hourFactor.length - 1, Math.floor(hour / 2))];
    if (state.load >= 5) m *= C.overloadFactor;
    const aged = state.tickets.filter((tk) => !tk.done && ticketAge(tk) > TICKET_AGED_SEC).length;
    m *= Math.pow(C.openTicketFactor, Math.min(2, aged));
    m *= 1 - Math.min(state.appetite / 500, C.appetiteFactorMax);
    m *= 1 - Math.max(-10, Math.min(10, state.mgScore?.pressure ?? 0)) * 0.02;
    const p = Math.max(C.minPauseSec, range(C.pauseSec) * m * pauseMul);
    pauseMul = 1;
    return p + add;
  }

  // ---------- режимы ----------
  function startPause(add = 0) {
    mode = 'pause';
    timer = calcPause(add);
    whistleAcc = 0;
    setStatus('idle');
  }

  function startDash() {
    dashLeft = rint(C.dashSteps[0], C.dashSteps[1]);
    mode = 'dash';
    setStatus('dash');
    stepNow();
  }

  function endDash() {
    startPause(0);
  }

  function enterDwell() {
    mode = 'dwell';
    timer = C.attack.dwellSec;
    goFloor = false;
    setStatus('idle', true);   // виден на камере 8 (и 7): последний шанс отогнать приманкой
  }

  function enterWarning(dark = false) {
    mode = 'warning';
    timer = range(dark ? C.dark.warningToJumpscareSec : C.attack.warningToJumpscareSec);
    moveTo('desk');            // за спиной игрока; для камер он пропадает (статус warning)
    setStatus('warning');
    play('warning_attack', 'desk');
  }

  function enterToilet() {
    mode = 'toilet';
    timer = range(C.toiletStaySec);
    setStatus('hidden');
    play('door_open', 's_toilet');
    waterHandle = play('toilet_water', 's_toilet', { loop: true });
  }

  function leaveToilet() {
    if (waterHandle) { audio.stop?.(waterHandle); waterHandle = null; }
    play('door_slam', 's_toilet');
    walkTo('s_floor');
    returning = true;
    dashLeft = 2;              // s_floor → s_hall3 → s_hall2
    mode = 'dash';
    stepTimer = range(C.stepIntervalSec);
    setStatus('dash');
  }

  function enterBreak() {
    mode = 'break';
    timer = range(C.breakSec);
    trail = ['n_stairs'];
    moveTo('n_stairs');
    setStatus('break');
    play('door_open', 'n_stairs');
  }

  function leaveBreak() {
    walkTo('n_floor');
    startPause(0);
  }

  // ---------- маршрут ----------
  function pickNext(pos) {
    if (returning) {
      if (pos === 's_floor') return 's_hall3';
      if (pos === 's_hall3') { returning = false; return 's_hall2'; }
    }
    switch (pos) {
      case 'n_stairs': return 'n_floor';
      case 'n_floor': return 'front';
      case 'front': return rng() < 0.8 ? 'n_hall' : 'n_kitchen';
      case 'n_kitchen': return 'front';
      case 'n_hall': return 's_hall1';
      case 's_hall1': return 's_hall2';
      case 's_hall2': return rng() < 0.75 ? 's_hall3' : 's_kitchen';
      case 's_kitchen': return rng() < 0.5 ? 's_hall2' : 's_hall3';
      case 's_hall3': return 's_floor';
      case 's_floor': return rng() < 0.8 ? 's_toilet' : 's_hall3';
      default: return null;
    }
  }

  function stepNow() {
    const pos = enemy.pos;
    if (!returning && BREAK_FROM.has(pos) && rng() < C.breakChance) { enterBreak(); return; }
    if (pos === 's_hall3' && !returning && !goFloor) { enterDwell(); return; }
    const to = pickNext(pos);
    if (!to) { endDash(); return; }
    if (needsKnock(pos, to)) { stepTimer = knockAtDoor(); return; }   // стук, потом вход на следующем шаге
    if (!graph.neighbors(pos).includes(to)) console.warn(`mr404: нет ребра ${pos} → ${to}`);
    if (pos === 's_hall3') goFloor = false;
    walkTo(to);
    dashLeft -= 1;
    arrive(to);
    if (mode !== 'dash') return;
    if (dashLeft <= 0) endDash();
    else stepTimer = range(C.stepIntervalSec);
  }

  function arrive(pos) {
    if (pos === 's_toilet') { enterToilet(); return; }
    // s_hall3 это последний шанс: 75% атака, 25% идёт дальше в туалет. Транзитом (из туалета) атаки нет.
    if (pos === 's_hall3' && !returning) {
      if (rng() < 0.25) goFloor = true;
      else enterDwell();
    }
  }

  // ---------- темнота: 0% токенов ----------
  const inDark = () => mode === 'dark';

  // Кратчайший путь по графу до target (без стола); пусто, если уже там или пути нет.
  function pathTo(target) {
    const start = enemy.pos;
    if (!start || start === target) return [];
    const prev = { [start]: null };
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === target) break;
      for (const nb of graph.neighbors(cur)) {
        if (nb === 'desk' || nb in prev) continue;
        prev[nb] = cur;
        queue.push(nb);
      }
    }
    if (!(target in prev)) return [];
    const path = [];
    for (let p = target; p && p !== start; p = prev[p]) path.unshift(p);
    return path;
  }

  function enterDark() {
    lure = null;
    returning = false;
    goFloor = false;
    doorKnocked = false;
    if (waterHandle) { audio.stop?.(waterHandle); waterHandle = null; }
    if (enemy.pos === null) { trail = ['n_stairs']; moveTo('n_stairs'); }   // ещё не приходил: появляется в темноте
    if (enemy.pos !== 's_hall3') {
      darkPath = pathTo('s_hall3');
      if (darkPath.length === 0) moveTo('s_hall3');                          // пути нет: не оставляем его где попало
    }
    if (enemy.pos === 's_hall3') { enterWarning(true); return; }             // уже там: окна отпугивания нет
    // весь путь занимает travelSec, но шаги не чаще minStepSec и не реже maxStepSec
    darkStep = Math.max(C.dark.minStepSec, Math.min(C.dark.maxStepSec, range(C.dark.travelSec) / darkPath.length));
    mode = 'dark';
    stepTimer = darkStep;
    setStatus('dash');
  }

  function updateDark(dt) {
    if (state.tokens > 0) { startPause(0); return; }   // токены вернули (отладка): темнота отменена
    stepTimer -= dt;
    if (stepTimer > 0) return;
    const next = darkPath[0];
    if (needsKnock(enemy.pos, next)) { stepTimer = knockAtDoor(); return; }
    darkPath.shift();
    walkTo(next);
    if (darkPath.length === 0) enterWarning(true);
    else stepTimer = darkStep;
  }

  // ---------- приманка ----------
  // Звонок привязан к месту: звонит телефон в комнате открытой камеры (payload.at). Враг не телепортируется:
  // он реагирует с задержкой, потом идёт к этому месту шагами по графу (быстрее всего слышно ближайших),
  // а дойдя (или пройдя максимум шагов) осматривается, и только потом возвращается к обычному ритму.
  const NO_GO = new Set(['desk', 'n_toilet', 's_toilet', 's_stairs']);   // сюда он по звонку не ходит
  let lure = null;          // { path, stage: 'react' | 'walk' | 'linger', lingerSec }
  let lureTimes = [];       // когда звонили недавно (state.time): каждый звонок в окне fatigueWindowSec сокращает путь на шаг

  // Кратчайший путь от текущей позиции к ближайшей доступной точке к месту звонка (без начальной позиции).
  function routeTo(target) {
    const start = enemy.pos;
    if (!start) return null;
    const prev = { [start]: null };
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      for (const nb of graph.neighbors(cur)) {
        if (NO_GO.has(nb) || nb in prev) continue;
        prev[nb] = cur;
        queue.push(nb);
      }
    }
    let best = start;
    let bestD = graph.distance(start, target);
    for (const node of Object.keys(prev)) {
      const d = graph.distance(node, target);
      if (d < bestD) { best = node; bestD = d; }   // порядок обхода шире-в-ширину: при равенстве выигрывает ближний
    }
    const path = [];
    for (let p = best; p && p !== start; p = prev[p]) path.unshift(p);
    return path;
  }

  function onLure(payload) {
    if (mode === 'absent' || mode === 'toilet' || mode === 'break' || mode === 'warning' || mode === 'dead' || inDark()) return;
    const at = payload?.at;
    if (!at) return;
    const sla = state.sla;
    const good = sla >= C.slaGood;
    const mid = !good && sla >= C.slaBad;
    if (!good && !mid) { pauseMul = 0.9; return; }   // не отвлекает, но следующая пауза короче на 10%

    const now = state.time;
    lureTimes = lureTimes.filter((ts) => now - ts <= C.lure.fatigueWindowSec);
    const fatigue = lureTimes.length;
    lureTimes.push(now);

    const path = routeTo(at);
    if (!path) return;
    // Звонят в той самой комнате, где он уже стоит в окне атаки: звонок ничего не меняет (таймер не сбрасываем).
    if (mode === 'dwell' && path.length === 0) return;

    returning = false;
    goFloor = false;
    lure = {
      path: path.slice(0, Math.max(1, (good ? C.lure.maxStepsGood : C.lure.maxStepsMid) - fatigue)),
      stage: 'react',
      lingerSec: good ? C.lure.lingerGoodSec : C.lure.lingerMidSec,
    };
    mode = 'lured';
    timer = range(C.lure.reactSec);
    setStatus('idle');
  }

  function updateLured(dt) {
    timer -= dt;
    if (timer > 0) return;
    if (lure.stage === 'linger') { lure = null; startPause(0); return; }
    if (lure.path.length === 0) { arriveLure(); return; }
    if (lure.stage === 'react') { lure.stage = 'walk'; setStatus('dash'); }
    if (needsKnock(enemy.pos, lure.path[0])) { timer = knockAtDoor(); return; }
    walkTo(lure.path.shift());
    if (lure.path.length === 0) arriveLure();
    else timer = range(C.lure.stepSec);
  }

  function arriveLure() {
    // Пришёл в комнату за твоей спиной по звонку: окно атаки начинается как обычно.
    if (enemy.pos === 's_hall3') { lure = null; enterDwell(); return; }
    lure.stage = 'linger';
    timer = lure.lingerSec;
    setStatus('idle');
  }

  // ---------- публичное ----------
  function forceMove(posId) {
    lure = null;
    doorKnocked = false;
    returning = false;
    goFloor = false;
    if (enemy.pos === null) trail = [posId];
    else trimTrailTo(posId);
    moveTo(posId);
    if (posId === 's_hall3') enterDwell();
    else if (posId === 's_toilet') enterToilet();
    else startPause(0);
  }

  function onEvent(name, payload) {
    if (name === 'call:start' && payload?.kind === 'lure') { onLure(payload); return; }
    if (name !== 'debug:enemy') return;
    switch (payload?.action) {
      case 'freeze':
        frozen = !!payload.value;
        if (!frozen && enemy.pos) {   // вернуть на экран то, где враг на самом деле
          emit('enemy:moved', { id, from: null, to: enemy.pos });
          setStatus(enemy.status, mode === 'dwell');
        }
        break;
      case 'move': if (payload.pos) forceMove(payload.pos); break;
      case 'dashNow': if (mode === 'pause') startDash(); break;
      case 'attackNow': forceMove('s_hall3'); break;
      default: break;
    }
  }

  function update(dt) {
    if (frozen || mode === 'dead') return;

    // 0% токенов перебивает всё, кроме уже начавшейся стадии предупреждения.
    if (state.running && state.tokens <= 0 && !inDark() && mode !== 'warning') enterDark();
    if (inDark()) { updateDark(dt); return; }

    // Смех: один раз, когда рейтинг падает ниже порога; снова после подъёма выше 50.
    if (mode !== 'absent') {
      if (laughArmed && state.sla < C.slaBad) { play('laugh_mr404', enemy.pos); laughArmed = false; }
      else if (!laughArmed && state.sla > LAUGH_REARM_SLA) laughArmed = true;
    }

    switch (mode) {
      case 'absent':
        appearT += dt;
        if (!knocked && appearT >= C.startDelaySec - KNOCK_BEFORE_SEC) {
          knocked = true;
          play('glass_knock', 'front');
        }
        if (appearT >= C.startDelaySec) {
          trail = ['n_stairs'];
          moveTo('n_stairs');
          play('step', 'n_stairs');
          startPause(0);
        }
        break;
      case 'pause':
        timer -= dt;
        whistleAcc += dt;
        if (whistleAcc >= 10) {
          whistleAcc -= 10;
          if (rng() < C.whistleChancePer10s) play('whistle_mr404', enemy.pos);
        }
        if (timer <= 0) startDash();
        break;
      case 'dash':
        stepTimer -= dt;
        if (stepTimer <= 0) stepNow();
        break;
      case 'lured': updateLured(dt); break;
      case 'dwell':
        timer -= dt;
        if (timer <= 0) enterWarning();
        break;
      case 'warning':
        timer -= dt;
        if (timer <= 0) {
          mode = 'dead';
          setStatus('attack');
          emit('jumpscare', { enemyId: id });
        }
        break;
      case 'toilet':
        timer -= dt;
        if (timer <= 0) leaveToilet();
        break;
      case 'break':
        timer -= dt;
        if (timer <= 0) leaveBreak();
        break;
      default: break;
    }
  }

  return enemy;
}