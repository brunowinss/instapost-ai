const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function ui(failAt) {
  const nodes = new Map();
  const calls = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', disabled: false, hidden: false, textContent: '',
      addEventListener() {}, append() {}, prepend() {}, before() {}, focus() {},
      querySelector: selector => node(id + selector)
    });
    return nodes.get(id);
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ai-ui.js'), 'utf8'), {
    document: { createElement: tag => node('new-' + tag), body: node('body'), getElementById: node, querySelector: node },
    fetch: async url => {
      calls.push(url);
      return { ok: !url.endsWith(failAt || 'never'), json: async () => url.endsWith(failAt || 'never') ? { error: 'Falha simulada' } : { success: true, valid: true } };
    }, showToast() {}
  });
  return { node, calls };
}
test('saving a key automatically validates it and keeps a visible saved indicator', async () => {
  const { node, calls } = ui();
  node('ai-key').value = 'test-only';
  await node('ai-key-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(calls, ['/api/ai/key', '/api/ai/validate']);
  assert.match(node('ai-key-status').textContent, /Validada/);
  assert.equal(node('ai-key').value, '');
  assert.match(node('ai-key').placeholder, /chave salva/);
  assert.equal(node('ai-validate').disabled, false);
});
test('failed validation shows saved-but-not-validated state and allows retry', async () => {
  const { node } = ui('validate');
  node('ai-key').value = 'test-only';
  await node('ai-key-form').onsubmit({ preventDefault() {} });
  assert.match(node('ai-key-status').textContent, /salva, mas não validada/);
  assert.equal(node('ai-validate').disabled, false);
});
test('failed save preserves entered key and does not attempt validation', async () => {
  const { node, calls } = ui('key');
  node('ai-key').value = 'test-only';
  await node('ai-key-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(calls, ['/api/ai/key']);
  assert.equal(node('ai-key').value, 'test-only');
  assert.match(node('ai-key-status').textContent, /Não foi possível salvar/);
});
