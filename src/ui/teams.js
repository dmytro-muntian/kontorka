// Правый монитор: Teams (этап 7). Только рисует и слушает события, игровой логики здесь нет.
// Вкладки: «Поддержка», личные «Чаты» и «Архив» (лор, открывается по ночам).
// Холст монитора 640×376 px; о перспективе этот модуль ничего не знает.

const MAX_ITEMS = 30;         // сколько карточек держим в ленте
const TYPING_MIN = 1.2;       // сек печати для самого короткого сообщения
const TYPING_MAX = 3.5;
const TYPING_PER_CHAR = 0.06; // длительность печати соответствует длине текста

// Сколько секунд «печатается» сообщение (её же использует main.js для звука клавиатуры).
export function typingSec(text) {
  return Math.min(TYPING_MAX, Math.max(TYPING_MIN, text.length * TYPING_PER_CHAR));
}
const REFRESH_SEC = 0.2;      // как часто обновляем возраст карточек
const AGE_FULL_SEC = 120;     // полоса возраста заполняется к моменту пропуска тикета
const PHANTOM_TYPING_SEC = 3.5; // фантомное «печатает…» (глюк пятого), если в событии не задано иное
const PHANTOM_TOAST_SEC = 12;   // сколько висит фантомное уведомление
const CHAT_STORE_KEY = 'kontorka.teams.chat.v1';
const CALLER_CHAT_ID = 'unknown-caller';
const CALL_HISTORY_LABELS = new Map([
  ['finished', 'teams.chat.call.finished'],
  ['playing', 'teams.chat.call.ongoing'],
  ['hungup', 'teams.chat.call.ended'],
  ['declined', 'teams.chat.call.declined'],
  ['missed', 'teams.chat.call.missed'],
]);

let root = null;
let els = {};
let S = null;
let T = null;
let offs = [];
let archive = [];
let items = new Map();        // id тикета -> { node, badge, bar }
let stickBottom = true;       // лента прижата к низу (новые сообщения прокручивают её)
let pending = [];             // сообщения-давление, которые ещё «печатаются»: { left, total, ticketId, key }
let acc = 0;
let tab = 'support';
let E = null;                 // emit из ctx
let phoneSig = '';            // что нарисовано в панели звонка
let phTyping = 0;             // сколько ещё секунд показывать фантомное «печатает…» (глюк пятого)
let toast = null;             // фантомное уведомление: { node, left, dot }
let dotReal = false;          // точка на вкладке «Поддержка» стоит из-за настоящего сообщения
let selectedArchiveId = null;
let selectedChatId = null;
let chatHistory = [];
let activeCallRecordId = null;
let callRecordSeq = 0;
let ghostCallTtl = 0;

function el(tag, className, parent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (parent) parent.appendChild(e);
  return e;
}

function onPress(node, fn) {
  node.addEventListener('pointerup', (e) => {
    if (e.button > 0) return;
    fn(e);
  });
}

const hourLabel = (timeSec) => {
  const h = Math.min(6, Math.floor(timeSec / 60));
  return T('teams.hour', { h: h === 0 ? 12 : h });
};

const initial = (name) => (name || '?').trim().charAt(0).toUpperCase();

// Тексты архива и сообщений приходят ключами словаря.
export function setArchive(list) {
  archive = Array.isArray(list) ? list : [];
  if (els.arch) renderArchive();
}

function loadChatHistory() {
  try {
    const raw = localStorage.getItem(CHAT_STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('история чата должна быть массивом');
    let migrated = false;
    const history = parsed.filter((entry) => {
      if (!entry || (entry.type !== 'message' && entry.type !== 'call')) return false;
      if (entry.type === 'message' && typeof entry.text !== 'string') return false;
      if (entry.type === 'call' && (typeof entry.callId !== 'string' || !Number.isFinite(entry.night))) return false;
      if (!Number.isFinite(entry.night) || !Number.isFinite(entry.gameTimeSec)) {
        entry.night = Number.isFinite(entry.night) ? entry.night : 1;
        entry.gameTimeSec = 0;
        migrated = true;
      }
      return true;
    });
    if (history.length !== parsed.length) console.warn('Teams: некорректные записи истории личного чата пропущены');
    if (migrated) localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(history));
    return history;
  } catch (e) {
    console.warn('Teams: не удалось загрузить историю личного чата', e);
    return [];
  }
}

