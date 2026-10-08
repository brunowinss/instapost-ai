/**
 * Utilitários de fuso horário sem dependências (só Intl).
 *
 * O servidor roda em UTC no Render, mas "09:00" para o usuário é 09:00 no
 * horário dele — por isso toda conta de horário passa por aqui.
 */
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Deslocamento (minutos) de um fuso IANA em relação ao UTC, no instante `date`. */
function getTimezoneOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour === '24' ? '0' : parts.hour), Number(parts.minute), Number(parts.second));
  return (asUTC - date.getTime()) / 60000;
}

/** Converte ano/mês/dia/hora/minuto *locais* (no fuso informado) para um Date em UTC. */
function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMinutes = getTimezoneOffsetMinutes(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offsetMinutes * 60000);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Data/hora locais de um instante: { year, month, day, hour, minute, dow } (dow: 0 = domingo). */
function localParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const p = dtf.formatToParts(date).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour === '24' ? '0' : p.hour),
    minute: Number(p.minute),
    dow: WEEKDAYS[p.weekday]
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 'AAAA-MM-DD' do dia local de um instante. */
function dayKey(date, timeZone) {
  const p = localParts(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Soma `n` dias a um dia de calendário { year, month, day } (sem depender de fuso). */
function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Dia da semana (0 = domingo) de um dia de calendário. */
function weekdayOf({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

module.exports = {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  getTimezoneOffsetMinutes,
  zonedTimeToUtc,
  localParts,
  dayKey,
  addDays,
  weekdayOf,
  pad2
};
