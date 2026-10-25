/**
 * Publicação em Páginas do Facebook (Graph API).
 *
 * Usa o Login do Facebook para Empresas do mesmo app da Meta do Instagram:
 * a pessoa entra com a conta que administra as Páginas, o app troca o código
 * por um token de longa duração e guarda o token de cada Página (que não vence).
 */
const nodeFetch = require('node-fetch');
const { getDB } = require('./database');

const GRAPH_VERSION = 'v22.0';
const PERMISSIONS = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'publish_video'];

let http = nodeFetch;
/** Só para testes: troca o cliente HTTP. */
function _setFetch(fn) { http = fn || nodeFetch; }

function config() {
  const redirectBase = process.env.REDIRECT_URI ? safeOrigin(process.env.REDIRECT_URI) : '';
  return {
    appId: process.env.FACEBOOK_APP_ID || process.env.META_APP_ID || process.env.APP_ID || '',
    appSecret: process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET || process.env.APP_SECRET || '',
    configId: process.env.FACEBOOK_CONFIG_ID || '',
    redirectUri: process.env.FACEBOOK_REDIRECT_URI || (redirectBase ? `${redirectBase}/auth/facebook/callback` : '')
  };
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function isConfigured() {
  const c = config();
  return !!(c.appId && c.appSecret && c.redirectUri);
}

/** URL de login. Com `config_id` usa o Login para Empresas; sem ele, cai nas permissões clássicas. */
function getAuthUrl(state) {
  const c = config();
  if (!isConfigured()) return null;
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', c.appId);
  url.searchParams.set('redirect_uri', c.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  if (c.configId) {
    url.searchParams.set('config_id', c.configId);
    url.searchParams.set('override_default_response_type', 'true');
  } else {
    url.searchParams.set('scope', PERMISSIONS.join(','));
  }
  return url.toString();
}

function describeError(error) {
  if (!error) return 'Resposta inesperada do Facebook.';
  if (error.code === 190) {
    const subcode = error.error_subcode ? `, subcódigo ${error.error_subcode}` : '';
    return `O acesso à Página expirou ou foi revogado — reconecte a Página na aba Facebook. (Meta: ${error.message || 'token inválido'}${subcode})`;
  }
  if (error.code === 10 || error.code === 200 || (error.code >= 200 && error.code <= 299)) {
    return `Sem permissão para publicar nessa Página (${error.message}). Reconecte e aceite todas as permissões.`;
  }
  const detail = error.error_user_msg && error.error_user_msg !== error.message ? ` — ${error.error_user_msg}` : '';
  return `[Facebook ${error.code || '?'}] ${error.message || 'erro desconhecido'}${detail}`;
}

async function graph(path, { method = 'GET', params = {}, host = 'graph.facebook.com' } = {}) {
  const url = new URL(`https://${host}/${GRAPH_VERSION}${path}`);
  const options = { method, timeout: 60000 };
  if (method === 'GET') {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  } else {
    options.body = new URLSearchParams(params).toString();
    options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  }
  const res = await http(url.toString(), options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok || !data || data.error) throw new Error(describeError(data && data.error ? data.error : { message: `HTTP ${res.status}` }));
  return data;
}

/**
 * Desempenho da Página e dos posts publicados pelo painel.
 * Só usa campos liberados por pages_read_engagement: alcance e impressões exigiriam read_insights.
 * posts: [{ mediaId, mediaType }]. Post apagado na Meta vira { unavailable: true } em vez de derrubar tudo.
 */
async function getFacebookStats(account, posts = []) {
  const token = account.accessToken;
  const pageId = encodeURIComponent(account.accountId);

  const info = await graph(`/${pageId}`, { params: { fields: 'fan_count,followers_count', access_token: token } });
  const page = {
    likes: info.fan_count ?? null,
    followers: info.followers_count ?? null
  };

  const total = (node) => (node && node.summary && typeof node.summary.total_count === 'number') ? node.summary.total_count : null;
  const fetchOne = async (post) => {
    try {
      if (post.mediaType === 'FB_VIDEO') {
        const v = await graph(`/${encodeURIComponent(post.mediaId)}`, {
          params: { fields: 'views,likes.summary(true).limit(0),comments.summary(true).limit(0)', access_token: token }
        });
        return { id: post.mediaId, views: v.views ?? null, reactions: total(v.likes), comments: total(v.comments), shares: null };
      }
      const p = await graph(`/${encodeURIComponent(post.mediaId)}`, {
        params: { fields: 'reactions.summary(true).limit(0),comments.summary(true).limit(0),shares', access_token: token }
      });
      return { id: post.mediaId, views: null, reactions: total(p.reactions), comments: total(p.comments), shares: p.shares ? p.shares.count : 0 };
    } catch {
      return { id: post.mediaId, unavailable: true };
    }
  };

  const results = {};
  for (const stats of await Promise.all(posts.slice(0, 25).map(fetchOne))) results[stats.id] = stats;
  return { page, posts: results };
}

/**
 * Pergunta à Meta se o token guardado de uma Página ainda vale (e quando vence).
 * expiresAt null = não vence.
 */
async function checkPageToken(account) {
  if (!account || !account.accessToken) return { valid: false, reason: 'Sem token salvo para essa Página.' };
  const c = config();
  try {
    const result = await graph('/debug_token', { params: { input_token: account.accessToken, access_token: `${c.appId}|${c.appSecret}` } });
    const info = result.data || {};
    const expiresAt = info.expires_at ? new Date(info.expires_at * 1000).toISOString() : null;
    const missing = info.is_valid ? PERMISSIONS.filter(p => Array.isArray(info.scopes) && !info.scopes.includes(p)) : [];
    return {
      valid: !!info.is_valid && missing.length === 0,
      type: info.type || null,
      expiresAt,
      reason: info.is_valid
        ? (missing.length ? `Faltam permissões: ${missing.join(', ')}.` : null)
        : ((info.error && info.error.message) || 'A Meta recusou esse token.')
    };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

/** Troca o código do login pelas Páginas que a pessoa administra, já com o token de cada uma. */
async function exchangeCodeForPages(code) {
  const c = config();
  const tokenData = await graph('/oauth/access_token', {
    params: { client_id: c.appId, client_secret: c.appSecret, redirect_uri: c.redirectUri, code }
  });

  let userToken = tokenData.access_token;
  try {
    const longLived = await graph('/oauth/access_token', {
      params: { grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: userToken }
    });
    if (longLived.access_token) userToken = longLived.access_token;
  } catch (err) {
    // Ainda dá para listar as Páginas, mas o token delas pode sair de curta duração: fica registrado.
    console.warn('[FACEBOOK] Troca por token de longa duração falhou:', err.message);
  }

  const PAGE_FIELDS = 'id,name,access_token,picture.type(large){url}';
  const toPage = (page) => ({
    id: String(page.id),
    name: page.name || `Página ${page.id}`,
    accessToken: page.access_token,
    picture: (page.picture && page.picture.data && page.picture.data.url) || ''
  });

  const listed = await graph('/me/accounts', { params: { fields: PAGE_FIELDS, limit: '100', access_token: userToken } });
  const rows = listed.data || [];
  let pages = rows.filter(page => page.id && page.access_token).map(toPage);
  if (pages.length > 0) return pages;

  // A lista veio vazia (ou sem token). Plano B: pegar as Páginas que a pessoa marcou no login
  // pelo ID, que é como a Meta registra o que foi liberado.
  const granularIds = await grantedPageIds(userToken);
  for (const id of granularIds) {
    try {
      const page = await graph(`/${encodeURIComponent(id)}`, { params: { fields: PAGE_FIELDS, access_token: userToken } });
      if (page.id && page.access_token) pages.push(toPage(page));
    } catch {
      // Essa Página específica não entregou token; o diagnóstico abaixo explica.
    }
  }
  if (pages.length > 0) return pages;

  throw new Error(explainNoPages({ listed: rows.length, granularIds, permissions: await grantedPermissions(userToken) }));
}

/** IDs das Páginas que a pessoa marcou na tela de login (escopos granulares do token). */
async function grantedPageIds(userToken) {
  try {
    const c = config();
    const debug = await graph('/debug_token', { params: { input_token: userToken, access_token: `${c.appId}|${c.appSecret}` } });
    const ids = new Set();
    for (const scope of (debug.data && debug.data.granular_scopes) || []) {
      if (PERMISSIONS.includes(scope.scope)) (scope.target_ids || []).forEach(id => ids.add(String(id)));
    }
    return [...ids];
  } catch {
    return [];
  }
}

async function grantedPermissions(userToken) {
  try {
    const result = await graph('/me/permissions', { params: { access_token: userToken } });
    return new Set((result.data || []).filter(p => p.status === 'granted').map(p => p.permission));
  } catch {
    return null;
  }
}

/** Explica por que nenhuma Página serve, em vez de uma mensagem genérica. */
function explainNoPages({ listed, granularIds, permissions }) {
  const missing = permissions ? PERMISSIONS.filter(p => !permissions.has(p)) : [];
  if (missing.length > 0) {
    return `A Meta não liberou estas permissões: ${missing.join(', ')}. Conecte de novo, clique em "Editar configurações" e deixe todas ligadas.`;
  }
  if (listed > 0 || granularIds.length > 0) {
    const count = Math.max(listed, granularIds.length);
    return `A Meta reconheceu ${count} Página(s), mas não entregou o acesso para publicar nelas. Você precisa ser administrador com acesso total à Página (Página → Configurações → Acesso à Página).`;
  }
  return 'Nenhuma Página encontrada. Na tela de login do Facebook, clique em "Editar configurações", marque as Páginas que quer conectar (e confirme que você é administrador delas).';
}

/**
 * Publica um post numa Página. Espelha publishToInstagram/publishToYouTube:
 * resolve a Página sozinho, publica e devolve o ID do post/vídeo.
 *
 * mediaType: FB_TEXT (só texto), FB_PHOTO (imageUrl) ou FB_VIDEO (imageUrl).
 * No vídeo, a primeira linha da legenda vira o título e o resto a descrição.
 */
async function publishToFacebook(post) {
  const db = await getDB();
  const account = await db.get('SELECT * FROM accounts WHERE "accountId" = ?', [post.accountId]);
  if (!account || account.platform !== 'facebook' || !account.accessToken) {
    throw new Error('Página do Facebook desconectada ou não encontrada.');
  }

  const token = account.accessToken;
  const pageId = encodeURIComponent(account.accountId);
  const caption = post.caption || '';

  if (post.mediaType === 'FB_PHOTO') {
    if (!post.imageUrl) throw new Error('Post sem foto.');
    const result = await graph(`/${pageId}/photos`, {
      method: 'POST', params: { url: post.imageUrl, caption, published: 'true', access_token: token }
    });
    return String(result.post_id || result.id);
  }

  if (post.mediaType === 'FB_VIDEO') {
    if (!post.imageUrl) throw new Error('Post sem vídeo.');
    const [title, ...rest] = caption.split('\n');
    const description = rest.join('\n').trim() || caption;
    const result = await graph(`/${pageId}/videos`, {
      method: 'POST', host: 'graph-video.facebook.com',
      params: { file_url: post.imageUrl, title: title.slice(0, 100), description, access_token: token }
    });
    return String(result.id);
  }

  if (!caption.trim()) throw new Error('Post de texto sem conteúdo.');
  const result = await graph(`/${pageId}/feed`, { method: 'POST', params: { message: caption, access_token: token } });
  return String(result.id);
}

module.exports = {
  PERMISSIONS,
  isConfigured,
  getAuthUrl,
  exchangeCodeForPages,
  publishToFacebook,
  describeError,
  checkPageToken,
  getFacebookStats,
  _setFetch
};