function saveChatHistory() {
  try {
    localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(chatHistory));
  } catch (e) {
    console.warn('Teams: не удалось сохранить историю личного чата', e);
  }
}

function addChatEntry(entry) {
  chatHistory.push(entry);
  saveChatHistory();
  if (tab === 'chats') renderChats();
}

// ---------- построение ----------
function build(ctx) {
  const { emit } = ctx;
  E = emit;
  els.root = el('div', 'tm', root);

  const top = el('div', 'tm-top', els.root);
  el('div', 'tm-logo', top).textContent = 'T';
  el('div', 'tm-title', top).textContent = T('teams.title');
  els.overload = el('div', 'tm-overload', top);
  els.overload.textContent = T('teams.overload');
  els.overload.hidden = true;
  const sla = el('div', 'tm-sla', top);
  el('span', 'tm-sla__label', sla).textContent = T('teams.sla');
  const bar = el('span', 'tm-sla__bar', sla);
  els.slaFill = el('i', '', bar);
  els.slaNum = el('b', 'tm-sla__num', sla);

  const body = el('div', 'tm-body', els.root);
  const side = el('div', 'tm-side', body);
  els.tabs = {};
  for (const [id, key] of [['support', 'teams.channel.support'], ['chats', 'teams.channel.chats'], ['archive', 'teams.channel.archive']]) {
    const b = el('button', 'tm-tab', side);
    b.type = 'button';
    el('span', '', b).textContent = T(key);
    els.tabs[id] = b;
    onPress(b, () => setTab(id));
  }
  els.dot = el('i', 'tm-dot', els.tabs.support);
  els.dot.hidden = true;
  els.chatDot = el('i', 'tm-dot', els.tabs.chats);
  els.chatDot.hidden = true;

  const main = el('div', 'tm-main', body);
  els.main = main;
  els.ghostCall = el('div', 'tm-ghost-call', main);
  els.ghostCall.textContent = T('glitch.unknownCall');
  els.ghostCall.hidden = true;
  els.ghostCall.setAttribute('role', 'status');
  els.ghostCall.setAttribute('aria-live', 'polite');
  els.feed = el('div', 'tm-feed', main);
  // Автопрокрутка вниз только пока игрок не отлистал ленту вверх.
  els.feed.addEventListener('scroll', () => {
    stickBottom = els.feed.scrollHeight - els.feed.scrollTop - els.feed.clientHeight < 40;
  });
  els.empty = el('div', 'tm-empty', els.feed);
  els.empty.textContent = T('teams.empty');
  els.typing = el('div', 'tm-typing', main);
  els.typing.hidden = true;
  els.typingText = el('span', '', els.typing);
  const dots = el('span', 'tm-dots', els.typing);
  el('i', '', dots); el('i', '', dots); el('i', '', dots);

  els.arch = el('div', 'tm-arch', main);
  els.arch.hidden = true;

  els.chats = el('div', 'tm-chats', main);
  els.chats.hidden = true;

  // Панель звонка внизу Teams: видна на любой вкладке, пока идёт звонок (тикеты остаются видны выше).
  els.bar = el('div', 'tm-callbar', main);
  els.bar.hidden = true;
  const barTop = el('div', 'tm-callbar__top', els.bar);
  els.barAvatar = el('div', 'tm-avatar', barTop);
  const info = el('div', 'tm-card__body', barTop);
  els.barName = el('div', 'tm-name', info);
  els.barStatus = el('div', 'tm-time', info);
  els.declineBtn = el('button', 'tm-hang', barTop);
  els.declineBtn.type = 'button';
  els.declineBtn.dataset.actionSound = 'call';
  els.declineBtn.textContent = T('calls.button.decline');
  onPress(els.declineBtn, () => emit('intent:declineCall', { id: S.phone.id }));
  els.answerBtn = el('button', 'tm-callbtn', barTop);
  els.answerBtn.type = 'button';
  els.answerBtn.dataset.actionSound = 'call';
  els.answerBtn.textContent = T('calls.button.answer');
  onPress(els.answerBtn, () => emit('intent:answerCall', { id: S.phone.id }));
  els.hangBtn = el('button', 'tm-hang', barTop);
  els.hangBtn.type = 'button';
  els.hangBtn.dataset.actionSound = 'call';
  els.hangBtn.textContent = T('calls.button.hangup');
  onPress(els.hangBtn, () => emit('intent:hangUpCall'));
  els.barSub = el('div', 'tm-callbar__sub', els.bar);
}

