const defaultFetch = require('node-fetch');

// Meta can return numeric IDs larger than Number.MAX_SAFE_INTEGER. Preserve
// their original digits before JSON.parse has a chance to round them.
async function readMetaResponse(response) {
  const raw = await response.text();
  return JSON.parse(raw.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, value => {
    if (/^-?\d+$/.test(value) && !Number.isSafeInteger(Number(value))) {
      return `"${value}"`;
    }
    return value;
  }));
}

function needsProfileSync(username, picture) {
  return !username || /^instagram_\d+$/.test(username) || !picture ||
    picture.startsWith('https://unavatar.io/');
}

async function resolveInstagramProfile(token, igUserId = null, options = {}) {
  const fetch = options.fetch || defaultFetch;
  const version = 'v22.0';
  const profile = { id: igUserId ? String(igUserId) : null, username: null, profilePictureUrl: null };
  if (!token) return profile;

  async function request(host, node, fields) {
    const url = new URL(`https://${host}/${version}/${node}`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('access_token', token);
    try {
      const response = await fetch(url.toString(), { timeout: 8000 });
      const data = await readMetaResponse(response);
      if (!response.ok || data.error) {
        // Never log response bodies or URLs: both may contain access tokens.
        console.warn(`[PROFILE] ${host}/${node}: status=${response.status}, code=${data.error?.code || 'unknown'}`);
        return null;
      }
      return data;
    } catch {
      console.warn(`[PROFILE] ${host}/${node}: request failed`);
      return null;
    }
  }

  function merge(data) {
    if (!data) return;
    // user_id is the Instagram ID; an automatically returned app-scoped id
    // from a later field-only request must not replace it.
    const id = data.user_id || profile.id || data.id;
    if (id) profile.id = String(id);
    if (typeof data.username === 'string' && data.username) profile.username = data.username;
    if (typeof data.profile_picture_url === 'string' && data.profile_picture_url) {
      profile.profilePictureUrl = data.profile_picture_url;
    }
  }

  // Instagram Login tokens must use graph.instagram.com. Facebook Login
  // remains supported for accounts connected manually with an EAA token.
  const facebookLogin = options.provider === 'facebook' ||
    (options.provider !== 'instagram' && token.startsWith('EAA'));
  if (!facebookLogin) {
    const host = 'graph.instagram.com';
    // /me exposes user_id; an optional photo field must not block identity.
    merge(await request(host, 'me', 'user_id,username,profile_picture_url'));
    if (!profile.username) merge(await request(host, 'me', 'user_id,username'));
    const node = profile.id ? encodeURIComponent(profile.id) : 'me';
    if (!profile.username || !profile.profilePictureUrl) {
      merge(await request(host, node, 'username,profile_picture_url'));
    }
    if (!profile.username) merge(await request(host, node, 'username'));
    if (!profile.profilePictureUrl) merge(await request(host, node, 'profile_picture_url'));
    return profile;
  }

  const host = 'graph.facebook.com';
  if (profile.id) {
    const node = encodeURIComponent(profile.id);
    merge(await request(host, node, 'id,username,profile_picture_url'));
    if (!profile.username) merge(await request(host, node, 'id,username'));
    if (profile.username && !profile.profilePictureUrl) merge(await request(host, node, 'profile_picture_url'));
    if (profile.username) return profile;
  }
  const pages = await request(host, 'me/accounts', 'instagram_business_account{id,username,profile_picture_url}');
  const candidates = (pages?.data || []).map(page => page.instagram_business_account).filter(Boolean);
  // Never silently choose another managed account or mix its photo with the
  // requested identity. Multiple accounts require an explicit account ID.
  const selected = igUserId
    ? candidates.find(account => String(account.id) === String(igUserId))
    : candidates.length === 1 ? candidates[0] : null;
  merge(selected);
  return profile;
}

module.exports = { readMetaResponse, resolveInstagramProfile, needsProfileSync };
