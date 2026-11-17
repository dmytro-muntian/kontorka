// Игровая логика глюков. Модуль решает, когда их показывать; UI получает только события.
import { play } from './audio.js';

const CLOCK_333_SEC = 3 * 60 + 33;
const AMBIENT_SCHEDULE = {
  2: [['clockBack', 80, 240]],
  3: [['tokensDash', 90, 250], ['camera12', 170, 290]],
  4: [['cursorSwitch', 120, 250], ['unknownCall', 190, 300]],
  5: [['clock333', CLOCK_333_SEC, CLOCK_333_SEC]],
};

export function create(ctx) {
  const { state: S, emit, on } = ctx;
  const rng = ctx.rng ?? Math.random;
  const between = ([a, b]) => a + (b - a) * rng();

  let cfg = null;
  let offs = [];
  let running = false;
  let plan = [];
  let idx = 0;
  let readyAt = 0;
  let deadline = 0;
  let midpoint = 0;
  let endAt = 0;
  let busyUntil = 0;
  let waitingSeen = false;
  let teamsTab = 'support';
  let repairing = false;
  let quietUntil = 0;
  let ambient = [];
  let silhouetteShown = false;
  let textShown = false;

  const enemyAlert = () => Object.values(S.enemies ?? {}).some(
    (e) => e && (e.status === 'warning' || e.status === 'attack'),
  );
  const ambientIsSafe = () => S.running && S.tokens > 0 && !repairing
    && !(S.phone && S.phone.status !== 'idle') && !enemyAlert();

  function canShow(kind) {
    const t = S.time;
    if (!S.running || !(S.tokens > 0) || t < quietUntil) return false;
    if (repairing || (S.phone && S.phone.status !== 'idle') || enemyAlert()) return false;
    if (kind === 'typing') return teamsTab === 'chat';
    if (idx === 0 && plan[0] === 'notify') return teamsTab !== 'support' && teamsTab !== 'chat';
    return true;
  }

  function trigger(kind) {
    const t = S.time;
    if (kind === 'typing') {
      const dur = cfg?.typingSec ?? 3.5;
      emit('glitch', { type: 'phantomTyping', source: 'fifth', durationSec: dur });
      busyUntil = t + dur;
      return;
    }
    if (kind === 'notify') {
      emit('glitch', { type: 'phantomNotify', source: 'fifth', ttlSec: cfg?.notifyTtlSec ?? 12 });
      if (cfg?.notifySound) {
        try { play(cfg.notifySound, { volume: cfg.notifyVolume }); }
        catch (e) { console.warn('glitches: не удалось проиграть пинг фантомного уведомления', e); }
      }
      waitingSeen = true;
      return;
    }
    if (kind === 'cursorSwitch') {
      const id = (S.camera ?? 0) % 11 + 1;
      emit('glitch', { type: kind, source: 'ai', target: id });
      return;
    }
    const durations = {
      clock333: 3,
      clockBack: 2.4,
      silhouette: 0.45,
      aiText: 0.12,
      tokensDash: 0.8,
      unknownCall: 4,
      camera12: 1,
    };
    const source = ['clock333', 'clockBack', 'silhouette', 'aiText'].includes(kind) ? 'fifth' : 'ai';
    emit('glitch', { type: kind, source, durationSec: durations[kind] });
  }

  function advance(afterGap) {
    idx += 1;
    if (idx >= plan.length) { plan = []; waitingSeen = false; return; }
    readyAt = S.time + afterGap;
    deadline = Math.min(S.time + afterGap + (cfg?.stepDeadlineSec ?? 40), endAt);
  }

  function scheduleNight(night) {
    const entries = AMBIENT_SCHEDULE[night] ?? [];
    ambient = entries.map(([type, min, max]) => {
      const at = min === max ? min : min + rng() * (max - min);
      return { type, at, expires: min === max ? max : at + 35, done: false };
    });
  }

  function triggerAmbient(event) {
    if (event.type === 'clock333') {
      trigger(event.type);
      event.done = true;
      return;
    }
    if (S.time > event.expires) {
      event.done = true;
      return;
    }
    if (!ambientIsSafe()) return;
    if (event.type === 'cursorSwitch' && S.camera === null) return;
    trigger(event.type);
    event.done = true;
  }

  function update() {
    if (!running) return;
    for (const event of ambient) {
      if (!event.done && S.time >= event.at) triggerAmbient(event);
    }
    if (!cfg || !plan.length || waitingSeen) return;
    const t = S.time;
    if (t < busyUntil || t < readyAt) return;
    if (t > deadline) { plan = []; return; }
    if (idx === 0 && plan[0] === 'notify' && t > midpoint) plan = ['typing', 'notify'];
    const kind = plan[idx];
    if (!canShow(kind)) return;
    trigger(kind);
    if (kind === 'typing') advance((cfg.typingSec ?? 3.5) + between(cfg.gapAfterTypingSec ?? [8, 14]));
  }

  function onSeen({ type, seen }) {
    if (type !== 'phantomNotify' || !waitingSeen) return;
    waitingSeen = false;
    if (!seen) { plan = []; return; }
    advance(between(cfg.gapAfterSeenSec ?? [4, 7]));
  }

  function onCameraOpen({ id }) {
    if (!running || !ambientIsSafe() || S.night < 2) return;
    if (!silhouetteShown && rng() < 0.08) {
      silhouetteShown = true;
      trigger('silhouette');
    }
    if (S.night >= 3 && !textShown && Number(id) >= 7 && Number(id) <= 8
      && S.time >= 90 && rng() < 0.18) {
      textShown = true;
      trigger('aiText');
    }
  }

  function start(nightCfg) {
    stop();
    cfg = nightCfg?.glitches?.phantom ?? null;
    endAt = (nightCfg?.durationSec ?? 360) - 15;
    plan = [];
    idx = 0;
    readyAt = deadline = midpoint = busyUntil = 0;
    waitingSeen = false;
    teamsTab = 'support';
    repairing = false;
    quietUntil = 0;
    silhouetteShown = false;
    textShown = false;
    scheduleNight(S.night);
    running = true;
    if (cfg) {
      const variant = cfg.variant === 'random' ? (rng() < 0.5 ? 'notifyFirst' : 'typingFirst') : cfg.variant;
      plan = variant === 'typingFirst' ? ['typing', 'notify'] : ['notify', 'typing'];
      const [a, b] = cfg.windowSec;
      readyAt = a;
      deadline = Math.min(b, endAt);
      midpoint = (a + b) / 2;
    }
    const quiet = () => { quietUntil = S.time + (cfg?.quietAfterMessageSec ?? 8); };
    offs = [
      on('intent:teamsTab', ({ tab }) => { teamsTab = tab; }),
      on('intent:repairStart', () => { repairing = true; }),
      on('intent:repairEnd', () => { repairing = false; }),
      on('ticket:pressure', quiet),
      on('ticket:new', quiet),
      on('intent:teamsMessage', quiet),
      on('intent:glitchSeen', onSeen),
      on('camera:open', onCameraOpen),
      on('night:end', stop),
    ];
  }

  function stop() {
    running = false;
    plan = [];
    ambient = [];
    offs.forEach((off) => off());
    offs = [];
  }

  function debug({ action, variant } = {}, nightCfg = null) {
    if (action === 'chain') {
      start(nightCfg);
      if (!cfg) return;
      plan = variant === 'typingFirst' ? ['typing', 'notify'] : ['notify', 'typing'];
      readyAt = S.time;
      deadline = S.time + 90;
      midpoint = Infinity;
      return;
    }
    if (action === 'typing' || action === 'notify') {
      if (!cfg) cfg = nightCfg?.glitches?.phantom ?? null;
      trigger(action);
      return;
    }
    if (action) trigger(action);
  }

  return { start, stop, update, debug };
}