function setTab(id) {
  tab = id;
  for (const [k, b] of Object.entries(els.tabs)) b.classList.toggle('is-active', k === id);
  els.feed.hidden = id !== 'support';
  els.chats.hidden = id !== 'chats';
  els.arch.hidden = id !== 'archive';
  els.main.classList.toggle('is-chat', id === 'chats' && selectedChatId === CALLER_CHAT_ID);
  if (id === 'support') {
    els.dot.hidden = true;
    dotReal = false;
  }
  if (id === 'chats' && selectedChatId === CALLER_CHAT_ID) {
    els.chatDot.hidden = true;
    if (toast) hideToast(true);
  }
  syncTyping();
  if (id === 'archive') renderArchive();
  if (id === 'chats') renderChats();
  if (E) E('intent:teamsTab', { tab: id === 'chats' && selectedChatId === CALLER_CHAT_ID ? 'chat' : id });
}

// ---------- лента поддержки ----------
function trimFeed() {
  while (els.feed.querySelectorAll('.tm-card, .tm-msg').length > MAX_ITEMS) {
    const first = els.feed.querySelector('.tm-card, .tm-msg');
    for (const [id, rec] of items) if (rec.node === first) items.delete(id);
    first.remove();
  }
}

function markUnread() {
  if (tab !== 'support') {
    els.dot.hidden = false;
    dotReal = true;
  }
}

// ---------- фантомное уведомление (глюк пятого) ----------
// Выглядит как настоящее сообщение от неизвестного абонента, но в ленте после него ничего нет.
function showToast(ttl) {
  hideToast();
  const name = T('calls.caller.unknown');
  const node = el('div', 'tm-toast is-fifth', els.main);
  el('div', 'tm-avatar', node).textContent = initial(name);
  const body = el('div', 'tm-card__body', node);
  el('div', 'tm-name', body).textContent = name;
  el('div', 'tm-text', body).textContent = T('teams.phantom.preview');
  onPress(node, openCallerChat);
  const dot = !(tab === 'chats' && selectedChatId === CALLER_CHAT_ID);
  if (dot) els.chatDot.hidden = false;
  toast = { node, left: ttl, dot };
}

// seen: true (игрок открыл чат) или false (истекло время) сообщает модулю глюков; без аргумента просто убирает.
function hideToast(seen) {
  if (!toast) return;
  const cur = toast;
  toast = null;
  cur.node.remove();
  if (cur.dot && seen) els.chatDot.hidden = true;
  if (seen !== undefined && E) E('intent:glitchSeen', { type: 'phantomNotify', seen });
}

