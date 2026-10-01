/**
 * Integração com o YouTube Data API v3 — OAuth (fluxo web) e publicação de vídeos/Shorts.
 *
 * Porta para Node a lógica que já existia em Python no projeto "postador-yt"
 * (core/auth.py, core/enviar.py, core/agenda.py), adaptada para um fluxo OAuth
 * de aplicação web (redirect_uri fixo) em vez do loopback de app desktop, já
 * que este servidor roda publicado (Render), não na máquina do usuário.
 */
const { google } = require('googleapis');
const fetch = require('node-fetch');
const { getDB } = require('./database');

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly'
];

const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

// Horários sugeridos por quantidade de posts no dia, mirando os picos de
// audiência: deslocamento da manhã, intervalo do almoço e a noite.
// (mesma tabela do core/agenda.py do postador-yt)
const SUGGESTED_TIMES = {
  1: ['19:00'],
  2: ['12:00', '19:00'],
  3: ['09:00', '13:00', '20:00'],
  4: ['08:00', '12:00', '17:00', '21:00'],
  5: ['08:00', '11:00', '14:00', '18:00', '21:00'],
  6: ['07:30', '10:00', '12:30', '16:00', '19:00', '21:30']
};
const MAX_PER_DAY = Math.max(...Object.keys(SUGGESTED_TIMES).map(Number));

function getOAuthClient() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function isConfigured() {
  return !!getOAuthClient();
}

/** URL de consentimento do Google. `prompt: 'consent'` força a emissão do refresh_token sempre. */
function getAuthUrl() {
  const client = getOAuthClient();
  if (!client) return null;
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
}

async function exchangeCode(code) {
  const client = getOAuthClient();
  if (!client) throw new Error('App do YouTube não configurado (faltam YOUTUBE_CLIENT_ID/SECRET/REDIRECT_URI).');
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  return { client, tokens };
}

async function getChannelInfo(oauthClient) {
  const youtube = google.youtube({ version: 'v3', auth: oauthClient });
  const result = await youtube.channels.list({ mine: true, part: 'snippet' });
  const channel = result.data.items && result.data.items[0];
  if (!channel) throw new Error('Não foi possível obter informações do canal do YouTube.');
  return {
    channelId: channel.id,
    title: channel.snippet.title,
    thumbnail: channel.snippet.thumbnails?.default?.url || ''
  };
}

function buildAuthorizedClient(account) {
  const client = getOAuthClient();
  if (!client) throw new Error('App do YouTube não configurado (faltam YOUTUBE_CLIENT_ID/SECRET/REDIRECT_URI).');
  if (!account.refreshToken) throw new Error('Canal do YouTube sem refresh token salvo — reconecte o canal em YouTube → Canais conectados.');
  client.setCredentials({ refresh_token: account.refreshToken });
  return client;
}

/** Extrai #hashtags de um texto como lista de tags (sem o #), para mandar como tags do vídeo. */
function extractTags(text) {
  const matches = String(text || '').match(/#(\w+)/g) || [];
  return [...new Set(matches.map(t => t.slice(1)))];
}

/**
 * Publica um post no YouTube. Espelha `publishToInstagram` do server.js: recebe
 * o post, resolve a conta/canal sozinho, baixa o vídeo (hoje já hospedado no
 * Cloudinary, igual aos Reels) e sobe pro YouTube.
 *
 * Como não existe um campo de "título" separado no post (schema compartilhado
 * com o Instagram), seguimos a mesma convenção do postador-yt pros arquivos
 * .txt: a primeira linha da legenda é o título, o resto é a descrição.
 */
async function publishToYouTube(post) {
  const db = await getDB();
  const account = await db.get('SELECT * FROM accounts WHERE "accountId" = ?', [post.accountId]);
  if (!account) throw new Error('Canal do YouTube desconectado ou não encontrado.');

  const client = buildAuthorizedClient(account);
  const youtube = google.youtube({ version: 'v3', auth: client });

  const isShort = post.mediaType === 'YOUTUBE_SHORT';
  const rawCaption = post.caption || '';
  const lines = rawCaption.split('\n');
  const title = (lines[0] || 'Vídeo').trim().slice(0, 100);
  let description = lines.slice(1).join('\n').trim() || rawCaption;
  const tags = extractTags(rawCaption);

  if (isShort) {
    if (!/#shorts/i.test(description)) description = `${description}\n\n#Shorts`.trim();
    if (!tags.some(t => t.toLowerCase() === 'shorts')) tags.push('Shorts');
  }

  if (!post.imageUrl) throw new Error('Post sem arquivo de vídeo.');
  const videoRes = await fetch(post.imageUrl);
  if (!videoRes.ok) throw new Error(`Não foi possível baixar o vídeo (HTTP ${videoRes.status}) para enviar ao YouTube.`);

  const requestBody = {
    snippet: {
      title,
      description: description.slice(0, 5000),
      tags: tags.slice(0, 50),
      categoryId: '22' // People & Blogs — a mais segura para conteúdo genérico
    },
    status: {
      privacyStatus: 'public',
      selfDeclaredMadeForKids: false
    }
  };

  try {
    const insertRes = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody,
      media: { body: videoRes.body }
    });
    const videoId = insertRes.data && insertRes.data.id;
    if (!videoId) throw new Error('O YouTube não retornou o ID do vídeo enviado.');
    return videoId;
  } catch (err) {
    const apiMsg = err?.response?.data?.error?.message || err.message;
    if (/uploadLimitExceeded/i.test(apiMsg) || /number of videos they may upload/i.test(apiMsg)) {
      throw new Error('O canal atingiu o limite diário de uploads do YouTube (cota de 100 vídeos/dia). Tente de novo mais tarde.');
    }
    throw new Error(`[YouTube] ${apiMsg}`);
  }
}

