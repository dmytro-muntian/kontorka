// Переход между сценами: плавное затухание в чёрное и появление из чёрного.
// Чёрный слой #scene-fade лежит в index.html выше всех экранов (в том числе выше дисклеймера).
// Игровой логики здесь нет. Время переходов это время интерфейса, а не игры, поэтому
// используются CSS-переходы, а не событие tick.

const DEFAULTS = { out: 700, hold: 200, in: 900 };   // мс
const REDUCED = { out: 200, hold: 80, in: 250 };     // для prefers-reduced-motion

let layer = null;
let chain = Promise.resolve();
let pending = 0;

function getLayer() {
  if (layer && layer.isConnected) return layer;
  layer = document.getElementById('scene-fade');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'scene-fade';
    layer.className = 'scene-fade';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
  }
  return layer;
}

function timing(opts = {}) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return { ...DEFAULTS, ...(reduced ? REDUCED : {}), ...opts };
}

// Меняет прозрачность слоя и ждёт конца перехода (с запасным таймером на случай, если событие не придёт).
function animateTo(opaque, ms) {
  const el = getLayer();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('transitionend', onEnd);
      resolve();
    };
    const onEnd = (event) => { if (event.target === el && event.propertyName === 'opacity') finish(); };
    el.addEventListener('transitionend', onEnd);
    el.style.transitionDuration = `${ms}ms`;
    el.classList.toggle('is-on', opaque);
    // Пока слой чёрный, он перехватывает касания: во время смены сцены ввод заблокирован.
    el.classList.toggle('is-blocking', opaque);
    setTimeout(finish, ms + 80);
    if (ms <= 0) finish();
  });
}

// true, пока идёт или ждёт своей очереди хотя бы один переход.
export function isBusy() {
  return pending > 0;
}

export function fadeOut(opts) {
  return animateTo(true, timing(opts).out);
}

export function fadeIn(opts) {
  return animateTo(false, timing(opts).in);
}

// Затухание -> swap() в самой тёмной точке -> появление. Переходы идут по очереди и не теряются.
// swap может быть async. Возвращает промис, который завершается, когда новая сцена проявилась.
export function fadeThrough(swap, opts) {
  const tm = timing(opts);
  pending += 1;
  const run = async () => {
    try {
      await animateTo(true, tm.out);
      try {
        await swap?.();
      } catch (err) {
        console.error('fade: ошибка при смене сцены', err);
      }
      await new Promise((r) => setTimeout(r, tm.hold));
      await animateTo(false, tm.in);
    } finally {
      pending -= 1;
    }
  };
  chain = chain.then(run, run);
  return chain;
}