function addCard(tk) {
  if (items.has(tk.id)) return;
  els.empty.hidden = true;
  const name = T(tk.senderKey);
  const node = el('div', 'tm-card is-open', els.feed);
  el('div', 'tm-avatar', node).textContent = initial(name);
  const body = el('div', 'tm-card__body', node);
  const head = el('div', 'tm-card__head', body);
  el('span', 'tm-name', head).textContent = name;
  el('span', 'tm-time', head).textContent = hourLabel(tk.openedAt);
  el('div', 'tm-text', body).textContent = T(tk.textKey);
  const foot = el('div', 'tm-card__foot', body);
  const badge = el('span', 'tm-badge', foot);
  badge.textContent = T('teams.status.open');
  const bar = el('span', 'tm-age', foot);
  const fill = el('i', '', bar);
  items.set(tk.id, { node, badge, fill, status: 'open' });
  trimFeed();
  markUnread();
  if (stickBottom) els.feed.scrollTop = els.feed.scrollHeight;
}

function addMessage(ticketId, key) {
  const tk = S.tickets.find((x) => x.id === ticketId);
  const name = tk ? T(tk.senderKey) : '';
  const node = el('div', 'tm-msg', els.feed);
  el('div', 'tm-avatar', node).textContent = initial(name);
  const body = el('div', 'tm-card__body', node);
  const head = el('div', 'tm-card__head', body);
  el('span', 'tm-name', head).textContent = name;
  el('span', 'tm-time', head).textContent = hourLabel(S.time);
  el('div', 'tm-text', body).textContent = T(key);
  els.empty.hidden = true;
  trimFeed();
  markUnread();
  if (stickBottom) els.feed.scrollTop = els.feed.scrollHeight;
}

// Утро: системное сообщение ИИ-агента с итогом смены. Строки появляются по одной (только оформление, таймеры не игровые).
function addMorningReport({ n, summary }) {
  setTab('support');
  const node = el('div', 'tm-msg tm-sys', els.feed);
  el('div', 'tm-avatar', node).textContent = 'AI';
  const body = el('div', 'tm-card__body', node);
  const head = el('div', 'tm-card__head', body);
  el('span', 'tm-name', head).textContent = T('morning.report.name');
  el('span', 'tm-time', head).textContent = T('morning.report.time');
  const text = el('div', 'tm-text', body);
  const lines = [
    [T('morning.report.title'), ''],
    [T('morning.report.tokens', { spent: Math.max(0, 100 - (summary?.tokens ?? 0)) }), ''],
    [T('morning.report.sla', { sla: summary?.sla ?? 0 }), ''],
    [T('morning.report.tickets', { resolved: summary?.resolved ?? 0, missed: summary?.missed ?? 0 }), ''],
    [T('morning.report.shift', { n }), ''],
    [T('morning.report.thanks'), 'is-thanks'],
  ];
  lines.forEach(([value, cls], i) => {
    const add = () => {
      if (!node.isConnected) return;
      el('div', `tm-sys-line ${cls}`.trim(), text).textContent = value;
      els.feed.scrollTop = els.feed.scrollHeight;
    };
    if (i === 0) add(); else setTimeout(add, 650 * i);
  });
  els.empty.hidden = true;
  trimFeed();
  markUnread();
  els.feed.scrollTop = els.feed.scrollHeight;
}

// Карточки показывают статус и возраст; читаем state раз в REFRESH_SEC.
function refreshCards() {
  for (const [id, rec] of items) {
    const tk = S.tickets.find((x) => x.id === id);
    if (!tk) continue;
    const status = tk.done ? (tk.outcome === 'resolved' ? 'done' : 'missed') : 'open';
    if (rec.status !== status) {
      rec.status = status;
      rec.node.classList.remove('is-open', 'is-done', 'is-missed');
      rec.node.classList.add(`is-${status}`);
      rec.badge.textContent = T(`teams.status.${status}`);
    }
    let k;
    if (tk.done) k = 1;
    else k = Math.min(1, Math.max(0, (S.time - tk.openedAt) / AGE_FULL_SEC));
    rec.fill.style.width = `${(k * 100).toFixed(1)}%`;
    rec.fill.className = status !== 'open' ? '' : k > 0.75 ? 'is-hot' : k > 0.5 ? 'is-warm' : '';
  }
}

