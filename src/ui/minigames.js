// Междуночная очередь Teams и экран концовки. Игровую логику и сохранение ведёт main.js.
let root = null;
let emit = null;
let t = null;
let offs = [];
let els = {};
let game = null;
let night = 1;
let questionIndex = 0;
let remaining = 0;
let transition = 0;
let answered = false;
let active = false;
let questionActive = false;

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

function button(key, handler, parent = els.actions) {
  const node = el('button', 'mg-button', parent);
  node.type = 'button';
  node.textContent = t(key);
  node.addEventListener('pointerup', (event) => {
    if (event.button > 0) return;
    handler();
  });
  return node;
}

function show() {
  els.screen.hidden = false;
  els.screen.inert = false;
  active = true;
}

function hide() {
  els.screen.hidden = true;
  els.screen.inert = false;
  active = false;
  questionActive = false;
  answered = false;
  transition = 0;
}

function resetContent() {
  els.actions.replaceChildren();
  els.content.replaceChildren();
  els.feedback.textContent = '';
  els.feedback.dataset.outcome = '';
}

function updateQueue() {
  els.queue.replaceChildren();
  if (!game) return;
  game.requests.forEach((request, index) => {
    const status = index < questionIndex ? 'done' : index === questionIndex ? 'active' : 'waiting';
    const item = el('article', `mg-queue-item is-${status}`, els.queue);
    item.setAttribute('aria-current', status === 'active' ? 'step' : 'false');
    const icon = el('span', 'mg-queue-icon', item);
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = status === 'done' ? '✓' : status === 'active' ? '●' : String(index + 1).padStart(2, '0');
    const copy = el('span', 'mg-queue-copy', item);
    el('span', 'mg-queue-name', copy).textContent = t(request.senderKey || 'minigame.sender.default');
    el('span', 'mg-queue-preview', copy).textContent = t(request.promptKey);
    const state = el('span', 'mg-queue-state', item);
    state.textContent = t(`minigame.queue.${status}`);
  });
  els.queueCount.textContent = `${Math.min(questionIndex, game.requests.length)} / ${game.requests.length}`;
}

function applyNightTheme() {
  els.screen.dataset.night = String(night);
  els.screen.classList.toggle('is-corrupted', night >= 3);
}

function showSummary(payload) {
  questionActive = false;
  game = payload.game;
  night = payload.night;
  questionIndex = payload.index ?? 0;
  applyNightTheme();
  resetContent();
  els.timer.hidden = true;
  els.timerLabel.hidden = true;
  els.headerStatus.textContent = t('minigame.summary.status');
  els.title.textContent = t('minigame.summary.title', { n: night });
  els.content.className = 'mg-content is-summary';
  const stats = el('div', 'mg-stats', els.content);
  for (const [key, value] of [
    ['tokens', `${payload.summary.tokens}%`],
    ['sla', `${payload.summary.sla}%`],
    ['resolved', payload.summary.resolved],
    ['missed', payload.summary.missed],
  ]) {
    const stat = el('div', 'mg-stat', stats);
    el('span', 'mg-stat-value', stat).textContent = String(value);
    el('span', 'mg-stat-label', stat).textContent = t(`minigame.summary.${key}`);
  }
  el('p', 'mg-copy', els.content).textContent = t('minigame.summary.copy');
  updateQueue();
  button('minigame.summary.continue', () => emit('intent:minigameBegin'));
  show();
}

function showQuestion(payload) {
  questionActive = true;
  game = payload.game;
  night = payload.night;
  questionIndex = payload.index;
  const request = game.requests[questionIndex];
  if (!request) {
    showComplete({ night, game, score: payload.score });
    return;
  }
  applyNightTheme();
  resetContent();
  answered = false;
  transition = 0;
  remaining = request.durationSec;
  els.timer.hidden = false;
  els.timerLabel.hidden = false;
  els.headerStatus.textContent = t('minigame.question.status');
  els.title.textContent = t(game.titleKey);
  els.content.className = 'mg-content is-question';
  updateQueue();

  const meta = el('div', 'mg-request-meta', els.content);
  const avatar = el('span', 'mg-sender-avatar', meta);
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = t(request.senderKey || 'minigame.sender.default').slice(0, 1);
  const sender = el('div', 'mg-sender-copy', meta);
  el('strong', 'mg-sender-name', sender).textContent = t(request.senderKey || 'minigame.sender.default');
  el('span', 'mg-sender-role', sender).textContent = t(request.roleKey || 'minigame.sender.role');
  const counter = el('span', 'mg-request-counter', meta);
  counter.textContent = t('minigame.question.count', {
    current: questionIndex + 1,
    total: game.requests.length,
  });

  el('p', 'mg-prompt', els.content).textContent = t(request.promptKey);
  const detail = el('div', 'mg-request-detail', els.content);
  el('span', 'mg-detail-label', detail).textContent = t('minigame.request.detail');
  el('p', 'mg-detail-copy', detail).textContent = t(request.detailKey || 'minigame.request.defaultDetail');

  els.timer.setAttribute('aria-valuemax', String(request.durationSec));
  els.timer.setAttribute('aria-valuenow', String(request.durationSec));
  els.timerFill.style.transform = 'scaleX(1)';
  els.timerFill.dataset.urgency = 'normal';
  els.timerLabel.textContent = t('minigame.timer', { s: Math.ceil(remaining) });
  const options = [...request.options];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  for (const option of options) {
    const answer = el('button', 'mg-button', els.actions);
    answer.type = 'button';
    answer.dataset.choice = option.id;
    answer.textContent = t(option.labelKey);
    answer.addEventListener('pointerup', (event) => {
      if (event.button > 0 || answered) return;
      answered = true;
      emit('intent:minigameAnswer', { optionId: option.id });
    });
  }
  show();
}

