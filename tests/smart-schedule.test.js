const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateSmartTimes, learnHourlyEngagement, makeWeightFn, priorScore } = require('../smart-schedule');
const { planStoryLoopPosts, slotKey } = require('../story-loop');
const { localParts, dayKey } = require('../time-utils');

const TZ = 'America/Sao_Paulo';
const FROM = new Date('2026-10-08T12:00:00.000Z'); // 09:00 em São Paulo

// RNG determinístico (mulberry32) para os testes não dependerem de sorte.
function seeded(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('smart times are not a fixed hour: 1 post/day varies in hour and minute', () => {
  const times = generateSmartTimes({ count: 14, perDay: 1, from: FROM, rng: seeded(1) });
  assert.equal(times.length, 14);
  const hours = new Set(times.map(d => localParts(d, TZ).hour));
  const minutes = new Set(times.map(d => localParts(d, TZ).minute));
  assert.ok(hours.size >= 4, `expected varied hours, got ${[...hours]}`);
  assert.ok(minutes.size >= 5, `expected varied minutes, got ${[...minutes]}`);
  assert.ok(!times.every(d => localParts(d, TZ).hour === 15 && localParts(d, TZ).minute === 0));
});

test('smart times respect lead time, daily quota, local window and minimum gap', () => {
  const times = generateSmartTimes({ count: 12, perDay: 3, from: FROM, rng: seeded(7) });
  assert.ok(times.every(d => d.getTime() >= FROM.getTime() + 30 * 60000), 'nothing before now + 30 min');
  assert.deepEqual(times, [...times].sort((a, b) => a - b));

  const perDay = {};
  for (const d of times) {
    const p = localParts(d, TZ);
    assert.ok(p.hour >= 7 && p.hour <= 22, `${p.hour}h fora da janela`);
    perDay[dayKey(d, TZ)] = (perDay[dayKey(d, TZ)] || []).concat(d);
  }
  for (const day of Object.values(perDay)) {
    assert.ok(day.length <= 3, 'no more than perDay posts on a day');
    for (let i = 1; i < day.length; i++) assert.ok(day[i] - day[i - 1] >= 60 * 60000, 'posts da mesma conta ficam espaçados');
  }
});

test('existing scheduled posts use up the daily quota, so a new batch continues on the next free day', () => {
  const today = generateSmartTimes({ count: 1, perDay: 1, from: FROM, rng: seeded(3) })[0];
  const next = generateSmartTimes({ count: 1, perDay: 1, from: FROM, existing: [today], rng: seeded(3) })[0];
  assert.notEqual(dayKey(next, TZ), dayKey(today, TZ));
  assert.ok(next > today);
});

test('startDate pushes the batch to the chosen day', () => {
  const times = generateSmartTimes({ count: 2, perDay: 2, from: FROM, startDate: '2026-10-20', rng: seeded(5) });
  assert.ok(times.every(d => dayKey(d, TZ) === '2026-10-20'));
});

test('24 posts per day still fit with all-distinct instants', () => {
  const times = generateSmartTimes({ count: 24, perDay: 24, from: FROM, rng: seeded(9) });
  assert.equal(times.length, 24);
  assert.equal(new Set(times.map(Number)).size, 24);
});

test('peaks are preferred: evening beats the small hours in the prior', () => {
  assert.ok(priorScore(2, 19) > priorScore(2, 3));
  assert.ok(priorScore(0, 20) > priorScore(0, 4));
});

test('learned engagement pulls the weights toward hours that worked for the account', () => {
  // Posts às 06h (São Paulo = 09h UTC) com muito engajamento; às 19h com pouco.
  const posts = [];
  for (let i = 0; i < 6; i++) posts.push({ timestamp: `2026-09-0${i + 1}T09:00:00+0000`, likes: 500, comments: 40 });
  for (let i = 0; i < 6; i++) posts.push({ timestamp: `2026-09-1${i}T22:00:00+0000`, likes: 20, comments: 1 });

  const learned = learnHourlyEngagement(posts, TZ);
  assert.ok(learned, 'enough posts to learn');
  assert.ok(learned[6].score > learned[19].score);

  const typical = makeWeightFn(null);
  const personal = makeWeightFn(learned);
  assert.ok(personal(2, 6) > typical(2, 6), 'hour that worked gets a boost');
  assert.ok(personal(2, 19) < typical(2, 19), 'hour that flopped loses weight');
  assert.equal(personal(2, 11), typical(2, 11), 'hours with no data keep the typical score');
});

test('too few posts to learn → falls back to the typical pattern', () => {
  assert.equal(learnHourlyEngagement([{ timestamp: '2026-09-01T12:00:00+0000', likes: 10, comments: 0 }], TZ), null);
  assert.equal(learnHourlyEngagement([], TZ), null);
});

const LOOP = {
  id: 'loop_IG1',
  times: JSON.stringify(['09:00', '18:00']),
  varianceMinutes: 0,
  activeMedia: JSON.stringify(['https://cdn.example/a.jpg', 'https://cdn.example/b.mp4', 'https://cdn.example/c.jpg'])
};

test('story loop plans the next slots in local time and rotates the media', () => {
  const now = new Date('2026-10-08T10:00:00.000Z'); // 07:00 em São Paulo
  const plan = planStoryLoopPosts({ loop: LOOP, now, timeZone: TZ });

  // Hoje 09:00 (=12:00Z) e 18:00 (=21:00Z), amanhã 09:00 (=12:00Z) — dentro das 26h.
  assert.deepEqual(plan.map(p => p.scheduledAt.toISOString()), [
    '2026-10-08T12:00:00.000Z', '2026-10-08T21:00:00.000Z', '2026-10-09T12:00:00.000Z'
  ]);
  assert.deepEqual(plan.map(p => p.mediaIndex), [0, 1, 2]);
  assert.equal(plan[1].mediaUrl, 'https://cdn.example/b.mp4');
  assert.equal(plan[0].key, slotKey('loop_IG1', '2026-10-08', '09:00'));
});

test('story loop never repeats a slot and continues the rotation where it stopped', () => {
  const now = new Date('2026-10-08T10:00:00.000Z');
  const existingKeys = new Set([slotKey('loop_IG1', '2026-10-08', '09:00'), slotKey('loop_IG1', '2026-10-08', '18:00')]);
  const plan = planStoryLoopPosts({ loop: LOOP, now, timeZone: TZ, existingKeys, lastIndex: 1 });
  assert.deepEqual(plan.map(p => p.key), [slotKey('loop_IG1', '2026-10-09', '09:00')]);
  assert.equal(plan[0].mediaIndex, 2);

  const wrapped = planStoryLoopPosts({ loop: LOOP, now, timeZone: TZ, existingKeys, lastIndex: 2 });
  assert.equal(wrapped[0].mediaIndex, 0, 'volta ao início quando as mídias acabam');
});

test('story loop publishes a slot that just passed soon, but drops old ones', () => {
  const justPassed = planStoryLoopPosts({ loop: LOOP, now: new Date('2026-10-08T12:10:00.000Z'), timeZone: TZ });
  assert.ok(justPassed[0].scheduledAt.getTime() > Date.parse('2026-10-08T12:10:00.000Z'), 'agendado para depois de agora');
  assert.ok(justPassed[0].scheduledAt.getTime() <= Date.parse('2026-10-08T12:12:00.000Z'), 'e quase imediatamente');

  const tooOld = planStoryLoopPosts({ loop: LOOP, now: new Date('2026-10-08T12:45:00.000Z'), timeZone: TZ });
  assert.ok(!tooOld.some(p => p.key.endsWith(':2026-10-08:09:00')), 'slot de 45 min atrás não é recuperado');
});

test('story loop jitter stays within the configured variance and needs media and times', () => {
  const now = new Date('2026-10-08T10:00:00.000Z');
  const jittery = planStoryLoopPosts({ loop: { ...LOOP, varianceMinutes: 10 }, now, timeZone: TZ, rng: seeded(11) });
  const exact = planStoryLoopPosts({ loop: LOOP, now, timeZone: TZ });
  jittery.forEach((p, i) => assert.ok(Math.abs(p.scheduledAt - exact[i].scheduledAt) <= 10 * 60000));

  assert.deepEqual(planStoryLoopPosts({ loop: { ...LOOP, activeMedia: '[]' }, now, timeZone: TZ }), []);
  assert.deepEqual(planStoryLoopPosts({ loop: { ...LOOP, times: '[]' }, now, timeZone: TZ }), []);
  assert.deepEqual(planStoryLoopPosts({ loop: { ...LOOP, times: '["25:99","abc"]' }, now, timeZone: TZ }), []);
});
