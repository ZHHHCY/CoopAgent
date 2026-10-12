import { Languages } from 'lucide-react';
import { setLanguage, t, useLanguage, type Language } from './index';
import './LanguageSelector.css';

export function LanguageSelector() {
  const language = useLanguage();
  return <label className="language-selector">
    <Languages size={15} aria-hidden="true" />
    <select aria-label={t('界面语言')} value={language}
      onChange={event => setLanguage(event.currentTarget.value as Language)}>
      <option value="zh-CN">简体中文</option>
      <option value="en-US">English</option>
    </select>
  </label>;
}
