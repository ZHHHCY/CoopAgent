import { afterEach, expect, test, vi } from 'vitest';
import { getLanguage, LANGUAGE_KEY, localizedName, localizedText, setLanguage, t, tx } from './index';
import { english } from './en';
import { localizeThinkingHint } from '../features/agent/thinking-hints';
import ts from 'typescript';

afterEach(() => { vi.restoreAllMocks(); setLanguage('zh-CN'); localStorage.removeItem(LANGUAGE_KEY); });

test('language is saved and restored, and switching still works when storage fails', async () => {
  setLanguage('en-US');
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en-US');
  vi.resetModules();
  const reloaded = await import('./index');
  expect(reloaded.getLanguage()).toBe('en-US');
  reloaded.setLanguage('zh-CN');
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('storage unavailable'); });
  expect(() => setLanguage('zh-CN')).not.toThrow();
  expect(getLanguage()).toBe('zh-CN');
  expect(write).toHaveBeenCalled();
});

test('translations preserve interpolated user values and unfamiliar source text', () => {
  setLanguage('en-US');
  expect(t('新建项目')).toBe('New project');
  expect(tx`当前指挥官：${'Raynor {0} $& 中文'}`).toBe('Current commander: Raynor {0} $& 中文');
  expect(t('toString')).toBe('toString');
  expect(t('custom raw label')).toBe('custom raw label');
  expect(localizeThinkingHint('正在采集晶体矿…')).toBe('Gathering minerals…');
  expect(localizeThinkingHint('正在调用 entity.get…')).toBe('Calling entity.get…');
  expect(localizeThinkingHint('生命值')).toBe('生命值'); // Model text is not a UI label.
});

test('game text uses existing translations with a source-language fallback', () => {
  const object = { nameZhCN: '陆战队员 /// 别名', nameEnUS: 'Marine' };
  expect(localizedName(object, 'MarineID')).toBe('陆战队员');
  setLanguage('en-US');
  expect(localizedName(object, 'MarineID')).toBe('Marine');
  expect(localizedName({ nameZhCN: '原文名称' }, 'ObjectID')).toBe('原文名称');
  expect(localizedName({}, 'ObjectID')).toBe('ObjectID');
  expect(localizedText('中文说明', 'English description')).toBe('English description');
  expect(localizedText('中文说明', null)).toBe('中文说明');
});

test('every static UI label has an English translation and template placeholders are preserved', () => {
  for (const [key, value] of Object.entries(english)) {
    expect(value.trim(), key).not.toBe('');
    expect(value.match(/\{\d+\}/g)?.sort() ?? [], key).toEqual(key.match(/\{\d+\}/g)?.sort() ?? []);
  }
  const sources = import.meta.glob<string>(['../**/*.ts', '../**/*.tsx', '!../**/*.test.*'], { query: '?raw', import: 'default', eager: true });
  for (const [relative, source] of Object.entries(sources)) {
    const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true,
      relative.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const check = (key: string) => expect(Object.prototype.hasOwnProperty.call(english, key), `${relative}: ${key}`).toBe(true);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't'
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text);
      if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === 'tx') {
        const key = ts.isTemplateExpression(node.template)
          ? node.template.head.text + node.template.templateSpans.map((span, index) => `{${index}}${span.literal.text}`).join('')
          : node.template.text;
        check(key);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
});