// «печатает…» перед сообщением; длительность зависит от длины текста
function syncTyping() {
  const cur = pending[0];
  const ghost = !cur && phTyping > 0;   // фантом: индикатор есть, сообщения не будет
  const supportTyping = !!cur && tab === 'support';
  const callerTyping = ghost && tab === 'chats' && selectedChatId === CALLER_CHAT_ID;
  const show = supportTyping || callerTyping;
  els.typing.hidden = !show;
  els.typing.classList.toggle('is-fifth', ghost);
  if (show) {
    const tk = cur ? S.tickets.find((x) => x.id === cur.ticketId) : null;
    const name = cur ? (tk ? T(tk.senderKey) : '') : T('calls.caller.unknown');
    els.typingText.textContent = T('teams.typing', { name });
  }
}

function updatePhantom(dt) {
  if (phTyping > 0) {
    phTyping -= dt;
    if (phTyping <= 0) {
      phTyping = 0;
      syncTyping();
    }
  }
  if (toast) {
    toast.left -= dt;
    if (toast.left <= 0) hideToast(false);
  }
}

function updateTyping(dt) {
  const cur = pending[0];
  if (!cur) return;
  cur.left -= dt;
  if (cur.left > 0) return;
  pending.shift();
  addMessage(cur.ticketId, cur.key);
  syncTyping();
}

// ---------- рейтинг и перегрузка ----------
function syncSla() {
  const v = Math.max(0, Math.min(100, S.sla));
  els.slaNum.textContent = String(Math.round(v));
  els.slaFill.style.width = `${v}%`;
  els.slaFill.className = v >= 60 ? 'is-good' : v >= 40 ? 'is-mid' : 'is-bad';
}

function syncOverload() {
  els.overload.hidden = !(S.running && S.load >= 5);
}

