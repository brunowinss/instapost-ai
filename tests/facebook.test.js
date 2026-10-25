const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// facebook.js lê a Página no banco; aqui o banco é falso para o teste nunca tocar em dados reais.
const pages = [];
require.cache[require.resolve('../database')] = {
  id: require.resolve('../database'), filename: require.resolve('../database'), loaded: true,
  exports: { getDB: async () => ({ get: async (sql, params) => pages.find(p => p.accountId === params[0]) }) }
};
const facebook = require('../facebook');

const calls = [];
function reply(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}
function mockGraph(handler) {
  facebook._setFetch(async (url, options = {}) => {
    const parsed = new URL(url);
    const params = options.body ? Object.fromEntries(new URLSearchParams(options.body)) : Object.fromEntries(parsed.searchParams);
    calls.push({ host: parsed.hostname, path: parsed.pathname, method: options.method || 'GET', params });
    return handler(parsed, params);
  });
}

beforeEach(() => {
  calls.length = 0;
  pages.length = 0;
  process.env.FACEBOOK_APP_ID = 'APP123';
  process.env.FACEBOOK_APP_SECRET = 'SECRET456';
  process.env.FACEBOOK_CONFIG_ID = '999';
  process.env.FACEBOOK_REDIRECT_URI = 'https://exemplo.com/auth/facebook/callback';
  pages.push({ accountId: 'PG1', platform: 'facebook', accessToken: 'PAGE-TOKEN', username: 'Minha Página' });
});

test('login URL uses the Business Login configuration, and falls back to scopes without one', () => {
  const withConfig = new URL(facebook.getAuthUrl('abc.def'));
  assert.equal(withConfig.hostname, 'www.facebook.com');
  assert.equal(withConfig.searchParams.get('client_id'), 'APP123');
  assert.equal(withConfig.searchParams.get('config_id'), '999');
  assert.equal(withConfig.searchParams.get('redirect_uri'), 'https://exemplo.com/auth/facebook/callback');
  assert.equal(withConfig.searchParams.get('state'), 'abc.def');
  assert.equal(withConfig.searchParams.get('scope'), null);

  delete process.env.FACEBOOK_CONFIG_ID;
  const classic = new URL(facebook.getAuthUrl('s'));
  assert.equal(classic.searchParams.get('config_id'), null);
  assert.equal(classic.searchParams.get('scope'), 'pages_show_list,pages_read_engagement,pages_manage_posts,publish_video');
});

test('not configured without app id/secret; redirect defaults to the site origin', () => {
  delete process.env.FACEBOOK_APP_ID; delete process.env.APP_ID; delete process.env.META_APP_ID;
  assert.equal(facebook.isConfigured(), false);
  assert.equal(facebook.getAuthUrl('s'), null);

  process.env.FACEBOOK_APP_ID = 'APP123';
  delete process.env.FACEBOOK_REDIRECT_URI;
  process.env.REDIRECT_URI = 'https://instapost.brunowins.com/auth/callback';
  assert.equal(new URL(facebook.getAuthUrl('s')).searchParams.get('redirect_uri'), 'https://instapost.brunowins.com/auth/facebook/callback');
});

test('code exchange: user token -> long-lived token -> Pages with their own non-expiring tokens', async () => {
  mockGraph((url) => {
    if (url.pathname.endsWith('/oauth/access_token') && url.searchParams.get('grant_type') === 'fb_exchange_token') return reply({ access_token: 'LONG-USER' });
    if (url.pathname.endsWith('/oauth/access_token')) return reply({ access_token: 'SHORT-USER' });
    return reply({ data: [
      { id: '1', name: 'Loja', access_token: 'PT-1', picture: { data: { url: 'https://cdn/1.jpg' } } },
      { id: '2', name: 'Sem token' },
      { id: '3', name: 'Blog', access_token: 'PT-3' }
    ] });
  });

  const result = await facebook.exchangeCodeForPages('CODE');
  assert.deepEqual(result.map(p => [p.id, p.accessToken]), [['1', 'PT-1'], ['3', 'PT-3']]);
  assert.equal(result[0].picture, 'https://cdn/1.jpg');
  assert.equal(result[1].picture, '');

  assert.equal(calls[0].params.code, 'CODE');
  assert.equal(calls[0].params.client_secret, 'SECRET456');
  assert.equal(calls[1].params.fb_exchange_token, 'SHORT-USER');
  assert.equal(calls[2].path.endsWith('/me/accounts'), true);
  assert.equal(calls[2].params.access_token, 'LONG-USER', 'as Páginas são listadas com o token de longa duração');
});

