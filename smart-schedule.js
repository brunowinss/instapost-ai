/**
 * Horários inteligentes de publicação.
 *
 * Antes todo agendamento usava slots fixos (1 post/dia = sempre 15:00). Agora:
 *  1. cada hora recebe uma nota (picos típicos por dia da semana, misturados
 *     com o desempenho real das publicações recentes da conta);
 *  2. os horários são sorteados favorecendo as notas altas, com minutos
 *     variados, evitando repetir a mesma hora do dia anterior;
 *  3. respeita um intervalo mínimo entre posts e a quantidade por dia.
 */
const { DEFAULT_TIMEZONE, zonedTimeToUtc, localParts, dayKey, addDays, weekdayOf } = require('./time-utils');

/** Nota de 5 a 100 típica de engajamento por dia da semana (0 = domingo) e hora local. */
function priorScore(dow, hour) {
  const isWeekend = (dow === 0 || dow === 6);
  let score;
  if (isWeekend) {
    if (hour >= 9 && hour <= 12) score = 75 + Math.floor(Math.sin(hour) * 15);
    else if (hour >= 14 && hour <= 17) score = 82 + Math.floor(Math.cos(hour) * 12);
    else if (hour >= 19 && hour <= 22) score = 95 + Math.floor(Math.sin(hour) * 5);
    else if (hour >= 1 && hour <= 7) score = 8;
    else score = 40 + (hour * 2);
  } else {
    if (hour >= 11 && hour <= 13) score = 88 + Math.floor(Math.sin(hour) * 8);
    else if (hour >= 15 && hour <= 17) score = 80 + Math.floor(Math.cos(hour) * 10);
    else if (hour >= 18 && hour <= 21) score = 96 + Math.floor(Math.sin(hour) * 4);
    else if (hour >= 7 && hour <= 9) score = 65;
    else if (hour >= 0 && hour <= 6) score = 5;
    else score = 45;
  }
  return Math.min(100, Math.max(5, score));
}

// A API devolve "+0000" sem dois-pontos; nem todo motor de JS aceita.
function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return isNaN(date) ? null : date;
}

const MIN_POSTS_TO_LEARN = 8;

/**
 * Engajamento médio por hora local a partir das publicações recentes.
 * Devolve null quando há poucos dados — aí vale só o padrão típico.
 */
function learnHourlyEngagement(posts, timeZone = DEFAULT_TIMEZONE) {
  const sum = new Array(24).fill(0);
  const count = new Array(24).fill(0);
  let usable = 0;

  for (const post of posts || []) {
    const when = parseTimestamp(post.timestamp);
    if (!when || post.likes === null || post.likes === undefined) continue;
    const hour = localParts(when, timeZone).hour;
    sum[hour] += post.likes + 3 * (post.comments || 0);
    count[hour]++;
    usable++;
  }
  if (usable < MIN_POSTS_TO_LEARN) return null;

  const averages = sum.map((s, h) => count[h] ? s / count[h] : null);
  const max = Math.max(...averages.filter(v => v !== null));
  if (!(max > 0)) return null;

  return averages.map((avg, h) => ({
    score: avg === null ? null : 5 + 95 * (avg / max),
    count: count[h]
  }));
}

/** (dia da semana, hora) → nota. Mistura o padrão típico com o que funcionou na conta. */
function makeWeightFn(learned) {
  return (dow, hour) => {
    const prior = priorScore(dow, hour);
    const own = learned && learned[hour];
    if (!own || own.score === null) return prior;
    const trust = Math.min(0.6, own.count * 0.15);
    return prior * (1 - trust) + own.score * trust;
  };
}

function pickWeighted(items, rng) {
  const total = items.reduce((t, item) => t + item.weight, 0);
  let r = rng() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

/**
 * Sorteia `count` horários (Date em UTC), em ordem, nunca antes de `from` +
 * `leadMinutes`.
 *
 * `existing` são posts já agendados: contam na cota diária (`perDay`) e
 * mantêm a distância mínima — então chamar de novo continua de onde parou.
 */
function generateSmartTimes({
  count,
  perDay = 1,
  from = new Date(),
  leadMinutes = 30,
  existing = [],
  weightFn = priorScore,
  timeZone = DEFAULT_TIMEZONE,
  rng = Math.random,
  startDate = null,
  windowStart = 7 * 60,
  windowEnd = 22 * 60,
  stepMinutes = 5,
  minGapMinutes = null,
  maxDays = 400
}) {
  const perDayCount = Math.max(1, Math.min(24, parseInt(perDay, 10) || 1));
  const wanted = Math.max(0, parseInt(count, 10) || 0);
  const baseGap = minGapMinutes ?? (perDayCount <= 1 ? 0 : Math.max(20, Math.min(120, Math.floor((windowEnd - windowStart) / (perDayCount + 1)))));
  const earliest = new Date(from.getTime() + leadMinutes * 60000);

  const taken = existing.map(d => new Date(d)).filter(d => !isNaN(d));
  const takenPerDay = new Map();
  for (const d of taken) {
    const key = dayKey(d, timeZone);
    takenPerDay.set(key, (takenPerDay.get(key) || 0) + 1);
  }

  let day = { year: 0, month: 0, day: 0 };
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    const [year, month, d] = startDate.split('-').map(Number);
    day = { year, month, day: d };
  } else {
    const p = localParts(earliest, timeZone);
    day = { year: p.year, month: p.month, day: p.day };
  }

  const chosen = [];
  let previousHours = new Set();

  for (let i = 0; i < maxDays && chosen.length < wanted; i++, day = addDays(day, 1)) {
    const key = `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
    const capacity = perDayCount - (takenPerDay.get(key) || 0);
    if (capacity <= 0) continue;

    const dow = weekdayOf(day);
    const need = Math.min(capacity, wanted - chosen.length);
    const baseCandidates = [];
    for (let minute = windowStart; minute <= windowEnd; minute += stepMinutes) {
      const when = zonedTimeToUtc(day.year, day.month, day.day, Math.floor(minute / 60), minute % 60, timeZone);
      if (when < earliest) continue;
      const hour = Math.floor(minute / 60);
      // Nota ao cubo concentra nos picos sem ignorar o resto; hora repetida de ontem perde força.
      let weight = Math.pow(weightFn(dow, hour) / 100, 3) + 0.001;
      if (previousHours.has(hour)) weight *= 0.45;
      baseCandidates.push({ when, hour, weight });
    }
    if (baseCandidates.length === 0) continue;

    let picks = [];
    let gap = baseGap;
    for (let attempt = 0; attempt < 5; attempt++) {
      const occupied = [...taken, ...chosen];
      let pool = baseCandidates.filter(c => occupied.every(o => Math.abs(o - c.when) >= gap * 60000));
      const attemptPicks = [];
      while (attemptPicks.length < need && pool.length > 0) {
        const pick = pickWeighted(pool, rng);
        attemptPicks.push(pick);
        pool = pool.filter(c => Math.abs(c.when - pick.when) >= gap * 60000);
      }
      if (attemptPicks.length > picks.length) picks = attemptPicks;
      if (picks.length >= need || gap === 0) break;
      gap = Math.floor(gap * 0.7);
    }

    for (const pick of picks) chosen.push(pick.when);
    if (picks.length > 0) previousHours = new Set(picks.map(p => p.hour));
  }

  return chosen.sort((a, b) => a - b);
}

module.exports = {
  priorScore,
  parseTimestamp,
  learnHourlyEngagement,
  makeWeightFn,
  generateSmartTimes,
  MIN_POSTS_TO_LEARN
};