/** Horários prontos para quem não quer escolher na mão (mesma tabela do README do postador-yt). */
function suggestTimes(porDia) {
  const n = Math.max(1, Math.min(MAX_PER_DAY, parseInt(porDia, 10) || 1));
  return [...SUGGESTED_TIMES[n]];
}

/** Decide a lista de horários: automática pelo ritmo, ou a que vier escrita/array. */
function resolveTimes({ horarios, porDia, automatic }) {
  const isAutoString = typeof horarios === 'string' && horarios.trim().toLowerCase() === 'auto';
  if (automatic || isAutoString || !horarios) return suggestTimes(porDia || 1);
  if (Array.isArray(horarios)) return horarios.map(h => String(h).trim()).filter(Boolean);
  return horarios.split(',').map(s => s.trim()).filter(Boolean);
}

function parseTimeList(times) {
  if (!times || times.length === 0) throw new Error('Nenhum horário informado.');
  const pairs = times.map(texto => {
    const [h, m] = String(texto).split(':').map(Number);
    const hora = h || 0;
    const minuto = m || 0;
    if (!(hora >= 0 && hora <= 23 && minuto >= 0 && minuto <= 59)) {
      throw new Error(`Horário fora da faixa: ${texto}`);
    }
    return [hora, minuto];
  });
  const uniqKeys = [...new Set(pairs.map(p => p.join(':')))];
  return uniqKeys.map(k => k.split(':').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
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

/** Converte ano/mês/dia/hora/minuto *local* (no fuso informado) para um Date em UTC. */
function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMinutes = getTimezoneOffsetMinutes(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offsetMinutes * 60000);
}

/**
 * Gera `quantidade` horários de publicação (Date em UTC), distribuídos nos
 * dias a partir de `comecarEm` (ou hoje), preenchendo todos os horários de
 * cada dia antes de passar pro próximo — porta de `core/agenda.py::montar`.
 */
function buildSchedule({ quantidade, horarios, comecarEm, timezone = DEFAULT_TIMEZONE, safetyMinutes = 20, after = null }) {
  const pairs = parseTimeList(horarios);
  const now = new Date();
  let minimum = new Date(now.getTime() + safetyMinutes * 60000);
  if (after instanceof Date && !isNaN(after) && after >= minimum) {
    minimum = new Date(after.getTime() + 60000);
  }

  let day;
  if (comecarEm) {
    const [y, m, d] = comecarEm.split('-').map(Number);
    day = { y, m, d };
  } else {
    const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = dtf.formatToParts(minimum).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    day = { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
  }

  const result = [];
  const maxDaysToScan = 366 * 3; // teto de segurança — nunca varre mais que alguns anos
  for (let i = 0; i < maxDaysToScan && result.length < quantidade; i++) {
    for (const [hora, minuto] of pairs) {
      const candidate = zonedTimeToUtc(day.y, day.m, day.d, hora, minuto, timezone);
      if (candidate < minimum) continue;
      result.push(candidate);
      if (result.length === quantidade) break;
    }
    const nextDay = new Date(Date.UTC(day.y, day.m - 1, day.d + 1));
    day = { y: nextDay.getUTCFullYear(), m: nextDay.getUTCMonth() + 1, d: nextDay.getUTCDate() };
  }

  if (result.length < quantidade) throw new Error('Não foi possível montar o agendamento com esses horários.');
  return result;
}

module.exports = {
  isConfigured,
  getAuthUrl,
  exchangeCode,
  getChannelInfo,
  publishToYouTube,
  suggestTimes,
  resolveTimes,
  buildSchedule,
  SUGGESTED_TIMES,
  MAX_PER_DAY,
  DEFAULT_TIMEZONE
};
