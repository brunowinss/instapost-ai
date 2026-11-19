/**
 * Cloudinary: uso do plano e limpeza dos arquivos que já foram publicados.
 *
 * O envio continua sendo feito pelo navegador com o preset não-assinado. Aqui, no servidor, ficam as
 * operações que exigem API Key + API Secret (que nunca saem do servidor): ler o uso e apagar arquivos.
 *
 * Regra de segurança: um arquivo só é apagado quando nada mais vai precisar dele. Fica protegido se
 * aparecer num post agendado/publicando, no loop de Stories ou no Acervo.
 */
const nodeFetch = require('node-fetch');

let http = nodeFetch;
/** Só para testes: troca o cliente HTTP. */
function _setFetch(fn) { http = fn || nodeFetch; }

// Depois de publicado, espera um pouco antes de apagar (a rede pode ainda estar processando o vídeo).
const DELETE_AFTER_MS = 2 * 3600 * 1000;
// Post com erro guarda o arquivo por uma semana, para dar tempo de tentar de novo.
const KEEP_FAILED_MS = 7 * 24 * 3600 * 1000;

/** https://res.cloudinary.com/<cloud>/<video|image|raw>/upload/[transformações/]v123/<public_id>.<ext> */
function parseCloudinaryUrl(url) {
  const m = String(url || '').match(/^https?:\/\/res\.cloudinary\.com\/([^/]+)\/(image|video|raw)\/upload\/(.+)$/);
  if (!m) return null;
  const parts = m[3].split('?')[0].split('/');
  const v = parts.findIndex(p => /^v\d+$/.test(p));
  const rest = v >= 0 ? parts.slice(v + 1) : parts.filter(p => !/^[a-z]{1,3}_[^/]*$/.test(p) && !p.includes(','));
  if (rest.length === 0) return null;
  const path = rest.join('/');
  const publicId = m[2] === 'raw' ? path : path.replace(/\.[^./]+$/, '');
  return { cloud: m[1], resourceType: m[2], publicId: decodeURIComponent(publicId) };
}

/**
 * Todos os arquivos do Cloudinary citados em textos (URLs soltas, JSON de carrossel, listas do loop...).
 * Com `cloud`, só os da conta configurada: link de outra conta não é nosso para apagar.
 */
function idsInText(texts, cloud) {
  const ids = new Set();
  for (const text of texts) {
    for (const url of String(text || '').match(/https?:\/\/res\.cloudinary\.com\/[^\s"'\\,\]]+/g) || []) {
      const parsed = parseCloudinaryUrl(url);
      if (parsed && (!cloud || parsed.cloud === cloud)) ids.add(`${parsed.resourceType}:${parsed.publicId}`);
    }
  }
  return ids;
}

/**
 * Quais arquivos já podem sair do Cloudinary.
 * posts: todos os posts ({ imageUrl, mediaItems, status, publishedAt }); protectedTexts: loop de Stories e Acervo.
 * deleted: chaves já apagadas antes. Devolve [{ resourceType, publicId, key }].
 */
function planAutoDelete({ posts, protectedTexts = [], deleted = new Set(), cloud, now = Date.now() }) {
  const busy = idsInText([
    ...posts.filter(p => p.status === 'pending' || p.status === 'processing').flatMap(p => [p.imageUrl, p.mediaItems]),
    ...protectedTexts
  ]);

  const byKey = new Map();
  for (const post of posts) {
    if (post.status !== 'success' && post.status !== 'error') continue;
    for (const key of idsInText([post.imageUrl, post.mediaItems], cloud)) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(post);
    }
  }

  const out = [];
  for (const [key, refs] of byKey) {
    if (busy.has(key) || deleted.has(key)) continue;
    const newest = Math.max(...refs.map(p => new Date(p.publishedAt || 0).getTime() || 0));
    const hasError = refs.some(p => p.status === 'error');
    const waited = now - newest >= (hasError ? KEEP_FAILED_MS : DELETE_AFTER_MS);
    if (!waited) continue;
    const [resourceType, ...rest] = key.split(':');
    out.push({ key, resourceType, publicId: rest.join(':') });
  }
  return out;
}

function authHeader(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString('base64');
}

async function adminCall(cfg, path, { method = 'GET', query = '' } = {}) {
  const url = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloud)}${path}${query ? `?${query}` : ''}`;
  const res = await http(url, { method, headers: { Authorization: authHeader(cfg) }, timeout: 30000 });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (res.status === 401) throw new Error('Cloudinary recusou a API Key/Secret. Confira em Settings → API Keys.');
  if (!res.ok || !data || data.error) throw new Error(`Cloudinary: ${(data && data.error && data.error.message) || `HTTP ${res.status}`}`);
  return data;
}

/** Uso do plano: créditos (plano grátis), armazenamento, banda e transformações. */
async function getUsage(cfg) {
  const u = await adminCall(cfg, '/usage');
  const credits = u.credits || {};
  return {
    plan: u.plan || null,
    credits: { used: credits.usage ?? null, limit: credits.limit ?? null, percent: credits.used_percent ?? null },
    storageBytes: (u.storage && u.storage.usage) ?? null,
    bandwidthBytes: (u.bandwidth && u.bandwidth.usage) ?? null,
    transformations: (u.transformations && u.transformations.usage) ?? null,
    files: (u.resources ?? (u.objects && u.objects.usage)) ?? null
  };
}

/** Apaga até 100 arquivos de um tipo por chamada. Devolve os ids apagados (ou que já não existiam). */
async function deleteResources(cfg, resourceType, publicIds) {
  const gone = [];
  for (let i = 0; i < publicIds.length; i += 100) {
    const batch = publicIds.slice(i, i + 100);
    const query = batch.map(id => `public_ids[]=${encodeURIComponent(id)}`).join('&') + '&invalidate=true';
    const data = await adminCall(cfg, `/resources/${resourceType}/upload`, { method: 'DELETE', query });
    for (const [id, result] of Object.entries(data.deleted || {})) {
      if (result === 'deleted' || result === 'not_found') gone.push(id);
    }
  }
  return gone;
}

/** Arquivos enviados antes de `before` (para a limpeza dos antigos). */
async function listResourcesBefore(cfg, resourceType, before) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const query = `max_results=500${cursor ? `&next_cursor=${encodeURIComponent(cursor)}` : ''}`;
    const data = await adminCall(cfg, `/resources/${resourceType}/upload`, { query });
    for (const r of data.resources || []) {
      if (new Date(r.created_at).getTime() < before) out.push({ publicId: r.public_id, bytes: r.bytes || 0, resourceType });
    }
    cursor = data.next_cursor;
    if (!cursor) break;
  }
  return out;
}

module.exports = {
  DELETE_AFTER_MS, KEEP_FAILED_MS,
  parseCloudinaryUrl, idsInText, planAutoDelete,
  getUsage, deleteResources, listResourcesBefore, _setFetch
};