// ---------- архив ----------
// Дата записи архива (ISO, например 2025-03-11) в формате языка интерфейса.
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(document.documentElement.lang || 'ru', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function renderArchive() {
  if (!els.arch) return;
  els.arch.replaceChildren();
  const unlocked = S.flags?.unlocked ?? [];
  const isOpen = (a) => (a.unlockNight ?? 1) <= S.night && (!a.unlockAfterCall || unlocked.includes(`call:${a.unlockAfterCall}`));
  const shown = archive.filter(isOpen);
  const locked = archive.length - shown.length;
  const selected = shown.find((a) => a.id === selectedArchiveId);
  if (!selected) selectedArchiveId = null;

  if (selected) {
    const back = el('button', 'tm-arch__back', els.arch);
    back.type = 'button';
    back.textContent = T('teams.archive.back');
    back.addEventListener('click', () => {
      selectedArchiveId = null;
      renderArchive();
    });

    const head = el('div', 'tm-arch__detail-head', els.arch);
    el('span', 'tm-chip', head).textContent = T(selected.channel);
    el('span', 'tm-name', head).textContent = T(selected.title || selected.author);
    const date = [fmtDate(selected.date), selected.time].filter(Boolean).join(' ');
    if (date) el('span', 'tm-time', head).textContent = date;

    if (Array.isArray(selected.messages)) {
      for (const message of selected.messages) {
        const row = el('div', 'tm-arch__msg', els.arch);
        el('span', 'tm-time', row).textContent = message.time ?? '';
        el('b', 'tm-name', row).textContent = T(message.author);
        el('span', 'tm-text', row).textContent = T(message.text);
      }
    } else {
      const message = el('div', 'tm-arch__item', els.arch);
      el('div', 'tm-name', message).textContent = T(selected.author);
      el('div', 'tm-text', message).textContent = T(selected.text);
    }
  } else {
    el('div', 'tm-arch__hint', els.arch).textContent = T('teams.archive.hint');
    for (const entry of shown) {
      const button = el('button', 'tm-arch__entry', els.arch);
      button.type = 'button';
      button.addEventListener('click', () => {
        selectedArchiveId = entry.id;
        renderArchive();
      });
      const head = el('span', 'tm-arch__entry-head', button);
      el('span', 'tm-chip', head).textContent = T(entry.channel);
      el('span', 'tm-name', head).textContent = T(entry.title || entry.author);
      const preview = Array.isArray(entry.messages)
        ? entry.messages[entry.messages.length - 1]
        : entry;
      const previewText = el('span', 'tm-arch__preview', button);
      if (preview?.author) {
        el('b', '', previewText).textContent = T(preview.author);
        previewText.append(' · ');
      }
      previewText.append(T(preview?.text));
    }
    if (shown.length === 0) {
      el('div', 'tm-empty', els.arch).textContent = T('teams.archive.empty');
    }
    if (locked > 0) {
      el('div', 'tm-arch__locked', els.arch).textContent = T('teams.archive.locked', { n: locked });
    }
  }
}

// ---------- личный чат с неизвестным абонентом ----------
function fmtGameDateTime(entry) {
  const night = Math.max(1, Math.floor(entry.night || 1));
  const day = new Date(Date.UTC(2028, 6, 31 + night - 1));
  const date = `${String(day.getUTCDate()).padStart(2, '0')}.${String(day.getUTCMonth() + 1).padStart(2, '0')}`;
  const elapsedMinutes = Math.max(0, Math.floor(entry.gameTimeSec || 0));
  const hour = Math.floor(elapsedMinutes / 60) % 12 || 12;
  const minute = String(elapsedMinutes % 60).padStart(2, '0');
  return `${date}, ${hour}:${minute} AM`;
}

function callHistoryLabel(outcome) {
  const key = CALL_HISTORY_LABELS.get(outcome) ?? 'teams.chat.call.incoming';
  return T(key);
}

function openCallerChat() {
  selectedChatId = CALLER_CHAT_ID;
  setTab('chats');
}

function sendChatMessage(event) {
  event.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text || selectedChatId !== CALLER_CHAT_ID) return;
  els.chatInput.value = '';
  addChatEntry({
    id: `message-${Date.now()}-${++callRecordSeq}`,
    type: 'message',
    text,
    night: S.night,
    gameTimeSec: S.time,
  });
  if (E) E('intent:teamsMessage', { chatId: CALLER_CHAT_ID });
}

