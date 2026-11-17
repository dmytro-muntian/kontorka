// Вступительный экран: страница вакансии KONTORKA на экране iPad (фото) в перспективе.
// Только рисует и шлёт намерения (intent:recruitDone). Игровой логики здесь нет.
// Перспектива считается той же гомографией, что у мониторов стола (monitorMatrix из desk.js).

import { monitorMatrix } from './desk.js';
import { loadLang, getLang } from '../i18n.js';

const SETTINGS_KEY = 'kontorka.settings.v1';
const AUTO_CONTINUE_SEC = 5;   // после подтверждения сам идёт в меню (по tick, а не таймером)

// Всё про планшет в одном месте. Координаты в px исходного фото (1673x940), не окна браузера.
// Углы стекла: левый верх, правый верх, правый низ, левый низ (пересечения краёв дисплея,
// измерены подгонкой прямых по краям, остаток 0,1-0,4 px). Если фото заменят, правятся только эти числа.
export const TABLET = {
  photo: [1673, 940],
  src: 'assets/img/menu/recruitment-tablet.png',
  size: [1200, 800],            // логическое разрешение HTML-холста
  quad: [[433.5, 214.0], [1359.1, 95.3], [1466.4, 717.6], [517.1, 845.0]],
  radius: 16,                   // скругление углов стекла, px холста
};

// Ключи словаря для списков (тексты только через t()).
const DUTY_KEYS = ['recruit.duty.1', 'recruit.duty.2', 'recruit.duty.3', 'recruit.duty.4', 'recruit.duty.5'];
const REQ_KEYS = ['recruit.req.1', 'recruit.req.2', 'recruit.req.3', 'recruit.req.4', 'recruit.req.5'];
const NAV_KEYS = ['recruit.nav.jobs', 'recruit.nav.companies', 'recruit.nav.salaries', 'recruit.nav.employers'];
const FACTS = [
  { id: 'salary', label: 'recruit.fact.salary.label', value: 'recruit.fact.salary.value', wide: true },
  { id: 'schedule', label: 'recruit.fact.schedule.label', value: 'recruit.fact.schedule.value' },
  { id: 'type', label: 'recruit.fact.type.label', value: 'recruit.fact.type.value' },
  { id: 'exp', label: 'recruit.fact.exp.label', value: 'recruit.fact.exp.value' },
];

const ICON = {
  logo: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 6v20M9 16.5 21 6M12.5 14l10.5 12" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.6" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  building: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V5l9-2v18M13 9h7v12M2 21h20M8 8h1M8 12h1M8 16h1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="3.5"/><path d="m14 25 7 7 13-15" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

let root = null;
let st = null;   // внутреннее состояние экрана

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

// Нажатие: pointerup (как в остальном проекте) и click только от клавиатуры (detail === 0).
function onPress(node, fn) {
  node.addEventListener('pointerup', (event) => {
    if (event.button > 0) return;
    fn(event);
  });
  node.addEventListener('click', (event) => {
    if (event.detail === 0) fn(event);
  });
}

function persistLanguage(ctx, lang) {
  try {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { /* пустые настройки */ }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...(ctx.settings ?? {}), ...stored, language: lang, languageAuto: false }));
  } catch (e) {
    console.warn('recruitment: не удалось сохранить язык', e);
  }
}

