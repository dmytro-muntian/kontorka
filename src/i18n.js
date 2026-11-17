// Словарь и функция t('ключ'). Тексты в коде не хранятся.

let dict = {};
let currentLang = 'ru';

export async function loadLang(lang = 'ru') {
  // Путь считается от этого файла, поэтому работает и локально, и на GitHub Pages.
  const url = new URL(`../i18n/${lang}.json`, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`i18n: не удалось загрузить ${url} (${res.status})`);
  const selected = await res.json();
  if (lang === 'ru') dict = selected;
  else {
    const fallbackUrl = new URL('../i18n/ru.json', import.meta.url);
    const fallbackRes = await fetch(fallbackUrl);
    if (!fallbackRes.ok) throw new Error(`i18n: не удалось загрузить ${fallbackUrl} (${fallbackRes.status})`);
    dict = { ...(await fallbackRes.json()), ...selected };
  }
  currentLang = lang;
  document.documentElement.lang = lang;
  if (dict['ui.title']) document.title = dict['ui.title'];
}

export function getLang() {
  return currentLang;
}

// t('ui.tickCounter', { n: 5 }) -> "Тиков: 5"
// Если ключа нет, возвращает [ключ] и пишет предупреждение в консоль.
export function t(key, params) {
  const str = dict[key];
  if (str === undefined) {
    console.warn(`i18n: нет ключа "${key}"`);
    return `[${key}]`;
  }
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) =>
    name in params ? String(params[name]) : m
  );
}
