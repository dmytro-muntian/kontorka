// Записи ночи приходят как входящие звонки Teams.
// Логика только здесь: интерфейс шлёт intent:answerCall, intent:declineCall, intent:hangUpCall
// и читает state.phone. Время берётся только из tick. Звук записи играет audio.playCall, субтитры шлёт этот модуль.
//
// state.phone: { status, kind, id, name, t, sub }
//   story: incoming (звонит ringSec, потом автоответ) -> playing (запись идёт) -> конец
//
// События: call:incoming {id}; call:start {id, kind}; call:end {id, kind, outcome}
// (outcome: 'finished' | 'hungup' | 'declined' | 'missed'); subtitle {key | null}.
//
// Вызов «Ночного коллеги» (kind 'dial', intent:dial из чата Teams): dialing (гудки call_ringback, ringSec) -> noanswer
// (показ «Нет ответа», noAnswerSec) -> конец. В ночь answerNight через answerAfterSec берут трубку (connected, call_pickup,
// молчат, flags.fifthAnswered) до intent:hangUpCall. Токены и нагрузку не тратит; при 0% токенов обрывается.

import { state, set, emit, on } from './state.js';
import * as audio from './audio.js';

let calls = {};      // data/calls.json -> calls
let started = new Set();
let ringSnd = null;  // рингтон Teams
let rec = null;      // handle записи
let scale = 1;       // подгонка субтитров под длину mp3
// Контакты для вызова (data/calls.json, ключ contacts; значения по умолчанию на случай, если ключа нет).
let contacts = { phoneGuy: { name: 'calls.contact.phoneGuy', ringSec: 20, noAnswerSec: 2.5, answerNight: 5, answerAfterSec: 9 } };

// data/calls.json: записи по id (call_n1…).
export function load(data) {
  const { contacts: extra, ...rest } = data ?? {};
  calls = rest;
  if (extra) contacts = { ...contacts, ...extra };
  audio.loadCalls(rest);
}

const phone = () => ({ ...state.phone });
function setPhone(patchObj) {
  set('phone', { ...phone(), ...patchObj });
}

function stopSounds() {
  if (ringSnd) { audio.stop(ringSnd); ringSnd = null; }
  if (rec) { audio.stop(rec); rec = null; }
}

function setSub(key) {
  if ((state.phone.sub ?? null) === key) return;
  setPhone({ sub: key });
  emit('subtitle', { key });
}

// Завершение любого звонка. outcome нужен для story; silent: без сигнала «положили трубку».
function endPhone(outcome, { silent = false } = {}) {
  const p = phone();
  if (p.status === 'idle') return;
  stopSounds();
  const storyEnded = p.kind === 'story' && ['finished', 'hungup', 'declined'].includes(outcome);
  if (!silent && (storyEnded || (p.kind === 'dial' && p.status === 'connected'))) audio.play('call_hangup');
  if (p.sub) emit('subtitle', { key: null });
  set('phone', { status: 'idle', kind: null, id: null, name: null, t: 0, sub: null });
  if (p.kind === 'story') emit('call:end', {
    id: p.id,
    kind: 'story',
    outcome,
    durationSec: p.t,
  });
  else if (p.kind === 'dial') emit('call:end', { id: p.id, kind: 'dial', outcome });
}

// ---------- вызов контакта ----------
function startDial(contactId = 'phoneGuy') {
  const cfg = contacts[contactId];
  if (!cfg || !state.running || state.tokens <= 0 || state.phone.status !== 'idle') return;
  set('phone', { status: 'dialing', kind: 'dial', id: contactId, name: cfg.name, t: 0, sub: null });
  ringSnd = audio.play('call_ringback', { loop: true });
  emit('call:start', { id: contactId, kind: 'dial' });
}

