const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readMetaResponse, resolveInstagramProfile, needsProfileSync } = require('../instagram-profile');

function response(data, status = 200) {
  return { ok: status === 200, status, text: async () => typeof data === 'string' ? data : JSON.stringify(data) };
}

test('preserves large numeric Meta IDs without altering quoted strings or counters', async () => {
  const data = await readMetaResponse(response('{"user_id":28473373415612949,"count":12,"ratio":1.2,"message":"id: 28473373415612949, \\"quoted\\""}'.replaceAll('\\\\"', '\\"')));
  assert.equal(data.user_id, '28473373415612949');
  assert.equal(data.count, 12);
  assert.equal(data.ratio, 1.2);
  assert.equal(data.message, 'id: 28473373415612949, "quoted"');
});

test('gets username and official photo from Instagram Login with user_id', async () => {
  const calls = [];
  const profile = await resolveInstagramProfile('IGAA+token&value', null, { fetch: async (url, options) => {
    const request = new URL(url);
    calls.push(request);
    assert.equal(request.hostname, 'graph.instagram.com');
    assert.equal(request.searchParams.get('access_token'), 'IGAA+token&value');
    assert.equal(request.searchParams.get('fields'), 'user_id,username,profile_picture_url');
    assert.equal(options.timeout, 8000);
    return response({ id: 'app-scoped', user_id: '17841400000000001', username: 'real_account', profile_picture_url: 'https://cdn.example/avatar.jpg' });
  } });
  assert.deepEqual(profile, { id: '17841400000000001', username: 'real_account', profilePictureUrl: 'https://cdn.example/avatar.jpg' });
  assert.equal(calls.length, 1);
});

test('keeps searching for the photo after resolving the username and preserves user_id', async () => {
  const calls = [];
  const profile = await resolveInstagramProfile('IGAA-token', 'rounded-old-id', { fetch: async url => {
    const request = new URL(url);
    calls.push(request);
    if (calls.length === 1) return response({ error: { code: 100 } }, 400);
    if (calls.length === 2) return response({ user_id: '17841400000000001', username: 'real_account' });
    assert.equal(request.pathname, '/v22.0/17841400000000001');
    return response({ id: 'different-app-scoped-id', profile_picture_url: 'https://cdn.example/photo.jpg' });
  } });
  assert.equal(profile.username, 'real_account');
  assert.equal(profile.id, '17841400000000001');
  assert.equal(profile.profilePictureUrl, 'https://cdn.example/photo.jpg');
  assert.equal(calls.length, 3);
});

test('does not invent a photo URL when the API only provides a username', async () => {
  const profile = await resolveInstagramProfile('IGAA-token', null, { fetch: async () => response({ user_id: '123', username: 'instagram_creator' }) });
  assert.equal(profile.username, 'instagram_creator');
  assert.equal(profile.profilePictureUrl, null);
});

test('expired tokens and network errors do not create fake usernames', async () => {
  for (const fetch of [async () => response({ error: { code: 190 } }, 400), async () => { throw new Error('network'); }]) {
    const result = await resolveInstagramProfile('IGAA-token', '123', { fetch });
    assert.equal(result.username, null);
    assert.equal(result.profilePictureUrl, null);
  }
});

test('Facebook login selects the requested linked account, never the first page', async () => {
  const profile = await resolveInstagramProfile('EAA-token', '222', { fetch: async url => {
    const request = new URL(url);
    assert.equal(request.hostname, 'graph.facebook.com');
    if (!request.pathname.endsWith('/me/accounts')) return response({ error: { code: 100 } }, 400);
    return response({ data: [
      { instagram_business_account: { id: '111', username: 'wrong', profile_picture_url: 'wrong.jpg' } },
      { instagram_business_account: { id: '222', username: 'right', profile_picture_url: 'right.jpg' } }
    ] });
  } });
  assert.deepEqual(profile, { id: '222', username: 'right', profilePictureUrl: 'right.jpg' });
});

test('Facebook login does not choose arbitrarily among multiple linked accounts', async () => {
  const profile = await resolveInstagramProfile('EAA-token', null, { fetch: async () => response({ data: [
    { instagram_business_account: { id: '111', username: 'first' } },
    { instagram_business_account: { id: '222', username: 'second' } }
  ] }) });
  assert.equal(profile.username, null);
});

test('missing names, old placeholder names and third-party avatars are eligible for repair', () => {
  assert.equal(needsProfileSync(null, 'https://cdn.example/a.jpg'), true);
  assert.equal(needsProfileSync('instagram_28473373415612948', 'broken.jpg'), true);
  assert.equal(needsProfileSync('real', 'https://unavatar.io/instagram/real'), true);
  assert.equal(needsProfileSync('real', ''), true);
  assert.equal(needsProfileSync('instagram_creator', 'https://cdn.example/a.jpg'), false);
});
