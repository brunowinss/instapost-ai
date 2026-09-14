const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateContent } = require('../aisa-content');
const result = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test('generation uses the AIsa host and sends credentials only in Authorization', async () => {
  const output = await generateContent({ topic: 'Café artesanal' }, 'test-secret', async (url, init) => {
    assert.equal(url, 'https://api.aisa.one/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer test-secret');
    assert.ok(!init.body.includes('test-secret'));
    assert.equal(JSON.parse(init.body).stream, false);
    return result(JSON.stringify({ caption: 'Uma pausa para o café.', hashtags: ['café', '#café', '#feito com carinho'] }));
  });
  assert.deepEqual(output, { caption: 'Uma pausa para o café.', hashtags: ['#café', '#feitocomcarinho'] });
});
test('invalid input and missing keys do not call the paid service', async () => {
  const request = () => { throw new Error('Must not call provider'); };
  await assert.rejects(generateContent({ topic: '' }, 'secret', request), /Descreva/);
  await assert.rejects(generateContent({ topic: 'Café' }, '', request), /Configure/);
  await assert.rejects(generateContent({ topic: 'Café', kind: 'invalid' }, 'secret', request), /Escolha/);
});
test('upstream errors never echo provider response bodies or credentials', async () => {
  for (const status of [401, 403, 402, 429, 500]) {
    await assert.rejects(generateContent({ topic: 'Café' }, 'secret', async () => ({ ok: false, status, json: async () => ({ error: 'secret' }) })), e => !e.message.includes('secret'));
  }
  await assert.rejects(generateContent({ topic: 'Café' }, 'secret', async () => { throw new Error('secret'); }), /não respondeu/);
});
test('malformed and empty generations fail instead of reporting successful validation', async () => {
  for (const content of ['not json', '{}', '{"caption":"","hashtags":[]}']) {
    await assert.rejects(generateContent({ topic: 'Café' }, 'secret', async () => result(content)), /incompleta/);
  }
  assert.deepEqual(await generateContent({ topic: 'Café', kind: 'hashtags' }, 'secret', async () => result('{"hashtags":["#café"]}')), { caption: '', hashtags: ['#café'] });
});