function renderChats() {
  if (!els.chats) return;
  const draft = selectedChatId === CALLER_CHAT_ID ? (els.chatInput?.value ?? '') : '';
  els.chats.replaceChildren();
  if (selectedChatId !== CALLER_CHAT_ID) {
    el('div', 'tm-arch__hint', els.chats).textContent = T('teams.chats.hint');
    const contact = el('button', 'tm-arch__entry tm-chat__contact', els.chats);
    contact.type = 'button';
    onPress(contact, openCallerChat);
    const head = el('span', 'tm-arch__entry-head', contact);
    el('span', 'tm-avatar', head).textContent = initial(T('calls.caller.unknown'));
    const who = el('span', 'tm-name', head);
    who.textContent = T('calls.caller.unknown');
    const latest = chatHistory[chatHistory.length - 1];
    const preview = el('span', 'tm-arch__preview', contact);
    preview.textContent = latest?.type === 'message'
      ? latest.text
      : latest?.type === 'call' ? callHistoryLabel(latest.outcome) : T('teams.chats.noMessages');
    return;
  }

  const chat = el('div', 'tm-chat', els.chats);
  const header = el('div', 'tm-chat__header', chat);
  const back = el('button', 'tm-arch__back', header);
  back.type = 'button';
  back.textContent = T('teams.chat.back');
  onPress(back, () => {
    selectedChatId = null;
    els.main.classList.remove('is-chat');
    renderChats();
    syncTyping();
    if (E) E('intent:teamsTab', { tab: 'chats' });
  });
  const name = el('span', 'tm-name', header);
  name.textContent = T('calls.caller.unknown');
  const dial = el('button', 'tm-callbtn tm-chat__dial', header);
  dial.type = 'button';
  dial.textContent = T('calls.button.dial');
  onPress(dial, () => { if (E) E('intent:dial', { contact: 'phoneGuy' }); });

  const messages = el('div', 'tm-chat__messages', chat);
  const entries = chatHistory;
  for (const entry of entries) {
    const row = el('div', `tm-chat__entry ${entry.type === 'message' ? 'is-outgoing' : 'is-call'}`, messages);
    if (entry.type === 'message') {
      const meta = el('div', 'tm-chat__meta', row);
      el('b', '', meta).textContent = T('teams.chat.you');
      el('span', 'tm-time', meta).textContent = fmtGameDateTime(entry);
      el('div', 'tm-text', row).textContent = entry.text;
    } else {
      const meta = el('div', 'tm-chat__meta', row);
      el('b', '', meta).textContent = callHistoryLabel(entry.outcome);
      el('span', 'tm-time', meta).textContent = fmtGameDateTime(entry);
      const detail = el('div', 'tm-text', row);
      detail.textContent = T('teams.chat.call.night', { n: entry.night });
      if ((entry.outcome === 'finished' || entry.outcome === 'hungup') && entry.durationSec > 0) {
        detail.append(` · ${mmss(entry.durationSec)}`);
      }
    }
  }
  if (entries.length === 0) {
    el('div', 'tm-empty', messages).textContent = T('teams.chat.empty');
  }
  const form = el('form', 'tm-chat__composer', chat);
  els.chatInput = el('input', 'tm-chat__input', form);
  els.chatInput.type = 'text';
  els.chatInput.autocomplete = 'off';
  els.chatInput.value = draft;
  els.chatInput.placeholder = T('teams.chat.placeholder');
  els.chatInput.setAttribute('aria-label', T('teams.chat.placeholder'));
  const send = el('button', 'tm-callbtn tm-chat__send', form);
  send.type = 'submit';
  send.textContent = T('teams.chat.send');
  form.addEventListener('submit', sendChatMessage);
  messages.scrollTop = messages.scrollHeight;
}

// ---------- звонки ----------
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function syncPhone() {
  if (!els.bar) return;
  const p = S.phone;
  const busy = p.status !== 'idle';
  const sig = `${p.status}|${p.kind}|${Math.floor(p.t)}|${p.sub}`;
  if (sig === phoneSig) return;
  phoneSig = sig;
  els.bar.hidden = !busy;
  els.main.classList.toggle('has-call', busy);
  els.main.classList.toggle('is-story', p.status === 'playing');
  if (!busy) return;
  els.barName.textContent = T(p.name);
  const timed = p.status === 'playing' || p.status === 'connected';
  els.barStatus.textContent = T(`calls.status.${p.status === 'playing' ? 'talk' : p.status}`) + (timed ? ` · ${mmss(p.t)}` : '');
  const incoming = p.status === 'incoming';
  els.answerBtn.hidden = !incoming;
  els.declineBtn.hidden = !incoming;
  els.hangBtn.hidden = incoming;
  els.barAvatar.classList.toggle('is-blank', true);
  els.barAvatar.textContent = '';
  els.barSub.hidden = p.status !== 'playing';
  els.barSub.textContent = p.sub ? T(p.sub) : '';
  els.bar.classList.toggle('is-ring', p.status === 'incoming');
}

function reset() {
  phoneSig = '';
  ghostCallTtl = 0;
  els.ghostCall.hidden = true;
  syncPhone();
  items.clear();
  pending = [];
  phTyping = 0;
  hideToast();
  dotReal = false;
  selectedArchiveId = null;
  activeCallRecordId = null;
  els.feed.replaceChildren(els.empty);
  stickBottom = true;
  els.empty.hidden = false;
  els.dot.hidden = true;
  els.chatDot.hidden = true;
  syncTyping();
  syncSla();
  syncOverload();
  renderArchive();
  renderChats();
}

