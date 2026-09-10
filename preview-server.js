// Local design preview. No database, credentials, scheduler or external API calls.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const app = express();
const port = Number(process.env.PREVIEW_PORT) || 4173;
const peers = new Set();
const root = __dirname;
const previewTime = Date.now();
const names = ['studio.criativo', 'cafeaurora', 'use.essencia'];
const accounts = names.map((username, i) => ({
  accountId: `demo-${i}`, username, profilePictureUrl: `/preview/avatar/${i}.svg`, hasToken: true
}));
const captions = ['Pequenos detalhes, grandes ideias.', 'Uma pausa para o que faz bem.', 'Um novo olhar para a sua rotina.', 'O próximo capítulo começa aqui.', 'Bastidores de um dia criativo.', 'Feito para inspirar.'];
function post(i, scheduled) {
  return {
    id: `${scheduled ? 'scheduled' : 'published'}-${i}`, accountId: accounts[i % 3].accountId,
    caption: captions[i % captions.length], imageUrl: `/preview/art/${i % 3}.svg`,
    mediaType: i % 3 === 0 ? 'REELS' : 'IMAGE', status: scheduled ? 'pending' : 'success',
    scheduledAt: new Date(previewTime + (i + 1) * 3 * 3600000).toISOString(),
    publishedAt: scheduled ? null : new Date(previewTime - i * 11 * 3600000).toISOString()
  };
}
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'self'");
  next();
});
app.get('/preview/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
  res.flushHeaders();
  peers.add(res);
  req.on('close', () => peers.delete(res));
});
app.get('/preview/bootstrap.js', (req, res) => res.type('js').send(`
  localStorage.setItem('insta_auth_token', 'local-design-preview');
  const stream = new EventSource('/preview/events');
  stream.onmessage = () => {
    sessionStorage.setItem('preview-section', document.querySelector('.nav-item.active')?.dataset.section || 'dashboard');
    location.reload();
  };
  addEventListener('DOMContentLoaded', () => {
    const ribbon = document.createElement('div');
    ribbon.className = 'preview-ribbon';
    ribbon.textContent = 'Prévia local · Dados de demonstração';
    document.body.append(ribbon);
    const section = sessionStorage.getItem('preview-section');
    if (section) setTimeout(() => switchSection(section), 250);
  });
`));
app.get(['/', '/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  res.type('html').send(html.replace('</head>', `<script src="/preview/bootstrap.js"></script><style>.preview-ribbon{position:fixed;bottom:14px;right:20px;z-index:10001;background:#203031;color:#a6e9d9;border:1px solid #42665e;border-radius:8px;padding:6px 12px;font:11px system-ui;box-shadow:0 3px 20px #0005;pointer-events:none}@media(max-width:700px){.preview-ribbon{bottom:80px;right:12px;font-size:10px}}</style></head>`));
});
app.get('/preview/:kind/:file', (req, res) => {
  const i = Number.parseInt(req.params.file, 10) % 3;
  const palettes = [['#433377', '#bd9cfa', 'SC'], ['#435547', '#e3d3ab', 'CA'], ['#663d49', '#f3b6a3', 'E']];
  const [bg, fg, initials] = palettes[i] || palettes[0];
  const avatar = req.params.kind === 'avatar';
  res.type('svg').send(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><rect width="600" height="600" fill="${bg}"/>${avatar ? `<text x="300" y="330" text-anchor="middle" dominant-baseline="middle" font-family="Arial" font-weight="700" font-size="200" fill="${fg}">${initials}</text>` : `<circle cx="470" cy="95" r="210" fill="${fg}" opacity=".18"/><path d="M-60 430 Q170 90 350 470 T700 300" stroke="${fg}" stroke-width="60" fill="none" opacity=".8"/><text x="50" y="110" fill="${fg}" font-family="Arial" font-size="28" letter-spacing="5">${['STUDIO CRIATIVO','CAFÉ AURORA','ESSÊNCIA'][i] || 'STUDIO'}</text>`}</svg>`);
});
app.get('/api/data', (req, res) => res.json({
  accounts, scheduledPosts: Array.from({ length: 12 }, (_, i) => post(i, true)),
  history: Array.from({ length: 24 }, (_, i) => post(i, false)), globalConfig: {},
  scheduler: { lastRun: Date.now(), intervalMinutes: 5, hasError: false }
}));
app.get('/api/account-stats', (req, res) => {
  const account = accounts.find(a => a.accountId === req.query.accountId) || accounts[0];
  const i = accounts.indexOf(account);
  res.json({ username: account.username, profilePictureUrl: account.profilePictureUrl, followersCount: [12480, 8230, 5610][i], followsCount: 340, mediaCount: [184, 92, 67][i] });
});
app.get('/api/instagram-status', (req, res) => res.json({ configured: true }));
app.get('/api/analytics/summary', (req, res) => res.json({ summary: {
  published: 24, pending: 12, successRate: 100,
  postsPerAccount: accounts.map(a => ({ accountId: a.accountId, total: 12, published: 8 })),
  mediaTypes: { reels: 12, image: 24, carousel: 0, stories: 0 }
} }));
app.get('/api/accounts/best-times', (req, res) => res.json({
  success: true,
  heatmap: Array.from({ length: 7 }, (_, day) => ({ scores: Array.from({ length: 24 }, (_, hour) => Math.max(5, 90 - Math.abs(hour - 18) * 9 - day * 3)) })),
  goldenHours: [{ time: '18:00', label: 'Demonstração', score: 90 }],
  todayPeakSlots: ['12:00', '18:00', '20:00']
}));
app.get('/api/captions', (req, res) => res.json({ captions: [
  { id: 'caption-1', title: 'Uma nova ideia', tag: 'Inspiração', text: 'Pequenos detalhes, grandes ideias. O que inspirou você hoje?' },
  { id: 'caption-2', title: 'Por trás da criação', tag: 'Bastidores', text: 'Cada ideia tem uma história. Hoje, compartilhamos um pouco do nosso processo com você.' },
  { id: 'caption-3', title: 'Pausa para o café', tag: 'Rotina', text: 'Uma pausa para o que faz bem. Salve este momento para lembrar de desacelerar.' }
] }));
app.get('/api/hashtags', (req, res) => res.json({ hashtags: [
  { id: 'tags-1', name: 'Criação e inspiração', tags: '#criatividade #design #inspiracao #conteudo' }
] }));
app.get('/api/drive', (req, res) => res.json({ files: accounts.map((a, i) => ({
  id: `media-${i}`, url: `/preview/art/${i}.svg`, filename: ['ideias-do-studio.svg', 'pausa-para-cafe.svg', 'nova-colecao.svg'][i], size: 'Demonstração', createdAt: new Date(previewTime).toISOString()
})) }));
app.get('/api/stories/loop', (req, res) => res.json({ loops: [{ enabled: false, times: '["09:00","13:00","18:00","21:00"]', activeMedia: '[]' }] }));
app.use('/api', (req, res) => res.status(403).json({ error: 'Esta é uma prévia visual. Conexões e publicações estão disponíveis no site oficial.' }));
app.use('/auth', (req, res) => res.status(403).send('Conexões externas estão desativadas na prévia local.'));
app.use((req, res, next) => {
  if (req.path.startsWith('/vendor/') || /^\/(index\.html|app\.js|particles\.js|sw\.js|style\.css|studio\.css|manifest\.json|[^/]+\.png)$/.test(req.path)) return next();
  res.sendStatus(404);
});
app.use(express.static(root));
let refreshTimer;
fs.watch(root, (event, filename) => {
  if (!['index.html', 'style.css', 'studio.css', 'app.js'].includes(filename)) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => peers.forEach(res => res.write('data: refresh\n\n')), 250);
});
app.listen(port, '127.0.0.1', () => console.log(`Prévia local: http://127.0.0.1:${port}`));
