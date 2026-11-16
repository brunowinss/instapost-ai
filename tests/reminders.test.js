const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dueReminders, normalizePrefs } = require('../reminders');

const TZ = 'America/Sao_Paulo';
// 16/11/2026 08:10 em São Paulo (UTC-3)
const NOW = new Date('2026-11-16T11:10:00.000Z');
const at = (local) => new Date(`${local}:00.000-03:00`).toISOString();

const accounts = [
  { accountId: 'ig1', username: 'bruno', platform: 'instagram', accessToken: 'IG' },
  { accountId: 'fb1', username: 'Página', platform: 'facebook', accessToken: 'EAA' },
  { accountId: 'yt1', username: 'Canal', platform: 'youtube', refreshToken: 'r' },
  { accountId: 'ig2', username: 'semacesso', platform: 'instagram', accessToken: '' }
];
const pending = [
  { accountId: 'ig1', platform: 'instagram', scheduledAt: at('2026-11-16T09:15') },
  { accountId: 'ig1', platform: 'instagram', scheduledAt: at('2026-11-20T18:00') },
  { accountId: 'fb1', platform: 'facebook', scheduledAt: at('2026-11-16T13:00') },
  { accountId: 'fb1', platform: 'facebook', scheduledAt: at('2026-11-17T13:00') }
];

test('às 08:10 sai o resumo do dia e o aviso de fila acabando; o lembrete livre fica desligado por padrão', () => {
  const { today, items } = dueReminders({ prefs: {}, accounts, pending, now: NOW, timeZone: TZ });
  assert.equal(today, '2026-11-16');
  assert.deepEqual(items.map(i => i.kind), ['summary', 'queue']);

  const summary = items[0];
  assert.equal(summary.title, '📅 Hoje saem 2 posts');
  assert.equal(summary.body, '1 no Instagram, 1 no Facebook. O primeiro sai às 09:15.');

  // fb1 só tem posts até amanhã (17/11 < 18/11) e o YouTube está vazio; ig1 vai até 20/11; ig2 sem acesso fica de fora.
  const queue = items[1];
  assert.equal(queue.title, '📭 2 contas precisam de vídeos');
  assert.equal(queue.body, 'Sem nada agendado: Canal. Acabando: Página (até 17/11).');
  assert.equal(queue.url, '/#crosspost');
});

test('cada tipo sai uma vez por dia e só a partir do horário escolhido (com 3 h de tolerância)', () => {
  const sent = { summary: '2026-11-16', queue: '2026-11-16' };
  assert.equal(dueReminders({ prefs: {}, accounts, pending, sent, now: NOW, timeZone: TZ }).items.length, 0);

  const early = new Date('2026-11-16T10:30:00.000Z'); // 07:30
  assert.equal(dueReminders({ prefs: {}, accounts, pending, now: early, timeZone: TZ }).items.length, 0);

  const tooLate = new Date('2026-11-16T14:30:00.000Z'); // 11:30, passou da janela das 08:00
  assert.equal(dueReminders({ prefs: {}, accounts, pending, now: tooLate, timeZone: TZ }).items.length, 0);
});

test('lembrete livre respeita o horário e os dias da semana; "force" manda tudo na hora', () => {
  const prefs = { dailySummary: false, queueLow: false, reminder: true, reminderTime: '19:00', reminderDays: [1], reminderText: 'Gravar vídeos!' };
  const monday19 = new Date('2026-11-16T22:05:00.000Z'); // segunda, 19:05
  assert.deepEqual(dueReminders({ prefs, now: monday19, timeZone: TZ }).items.map(i => i.body), ['Gravar vídeos!']);

  const tuesday19 = new Date('2026-11-17T22:05:00.000Z');
  assert.equal(dueReminders({ prefs, now: tuesday19, timeZone: TZ }).items.length, 0);

  const forced = dueReminders({ prefs: { reminder: true }, accounts, pending, now: tuesday19, timeZone: TZ, force: true, sent: { summary: '2026-11-17' } });
  assert.deepEqual(forced.items.map(i => i.kind), ['summary', 'queue', 'reminder']);
});

test('sem posts hoje o resumo convida a agendar; fila em dia não gera aviso (só marca o dia)', () => {
  const full = [{ accountId: 'ig1', platform: 'instagram', scheduledAt: at('2026-11-25T10:00') }];
  const { items } = dueReminders({ prefs: {}, accounts: [accounts[0]], pending: full, now: NOW, timeZone: TZ });
  assert.equal(items[0].title, '📅 Nada agendado para hoje');
  assert.deepEqual(items[1], { kind: 'queue', skip: true });
});

test('preferências inválidas voltam ao padrão', () => {
  const p = normalizePrefs({ summaryTime: '25:00', queueDays: 'x', reminderDays: [9, 1, 1], reminderText: '  ', publishSuccess: 'sim' });
  assert.equal(p.summaryTime, '08:00');
  assert.equal(p.queueDays, 2);
  assert.deepEqual(p.reminderDays, [1]);
  assert.equal(p.reminderText, 'Hora de agendar os vídeos dos próximos dias!');
  assert.equal(p.publishSuccess, true);
});
