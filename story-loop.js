/**
 * Loop de Stories 24/7: transforma a configuração salva (horários + mídias)
 * em Stories agendados de verdade.
 *
 * Antes a tela só salvava a configuração e nada no servidor a lia, então o
 * loop nunca publicava. Agora o agendador chama planStoryLoopPosts() a cada
 * ciclo e cria os posts das próximas ~26 horas.
 */
const { DEFAULT_TIMEZONE, zonedTimeToUtc, localParts, addDays, pad2 } = require('./time-utils');

function parseHHMM(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, label: `${pad2(hour)}:${pad2(minute)}` };
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Chave única de um slot do loop; evita criar o mesmo Story duas vezes. */
function slotKey(loopId, dateLabel, timeLabel) {
  return `loop:${loopId}:${dateLabel}:${timeLabel}`;
}

/**
 * @param loop            { id, times, varianceMinutes, activeMedia } (times/activeMedia: array ou JSON)
 * @param existingKeys    Set com as chaves de slot já criadas (qualquer status)
 * @param lastIndex       índice da última mídia usada (-1 se nunca usou)
 * @returns [{ key, scheduledAt: Date, mediaUrl, mediaIndex }] em ordem cronológica
 */
function planStoryLoopPosts({
  loop,
  now = new Date(),
  existingKeys = new Set(),
  lastIndex = -1,
  horizonHours = 26,
  graceMinutes = 20,
  timeZone = DEFAULT_TIMEZONE,
  rng = Math.random
}) {
  const media = parseList(loop.activeMedia).filter(url => typeof url === 'string' && url.startsWith('http'));
  const times = parseList(loop.times).map(parseHHMM).filter(Boolean)
    .sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  if (media.length === 0 || times.length === 0) return [];

  const variance = Math.max(0, Math.min(60, parseInt(loop.varianceMinutes, 10) || 0));
  const horizon = now.getTime() + horizonHours * 3600000;
  const oldest = now.getTime() - graceMinutes * 60000;

  const today = localParts(now, timeZone);
  const slots = [];

  for (let offset = 0; offset <= 2; offset++) {
    const day = addDays({ year: today.year, month: today.month, day: today.day }, offset);
    const dateLabel = `${day.year}-${pad2(day.month)}-${pad2(day.day)}`;
    for (const time of times) {
      const key = slotKey(loop.id, dateLabel, time.label);
      if (existingKeys.has(key)) continue;

      const base = zonedTimeToUtc(day.year, day.month, day.day, time.hour, time.minute, timeZone).getTime();
      if (base < oldest || base > horizon) continue;

      const jitter = variance ? Math.round((rng() * 2 - 1) * variance) * 60000 : 0;
      // Horário que acabou de passar (servidor dormindo) sai logo em vez de ser perdido.
      const scheduled = Math.max(base + jitter, now.getTime() + 60000);
      slots.push({ key, scheduledAt: new Date(scheduled) });
    }
  }

  return slots
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .map((slot, i) => {
      const mediaIndex = (lastIndex + 1 + i) % media.length;
      return { ...slot, mediaUrl: media[mediaIndex], mediaIndex };
    });
}

module.exports = { planStoryLoopPosts, parseHHMM, slotKey };
