import { useSyncExternalStore } from 'react';
import { english } from './en';

export type Language = 'zh-CN' | 'en-US';
export const LANGUAGE_KEY = 'coopagent.ui-language';

function readLanguage(): Language {
  try { return localStorage.getItem(LANGUAGE_KEY) === 'en-US' ? 'en-US' : 'zh-CN'; }
  catch { return 'zh-CN'; }
}

let language = readLanguage();
const listeners = new Set<() => void>();
export const getLanguage = () => language;

export function setLanguage(next: Language) {
  if (next !== 'zh-CN' && next !== 'en-US') return;
  try { localStorage.setItem(LANGUAGE_KEY, next); } catch { /* Switching still works when storage is unavailable. */ }
  if (next === language) return;
  language = next;
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

export function useLanguage() {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

/** Use only for interface text. User messages, model replies and IDs stay intact. */
export function t(key: string): string {
  return language === 'en-US' && Object.prototype.hasOwnProperty.call(english, key) ? english[key] : key;
}

export function tx(strings: TemplateStringsArray, ...values: unknown[]): string {
  const key = strings[0] + values.map((_, index) => `{${index}}${strings[index + 1]}`).join('');
  return t(key).replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)]));
}

/** Choose existing game translations; missing translations retain the source text. */
export function localizedText(zh: string | null | undefined, en: string | null | undefined): string {
  return (language === 'en-US' ? en || zh : zh || en) || '';
}

export function localizedName(record: { nameZhCN?: string | null; nameEnUS?: string | null }, fallback: string): string {
  return localizedText(record.nameZhCN?.split(' /// ')[0]?.trim(), record.nameEnUS?.trim()) || fallback;
}
