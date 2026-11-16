/**
 * Lembretes por notificação do app (Web Push): resumo do dia, fila acabando e lembrete de agendar.
 *
 * Tudo aqui é cálculo puro: o servidor passa contas, posts agendados, preferências e o que já foi
 * enviado hoje, e recebe a lista do que precisa sair agora. Cada tipo sai no máximo uma vez por dia.
 */
const { DEFAULT_TIMEZONE, localParts, dayKey, addDays, pad2 } = require('./time-utils');

const DEFAULT_PREFS = {
  publishSuccess: true,   // "Post publicado!"
  publishError: true,     // "Erro na publicação"
  dailySummary: true,     // resumo do que sai hoje
  summaryTime: '08:00',
  queueLow: true,         // aviso de fila acabando (sai junto com o resumo)
  queueDays: 2,           // avisa quando a conta só tem posts para menos que isso de dias
  reminder: false,        // lembrete livre, no horário e nos dias escolhidos
  reminderTime: '19:00',
  reminderDays: [0, 1, 2, 3, 4, 5, 6],
  reminderText: 'Hora de agendar os vídeos dos próximos dias!'
};

// Se o servidor ficou fora do ar no horário, o lembrete ainda sai nas 3 horas seguintes; depois disso, só amanhã.
const LATE_WINDOW_MIN = 180;

const NETWORK_NAMES = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube' };

function validTime(value, fallback) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function normalizePrefs(raw) {
  const p = Object.assign({}, DEFAULT_PREFS, raw && typeof raw === 'object' ? raw : {});
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  const days = Array.isArray(p.reminderDays) ? [...new Set(p.reminderDays.map(Number).filter(d => d >= 0 && d <= 6))] : DEFAULT_PREFS.reminderDays;
  return {
    publishSuccess: bool(p.publishSuccess, DEFAULT_PREFS.publishSuccess),
    publishError: bool(p.publishError, DEFAULT_PREFS.publishError),
    dailySummary: bool(p.dailySummary, DEFAULT_PREFS.dailySummary),
    summaryTime: validTime(p.summaryTime, DEFAULT_PREFS.summaryTime),
    queueLow: bool(p.queueLow, DEFAULT_PREFS.queueLow),
    queueDays: Math.max(1, Math.min(30, parseInt(p.queueDays, 10) || DEFAULT_PREFS.queueDays)),
    reminder: bool(p.reminder, DEFAULT_PREFS.reminder),
    reminderTime: validTime(p.reminderTime, DEFAULT_PREFS.reminderTime),
    reminderDays: days,
    reminderText: String(p.reminderText || '').trim().slice(0, 200) || DEFAULT_PREFS.reminderText
  };
}

/** Minutos desde a meia-noite local. */
function minutesOf(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function isDue(time, nowMin) {
  const start = minutesOf(time);
  return nowMin >= start && nowMin < start + LATE_WINDOW_MIN;
}

function accountName(acc) {
  return acc.platform === 'instagram' || !acc.platform ? `@${acc.username}` : acc.username;
}

function hasAccess(acc) {
  return acc.platform === 'youtube' ? !!acc.refreshToken : !!acc.accessToken;
}

function listNames(names, max = 3) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} e mais ${names.length - max}`;
}

function summaryReminder({ pending, today, timeZone }) {
  const todays = pending.filter(p => dayKey(new Date(p.scheduledAt), timeZone) === today)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  if (todays.length === 0) {
    return { title: '📅 Nada agendado para hoje', body: 'Nenhum post sai hoje. Que tal agendar alguns vídeos?', url: '/#crosspost' };
  }
  const byNetwork = {};
  todays.forEach(p => { const n = p.platform || 'instagram'; byNetwork[n] = (byNetwork[n] || 0) + 1; });
  const parts = Object.entries(byNetwork).map(([n, c]) => `${c} no ${NETWORK_NAMES[n] || n}`);
  const first = localParts(new Date(todays[0].scheduledAt), timeZone);
  return {
    title: `📅 Hoje saem ${todays.length} ${todays.length === 1 ? 'post' : 'posts'}`,
    body: `${parts.join(', ')}. O primeiro sai às ${pad2(first.hour)}:${pad2(first.minute)}.`,
    url: '/#dashboard'
  };
}

function queueReminder({ accounts, pending, today, todayParts, timeZone, queueDays }) {
  // Contas que só têm posts até antes deste dia ficam na lista.
  const limit = addDays(todayParts, queueDays);
  const limitKey = `${limit.year}-${pad2(limit.month)}-${pad2(limit.day)}`;
  const empty = [];
  const ending = [];
  accounts.filter(hasAccess).forEach(acc => {
    const mine = pending.filter(p => p.accountId === acc.accountId).map(p => dayKey(new Date(p.scheduledAt), timeZone)).sort();
    const last = mine[mine.length - 1];
    if (!last || last < today) empty.push(accountName(acc));
    else if (last < limitKey) ending.push(`${accountName(acc)} (até ${last.slice(8, 10)}/${last.slice(5, 7)})`);
  });
  if (empty.length + ending.length === 0) return null;
  const lines = [];
  if (empty.length) lines.push(`Sem nada agendado: ${listNames(empty)}.`);
  if (ending.length) lines.push(`Acabando: ${listNames(ending)}.`);
  const total = empty.length + ending.length;
  return {
    title: `📭 ${total} ${total === 1 ? 'conta precisa' : 'contas precisam'} de vídeos`,
    body: lines.join(' '),
    url: '/#crosspost'
  };
}

/**
 * O que deve ser notificado agora.
 * sent: { summary: 'AAAA-MM-DD', queue: ..., reminder: ... } — o dia em que cada tipo já saiu.
 * force: ignora horário e o "já enviado hoje" (botão "Enviar agora" das configurações).
 */
function dueReminders({ prefs: rawPrefs, accounts = [], pending = [], sent = {}, now = new Date(), timeZone = DEFAULT_TIMEZONE, force = false }) {
  const prefs = normalizePrefs(rawPrefs);
  const parts = localParts(now, timeZone);
  const today = dayKey(now, timeZone);
  const nowMin = parts.hour * 60 + parts.minute;
  const todayParts = { year: parts.year, month: parts.month, day: parts.day };
  const out = [];
  const ready = (kind, time) => force || (sent[kind] !== today && isDue(time, nowMin));

  if (prefs.dailySummary && ready('summary', prefs.summaryTime)) {
    out.push({ kind: 'summary', tag: 'summary', ...summaryReminder({ pending, today, timeZone }) });
  }
  if (prefs.queueLow && ready('queue', prefs.summaryTime)) {
    const queue = queueReminder({ accounts, pending, today, todayParts, timeZone, queueDays: prefs.queueDays });
    // Mesmo sem nada a avisar, o dia fica marcado para não recalcular o tempo todo.
    out.push(queue ? { kind: 'queue', tag: 'queue', ...queue } : { kind: 'queue', skip: true });
  }
  if (prefs.reminder && (force || prefs.reminderDays.includes(parts.dow)) && ready('reminder', prefs.reminderTime)) {
    out.push({ kind: 'reminder', tag: 'reminder', title: '⏰ Lembrete', body: prefs.reminderText, url: '/#crosspost' });
  }
  return { today, items: out };
}

module.exports = { DEFAULT_PREFS, normalizePrefs, dueReminders };