test('code exchange survives a failing long-lived exchange and surfaces provider errors', async () => {
  mockGraph((url) => {
    if (url.searchParams.get('grant_type') === 'fb_exchange_token') return reply({ error: { code: 1, message: 'falha' } }, 400);
    if (url.pathname.endsWith('/oauth/access_token')) return reply({ access_token: 'SHORT-USER' });
    return reply({ data: [{ id: '1', name: 'Loja', access_token: 'PT-1' }] });
  });
  assert.equal((await facebook.exchangeCodeForPages('CODE'))[0].accessToken, 'PT-1');

  mockGraph(() => reply({ error: { code: 100, message: 'Invalid verification code format.' } }, 400));
  await assert.rejects(() => facebook.exchangeCodeForPages('X'), /Invalid verification code/);
});

test('publishing: text goes to /feed, photo to /photos, video to graph-video /videos with title and description', async () => {
  mockGraph((url) => reply(url.pathname.endsWith('/photos') ? { id: 'ph1', post_id: 'PG1_55' } : { id: 'x' + calls.length }));

  assert.equal(await facebook.publishToFacebook({ accountId: 'PG1', mediaType: 'FB_TEXT', caption: 'Olá!' }), 'x1');
  assert.deepEqual([calls[0].path, calls[0].method, calls[0].params.message, calls[0].params.access_token], ['/v22.0/PG1/feed', 'POST', 'Olá!', 'PAGE-TOKEN']);

  assert.equal(await facebook.publishToFacebook({ accountId: 'PG1', mediaType: 'FB_PHOTO', imageUrl: 'https://cdn/a.jpg', caption: 'Foto' }), 'PG1_55');
  assert.deepEqual([calls[1].path, calls[1].params.url, calls[1].params.caption, calls[1].params.published], ['/v22.0/PG1/photos', 'https://cdn/a.jpg', 'Foto', 'true']);

  await facebook.publishToFacebook({ accountId: 'PG1', mediaType: 'FB_VIDEO', imageUrl: 'https://cdn/v.mp4', caption: 'Título do vídeo\n\nDescrição longa' });
  assert.equal(calls[2].host, 'graph-video.facebook.com');
  assert.deepEqual([calls[2].path, calls[2].params.file_url, calls[2].params.title, calls[2].params.description], ['/v22.0/PG1/videos', 'https://cdn/v.mp4', 'Título do vídeo', 'Descrição longa']);
});

test('publishing refuses missing media, wrong platform and unknown Pages before calling Facebook', async () => {
  mockGraph(() => reply({ id: '1' }));
  await assert.rejects(() => facebook.publishToFacebook({ accountId: 'PG1', mediaType: 'FB_PHOTO', caption: 'sem foto' }), /sem foto/i);
  await assert.rejects(() => facebook.publishToFacebook({ accountId: 'PG1', mediaType: 'FB_VIDEO', caption: 'sem video' }), /sem vídeo/i);
  await assert.rejects(() => facebook.publishToFacebook({ accountId: 'PG1', mediaType: 'FB_TEXT', caption: '   ' }), /sem conteúdo/i);
  await assert.rejects(() => facebook.publishToFacebook({ accountId: 'NOPE', mediaType: 'FB_TEXT', caption: 'oi' }), /desconectada/i);

  pages.push({ accountId: 'IG9', platform: 'instagram', accessToken: 'IGAA' });
  await assert.rejects(() => facebook.publishToFacebook({ accountId: 'IG9', mediaType: 'FB_TEXT', caption: 'oi' }), /desconectada/i);
  assert.equal(calls.length, 0);
});

test('Facebook errors are explained: expired token asks to reconnect, permission errors say so', async () => {
  mockGraph(() => reply({ error: { code: 190, message: 'Error validating access token' } }, 400));
  await assert.rejects(() => facebook.publishToFacebook({ accountId: 'PG1', mediaType: 'FB_TEXT', caption: 'oi' }), /reconecte a Página/i);

  mockGraph(() => reply({ error: { code: 200, message: '(#200) Requires pages_manage_posts permission' } }, 403));
  await assert.rejects(() => facebook.publishToFacebook({ accountId: 'PG1', mediaType: 'FB_TEXT', caption: 'oi' }), /Sem permissão/);

  mockGraph(() => reply({ error: { code: 368, message: 'Bloqueado', error_user_msg: 'Conteúdo repetido' } }, 400));
  await assert.rejects(() => facebook.publishToFacebook({ accountId: 'PG1', mediaType: 'FB_TEXT', caption: 'oi' }), /\[Facebook 368\] Bloqueado — Conteúdo repetido/);
});
