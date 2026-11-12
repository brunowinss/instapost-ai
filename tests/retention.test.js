const { test } = require('node:test');
const assert = require('node:assert/strict');
const { purgeOldPosts, retentionDays } = require('../retention');

test('purgeOldPosts apaga só publicados/erros antigos e preserva loops de Stories', async () => {
  const calls = [];
  const db = { run: async (sql, params) => { calls.push({ sql, params }); return { changes: 3 }; } };
  const now = new Date('2026-11-12T12:00:00.000Z');
  const removed = await purgeOldPosts(db, { days: 14, now });

  assert.equal(removed, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], '2026-10-29T12:00:00.000Z');
  assert.match(calls[0].sql, /"status" IN \('success', 'error'\)/);
  assert.doesNotMatch(calls[0].sql, /pending|processing/);
  assert.match(calls[0].sql, /NOT LIKE 'loop:%'/);
});

test('retentionDays usa POST_RETENTION_DAYS e cai para 14 quando inválido', () => {
  assert.equal(retentionDays({}), 14);
  assert.equal(retentionDays({ POST_RETENTION_DAYS: '30' }), 30);
  assert.equal(retentionDays({ POST_RETENTION_DAYS: '0' }), 14);
  assert.equal(retentionDays({ POST_RETENTION_DAYS: 'abc' }), 14);
});