function recordIncomingCall({ id }) {
  activeCallRecordId = `call-${Date.now()}-${++callRecordSeq}`;
  addChatEntry({
    id: activeCallRecordId,
    type: 'call',
    callId: id,
    night: S.night,
    outcome: null,
    durationSec: 0,
    gameTimeSec: S.time,
  });
}

function finishCallRecord({ kind, outcome, durationSec }) {
  if (kind !== 'story' || !activeCallRecordId) return;
  const record = chatHistory.find((entry) => entry.id === activeCallRecordId);
  activeCallRecordId = null;
  if (!record) return;
  record.outcome = outcome;
  record.durationSec = durationSec ?? 0;
  saveChatHistory();
  if (tab === 'chats') renderChats();
}

function startCallRecord({ kind }) {
  if (kind !== 'story' || !activeCallRecordId) return;
  const record = chatHistory.find((entry) => entry.id === activeCallRecordId);
  if (!record) return;
  record.outcome = 'playing';
  saveChatHistory();
  if (tab === 'chats') renderChats();
}

// ---------- модуль ----------
export function mount(rootEl, ctx) {
  root = rootEl;
  S = ctx.state;
  T = ctx.t;
  chatHistory = loadChatHistory();
  selectedChatId = null;
  callRecordSeq = 0;
  const { on } = ctx;
  build(ctx);
  setTab('support');
  reset();

  offs = [
    on('night:start', reset),
    on('morning:report', addMorningReport),
    on('ticket:new', ({ id }) => {
      const tk = S.tickets.find((x) => x.id === id);
      if (tk) addCard(tk);
    }),
    on('ticket:pressure', ({ id, key }) => {
      const text = T(key);
      const total = typingSec(text);
      pending.push({ left: total, total, ticketId: id, key });
      phTyping = 0;                 // настоящая печать важнее фантома
      syncTyping();
    }),
    on('glitch', ({ type, durationSec, ttlSec }) => {
      if (type === 'phantomTyping') {
        if (pending.length || (tab !== 'support' && !(tab === 'chats' && selectedChatId === CALLER_CHAT_ID))) return;
        phTyping = durationSec ?? PHANTOM_TYPING_SEC;
        syncTyping();
      } else if (type === 'phantomNotify') {
        showToast(ttlSec ?? PHANTOM_TOAST_SEC);
      } else if (type === 'unknownCall') {
        ghostCallTtl = durationSec ?? 4;
        els.ghostCall.hidden = false;
      }
    }),
    on('ticket:resolved', refreshCards),
    on('ticket:missed', refreshCards),
    on('call:incoming', recordIncomingCall),
    on('call:start', startCallRecord),
    on('call:end', (event) => {
      finishCallRecord(event);
      renderArchive();
    }),
    on('sla:change', syncSla),
    on('load:change', syncOverload),
    on('night:end', syncOverload),
    on('night:end', () => { phoneSig = ''; syncPhone(); }),
    on('tick', ({ dt }) => {
      syncPhone();
      updatePhantom(dt);
      updateTyping(dt);
      if (ghostCallTtl > 0) {
        ghostCallTtl = Math.max(0, ghostCallTtl - dt);
        els.ghostCall.hidden = ghostCallTtl <= 0;
      }
      acc += dt;
      if (acc < REFRESH_SEC) return;
      acc = 0;
      refreshCards();
    }),
  ];
}

export function unmount() {
  offs.forEach((off) => off());
  offs = [];
  if (root) root.replaceChildren();
  root = null;
  els = {};
  items = new Map();
  pending = [];
  phoneSig = '';
  phTyping = 0;
  toast = null;
  dotReal = false;
  selectedChatId = null;
  activeCallRecordId = null;
}