function tickDial(dt) {
  const p = state.phone;
  const cfg = contacts[p.id] ?? {};
  const t = p.t + dt;
  setPhone({ t });
  if (p.status === 'dialing') {
    if (state.night === cfg.answerNight && t >= (cfg.answerAfterSec ?? 9)) {
      if (ringSnd) { audio.stop(ringSnd); ringSnd = null; }
      audio.play('call_pickup');
      set('flags.fifthAnswered', true);
      setPhone({ status: 'connected', t: 0 });
    } else if (t >= (cfg.ringSec ?? 20)) {
      if (ringSnd) { audio.stop(ringSnd); ringSnd = null; }
      setPhone({ status: 'noanswer', t: 0 });
    }
  } else if (p.status === 'noanswer' && t >= (cfg.noAnswerSec ?? 2.5)) {
    endPhone('noanswer', { silent: true });
  }
}

// ---------- запись ночи ----------
function startIncoming(id) {
  const def = calls[id];
  started.add(id);
  if (state.phone.status !== 'idle') endPhone('declined', { silent: true });
  scale = 1;
  set('phone', { status: 'incoming', kind: 'story', id, name: def.caller, t: 0, sub: null });
  ringSnd = audio.play('teams_call', { loop: true });
  emit('call:incoming', { id });
}

function answerStory() {
  const p = state.phone;
  if (ringSnd) { audio.stop(ringSnd); ringSnd = null; }
  audio.play('call_pickup');
  rec = audio.playCall(p.id);
  setPhone({ status: 'playing', t: 0 });
  emit('call:start', { id: p.id, kind: 'story' });
}

function tickStory(dt) {
  const p = state.phone;
  const def = calls[p.id];
  const audioTime = rec?.getTime?.() ?? null;
  if (rec && audioTime === null && !rec.failed) {
    setPhone({ t: 0 });
    setSub(null);
    return;
  }
  const t = audioTime ?? (p.t + dt);
  setPhone({ t });
  const lines = def.lines ?? [];
  const lastTo = lines.length ? lines[lines.length - 1].to : 0;
  // Время субтитров идёт по аудиоконтексту и подгоняется под полную длину записи.
  if (def.fit !== false && rec?.duration && lastTo > 0) scale = Math.max(0.1, (rec.duration - 0.5) / lastTo);
  const line = lines.find((l) => t >= l.from * scale && t < l.to * scale);
  setSub(line ? line.key : null);
  if (t >= Math.max(rec?.duration ?? 0, lastTo * scale) + 0.6) endPhone('finished');
}

on('tick', ({ dt }) => {
  if (!state.running) return;
  const p = state.phone;
  if (p.kind === 'dial' && state.tokens <= 0) { endPhone('cutoff', { silent: true }); return; }
  if (p.status === 'idle') {
    for (const [id, def] of Object.entries(calls)) {
      if (def.night !== state.night || def.kind !== 'story' || !def.autoplay || started.has(id)) continue;
      if (state.time >= (def.startAtSec ?? 0)) { startIncoming(id); return; }
    }
  }
  if (p.kind === 'dial') tickDial(dt);
  if (p.kind === 'story') {
    if (p.status === 'incoming') {
      const def = calls[p.id];
      const t = p.t + dt;
      setPhone({ t });
      if (t >= (def.ringSec ?? 20) && def.autoAnswer !== false) answerStory();
      else if (t >= (def.ringSec ?? 20)) endPhone('missed');
    } else if (p.status === 'playing') tickStory(dt);
  }
});

// ---------- намерения интерфейса ----------
on('intent:answerCall', ({ id } = {}) => {
  const p = state.phone;
  if (p.kind === 'story' && p.status === 'incoming' && (!id || id === p.id)) answerStory();
});
on('intent:declineCall', ({ id } = {}) => {
  const p = state.phone;
  if (p.kind === 'story' && p.status === 'incoming' && (!id || id === p.id)) endPhone('declined');
});
on('intent:hangUpCall', () => {
  const p = state.phone;
  if (p.kind === 'story' && p.status === 'playing') endPhone('hungup');
  else if (p.kind === 'dial') endPhone('hungup');
});
on('intent:dial', ({ contact } = {}) => startDial(contact));

// ---------- смена ночи, токены ----------
on('night:start', () => {
  stopSounds();
  started = new Set();
});
on('night:end', () => endPhone('hungup', { silent: true }));
on('game:exit', () => endPhone('hungup', { silent: true }));
