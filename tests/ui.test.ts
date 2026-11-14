import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionNotice } from '../src/App.tsx';
import type { useConnection } from '../src/connection.ts';
import { dictionary, type Language } from '../src/i18n.ts';

type Connection = ReturnType<typeof useConnection>;
function renderNotice(overrides: Partial<Connection>, language: Language = 'en') {
  const connection: Connection = {
    snapshot: null, connected: true, error: null, pending: false, disabled: false,
    command: async () => true, retry: undefined, reconnect: () => undefined, clearError: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ConnectionNotice, {
    connection, language, t: key => dictionary[language][key],
  }));
}

test('a lost acknowledgement retains a visible enabled retry after reconnection clears the error', () => {
  const html = renderNotice({ disabled: true, retry: async () => true });
  assert.ok(html.includes(dictionary.en.uncertain));
  assert.ok(html.includes(dictionary.en.retryAction));
  assert.ok(html.includes('role="alert"'));
  assert.ok(!html.includes('disabled=""'));
});

test('retry stays visible but unavailable while disconnected or already pending', () => {
  for (const state of [{ connected: false }, { pending: true }]) {
    const html = renderNotice({ retry: async () => true, ...state });
    assert.ok(html.includes(dictionary.en.retryAction));
    assert.ok(html.includes('disabled=""'));
  }
});

test('connection notices localize the recovery action and leave a healthy connection unobstructed', () => {
  assert.equal(renderNotice({}), '');
  const html = renderNotice({ retry: async () => true }, 'zh');
  assert.ok(html.includes(dictionary.zh.uncertain));
  assert.ok(html.includes(dictionary.zh.retryAction));
});
