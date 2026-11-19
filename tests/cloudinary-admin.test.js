const { test } = require('node:test');
const assert = require('node:assert/strict');
const cld = require('../cloudinary-admin');

const NOW = new Date('2026-11-19T12:00:00.000Z').getTime();
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString();
const url = (id, type = 'video', ext = 'mp4') => `https://res.cloudinary.com/meucloud/${type}/upload/v1790000000/${id}.${ext}`;

test('lê public_id e tipo do link, com ou sem pasta e transformações', () => {
  assert.deepEqual(cld.parseCloudinaryUrl(url('pasta/video_1')), { cloud: 'meucloud', resourceType: 'video', publicId: 'pasta/video_1' });
  assert.deepEqual(cld.parseCloudinaryUrl('https://res.cloudinary.com/meucloud/image/upload/w_400,c_fill/v12/foto.jpg'), { cloud: 'meucloud', resourceType: 'image', publicId: 'foto' });
  assert.equal(cld.parseCloudinaryUrl('https://i.ibb.co/x/foto.jpg'), null);
});

test('só apaga o que já foi publicado, há mais de 2 h, e que nada mais usa', () => {
  const posts = [
    // publicado em todas as redes há 3 h → apaga
    { imageUrl: url('a'), status: 'success', publishedAt: hoursAgo(3) },
    { imageUrl: url('a'), status: 'success', publishedAt: hoursAgo(4) },
    // publicado no Instagram, mas ainda agendado no Facebook → fica
    { imageUrl: url('b'), status: 'success', publishedAt: hoursAgo(5) },
    { imageUrl: url('b'), status: 'pending', publishedAt: '' },
    // publicado há 1 h → ainda espera
    { imageUrl: url('c'), status: 'success', publishedAt: hoursAgo(1) },
    // deu erro há 2 dias → guarda (pode tentar de novo); erro há 8 dias → apaga
    { imageUrl: url('d'), status: 'error', publishedAt: hoursAgo(48) },
    { imageUrl: url('e'), status: 'error', publishedAt: hoursAgo(24 * 8) },
    // carrossel: as mídias ficam no JSON de mediaItems
    { imageUrl: url('f1', 'image', 'jpg'), mediaItems: JSON.stringify([{ url: url('f1', 'image', 'jpg') }, { url: url('f2') }]), status: 'success', publishedAt: hoursAgo(10) },
    // está no loop de Stories → fica
    { imageUrl: url('g'), status: 'success', publishedAt: hoursAgo(10) },
    // já apagado antes → não repete
    { imageUrl: url('h'), status: 'success', publishedAt: hoursAgo(10) },
    // outra conta do Cloudinary → não é nossa
    { imageUrl: 'https://res.cloudinary.com/outraconta/video/upload/v1/x.mp4', status: 'success', publishedAt: hoursAgo(10) }
  ];
  const plan = cld.planAutoDelete({
    posts, cloud: 'meucloud', now: NOW,
    protectedTexts: [JSON.stringify([url('g')])],
    deleted: new Set(['video:h'])
  });
  assert.deepEqual(plan.map(p => p.key).sort(), ['image:f1', 'video:a', 'video:e', 'video:f2']);
});

test('apaga em lotes pela Admin API com a chave no cabeçalho e conta "not_found" como já apagado', async () => {
  const calls = [];
  cld._setFetch(async (u, opts) => {
    calls.push({ u, opts });
    return { ok: true, status: 200, text: async () => JSON.stringify({ deleted: { a: 'deleted', b: 'not_found' } }) };
  });
  const gone = await cld.deleteResources({ cloud: 'meucloud', apiKey: 'K', apiSecret: 'S' }, 'video', ['a', 'b']);
  assert.deepEqual(gone, ['a', 'b']);
  assert.equal(calls[0].opts.method, 'DELETE');
  assert.match(calls[0].u, /\/v1_1\/meucloud\/resources\/video\/upload\?public_ids\[\]=a&public_ids\[\]=b&invalidate=true$/);
  assert.equal(calls[0].opts.headers.Authorization, 'Basic ' + Buffer.from('K:S').toString('base64'));
});

test('uso do plano: créditos, armazenamento e banda; chave errada vira mensagem clara', async () => {
  cld._setFetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ plan: 'Free', credits: { usage: 10.1, limit: 25, used_percent: 40.4 }, storage: { usage: 8396800000 }, bandwidth: { usage: 2040000000 }, transformations: { usage: 421 }, resources: 1159 }) }));
  const usage = await cld.getUsage({ cloud: 'meucloud', apiKey: 'K', apiSecret: 'S' });
  assert.deepEqual(usage.credits, { used: 10.1, limit: 25, percent: 40.4 });
  assert.equal(usage.files, 1159);

  cld._setFetch(async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'Invalid' } }) }));
  await assert.rejects(() => cld.getUsage({ cloud: 'meucloud', apiKey: 'K', apiSecret: 'errado' }), /API Key\/Secret/);
  cld._setFetch(null);
});
