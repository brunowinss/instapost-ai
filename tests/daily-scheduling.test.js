const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function extract(file, name) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

test('daily counts produce unique minute slots, consistent in browser and importer', () => {
  const browser = vm.runInNewContext(`(${extract('app.js', 'slotsForCount')})`);
  const importer = vm.runInNewContext(`(${extract('auto_importer.js', 'slotsForCount')})`);
  for (let count = 1; count <= 24; count++) {
    const minutes = Array.from(browser(count), hour => Math.round(hour * 60));
    assert.equal(minutes.length, count);
    assert.equal(new Set(minutes).size, count);
    assert.ok(minutes.every(m => m >= 600 && m <= 1200));
    assert.deepEqual(minutes, Array.from(importer(count), hour => Math.round(hour * 60)));
  }
  assert.deepEqual(Array.from(browser(3)), [10, 15, 20]);
});

test('automatic scheduling fills exactly the selected daily count and then advances a day', () => {
  const context = vm.createContext({ STATE: { globalConfig: { postsPerDay: 24 } } });
  vm.runInContext(extract('app.js', 'slotsForCount') + '\n' + extract('app.js', 'calculateNextSlot'), context);
  let date = new Date();
  date.setDate(date.getDate() + 3);
  date.setHours(0, 0, 0, 0);
  const day = date.toDateString();
  const times = [];
  for (let i = 0; i < 24; i++) {
    context.basis = date.toISOString();
    date = vm.runInContext('calculateNextSlot(basis)', context);
    assert.equal(date.toDateString(), day);
    times.push(date.getTime());
  }
  assert.equal(new Set(times).size, 24);
  context.basis = date.toISOString();
  assert.notEqual(vm.runInContext('calculateNextSlot(basis)', context).toDateString(), day);
});
