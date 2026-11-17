// Междуночные запросы и экран концовки. Игровую логику и сохранение ведёт main.js.
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
  active = true;
}

function hide() {
  els.screen.hidden = true;
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

function showSummary(payload) {
  questionActive = false;
  game = payload.game;
  night = payload.night;
  questionIndex = payload.index ?? 0;
  resetContent();
  els.title.textContent = t('minigame.summary.title', { n: night });
  els.timer.hidden = true;
  els.timerLabel.hidden = true;
  els.content.append(
    Object.assign(el('p', 'mg-summary', els.content), {
      textContent: t('minigame.summary.stats', payload.summary),
    }),
    Object.assign(el('p', 'mg-copy', els.content), {
      textContent: t('minigame.summary.copy'),
    }),
  );
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
  resetContent();
  answered = false;
  transition = 0;
  remaining = request.durationSec;
  els.timer.hidden = false;
  els.timerLabel.hidden = false;
  els.title.textContent = t(game.titleKey);
  el('p', 'mg-step', els.content).textContent = t('minigame.question.count', {
    current: questionIndex + 1,
    total: game.requests.length,
  });
  el('p', 'mg-prompt', els.content).textContent = t(request.promptKey);
  els.timer.setAttribute('aria-valuemax', String(request.durationSec));
  els.timerFill.style.transform = 'scaleX(1)';
  els.timerLabel.textContent = t('minigame.timer', { s: Math.ceil(remaining) });
  const options = [...request.options];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  for (const option of options) {
    const answer = el('button', 'mg-button', els.actions);
    answer.type = 'button';
    answer.textContent = t(option.labelKey);
    answer.addEventListener('pointerup', (event) => {
      if (event.button > 0 || answered) return;
      answered = true;
      emit('intent:minigameAnswer', { optionId: option.id });
    });
  }
  show();
}

function showFeedback(outcome) {
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
  resetContent();
  els.timer.hidden = true;
  els.timerLabel.hidden = true;
  els.title.textContent = t('minigame.complete.title');
  const total = payload.score.total;
  const correct = payload.score.correct;
  el('p', 'mg-copy', els.content).textContent = t('minigame.complete.score', { correct, total });
  el('p', 'mg-copy', els.content).textContent = t('minigame.complete.weight', {
    weighted: payload.score.weighted,
    weightTotal: payload.score.weightTotal,
  });
  button(night === 5 ? 'minigame.complete.finish' : 'minigame.complete.next', () => emit('intent:minigameFinish'));
  show();
}

function showEnding({ ending, score }) {
  questionActive = false;
  resetContent();
  els.timer.hidden = true;
  els.timerLabel.hidden = true;
  els.title.textContent = t(ending === 'good' ? 'minigame.ending.good' : 'minigame.ending.bad');
  el('p', 'mg-copy', els.content).textContent = t(
    ending === 'good' ? 'minigame.ending.good.copy' : 'minigame.ending.bad.copy',
  );
  el('p', 'mg-copy', els.content).textContent = t('minigame.complete.score', {
    correct: score.correct,
    total: score.total,
  });
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
  els.title = el('h1', 'mg-title', panel);
  els.title.id = 'mg-title';
  els.timer = el('div', 'mg-timer', panel);
  els.timer.setAttribute('role', 'progressbar');
  els.timer.setAttribute('aria-label', t('minigame.timer.label'));
  els.timerFill = el('i', '', els.timer);
  els.timerLabel = el('p', 'mg-timer-label', panel);
  els.content = el('div', 'mg-content', panel);
  els.feedback = el('p', 'mg-feedback', panel);
  els.actions = el('div', 'mg-actions', panel);
  const { on } = ctx;
  offs = [
    on('minigame:start', showSummary),
    on('minigame:question', showQuestion),
    on('minigame:answer', ({ outcome }) => showFeedback(outcome)),
    on('minigame:complete', showComplete),
    on('ending:show', showEnding),
    on('minigame:close', hide),
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
      els.timerFill.style.transform = `scaleX(${remaining / request.durationSec})`;
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
}
