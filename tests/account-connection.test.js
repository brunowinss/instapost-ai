const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const profileApi = require('../instagram-profile');

function response(data, status = 200) {
  const raw = typeof data === 'string' ? data : JSON.stringify(data);
  return { ok: status === 200, status, text: async () => raw, json: async () => JSON.parse(raw) };
}

// Run the actual route handlers with isolated HTTP/database dependencies.
// No listening socket, scheduler, real credentials or production writes.
function serverHarness(fetch, accounts = [], postgres = false) {
  const routes = new Map();
  const writes = [];
  const logs = [];
  const app = { use() {}, listen() {} };
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (route, ...handlers) => routes.set(`${method} ${route}`, handlers.at(-1));
  }
  const express = Object.assign(() => app, { json() {}, static() {} });
  const db = {
    all: async sql => sql === 'SELECT * FROM accounts' ? accounts.map(a => ({ ...a })) : [],
    get: async (sql, params) => accounts.find(a => a.accountId === params?.[0]),
    run: async (sql, params) => writes.push({ sql, params })
  };
  const mocks = {
    express,
    cors: () => () => {},
    'node-fetch': fetch,
    dotenv: { config() {} },
    './database': { getDB: async () => db, initDB: () => new Promise(() => {}) },
    './auto_importer': {},
    './instagram-profile': {
      ...profileApi,
      resolveInstagramProfile: (token, id, options) => profileApi.resolveInstagramProfile(token, id, { ...options, fetch })
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), {
    require: name => name in mocks ? mocks[name] : require(name),
    __dirname: path.join(__dirname, '..'),
    process: { env: { SESSION_SECRET: 'test-only', IG_APP_ID: 'test-app', IG_APP_SECRET: 'test-secret', ...(postgres ? { DATABASE_URL: 'test-only' } : {}) }, on() {} },
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...values) => logs.push(values.join(' '))])),
    setInterval() {}, URLSearchParams, Buffer
  });
  return {
    writes, logs,
    async invoke(method, route, req = {}) {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; },
        send(body) { this.body = body; },
        redirect(url) { this.redirectUrl = url; }
      };
      await routes.get(`${method} ${route}`)({ query: {}, body: {}, ...req }, res);
      return res;
    }
  };
}

function oauthFetch(profileReply) {
  return async url => {
    const request = new URL(url);
    if (request.hostname === 'api.instagram.com') {
      return response('{"access_token":"IGAA-short-secret","user_id":28473373415612949}');
    }
    if (request.pathname === '/access_token') return response({ access_token: 'IGAA-long-secret' });
    return profileReply(request);
  };
}

for (const postgres of [false, true]) {
  test(`OAuth saves the exact ID, real username and official photo (${postgres ? 'PostgreSQL' : 'SQLite'})`, async () => {
    const server = serverHarness(oauthFetch(() => response({
      user_id: '28473373415612949', username: 'actual_account', profile_picture_url: 'https://cdn.example/photo.jpg'
    })), [], postgres);
    const res = await server.invoke('get', '/auth/callback', { query: { code: 'test-code' } });
    assert.match(res.body, /@actual_account/);
    assert.match(res.body, /https:\/\/cdn.example\/photo.jpg/);
    assert.equal(server.writes.length, 1);
    assert.deepEqual(Array.from(server.writes[0].params).slice(0, 4), [
      '28473373415612949', 'actual_account', 'IGAA-long-secret', 'https://cdn.example/photo.jpg'
    ]);
    assert.equal(server.writes[0].sql.includes('ON CONFLICT'), postgres);
    assert.doesNotMatch(server.logs.join('\n'), /IGAA-(short|long)-secret/);
  });
}

test('OAuth does not persist a generic account or report success when Meta denies profile access', async () => {
  const server = serverHarness(oauthFetch(() => response({ error: { code: 190 } }, 400)));
  const res = await server.invoke('get', '/auth/callback', { query: { code: 'test-code' } });
  assert.equal(server.writes.length, 0);
  assert.match(res.redirectUrl, /^\/\?error=/);
  assert.equal(res.body, undefined);
});

