/**
 * Verifies model-debug capture (no live API calls).
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { appendModelDebug } = require('../src/integrations/modelDebugCapture');

test('appendModelDebug stores messages and tools when debugContext is on', () => {
  const turn = { debugContext: true };
  appendModelDebug(turn, 'openai/gpt-oss-20b', {
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'noop', parameters: {} } }],
    toolChoice: 'auto',
  });

  assert.ok(Array.isArray(turn.modelDebug));
  assert.equal(turn.modelDebug.length, 1);
  assert.equal(turn.modelDebug[0].model, 'openai/gpt-oss-20b');
  assert.equal(turn.modelDebug[0].messages[0].content, 'hello');
  assert.equal(turn.modelDebug[0].toolChoice, 'auto');
});

test('appendModelDebug is a no-op when debugContext is off', () => {
  const turn = { debugContext: false };
  appendModelDebug(turn, 'm', { messages: [{ role: 'user', content: 'x' }] });
  assert.equal(turn.modelDebug, undefined);
});