export function mount(rootEl, ctx) {
  const { t, emit, on } = ctx;
  const [photoW, photoH] = TABLET.photo;
  const [w, h] = TABLET.size;

  st = {
    ctx,
    bootLang: getLang(),
    texts: [],          // [узел, ключ, атрибут|null]
    offs: [],
    began: false,
    applied: false,
    done: false,
    autoLeft: 0,
  };

  // Привязка текста к ключу словаря. attr = 'aria-label' и т. п., иначе textContent.
  const bind = (node, key, attr = null) => { st.texts.push([node, key, attr]); return node; };

  root = el('section', 'rc-root', rootEl);
  root.setAttribute('role', 'region');
  bind(root, 'recruit.aria.screen', 'aria-label');

  const scene = el('div', 'rc-scene', root);
  st.scene = scene;

  // Размытая копия фото заполняет поля, если окно шире или выше кадра.
  const backdrop = el('img', 'backdrop', scene);
  backdrop.src = TABLET.src;
  backdrop.alt = '';
  backdrop.draggable = false;

  const stage = el('div', 'rc-stage', scene);
  stage.style.aspectRatio = `${photoW} / ${photoH}`;
  stage.style.setProperty('--rc-ratio', String(photoW / photoH));
  const photo = el('img', 'rc-photo', stage);
  photo.src = TABLET.src;
  photo.alt = '';
  photo.draggable = false;

  // ----- холст 1200x800, который matrix3d натягивает на стекло -----
  const screen = el('div', 'rc-screen', stage);
  screen.style.width = `${w}px`;
  screen.style.height = `${h}px`;
  screen.style.borderRadius = `${TABLET.radius}px`;
  st.screen = screen;

  // Шапка сайта
  const header = el('header', 'rc-header', screen);
  const brand = el('div', 'rc-brand', header);
  el('span', 'rc-logo', brand).innerHTML = ICON.logo;
  const brandText = el('div', 'rc-brand-text', brand);
  bind(el('strong', 'rc-brand-name', brandText), 'recruit.brand.name');
  bind(el('span', 'rc-brand-tag', brandText), 'recruit.brand.tag');
  const nav = el('nav', 'rc-nav', header);
  NAV_KEYS.forEach((key, i) => {
    const link = el('span', i === 0 ? 'rc-nav-item is-active' : 'rc-nav-item', nav);
    bind(link, key);
  });
  const lang = el('div', 'rc-lang', header);
  lang.setAttribute('role', 'group');
  bind(lang, 'recruit.lang.aria', 'aria-label');
  st.langBtns = {};
  for (const code of ['ru', 'de']) {
    const b = el('button', 'rc-lang-btn', lang);
    b.type = 'button';
    b.dataset.noUiClick = 'true';
    bind(b, `recruit.lang.${code}`);
    st.langBtns[code] = b;
    onPress(b, () => setLanguage(code));
  }

  // Содержимое (прокручивается внутри экрана, как на настоящем сайте)
  const scroll = el('main', 'rc-scroll', screen);
  const page = el('article', 'rc-page', scroll);

  const crumbs = el('div', 'rc-crumbs', page);
  bind(el('span', '', crumbs), 'recruit.crumb.jobs');
  el('i', '', crumbs).textContent = '/';
  bind(el('span', 'rc-chip', crumbs), 'recruit.category');

  bind(el('h1', 'rc-title', page), 'recruit.title');

  const company = el('div', 'rc-company', page);
  const cName = el('span', 'rc-company-item', company);
  el('span', 'rc-icon', cName).innerHTML = ICON.building;
  bind(el('b', '', cName), 'recruit.company.name');
  const cPlace = el('span', 'rc-company-item', company);
  el('span', 'rc-icon', cPlace).innerHTML = ICON.pin;
  bind(el('span', '', cPlace), 'recruit.location');

  const facts = el('div', 'rc-facts', page);
  for (const f of FACTS) {
    const card = el('div', `rc-fact${f.wide ? ' rc-fact--wide' : ''}`, facts);
    bind(el('span', 'rc-fact-label', card), f.label);
    bind(el('strong', 'rc-fact-value', card), f.value);
  }

  const about = el('section', 'rc-section', page);
  bind(el('h2', '', about), 'recruit.about.title');
  bind(el('p', '', about), 'recruit.about.text');

  const cols = el('div', 'rc-cols', page);
  for (const [titleKey, keys] of [['recruit.duties.title', DUTY_KEYS], ['recruit.req.title', REQ_KEYS]]) {
    const sec = el('section', 'rc-section', cols);
    bind(el('h2', '', sec), titleKey);
    const ul = el('ul', 'rc-list', sec);
    for (const key of keys) bind(el('li', '', ul), key);
  }

  // Нижняя панель с кнопкой отклика (всегда на виду)
  const bar = el('div', 'rc-bar', screen);
  bind(el('span', 'rc-bar-hint', bar), 'recruit.bar.hint');
  const applyBtn = el('button', 'rc-apply', bar);
  applyBtn.type = 'button';
  applyBtn.dataset.noUiClick = 'true';
  bind(applyBtn, 'recruit.apply');
  onPress(applyBtn, apply);

  // Нижняя строка: дата публикации и ID
  const footer = el('footer', 'rc-footer', screen);
  bind(el('span', '', footer), 'recruit.footer.posted');
  bind(el('span', '', footer), 'recruit.footer.id');

  // Подтверждение отклика
  const confirm = el('div', 'rc-confirm', screen);
  confirm.hidden = true;
  confirm.setAttribute('role', 'alertdialog');
  bind(confirm, 'recruit.confirm.title', 'aria-label');
  const card = el('div', 'rc-confirm-card', confirm);
  el('span', 'rc-confirm-icon', card).innerHTML = ICON.check;
  bind(el('h2', '', card), 'recruit.confirm.title');
  bind(el('p', '', card), 'recruit.confirm.text');
  const nextBtn = el('button', 'rc-apply rc-apply--next', card);
  nextBtn.type = 'button';
  nextBtn.dataset.noUiClick = 'true';
  bind(nextBtn, 'recruit.confirm.next');
  onPress(nextBtn, finish);
  st.confirm = confirm;
  st.nextBtn = nextBtn;

  // Лёгкий слой бликов и внутренней тени стекла поверх интерфейса (не перехватывает касания)
  el('div', 'rc-glare', screen).setAttribute('aria-hidden', 'true');

  // ----- перспектива -----
  const layout = () => {
    const k = stage.clientWidth / photoW;
    if (!k) return;
    screen.style.transform = `matrix3d(${monitorMatrix(TABLET.quad, w, h, k).join(',')})`;
    screen.classList.add('is-ready');
  };
  layout();
  if (typeof ResizeObserver !== 'undefined') {
    st.resizeObserver = new ResizeObserver(layout);
    st.resizeObserver.observe(stage);
  } else {
    window.addEventListener('resize', layout);
    st.offs.push(() => window.removeEventListener('resize', layout));
  }

  render();

  // ----- появление после дисклеймера -----
  const onAccepted = () => begin();
  window.addEventListener('kontorka:disclaimer-accepted', onAccepted);
  st.offs.push(() => window.removeEventListener('kontorka:disclaimer-accepted', onAccepted));
  if (window.__kontorkaDisclaimerAccepted) begin();

  // Автопереход после подтверждения считается по tick, своих игровых таймеров нет.
  st.offs.push(on('tick', ({ dt }) => {
    if (st.autoLeft > 0) {
      st.autoLeft -= dt;
      if (st.autoLeft <= 0) finish();
    }
  }));

  // ----- внутренние функции (используют t, emit из замыкания) -----
  function render() {
    for (const [node, key, attr] of st.texts) {
      const value = t(key);
      if (attr) node.setAttribute(attr, value);
      else node.textContent = value;
    }
    const current = getLang();
    for (const [code, b] of Object.entries(st.langBtns)) b.setAttribute('aria-pressed', String(code === current));
  }

  async function setLanguage(code) {
    if (code === getLang()) return;
    try {
      await loadLang(code);
    } catch (e) {
      console.warn('recruitment: не удалось загрузить язык', code, e);
      return;
    }
    persistLanguage(ctx, code);
    render();
  }

  function begin() {
    if (st.began) return;
    st.began = true;
    // два кадра, чтобы сработал CSS-переход из чёрного
    requestAnimationFrame(() => requestAnimationFrame(() => scene.classList.add('is-visible')));
  }

  function apply() {
    if (st.applied) return;
    st.applied = true;
    confirm.hidden = false;
    requestAnimationFrame(() => confirm.classList.add('is-open'));
    st.autoLeft = AUTO_CONTINUE_SEC;
    nextBtn.focus({ preventScroll: true });
  }

  function finish() {
    if (st.done || !st.applied) return;
    st.done = true;
    st.autoLeft = 0;
    emit('intent:recruitDone', { langChanged: getLang() !== st.bootLang });
  }
}

export function unmount() {
  if (!st) return;
  st.resizeObserver?.disconnect();
  st.offs.forEach((off) => off());
  root?.remove();
  root = null;
  st = null;
}