function showFeedback({ outcome }) {
  answered = true;
  transition = 0.9;
  els.feedback.dataset.outcome = outcome;
  const key = outcome === 'correct' ? 'minigame.feedback.correct'
    : outcome === 'incorrect' ? 'minigame.feedback.incorrect'
      : 'minigame.feedback.neutral';
  els.feedback.textContent = t(key);
  for (const answer of els.actions.querySelectorAll('button')) answer.disabled = true;
}

function showComplete(payload) {
  questionActive = false;
  game = payload.game;
  night = payload.night;
  questionIndex = game.requests.length;
  applyNightTheme();
  resetContent();
  els.timer.hidden = true;
  els.timerLabel.hidden = true;
  els.headerStatus.textContent = t('minigame.complete.status');
  els.title.textContent = t('minigame.complete.title');
  els.content.className = 'mg-content is-complete';
  const total = payload.score.total;
  const correct = payload.score.correct;
  el('p', 'mg-copy', els.content).textContent = t('minigame.complete.score', { correct, total });
  el('p', 'mg-copy', els.content).textContent = t('minigame.complete.weight', {
    weighted: payload.score.weighted,
    weightTotal: payload.score.weightTotal,
  });
  updateQueue();
  button(night === 5 ? 'minigame.complete.finish' : 'minigame.complete.next', () => emit('intent:minigameFinish'));
  show();
}

function showEnding({ ending, score }) {
  questionActive = false;
  resetContent();
  els.timer.hidden = true;
  els.timerLabel.hidden = true;
  els.headerStatus.textContent = t('minigame.ending.status');
  els.title.textContent = t(ending === 'good' ? 'minigame.ending.good' : 'minigame.ending.bad');
  els.content.className = 'mg-content is-ending';
  el('p', 'mg-copy', els.content).textContent = t(
    ending === 'good' ? 'minigame.ending.good.copy' : 'minigame.ending.bad.copy',
  );
  el('p', 'mg-copy', els.content).textContent = t('minigame.complete.score', {
    correct: score.correct,
    total: score.total,
  });
  els.queue.replaceChildren();
  els.queueCount.textContent = '';
  button('minigame.ending.menu', () => emit('intent:endingClose'));
  show();
}

export function mount(rootEl, ctx) {
  root = rootEl;
  emit = ctx.emit;
  t = ctx.t;
  els.screen = el('section', 'mg-screen', root);
  els.screen.hidden = true;
  els.screen.setAttribute('aria-labelledby', 'mg-title');
  const panel = el('div', 'mg-panel', els.screen);
  const header = el('header', 'mg-topbar', panel);
  const brand = el('div', 'mg-brand', header);
  el('span', 'mg-brand-mark', brand).textContent = 'T';
  el('span', 'mg-brand-name', brand).textContent = t('minigame.brand');
  els.headerStatus = el('span', 'mg-header-status', header);
  const workspace = el('div', 'mg-workspace', panel);
  const sidebar = el('aside', 'mg-sidebar', workspace);
  const queueHeading = el('div', 'mg-queue-heading', sidebar);
  el('strong', '', queueHeading).textContent = t('minigame.queue.title');
  els.queueCount = el('span', 'mg-queue-count', queueHeading);
  els.queue = el('div', 'mg-queue', sidebar);
  const contentPanel = el('section', 'mg-request', workspace);
  const requestHeading = el('div', 'mg-request-heading', contentPanel);
  els.title = el('h1', 'mg-title', requestHeading);
  els.title.id = 'mg-title';
  els.timerLabel = el('p', 'mg-timer-label', requestHeading);
  els.timer = el('div', 'mg-timer', contentPanel);
  els.timer.setAttribute('role', 'progressbar');
  els.timer.setAttribute('aria-label', t('minigame.timer.label'));
  els.timerFill = el('i', '', els.timer);
  els.content = el('div', 'mg-content', contentPanel);
  els.feedback = el('p', 'mg-feedback', contentPanel);
  els.actions = el('div', 'mg-actions', contentPanel);
  const { on } = ctx;
  offs = [
    on('minigame:start', showSummary),
    on('minigame:question', showQuestion),
    on('minigame:answer', showFeedback),
    on('minigame:complete', showComplete),
    on('ending:show', showEnding),
    on('minigame:close', hide),
    on('game:menu', hide),
    on('tick', ({ dt }) => {
      if (!active) return;
      if (transition > 0) {
        transition = Math.max(0, transition - dt);
        if (transition === 0) emit('intent:minigameBegin');
      }
      if (!questionActive || !game || answered || transition > 0) return;
      const request = game.requests[questionIndex];
      if (!request) return;
      remaining = Math.max(0, remaining - dt);
      const progress = remaining / request.durationSec;
      els.timerFill.style.transform = `scaleX(${progress})`;
      els.timerFill.dataset.urgency = progress < 0.35 ? 'urgent' : progress < 0.65 ? 'warning' : 'normal';
      els.timer.setAttribute('aria-valuenow', String(Math.ceil(remaining)));
      els.timerLabel.textContent = t('minigame.timer', { s: Math.ceil(remaining) });
      if (remaining === 0) {
        answered = true;
        emit('intent:minigameAnswer', { timeout: true });
      }
    }),
  ];
}

export function unmount() {
  offs.forEach((off) => off());
  offs = [];
  root?.replaceChildren();
  root = null;
  els = {};
  game = null;
  active = false;
  questionActive = false;
}