test('OAuth tries the short token for a missing photo even when the long token returned a username', async () => {
  const server = serverHarness(oauthFetch(request => response({
    user_id: '28473373415612949', username: 'actual_account',
    ...(request.searchParams.get('access_token') === 'IGAA-short-secret' ? { profile_picture_url: 'https://cdn.example/photo.jpg' } : {})
  })));
  await server.invoke('get', '/auth/callback', { query: { code: 'test-code' } });
  assert.equal(server.writes[0].params[3], 'https://cdn.example/photo.jpg');
});

test('loading saved accounts repairs placeholder names and unavatar URLs without exposing tokens', async () => {
  const accounts = [
    { accountId: '123', username: 'instagram_123', profilePictureUrl: '', accessToken: 'IGAA-old' },
    { accountId: '456', username: 'known', profilePictureUrl: 'https://unavatar.io/instagram/known', accessToken: 'IGAA-known' }
  ];
  const server = serverHarness(async url => {
    const known = new URL(url).searchParams.get('access_token') === 'IGAA-known';
    return response({ user_id: known ? '456' : '123', username: known ? 'known' : 'recovered', profile_picture_url: 'https://cdn.example/photo.jpg' });
  }, accounts);
  const res = await server.invoke('get', '/api/data');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.accounts[0].username, 'recovered');
  assert.equal(res.body.accounts[1].profilePictureUrl, 'https://cdn.example/photo.jpg');
  assert.equal(server.writes.length, 2);
  assert.equal(res.body.accounts[0].accessToken, undefined);
});

test('stats uses the recovered profile and Instagram host and caches its response', async () => {
  let requests = 0;
  const server = serverHarness(async url => {
    requests++;
    const request = new URL(url);
    assert.equal(request.hostname, 'graph.instagram.com');
    if (request.searchParams.get('fields').includes('followers_count')) {
      assert.equal(request.pathname, '/v22.0/123');
      return response({ followers_count: 42, follows_count: 5, media_count: 9 });
    }
    return response({ user_id: '123', username: 'recovered', profile_picture_url: 'https://cdn.example/photo.jpg' });
  }, [{ accountId: '123', username: 'instagram_123', accessToken: 'IGAA-old' }]);
  const first = await server.invoke('get', '/api/account-stats', { query: { accountId: '123' } });
  assert.equal(first.body.username, 'recovered');
  assert.equal(first.body.followersCount, 42);
  assert.equal(first.body.followsCount, 5);
  assert.equal(first.body.mediaCount, 9);
  const second = await server.invoke('get', '/api/account-stats', { query: { accountId: '123' } });
  assert.equal(second.body.cached, true);
  assert.equal(requests, 2);
});

test('sync failure preserves the saved photo instead of replacing it with an unavatar URL', async () => {
  const server = serverHarness(async () => response({ error: { code: 190 } }, 400), [
    { accountId: '123', username: 'known', profilePictureUrl: 'https://cdn.example/saved.jpg', accessToken: 'IGAA-old' }
  ]);
  const res = await server.invoke('post', '/api/accounts/sync-meta', { body: { accountId: '123' } });
  assert.equal(res.body.success, false);
  assert.equal(server.writes.length, 0);
});

test('manual token connection saves the profile returned by Instagram', async () => {
  const server = serverHarness(async url => {
    const request = new URL(url);
    assert.equal(request.hostname, 'graph.instagram.com');
    if (request.pathname === '/access_token') {
      assert.equal(request.searchParams.get('grant_type'), 'ig_exchange_token');
      assert.equal(request.searchParams.get('access_token'), 'IGAA-manual');
      return response({ access_token: 'IGAA-manual-long' });
    }
    assert.equal(request.searchParams.get('access_token'), 'IGAA-manual-long');
    return response({ user_id: '123', username: 'actual_account', profile_picture_url: 'https://cdn.example/photo.jpg' });
  });
  const res = await server.invoke('post', '/api/accounts/connect-by-link', { body: { linkOrToken: 'IGAA-manual' } });
  assert.equal(res.body.success, true);
  assert.equal(res.body.account.accountId, '123');
  assert.equal(res.body.account.profilePictureUrl, 'https://cdn.example/photo.jpg');
});
