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
  if (error.code === 190) return 'O acesso à Página expirou ou foi revogado — reconecte a Página na aba Facebook.';
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
  } catch {
    // Sem token de longa duração ainda dá para listar as Páginas; o token da Página sai igual.
  }

  const pages = await graph('/me/accounts', {
    params: { fields: 'id,name,access_token,picture.type(large){url}', limit: '100', access_token: userToken }
  });

  return (pages.data || [])
    .filter(page => page.id && page.access_token)
    .map(page => ({
      id: String(page.id),
      name: page.name || `Página ${page.id}`,
      accessToken: page.access_token,
      picture: (page.picture && page.picture.data && page.picture.data.url) || ''
    }));
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
  _setFetch
};
