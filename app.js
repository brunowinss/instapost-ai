/**
 * InstaScheduler AI — Master Frontend Logic
 * ============================================================ */

/**
 * 🔐 Envia o token de sessão em toda chamada à própria API.
 *
 * O token já era guardado no localStorage, mas nunca era enviado — então o
 * backend não tinha como saber quem estava chamando. Em vez de alterar as ~20
 * chamadas espalhadas pelo arquivo, interceptamos o fetch num ponto só.
 *
 * Só mexe em requisições para a nossa API: chamadas externas (Cloudinary,
 * imgbb, Telegram) passam intactas, para não vazar o token para terceiros.
 */
(function attachAuthHeader() {
  const originalFetch = window.fetch;

  const isOwnApi = (url) => {
    const u = String(url);
    return u.startsWith('/api') || u.startsWith(window.location.origin + '/api');
  };

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;

    if (isOwnApi(url)) {
      const token = localStorage.getItem('insta_auth_token');
      if (token) {
        init.headers = { ...(init.headers || {}), Authorization: `Bearer ${token}` };
      }
    }

    const res = await originalFetch(input, init);

    // Token expirado ou inválido: derruba a sessão em vez de deixar a tela
    // quebrada com erros silenciosos.
    if (res.status === 401 && isOwnApi(url)) {
      localStorage.removeItem('insta_auth_token');
      window.location.reload();
    }

    return res;
  };
})();

const STATE = {
  activeSection: 'dashboard',
  accounts: [],
  activeAccountId: '',
  filterAccountId: 'all',
  selectionMode: false,
  selectedPostIds: [],
  globalConfig: {
    imgbbKey: '',
    cloudinaryName: '',
    cloudinaryPreset: '',
    telegramToken: '',
    telegramChatId: ''
  },
  scheduledPosts: [],
  history: [],
  uploadedUrl: '',
  scheduleMode: 'auto',
  // ScaleReels State Extensions
  captionsList: [],
  hashtagsList: [],
  driveFiles: [],
  bulkFiles: [],
  bulkQueue: [],
  carouselSlides: [],
  storySlots: ['09:00', '13:00', '18:00', '21:00'],
  storyMediaPool: [],
  libraryActiveTab: 'captions'
};

const API_BASE = '/api';

/**
 * 🎨 Custom Elite Modal Logic (Replaces window.prompt)
 */
function showCustomModal({ title, message, inputs }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-modal');
    const titleEl = modal.querySelector('#modal-title span');
    const msgEl = modal.querySelector('#modal-msg');
    const container = modal.querySelector('#modal-inputs-container');
    const btnConfirm = modal.querySelector('#modal-confirm');
    const btnCancel = modal.querySelector('#modal-cancel');

    titleEl.innerText = title || 'ENTRADA DE DADOS';
    msgEl.innerText = message || '';
    container.innerHTML = '';

    inputs.forEach(inp => {
      if (inp.type === 'select') {
        const select = document.createElement('select');
        select.id = `modal-inp-${inp.id}`;
        select.className = 'input';
        select.style.cssText = 'background:var(--card-bg);color:var(--text-main);cursor:pointer;';
        (inp.options || []).forEach(opt => {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          select.appendChild(option);
        });
        container.appendChild(select);
      } else {
        const input = document.createElement('input');
        input.id = `modal-inp-${inp.id}`;
        input.placeholder = inp.placeholder || '';
        input.type = inp.type || 'text';
        input.className = 'input';
        container.appendChild(input);
      }
    });

    // Habilita o botão confirmar e muda texto (o modal é compartilhado com "Conectar")
    btnConfirm.disabled = false;
    btnConfirm.style.opacity = '1';
    btnConfirm.textContent = 'Confirmar';

    modal.style.display = 'flex';
    const firstFocusable = container.querySelector('input, select');
    if (firstFocusable) firstFocusable.focus();

    const cleanup = () => {
      modal.style.display = 'none';
      btnConfirm.onclick = null;
      btnCancel.onclick = null;
      window.onkeydown = null;
    };

    btnConfirm.onclick = () => {
      const results = {};
      inputs.forEach(inp => {
        results[inp.id] = document.getElementById(`modal-inp-${inp.id}`).value;
      });
      cleanup();
      resolve(results);
    };

    btnCancel.onclick = () => {
      cleanup();
      resolve(null);
    };

    window.onkeydown = (e) => {
        if (e.key === 'Escape') btnCancel.onclick();
        if (e.key === 'Enter') {
            if (btnConfirm.style.display !== 'none') btnConfirm.onclick();
        }
    };
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const loginScreen = document.getElementById('login-screen');
  const params = new URLSearchParams(window.location.search);
  const tokenFromUrl = params.get('token') || params.get('magic');

  // Login direto via URL (Link Mágico)
  if (tokenFromUrl) {
    try {
      showLoading(true, 'VALIDANDO LINK MÁGICO...');
      const res = await fetch(`${API_BASE}/auth/verify-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenFromUrl })
      });
      const data = await res.json();
      if (res.ok && data.valid) {
        localStorage.setItem('insta_auth_token', tokenFromUrl);
        history.replaceState({}, '', window.location.pathname);
        showLoading(false);
        showToast('Login por Link Mágico realizado com sucesso!', 'success');
        loginScreen.style.display = 'none';
        initApp();
        return;
      } else {
        showLoading(false);
        showToast(data.error || 'Link mágico inválido ou expirado.', 'error');
      }
    } catch (e) {
      showLoading(false);
      showToast('Erro ao validar link de acesso.', 'error');
    }
  }

  // Check if already logged in
  const token = localStorage.getItem('insta_auth_token');
  if (token) {
    loginScreen.style.display = 'none';
    initApp();
  } else {
    loginScreen.style.display = 'flex';
  }

  // Toggle Magic Login no Login Screen
  const btnToggleMagic = document.getElementById('btn-toggle-magic-login');
  const magicContainer = document.getElementById('magic-login-container');
  if (btnToggleMagic && magicContainer) {
    btnToggleMagic.onclick = () => {
      const isHidden = magicContainer.style.display === 'none' || !magicContainer.style.display;
      magicContainer.style.display = isHidden ? 'block' : 'none';
    };
  }

  // Submit Magic Token no Login Screen
  const btnSubmitMagic = document.getElementById('btn-submit-magic-token');
  const magicInput = document.getElementById('magic-token-input');
  if (btnSubmitMagic && magicInput) {
    btnSubmitMagic.onclick = async () => {
      let raw = magicInput.value.trim();
      if (!raw) return showToast('Cole o token ou link de acesso.', 'warning');

      if (raw.includes('token=')) {
        try {
          const u = new URL(raw);
          raw = u.searchParams.get('token') || raw;
        } catch (e) {
          const match = raw.match(/token=([^&]+)/);
          if (match) raw = match[1];
        }
      }

      showLoading(true, 'VALIDANDO TOKEN...');
      try {
        const res = await fetch(`${API_BASE}/auth/verify-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: raw })
        });
        const data = await res.json();
        if (res.ok && data.valid) {
          localStorage.setItem('insta_auth_token', raw);
          showToast('Acesso concedido com sucesso!', 'success');
          loginScreen.style.display = 'none';
          initApp();
        } else {
          showToast(data.error || 'Token inválido ou expirado.', 'error');
        }
      } catch (err) {
        showToast('Erro ao conectar com o servidor.', 'error');
      } finally {
        showLoading(false);
      }
    };
  }
  
  // Login form handler
  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const user = document.getElementById('login-user').value.trim();
    const pass = document.getElementById('login-pass').value.trim();
    const errorEl = document.getElementById('login-error');
    
    const btn = e.target.querySelector('button[type="submit"]');
    btn.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0 auto;"></div>';
    btn.disabled = true;
    
    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      
      const data = await res.json();
      
      if (res.ok && data.token) {
        localStorage.setItem('insta_auth_token', data.token);
        loginScreen.style.opacity = '0';
        loginScreen.style.transition = 'opacity 0.5s ease';
        setTimeout(() => {
          loginScreen.style.display = 'none';
          initApp();
        }, 500);
      } else {
        errorEl.innerText = data.error || 'Credenciais inválidas.';
        errorEl.style.display = 'block';
        btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> ENTRAR';
        btn.disabled = false;
      }
    } catch (err) {
      errorEl.innerText = 'Erro de conexão com o servidor.';
      errorEl.style.display = 'block';
      btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> ENTRAR';
      btn.disabled = false;
    }
  };
});

async function checkInstagramConfig() {
  try {
    const res = await fetch('/api/instagram-status');
    const data = await res.json();
    const warning = document.getElementById('ig-config-warning');
    const btn = document.getElementById('connect-instagram-btn');
    if (warning) warning.style.display = data.configured ? 'none' : 'block';
    if (btn && !data.configured) {
      btn.style.opacity = '0.5';
      btn.title = 'IG_APP_ID e IG_APP_SECRET não configurados no servidor.';
    }
  } catch (e) { /* silently ignore */ }
}

function initApp() {
  setupNavigation();
  setupForms();
  setupUIEvents();
  loadData();
  setupPushNotifications();
  checkInstagramConfig();
  setInterval(loadData, 30000);

  // Detecta retorno do OAuth
  const params = new URLSearchParams(window.location.search);
  if (params.get('connected')) {
    showToast('@' + params.get('connected') + ' conectado com sucesso!', 'success');
    history.replaceState({}, '', '/');
    setTimeout(() => { navigateTo('settings'); }, 600);
  } else if (params.get('error')) {
    showToast('Erro ao conectar: ' + params.get('error'), 'error');
    history.replaceState({}, '', '/');
  }
}

function logout() {
  localStorage.removeItem('insta_auth_token');
  location.reload();
}

function setScheduleMode(mode) {
  STATE.scheduleMode = mode;
  document.querySelectorAll('.schedule-mode').forEach(b => {
    b.classList.remove('active');
    b.classList.add('btn-ghost');
  });
  document.querySelector(`.schedule-mode[data-mode="${mode}"]`).classList.add('active');
  document.querySelector(`.schedule-mode[data-mode="${mode}"]`).classList.remove('btn-ghost');
  document.getElementById('schedule-auto').style.display = mode === 'auto' ? 'block' : 'none';
  document.getElementById('schedule-manual').style.display = mode === 'manual' ? 'block' : 'none';
}

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const section = item.getAttribute('data-section');
      switchSection(section);
    });
  });
}

function switchSection(name) {
  STATE.activeSection = name;
  
  // Update UI Navigation state
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const activeNavItem = document.querySelector(`.nav-item[data-section="${name}"]`);
  if (activeNavItem) activeNavItem.classList.add('active');
  
  // Update Header
  const titles = {
    'dashboard': { t: 'Dashboard', s: 'Acompanhe seus resultados e agendamentos.' },
    'bulk-reels': { t: 'Reels em Massa', s: 'Distribuição inteligente de múltiplos vídeos com variância anti-ban.' },
    'bulk-carousel': { t: 'Carrossel & Fotos', s: 'Assistente de criação de posts carrossel de 2 a 10 mídias.' },
    'stories-loop': { t: 'Stories 24/7', s: 'Automação contínua de stories para máxima retenção de seguidores.' },
    'captions': { t: 'Legendas & Hashtags', s: 'Biblioteca de modelos e grupos com rotação automática.' },
    'drive': { t: 'Acervo / Drive', s: 'Pool de mídias e criativos salvos na nuvem prontos para postar.' },
    'analytics': { t: 'Analytics Pro', s: 'Métricas consolidadas e inteligência multi-conta.' },
    'new-post': { t: 'Novo Post', s: 'Crie e agende uma publicação avulsa.' },
    'schedule': { t: 'Agendados', s: 'Organize seu calendário de conteúdo.' },
    'settings': { t: 'Configurações', s: 'Gerencie suas conexões e chaves de API.' }
  };
  
  if (titles[name]) {
    document.getElementById('page-title').innerText = titles[name].t;
    document.getElementById('page-subtitle').innerText = titles[name].s;
  }
  
  // Show/Hide Sections
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const targetSection = document.getElementById(`section-${name}`);
  if (targetSection) targetSection.classList.add('active');
  
  renderActiveSection();
}

async function loadData() {
  try {
    const res = await fetch(`${API_BASE}/data`);
    const data = await res.json();
    
    STATE.accounts = data.accounts || [];
    STATE.scheduledPosts = data.scheduledPosts || [];
    STATE.history = data.history || [];
    STATE.globalConfig = data.globalConfig || STATE.globalConfig;
    
    if (STATE.accounts.length > 0 && !STATE.activeAccountId) {
      STATE.activeAccountId = STATE.accounts[0].accountId;
    }
    
    updateHeaderUI();
    updateSchedulerStatus(data.scheduler);
    populateAccountSelector();
    renderActiveSection();
    loadAccountStats();
    clearDataError();
  } catch (err) {
    console.error('Sync Error:', err);
    updateSchedulerStatus(null); // servidor fora do ar
    showDataError();
  }
}

function clearDataError() {
  const el = document.getElementById('data-error-banner');
  if (el) el.style.display = 'none';
}

function showDataError() {
  const el = document.getElementById('data-error-banner');
  if (!el) return;
  el.style.display = 'flex';
}

/**
 * Reflete o estado real do agendador na barra lateral.
 *
 * Antes o "CRON ATIVO" era texto fixo no HTML — ficava verde mesmo com o
 * motor travado. Agora compara a última execução com o intervalo esperado.
 */
function updateSchedulerStatus(info) {
  const dot = document.getElementById('scheduler-dot');
  const text = document.getElementById('scheduler-text');
  const detail = document.getElementById('scheduler-detail');
  if (!dot || !text || !detail) return;

  const set = (color, label, note) => {
    dot.style.background = color;
    dot.style.boxShadow = `0 0 10px ${color}`;
    text.style.color = color;
    text.innerText = label;
    detail.innerText = note;
  };

  const ok = 'var(--success)', warn = 'var(--warning)', bad = 'var(--error)';

  if (!info || !info.lastRun) {
    set(bad, 'SEM RESPOSTA', 'Servidor não respondeu');
    return;
  }

  const minutosAtras = Math.floor((Date.now() - info.lastRun) / 60000);
  const limite = info.intervalMinutes * 2; // dois ciclos de tolerância
  const quando = minutosAtras < 1 ? 'agora há pouco' : `há ${minutosAtras} min`;

  if (info.hasError) {
    set(warn, 'COM FALHA', `Último ciclo ${quando} deu erro`);
  } else if (minutosAtras > limite) {
    set(warn, 'ATRASADO', `Sem rodar ${quando}`);
  } else {
    set(ok, 'ATIVO', `Rodou ${quando}`);
  }
}

/**
 * Busca seguidores/publicações do perfil ativo direto na API do Instagram.
 *
 * O servidor guarda o resultado por 10 min: os proprios numeros da Meta ja vem
 * com atraso, entao consultar mais que isso so gasta cota sem ganhar precisao.
 */
async function loadAccountStats() {
  const valueEl = document.getElementById('stat-followers');
  const labelEl = document.getElementById('stat-followers-label');
  const barEl = document.getElementById('progress-followers');
  if (!valueEl || !labelEl) return;

  const accountId = STATE.activeAccountId;
  if (!accountId) {
    valueEl.innerText = '—';
    labelEl.innerText = 'Nenhuma conta conectada';
    if (barEl) barEl.style.width = '0%';
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/account-stats?accountId=${encodeURIComponent(accountId)}`);
    const s = await res.json();

    if (s.unavailable || s.followersCount === null || s.followersCount === undefined) {
      valueEl.innerText = '—';
      labelEl.innerText = 'Instagram não retornou o número';
      if (barEl) barEl.style.width = '0%';
      return;
    }

    animateNumber(valueEl, s.followersCount);
    const acc = STATE.accounts.find(a => a.accountId === accountId);
    const nome = acc ? `@${acc.username}` : '';
    labelEl.innerText = `${nome} • ${s.mediaCount ?? '?'} publicações`;
    if (barEl) barEl.style.width = '100%';
  } catch (err) {
    console.error('Stats Error:', err);
    valueEl.innerText = '—';
    labelEl.innerText = 'Não foi possível consultar';
  }
}

/** Conta de 0 até o valor, respeitando quem prefere menos movimento. */
function animateNumber(el, alvo) {
  const fmt = (n) => n.toLocaleString('pt-BR');

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.innerText = fmt(alvo);
    return;
  }

  const duracao = 800;
  const inicio = performance.now();

  const passo = (agora) => {
    const p = Math.min((agora - inicio) / duracao, 1);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out
    el.innerText = fmt(Math.round(alvo * eased));
    if (p < 1) requestAnimationFrame(passo);
  };

  requestAnimationFrame(passo);
}

function renderActiveSection() {
  const n = STATE.activeSection;
  if (n === 'dashboard') renderDashboard();
  if (n === 'bulk-reels') renderBulkReelsSection();
  if (n === 'bulk-carousel') renderBulkCarouselSection();
  if (n === 'stories-loop') renderStoriesLoopSection();
  if (n === 'captions') renderCaptionsSection();
  if (n === 'drive') renderDriveSection();
  if (n === 'analytics') renderAnalyticsSection();
  if (n === 'schedule') renderScheduleGrid();
  if (n === 'settings') {
    renderSettings();
    renderSettingsAccounts();
  }
}

function renderSettings() {
  const c = STATE.globalConfig;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
  setVal('imgbb-key-input', c.imgbbKey);
  setVal('cloudinary-name-input', c.cloudinaryName);
  setVal('cloudinary-preset-input', c.cloudinaryPreset);
  setVal('telegram-token-input', c.telegramToken);
  setVal('telegram-chatid-input', c.telegramChatId);
  setVal('posts-per-day-input', String(c.postsPerDay || 3));
}

/**
 * Troca a foto de perfil de uma conta em todos os lugares que a mostram, sem
 * precisar recarregar. Chamado quando a API do Instagram devolve uma foto nova
 * (o usuário trocou a foto lá, ou a URL antiga expirou).
 */
function updateAvatar(accountId, url) {
  if (!url) return;
  const acc = STATE.accounts.find(a => a.accountId === accountId);
  if (acc) acc.profilePictureUrl = url;

  document.querySelectorAll(`[data-avatar="${accountId}"]`).forEach(box => {
    box.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;">`;
  });

  // Avatar do cabeçalho, se for a conta ativa
  if (accountId === STATE.activeAccountId) {
    const headerAvatar = document.getElementById('preview-user-avatar');
    if (headerAvatar) {
      headerAvatar.innerHTML = `<img src="${url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
      headerAvatar.style.background = 'none';
    }
  }
}

function renderSettingsAccounts() {
  const list = document.getElementById('accounts-list-settings');
  if (!list) return;
  
  if (STATE.accounts.length === 0) {
    list.innerHTML = '<p style="color:var(--text-dim); font-size:0.85rem;">Nenhuma conta conectada.</p>';
    return;
  }
  
  list.innerHTML = STATE.accounts.map(acc => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:1rem; background:rgba(255,255,255,0.03); border-radius:14px; border:1px solid var(--glass-border); margin-bottom:0.8rem; flex-wrap:wrap; gap:10px;">
      <div style="display:flex; align-items:center; gap:12px;">
        <div data-avatar="${acc.accountId}" style="width:38px; height:38px; border-radius:50%; background:linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888); display:flex; align-items:center; justify-content:center; color:white; overflow:hidden; flex-shrink:0;">
          ${acc.profilePictureUrl ? `<img src="${acc.profilePictureUrl}" style="width:100%;height:100%;object-fit:cover;">` : '<i class="fa-brands fa-instagram"></i>'}
        </div>
        <div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-weight:700; font-size:0.95rem;">@${acc.username}</span>
            ${acc.username.startsWith('instagram_') ? '<span style="font-size:0.68rem; background:rgba(239,68,68,0.15); color:#fca5a5; padding:2px 6px; border-radius:4px; border:1px solid rgba(239,68,68,0.3);"><i class="fa-solid fa-pen"></i> Clique em Editar</span>' : ''}
          </div>
          <div style="font-size:0.72rem; color:var(--text-secondary); margin-top:2px;">
            <i class="fa-solid fa-heart" style="color:var(--accent); font-size:0.7rem;"></i>
            <span id="followers-${acc.accountId}">carregando…</span>
          </div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <button class="btn btn-sm btn-ghost" onclick="openEditAccountModal('${acc.accountId}')" title="Editar nome de usuário e foto" style="padding:0.4rem 0.75rem; font-size:0.75rem; color:var(--accent); border-color:rgba(16,184,245,0.3);">
          <i class="fa-solid fa-pen"></i> Editar
        </button>
        <button class="btn btn-sm btn-ghost btn-delete" onclick="deleteAccount('${acc.accountId}')" title="Excluir conta" style="padding:0.4rem; width:32px; height:32px; color:var(--error); border-color:rgba(239,68,68,0.2);">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    </div>
  `).join('');

  // Busca estatísticas e atualiza username / foto se Meta retornar dados reais
  STATE.accounts.forEach(async (acc) => {
    const el = document.getElementById(`followers-${acc.accountId}`);
    if (!el) return;
    try {
      const res = await fetch(`${API_BASE}/account-stats?accountId=${encodeURIComponent(acc.accountId)}`);
      const s = await res.json();
      if (s.profilePictureUrl) updateAvatar(acc.accountId, s.profilePictureUrl);
      if (s.username && s.username !== acc.username) {
        acc.username = s.username;
        updateHeaderUI();
      }
      if (s.unavailable || s.followersCount === null || s.followersCount === undefined) {
        el.innerText = 'seguidores indisponíveis';
        el.parentElement.style.color = 'var(--text-dim)';
      } else {
        el.innerText = `${s.followersCount.toLocaleString('pt-BR')} seguidores · ${(s.mediaCount ?? '?')} posts`;
      }
    } catch {
      el.innerText = '—';
    }
  });
}


function updateHeaderUI() {
  const authStatus = document.getElementById('auth-status');
  const accountName = document.getElementById('active-account-name');
  const previewName = document.getElementById('preview-username');
  const previewAvatar = document.getElementById('preview-user-avatar');
  
  const activeAcc = STATE.accounts.find(a => a.accountId === STATE.activeAccountId);
  
  if (activeAcc) {
    authStatus.style.background = 'var(--success)';
    authStatus.style.boxShadow = '0 0 10px var(--success)';
    accountName.innerText = `@${activeAcc.username}`;
    
    if (previewName) previewName.innerText = `@${activeAcc.username}`;
    if (previewAvatar) {
      if (activeAcc.profilePictureUrl) {
        previewAvatar.innerHTML = `<img src="${activeAcc.profilePictureUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
        previewAvatar.style.background = 'none';
      } else {
        previewAvatar.innerHTML = '';
        previewAvatar.style.background = 'linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)';
      }
    }
  } else {
    authStatus.style.background = 'var(--error)';
    authStatus.style.boxShadow = '0 0 10px var(--error)';
    accountName.innerText = 'Login Pendente';
    if (previewName) previewName.innerText = '@seu_perfil';
    if (previewAvatar) {
        previewAvatar.innerHTML = '';
        previewAvatar.style.background = 'linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)';
    }
  }
}

function populateAccountSelector() {
  const selectors = [
    document.getElementById('post-account-select'),
    document.getElementById('bulk-account-select'),
    document.getElementById('carousel-account-select'),
    document.getElementById('stories-account-select')
  ];

  selectors.forEach(sel => {
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = STATE.accounts.map(a => 
      `<option value="${a.accountId}" ${a.accountId === prev ? 'selected' : ''}>@${a.username}</option>`
    ).join('');
    
    sel.onchange = () => {
      STATE.activeAccountId = sel.value;
      updateHeaderUI();
      loadAccountStats();
      if (sel.id === 'stories-account-select') loadStoryLoopForAccount();
    };
  });

  if (STATE.accounts.length > 0 && !STATE.activeAccountId) {
    STATE.activeAccountId = STATE.accounts[0].accountId;
    updateHeaderUI();
  }
}

function getTimeRemaining(dateStr) {
  const diff = new Date(dateStr) - new Date();
  if (diff < 0) return 'Postando...';
  const hours = Math.floor(diff / 1000 / 60 / 60);
  const mins = Math.floor((diff / 1000 / 60) % 60);
  
  if (hours > 48) return `Daqui a ${Math.floor(hours / 24)} dias`;
  if (hours > 24) return 'Amanhã';
  if (hours > 0) return `Faltam ${hours}h ${mins}m`;
  if (mins > 0) return `Faltam ${mins}m`;
  return 'Agora mesmo';
}

/**
 * Anima um número de 0 até o valor final.
 * Só roda quando o valor muda, senão cada re-render reinicia a contagem.
 */
function animateCount(el, target) {
  if (!el) return;
  const current = Number(el.dataset.value ?? -1);
  if (current === target) return;
  el.dataset.value = target;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || target === 0) { el.innerText = target; return; }

  const duration = 800;
  const start = performance.now();
  const from = Number(el.innerText) || 0;

  const step = (now) => {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    el.innerText = Math.round(from + (target - from) * eased);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Painel "Seguidores por Conta" do Dashboard: um cartão por conta com o número
 * de seguidores, buscado por conta e protegido pelo cache de 10 min do servidor.
 */
function renderDashboardFollowers() {
  const container = document.getElementById('dashboard-followers-list');
  if (!container) return;

  if (STATE.accounts.length === 0) {
    container.innerHTML = '<p style="color:var(--text-dim); font-size:0.85rem; grid-column:1/-1;">Nenhuma conta conectada ainda.</p>';
    return;
  }

  container.innerHTML = STATE.accounts.map(acc => `
    <div style="display:flex; align-items:center; gap:12px; padding:0.9rem 1rem; background:rgba(4,7,12,0.5); border:1px solid var(--border-color); border-radius:var(--radius-sm);">
      <div data-avatar="${acc.accountId}" style="width:38px; height:38px; border-radius:50%; background:linear-gradient(45deg,#f09433,#dc2743,#bc1888); display:flex; align-items:center; justify-content:center; color:#fff; overflow:hidden; flex-shrink:0;">
        ${acc.profilePictureUrl ? `<img src="${acc.profilePictureUrl}" style="width:100%;height:100%;object-fit:cover;">` : '<i class="fa-brands fa-instagram"></i>'}
      </div>
      <div style="min-width:0;">
        <div style="font-weight:700; font-size:0.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">@${acc.username}</div>
        <div style="font-size:1.15rem; font-weight:700; color:var(--accent); line-height:1.2;" id="dash-fol-${acc.accountId}">…</div>
        <div style="font-size:0.68rem; color:var(--text-dim);">seguidores</div>
      </div>
    </div>
  `).join('');

  STATE.accounts.forEach(async (acc) => {
    const el = document.getElementById(`dash-fol-${acc.accountId}`);
    if (!el) return;
    try {
      const res = await fetch(`${API_BASE}/account-stats?accountId=${encodeURIComponent(acc.accountId)}`);
      const s = await res.json();
      if (s.profilePictureUrl) updateAvatar(acc.accountId, s.profilePictureUrl);
      if (s.unavailable || s.followersCount === null || s.followersCount === undefined) {
        el.innerText = '—';
        el.style.color = 'var(--text-dim)';
        el.parentElement.querySelector('div:last-child').innerText = 'indisponível';
      } else {
        animateCount(el, s.followersCount);
      }
    } catch {
      el.innerText = '—';
      el.style.color = 'var(--text-dim)';
    }
  });
}

/* Gráficos do Dashboard: barras por dia, donut de tipos e sparkline de sucesso. */
function renderDashboardCharts() {
  const barsEl = document.getElementById('chart-weekly-bars');
  if (barsEl) renderWeeklyBars(barsEl);
  const typesEl = document.getElementById('chart-media-types');
  if (typesEl) renderMediaTypes(typesEl);
  const sparkEl = document.getElementById('chart-success-spark');
  if (sparkEl) renderSuccessSpark(sparkEl);
}

function renderWeeklyBars(el) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toDateString();
    const count = STATE.history.filter(h =>
      h.status === 'success' && new Date(h.publishedAt).toDateString() === key
    ).length;
    days.push({ label: d.toLocaleDateString('pt-BR', { weekday: 'short' }).slice(0, 3), count });
  }
  const max = Math.max(1, ...days.map(d => d.count));
  el.innerHTML = days.map((d, i) => `
    <div class="chart-bar" style="height:${Math.max(6, (d.count / max) * 100)}%; animation-delay:${i * 60}ms;" data-label="${d.count}">
    </div>
  `).join('');
}

function renderMediaTypes(el) {
  const successPosts = STATE.history.filter(h => h.status === 'success');
  const images = successPosts.filter(h => h.mediaType !== 'REELS').length;
  const reels = successPosts.filter(h => h.mediaType === 'REELS').length;
  const total = images + reels;
  if (total === 0) {
    el.innerHTML = '<p style="color:var(--text-dim); font-size:0.85rem;">Sem publicações ainda.</p>';
    return;
  }
  const imgPct = (images / total) * 100;
  const reelsPct = 100 - imgPct;
  const R = 54, C = 2 * Math.PI * R;
  const imgArc = (imgPct / 100) * C;
  const reelsArc = (reelsPct / 100) * C;
  el.innerHTML = `
    <div class="chart-donut-wrap">
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="${R}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="14"/>
        <circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--accent)" stroke-width="14"
          stroke-linecap="round" stroke-dasharray="${imgArc} ${C}"
          transform="rotate(-90 60 60)" style="transition: stroke-dasharray 0.8s cubic-bezier(0.16,1,0.3,1);"/>
        <circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--primary-600)" stroke-width="14"
          stroke-linecap="round" stroke-dasharray="${reelsArc} ${C}"
          stroke-dashoffset="${-imgArc}"
          transform="rotate(-90 60 60)" style="transition: stroke-dasharray 0.8s cubic-bezier(0.16,1,0.3,1);"/>
      </svg>
      <div class="chart-donut-center">${total}</div>
    </div>
    <div class="legend-list">
      <div class="legend-item"><span class="legend-dot" style="background:var(--accent);"></span> Fotos <span class="legend-value">${images}</span></div>
      <div class="legend-item"><span class="legend-dot" style="background:var(--primary-600);"></span> Reels <span class="legend-value">${reels}</span></div>
    </div>
  `;
}

function renderSuccessSpark(el) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toDateString();
    const total = STATE.history.filter(h => new Date(h.publishedAt).toDateString() === key).length;
    const ok = STATE.history.filter(h => h.status === 'success' && new Date(h.publishedAt).toDateString() === key).length;
    days.push(total === 0 ? 0 : (ok / total) * 100);
  }
  const max = Math.max(10, ...days.map(d => d));
  el.innerHTML = days.map((pct, i) => `
    <div class="chart-bar" style="height:${Math.max(4, (pct / max) * 100)}%; background:linear-gradient(180deg, var(--success) 0%, color-mix(in srgb, var(--success) 35%, transparent) 100%); animation-delay:${i * 60}ms;" data-label="${pct === 0 ? '—' : pct.toFixed(0) + '%'}">
    </div>
  `).join('');
}

function renderDashboard() {
  const successCount = STATE.history.filter(h => h.status === 'success').length;
  const scheduledCount = STATE.scheduledPosts.length;
  
  const now = new Date();
  const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weeklyCount = STATE.history.filter(h => h.status === 'success' && new Date(h.publishedAt) >= lastWeek).length;
  const weeklyGoal = 7;
  const weeklyPercent = Math.min((weeklyCount / weeklyGoal) * 100, 100);

  animateCount(document.getElementById('stat-total'), successCount);
  animateCount(document.getElementById('stat-scheduled'), scheduledCount);
  animateCount(document.getElementById('stat-accounts'), STATE.accounts.length);

  renderDashboardFollowers();
  renderDashboardCharts();
  
  const ptEl = document.getElementById('progress-total');
  if (ptEl) ptEl.style.width = `${Math.min(successCount * 5, 100)}%`;
  const psEl = document.getElementById('progress-scheduled');
  if (psEl) psEl.style.width = `${Math.min(scheduledCount * 10, 100)}%`;

  const next = STATE.scheduledPosts[0];
  if (next) {
    const date = new Date(next.scheduledAt);
    const remaining = getTimeRemaining(next.scheduledAt);
    document.getElementById('stat-next-label').innerText = `Próximo: ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} (${remaining})`;
  } else {
    document.getElementById('stat-next-label').innerText = 'Sem agendamentos';
  }
    
  // Activity list
  const list = document.getElementById('recent-activity-list');
  if (!list) return;
  if (STATE.history.length === 0 && STATE.scheduledPosts.length === 0) {
    list.innerHTML = '<p style="text-align:center; padding:2.5rem; color:var(--text-dim); font-size:0.9rem;">Aguardando primeira atividade...</p>';
    return;
  }
  
  const allPosts = [...STATE.scheduledPosts, ...STATE.history].slice(0, 6);
  list.innerHTML = allPosts.map(h => {
    const acc = STATE.accounts.find(a => a.accountId === h.accountId);
    const accName = acc ? `@${acc.username}` : h.accountId;
    const dateStr = h.publishedAt ? new Date(h.publishedAt).toLocaleString('pt-BR') : new Date(h.scheduledAt).toLocaleString('pt-BR');
    const statusColor = h.status === 'success' ? 'var(--success)' : h.status === 'pending' ? 'var(--warning)' : 'var(--error)';
    const statusBg = h.status === 'success' ? 'rgba(16,185,129,0.1)' : h.status === 'pending' ? 'rgba(245,158,11,0.1)' : 'rgba(239,68,68,0.1)';
    const thumbUrl = getThumbnailUrl(h.imageUrl);
    const thumb = thumbUrl
      ? `<img class="activity-thumb" src="${thumbUrl}" loading="lazy" onerror="this.style.display='none';">`
      : `<div class="activity-thumb" style="display:flex; align-items:center; justify-content:center;"><i class="fa-solid ${h.mediaType === 'REELS' ? 'fa-film' : 'fa-image'}" style="color:var(--accent);"></i></div>`;
    return `
    <div class="activity-item">
      ${thumb}
      <div style="flex:1; min-width:0;">
        <div style="font-weight:700; font-size:0.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${h.caption || 'Sem legenda'}</div>
        <div style="font-size:0.72rem; color:var(--text-dim); margin-top:2px;">${accName} • ${dateStr}</div>
      </div>
      <span style="font-size:0.6rem; font-weight:800; text-transform:uppercase; padding:3px 8px; border-radius:6px; background:${statusBg}; color:${statusColor}; border:1px solid ${statusColor}; letter-spacing:0.5px;">${h.status}</span>
    </div>`;
  }).join('');
}

// ── Calendar State ──
let calendarDate = new Date();

function getFilteredPosts() {
  if (!STATE.filterAccountId) return STATE.scheduledPosts;
  return STATE.scheduledPosts.filter(p => p.accountId === STATE.filterAccountId);
}

function renderAccountFilterTabs() {
  const container = document.getElementById('account-filter-tabs');
  if (!container) return;
  
  let html = `<button class="btn btn-sm ${!STATE.filterAccountId ? '' : 'btn-ghost'}" onclick="setAccountFilter('')" style="border-radius:100px; font-size:0.75rem; padding:0.5rem 1rem;">Todas</button>`;
  STATE.accounts.forEach(a => {
    const isActive = STATE.filterAccountId === a.accountId;
    const count = STATE.scheduledPosts.filter(p => p.accountId === a.accountId).length;
    html += `<button class="btn btn-sm ${isActive ? '' : 'btn-ghost'}" onclick="setAccountFilter('${a.accountId}')" style="border-radius:100px; font-size:0.75rem; padding:0.5rem 1rem;">@${a.username} <span style='opacity:0.6; margin-left:4px;'>(${count})</span></button>`;
  });
  container.innerHTML = html;
}

function setAccountFilter(accountId) {
  STATE.filterAccountId = accountId;
  renderAccountFilterTabs();
  renderCalendar();
  renderScheduleCards();
}

function renderScheduleGrid() {
  renderAccountFilterTabs();
  renderCalendar();
  renderScheduleCards();
  
  const prevBtn = document.getElementById('cal-prev');
  const nextBtn = document.getElementById('cal-next');
  if (prevBtn) prevBtn.onclick = () => { calendarDate.setMonth(calendarDate.getMonth() - 1); renderCalendar(); };
  if (nextBtn) nextBtn.onclick = () => { calendarDate.setMonth(calendarDate.getMonth() + 1); renderCalendar(); };
}

function renderCalendar() {
  const grid = document.getElementById('calendar-grid');
  const label = document.getElementById('cal-month-label');
  if (!grid || !label) return;

  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  label.innerText = `${months[month]} ${year}`;

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  // Get dates with scheduled posts (filtered by account)
  const filteredPosts = getFilteredPosts();
  const postsByDay = new Map();
  filteredPosts.forEach(p => {
    const d = new Date(p.scheduledAt);
    if (d.getMonth() === month && d.getFullYear() === year) {
      if (!postsByDay.has(d.getDate())) postsByDay.set(d.getDate(), []);
      postsByDay.get(d.getDate()).push(p);
    }
  });

  let html = '<div class="cal-header">';
  ['DOM','SEG','TER','QUA','QUI','SEX','SÁB'].forEach(d => html += `<div class="cal-header-cell">${d}</div>`);
  html += '</div><div class="cal-grid">';

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = today.getDate() === day && today.getMonth() === month && today.getFullYear() === year;
    const dayPosts = postsByDay.get(day) || [];
    const classes = ['cal-day'];
    if (isToday) classes.push('today');
    if (dayPosts.length > 0) classes.push('has-posts');

    let thumbs = '';
    if (dayPosts.length > 0) {
      const shown = dayPosts.slice(0, 2).map(p => {
        const u = getThumbnailUrl(p.imageUrl);
        return u
          ? `<img class="cal-day-thumb" src="${u}" loading="lazy" onerror="this.style.display='none';" data-tip="${p.status}">`
          : `<div class="cal-day-thumb" style="display:flex;align-items:center;justify-content:center;background:rgba(16,184,245,0.15);" data-tip="${p.status}"><i class="fa-solid fa-${p.mediaType === 'REELS' ? 'film' : 'image'}" style="font-size:0.5rem;color:var(--accent);"></i></div>`;
      }).join('');
      const overflow = dayPosts.length > 2 ? `<div class="cal-day-thumb-overflow">+${dayPosts.length - 2}</div>` : '';
      thumbs = `<div class="cal-day-thumbs">${shown}${overflow}</div>`;
    }

    html += `<div class="${classes.join(' ')}">${day}${thumbs}</div>`;
  }

  html += '</div>';
  html += `<div class="cal-legend">
    <span><span class="cal-legend-dot" style="background:var(--warning);"></span> Pendente</span>
    <span><span class="cal-legend-dot" style="background:var(--success);"></span> Sucesso</span>
    <span><span class="cal-legend-dot" style="background:var(--error);"></span> Falhou</span>
  </div>`;
  grid.innerHTML = html;
}

function renderScheduleCards() {
  const container = document.getElementById('scheduled-posts-container');
  if (!container) return;
  
  const posts = getFilteredPosts();
  
  if (posts.length === 0) {
    container.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:3rem; color:var(--text-dim);"><i class="fa-solid fa-calendar-xmark" style="font-size:2.5rem; margin-bottom:1rem; opacity:0.3; display:block;"></i>Nenhum agendamento para esta conta.</div>';
    return;
  }
  
  const selBar = document.getElementById('selection-bar');
  if (STATE.selectionMode) {
    selBar.classList.add('active');
    document.getElementById('selection-count').innerText = `${STATE.selectedPostIds.length} selecionados`;
    document.getElementById('btn-toggle-selection').style.background = 'var(--purple-main)';
    document.getElementById('btn-toggle-selection').style.borderColor = 'var(--purple-main)';
  } else {
    selBar.classList.remove('active');
    document.getElementById('btn-toggle-selection').style.background = '';
    document.getElementById('btn-toggle-selection').style.borderColor = '';
  }

  container.innerHTML = posts.map((p, i) => {
    const acc = STATE.accounts.find(a => a.accountId === p.accountId);
    const accName = acc ? `@${acc.username}` : p.accountId;
    const date = new Date(p.scheduledAt);
    const dateStr = date.toLocaleDateString('pt-BR', { day:'2-digit', month:'short' });
    const timeStr = date.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
    const remainingStr = getTimeRemaining(p.scheduledAt);
    const thumbUrl = getThumbnailUrl(p.imageUrl);
    const isSelected = STATE.selectedPostIds.includes(p.id);
    
    return `
    <div class="sched-card ${isSelected ? 'selected' : ''}" style="--card-i:${i % 12}" onclick="${STATE.selectionMode ? `togglePostSelection('${p.id}')` : ''}">
      ${STATE.selectionMode ? `
        <div class="selection-checkbox ${isSelected ? 'checked' : ''}">
          <i class="fa-solid fa-check"></i>
        </div>
      ` : ''}
      <div class="sched-card-header">
        <span class="sched-account"><i class="fa-brands fa-instagram"></i> ${accName}</span>
        <span class="sched-badge pending">${p.status}</span>
      </div>
      <div style="margin-bottom:0.8rem;">
        <div class="sched-img-container">
          <img src="${thumbUrl}" alt="Capinha" class="sched-thumb" loading="lazy" onerror="this.src='https://placehold.co/400x400/0a0a0a/ffffff?text=Video+Indisponivel'">
          <div class="sched-img-overlay">
            <i class="fa-solid ${p.mediaType === 'REELS' ? 'fa-circle-play' : 'fa-image'}"></i>
          </div>
        </div>
        <p style="font-size:0.85rem; line-height:1.5; color:rgba(255,255,255,0.8); max-height:3.2em; overflow:hidden; margin-top:0.8rem;">${p.caption || 'Sem legenda'}</p>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; padding-top:0.8rem; border-top:1px solid var(--glass-border);">
        <div style="font-size:0.78rem; color:var(--text-dim); display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <div><i class="fa-solid fa-calendar"></i> ${dateStr} às ${timeStr}</div>
          <span style="background: rgba(139,92,246,0.15); color: var(--purple-main); padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 0.68rem;">
             ${remainingStr}
          </span>
        </div>
        <div style="display:flex; gap:8px;">
          ${!STATE.selectionMode ? `
            <button class="btn btn-sm btn-ghost btn-delete" onclick="deletePost('${p.id}')" data-tip="Excluir agendamento" style="font-size:0.7rem; padding:0.5rem 0.8rem; color:var(--error);">
              <i class="fa-solid fa-trash"></i>
            </button>
            <button class="btn btn-sm btn-ghost" onclick="publishNow('${p.id}')" data-tip="Publicar agora" style="font-size:0.7rem; padding:0.5rem 0.8rem;">
              <i class="fa-solid fa-paper-plane"></i> Publicar
            </button>
          ` : '<span style="font-size:0.65rem; color:var(--purple-main); font-weight:700;">MODO SELEÇÃO</span>'}
        </div>
      </div>
    </div>`;
  }).join('');
}

/**
 * 🎨 Helpers de UI e Otimização
 */

function getThumbnailUrl(url) {
  if (!url) return '';
  if (url.includes('cloudinary.com')) {
    // Transforma vídeos .mp4 em imagens .jpg e aplica compressão w_400
    if (url.endsWith('.mp4') || url.endsWith('.mov') || url.includes('/video/upload/')) {
        return url.replace('/video/upload/', '/video/upload/w_400,c_fill,f_auto,so_0/').replace(/\.(mp4|mov)$/, '.jpg');
    }
    // Aplica compressão básica em imagens também
    return url.replace('/upload/', '/upload/w_400,c_fill,f_auto/');
  }
  return url; // Retorna URL original se não for Cloudinary (ex: imgbb)
}


function autoFillNextSlot() {
  const SLOTS = [10, 15, 20];
  const dateInput = document.getElementById('post-date');
  const timeInput = document.getElementById('post-time');
  if (!dateInput || !timeInput) return;

  // Find the latest scheduled post
  let baseDate = new Date();
  if (STATE.scheduledPosts.length > 0) {
    const sorted = [...STATE.scheduledPosts].sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));
    const lastDate = new Date(sorted[0].scheduledAt);
    if (lastDate > baseDate) baseDate = lastDate;
  }

  // Find the next available slot after baseDate
  const minTime = new Date(Date.now() + 30 * 60000); // At least 30 mins from now
  let nextDate = new Date(baseDate);
  let found = false;

  for (let attempts = 0; attempts < 30 && !found; attempts++) {
    for (const hour of SLOTS) {
      const slot = new Date(nextDate);
      slot.setHours(hour, 0, 0, 0);
      if (slot > baseDate && slot > minTime) {
        nextDate = slot;
        found = true;
        break;
      }
    }
    if (!found) {
      nextDate.setDate(nextDate.getDate() + 1);
      nextDate.setHours(0, 0, 0, 0);
    }
  }

  // Fill the inputs
  const yyyy = nextDate.getFullYear();
  const mm = String(nextDate.getMonth() + 1).padStart(2, '0');
  const dd = String(nextDate.getDate()).padStart(2, '0');
  const hh = String(nextDate.getHours()).padStart(2, '0');
  const min = String(nextDate.getMinutes()).padStart(2, '0');

  dateInput.value = `${yyyy}-${mm}-${dd}`;
  timeInput.value = `${hh}:${min}`;
}

/**
 * Gera os horários do dia a partir da quantidade de posts/dia configurada.
 * 1 → [15h]; 3 → [10,15,20] (padrão); espalha entre 10h e 20h. Máx. 6.
 */
function slotsForCount(n) {
  const count = Math.max(1, Math.min(6, parseInt(n, 10) || 3));
  if (count === 1) return [15];
  const slots = [];
  for (let i = 0; i < count; i++) {
    slots.push(Math.round(10 + (20 - 10) * i / (count - 1)));
  }
  return slots;
}

function calculateNextSlot(lastDate) {
  const SLOTS = slotsForCount(STATE.globalConfig.postsPerDay);
  const minTime = new Date(Date.now() + 30 * 60000);
  let baseDate = lastDate ? new Date(lastDate) : new Date();
  let nextDate = new Date(baseDate);

  for (let attempts = 0; attempts < 60; attempts++) {
    for (const hour of SLOTS) {
      const slot = new Date(nextDate);
      slot.setHours(hour, 0, 0, 0);
      if (slot > baseDate && slot > minTime) {
        return slot;
      }
    }
    nextDate.setDate(nextDate.getDate() + 1);
    nextDate.setHours(0, 0, 0, 0);
  }
  return new Date(Date.now() + 3600000);
}

function setupForms() {
  const fileInput = document.getElementById('file-input');
  const dropzone = document.getElementById('dropzone');
  
  fileInput.setAttribute('multiple', 'true');
  fileInput.setAttribute('accept', 'image/*,video/*');
  
  dropzone.onclick = () => fileInput.click();
  autoFillNextSlot();
  
  STATE.queuedFiles = [];
  
  fileInput.onchange = (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    // ✅ Validação de tipo e tamanho antes de aceitar
    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime'];
    const MAX_IMAGE_MB = 10;
    const MAX_VIDEO_MB = 100;

    for (const file of files) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        showToast(`Tipo não suportado: "${file.name}". Use JPG, PNG, GIF, WEBP, MP4 ou MOV.`, 'error');
        fileInput.value = '';
        return;
      }
      const mb = file.size / 1024 / 1024;
      const limit = file.type.startsWith('video/') ? MAX_VIDEO_MB : MAX_IMAGE_MB;
      if (mb > limit) {
        showToast(`"${file.name}" excede o limite (${limit}MB). Tamanho: ${mb.toFixed(1)}MB.`, 'error');
        fileInput.value = '';
        return;
      }
    }

    STATE.queuedFiles = files;
    
    const first = files[0];
    const isVideo = first.type.startsWith('video/');
    const type = isVideo ? 'REELS' : 'IMAGE';
    
    document.querySelectorAll('.btn-media').forEach(b => { b.classList.remove('active'); b.classList.add('btn-ghost'); });
    const activeBtn = document.querySelector(`.btn-media[data-type="${type}"]`);
    if (activeBtn) { activeBtn.classList.add('active'); activeBtn.classList.remove('btn-ghost'); }

    const localUrl = URL.createObjectURL(first);
    const box = document.getElementById('preview-image-box');
    if (isVideo) {
      box.innerHTML = `<video src="${localUrl}" autoplay muted loop playsinline style="width:100%;height:100%;object-fit:cover;border-radius:12px;"></video>`;
    } else {
      box.innerHTML = `<img src="${localUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:12px;">`;
    }
    
    const submitBtn = document.querySelector('#post-form button[type="submit"]');
    if (files.length > 1) {
      submitBtn.innerHTML = `<i class="fa-solid fa-bolt"></i> AGENDAR ${files.length} PUBLICAÇÕES`;
      const preview = document.getElementById('preview-caption');
      if (preview) preview.innerHTML = `<strong>${files.length} arquivos:</strong><br>${files.map(f => '• ' + f.name).join('<br>')}`;
    } else {
      submitBtn.innerHTML = `<i class="fa-solid fa-calendar-check"></i> AGENDAR PUBLICAÇÃO`;
    }
    
    showToast(`${files.length} arquivo(s) selecionado(s)`, 'success');
  };

  document.querySelectorAll('.btn-media').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.btn-media').forEach(b => b.classList.remove('active', 'btn-ghost'));
      btn.classList.add('active');
      document.querySelectorAll('.btn-media:not(.active)').forEach(b => b.classList.add('btn-ghost'));
    };
  });

  document.getElementById('post-form').onsubmit = async (e) => {
    e.preventDefault();
    
    const files = STATE.queuedFiles || [];
    if (!files.length) return showToast('Selecione pelo menos um arquivo!', 'warning');
    
    const accountId = document.getElementById('post-account-select').value || STATE.activeAccountId;
    if (!accountId) return showToast('Selecione uma conta!', 'warning');
    
    const caption = document.getElementById('post-caption').value;
    // Variações separadas por uma linha "---": cada post recebe uma versão
    // diferente, evitando a legenda idêntica que o Instagram penaliza.
    const captionVariations = parseCaptionVariations(caption);

    showLoading(true, `PROCESSANDO 0/${files.length}...`);
    
    let successCount = 0;
    let lastScheduledDate = null;
    let manualDateTime = null;
    
    if (STATE.scheduleMode === 'manual') {
      // Manual mode: use specific date + time
      const dateVal = document.getElementById('post-date-manual').value;
      const timeVal = document.getElementById('post-time-manual').value;
      if (!dateVal || !timeVal) return showToast('Selecione data e horário!', 'warning') || showLoading(false);
      manualDateTime = new Date(`${dateVal}T${timeVal}:00`);
      if (manualDateTime <= new Date()) {
        // Allow past time but warn
        showToast('Atenção: horário já passou, post será publicado em breve.', 'warning');
      }
    } else {
      // Auto mode: use start date + auto slots
      const startDateInput = document.getElementById('post-date').value;
      if (startDateInput) {
        const startDate = new Date(startDateInput + 'T00:00:00');
        startDate.setHours(0, 0, 0, 0);
        lastScheduledDate = startDate;
      }
      
      // Continue from latest existing post for this account
      const accountPosts = STATE.scheduledPosts.filter(p => p.accountId === accountId);
      if (accountPosts.length > 0) {
        const sorted = [...accountPosts].sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));
        const latestExisting = new Date(sorted[0].scheduledAt);
        if (!lastScheduledDate || latestExisting > lastScheduledDate) {
          lastScheduledDate = latestExisting;
        }
      }
    }
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isVideo = file.type.startsWith('video/');
      const type = isVideo ? 'REELS' : 'IMAGE';
      
      const loadingText = document.querySelector('#loading-overlay span');
      if (loadingText) loadingText.innerText = `ENVIANDO ${i + 1}/${files.length}...`;
      
      try {
        let url;
        if (type === 'IMAGE') {
          url = await uploadToImgbb(file);
        } else {
          url = await uploadToCloudinary(file);
        }
        
        let scheduledAt;
        if (STATE.scheduleMode === 'manual') {
          // Manual: all files at the same date+time (or offset by 1 min each)
          scheduledAt = new Date(manualDateTime.getTime() + (i * 60000));
        } else {
          // Auto: distribute across slots
          const nextSlot = calculateNextSlot(lastScheduledDate);
          lastScheduledDate = nextSlot;
          scheduledAt = nextSlot;
        }
        
        const post = {
          id: `post_${Date.now()}_${i}`,
          accountId,
          mediaType: type,
          imageUrl: url,
          caption: pickVariation(captionVariations, i),
          scheduledAt: scheduledAt.toISOString()
        };
        
        const res = await fetch(`${API_BASE}/save-post`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(post)
        });
        
        if (res.ok) successCount++;
      } catch (err) {
        showToast(`Erro: ${file.name} - ${err.message}`, 'error');
      }
    }
    
    showLoading(false);
    STATE.queuedFiles = [];
    fileInput.value = '';
    
    if (successCount > 0) {
      showToast(`${successCount} publicação(ões) agendada(s)!`, 'success');
      switchSection('schedule');
      await loadData();
    }
  };
}

/**
 * 🛠️ Management Actions (Globals)
 */

window.toggleSelectionMode = () => {
  STATE.selectionMode = !STATE.selectionMode;
  if (!STATE.selectionMode) STATE.selectedPostIds = [];
  renderScheduleCards();
};

window.togglePostSelection = (postId) => {
  if (STATE.selectedPostIds.includes(postId)) {
    STATE.selectedPostIds = STATE.selectedPostIds.filter(id => id !== postId);
  } else {
    STATE.selectedPostIds.push(postId);
  }
  renderScheduleCards();
};

window.selectAllPosts = () => {
  const posts = getFilteredPosts();
  STATE.selectedPostIds = posts.map(p => p.id);
  renderScheduleCards();
};

window.deleteSelectedPosts = async () => {
  if (STATE.selectedPostIds.length === 0) return showToast('Nenhum post selecionado.', 'warning');
  if (!confirm(`Deseja excluir permanentemente os ${STATE.selectedPostIds.length} posts selecionados?`)) return;
  
  try {
    showLoading(true, 'EXCLUINDO SELECIONADOS...');
    const res = await fetch(`${API_BASE}/posts/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: STATE.selectedPostIds })
    });
    if (res.ok) {
      showToast(`${STATE.selectedPostIds.length} posts excluídos!`, 'success');
      STATE.selectedPostIds = [];
      STATE.selectionMode = false;
      await loadData();
    }
  } catch (err) {
    showToast('Erro ao excluir posts.', 'error');
  } finally {
    showLoading(false);
  }
};

window.clearAllPending = async () => {
  const accId = STATE.filterAccountId;
  if (accId === 'all') return showToast('Selecione uma conta específica para limpar tudo.', 'warning');
  
  const acc = STATE.accounts.find(a => a.accountId === accId);
  if (!confirm(`⚠️ EXCLUIR TUDO: Deseja apagar TODOS os posts pendentes da conta @${acc.username}?`)) return;
  
  try {
    showLoading(true, 'LIMPANDO CONTA...');
    const res = await fetch(`${API_BASE}/posts/clear-pending/${accId}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Todos os agendamentos pendentes foram removidos!', 'success');
      await loadData();
    }
  } catch (err) {
    showToast('Erro ao limpar conta.', 'error');
  } finally {
    showLoading(false);
  }
};
window.deletePost = async (id) => {
  if (!confirm('Deseja realmente excluir este agendamento?')) return;
  try {
    const res = await fetch(`${API_BASE}/posts/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Agendamento excluído!', 'success');
      await loadData();
    }
  } catch (err) {
    showToast('Erro ao excluir.', 'error');
  }
};

window.transferAllPosts = async () => {
  if (STATE.accounts.length < 2) {
    return showToast('Você precisa de pelo menos duas contas conectadas.', 'warning');
  }

  const fromAcc = STATE.accounts.find(a => a.accountId === STATE.filterAccountId) || STATE.accounts[0];
  const otherAccounts = STATE.accounts.filter(a => a.accountId !== fromAcc.accountId);

  // Detecta usernames duplicados para mostrar ID curto
  const usernameCounts2 = {};
  otherAccounts.forEach(a => { usernameCounts2[a.username] = (usernameCounts2[a.username] || 0) + 1; });
  const res = await showCustomModal({
    title: 'TRANSFERIR AGENDAMENTOS',
    message: `Mover todos os posts pendentes de @${fromAcc.username} para:`,
    inputs: [{
      id: 'targetAccountId',
      type: 'select',
      options: otherAccounts.map(a => ({
        value: a.accountId,
        label: usernameCounts2[a.username] > 1
          ? `@${a.username} (ID: ...${String(a.accountId).slice(-6)})`
          : `@${a.username}`
      }))
    }]
  });

  if (!res || !res.targetAccountId) return;

  try {
    showLoading(true, 'TRANSFERINDO...');
    const response = await fetch(`${API_BASE}/posts/transfer-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromAccountId: fromAcc.accountId, toAccountId: res.targetAccountId })
    });
    if (response.ok) {
      showToast('Transferência concluída!', 'success');
      await loadData();
    }
  } catch (err) {
    showToast('Erro na transferência.', 'error');
  } finally {
    showLoading(false);
  }
};

// Função auxiliar para pegar conta destino via modal
async function pickTargetAccount(excludeId) {
  if (STATE.accounts.length < 2) {
    showToast('Você precisa de pelo menos duas contas conectadas.', 'warning');
    return null;
  }
  const others = STATE.accounts.filter(a => a.accountId !== excludeId);
  if (others.length === 0) {
    showToast('Nenhuma outra conta disponível.', 'warning');
    return null;
  }
  // Detecta usernames duplicados para mostrar ID curto
  const usernameCounts = {};
  others.forEach(a => { usernameCounts[a.username] = (usernameCounts[a.username] || 0) + 1; });
  const options = others.map(a => ({
    value: a.accountId,
    label: usernameCounts[a.username] > 1
      ? `@${a.username} (ID: ...${String(a.accountId).slice(-6)})`
      : `@${a.username}`
  }));
  const res = await showCustomModal({
    title: 'SELECIONAR CONTA DESTINO',
    message: 'Escolha a conta de destino:',
    inputs: [{ id: 'targetAccountId', type: 'select', options }]
  });
  return res?.targetAccountId || null;
}

// Copiar posts selecionados para outra conta (mantém originais)
window.copySelectedToAccount = async () => {
  if (!STATE.selectedPostIds.length) return showToast('Selecione ao menos um post.', 'warning');
  const sourceId = STATE.selectedPostIds.length > 0 ? (STATE.scheduledPosts.find(p => STATE.selectedPostIds.includes(p.id))?.accountId) : STATE.filterAccountId;
  const targetId = await pickTargetAccount(sourceId);
  if (!targetId) return;
  try {
    showLoading(true, 'COPIANDO...');
    const response = await fetch(`${API_BASE}/posts/copy-selected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postIds: STATE.selectedPostIds, toAccountId: targetId })
    });
    const data = await response.json();
    if (response.ok) {
      showToast(`${data.count || STATE.selectedPostIds.length} post(s) copiados!`, 'success');
      toggleSelectionMode();
      await loadData();
    } else throw new Error(data.error);
  } catch (err) {
    showToast('Erro ao copiar: ' + err.message, 'error');
  } finally { showLoading(false); }
};

// Mover posts selecionados para outra conta (remove da original)
window.moveSelectedToAccount = async () => {
  if (!STATE.selectedPostIds.length) return showToast('Selecione ao menos um post.', 'warning');
  const sourceId = STATE.scheduledPosts.find(p => STATE.selectedPostIds.includes(p.id))?.accountId;
  const targetId = await pickTargetAccount(sourceId);
  if (!targetId) return;
  try {
    showLoading(true, 'MOVENDO...');
    const response = await fetch(`${API_BASE}/posts/move-selected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postIds: STATE.selectedPostIds, toAccountId: targetId })
    });
    const data = await response.json();
    if (response.ok) {
      showToast(`${STATE.selectedPostIds.length} post(s) movidos!`, 'success');
      toggleSelectionMode();
      await loadData();
    } else throw new Error(data.error);
  } catch (err) {
    showToast('Erro ao mover: ' + err.message, 'error');
  } finally { showLoading(false); }
};

window.deleteAccount = async (id) => {
  if (!confirm('⚠️ ATENÇÃO: Isso excluirá permanentemente esta conta e TODOS os posts agendados associados a ela. Confirmar?')) return;
  
  try {
    showLoading(true, 'EXCLUINDO CONTA...');
    const res = await fetch(`${API_BASE}/accounts/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Conta e posts removidos!', 'success');
      if (STATE.activeAccountId === id) STATE.activeAccountId = null;
      await loadData();
    } else {
      throw new Error('Falha ao excluir conta.');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    showLoading(false);
  }
};

window.publishNow = async (postId) => {
  const post = STATE.scheduledPosts.find(p => p.id === postId);
  if (!post) return;
  
  showLoading(true, 'PUBLICANDO AGORA...');
  try {
    const res = await fetch(`${API_BASE}/publish-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post })
    });
    const data = await res.json();
    if (res.ok) {
      showToast('Publicado com sucesso!', 'success');
      await loadData();
    } else {
      throw new Error(data.error || 'Erro ao publicar.');
    }
  } catch (err) {
    showToast(`Erro: ${err.message}`, 'error');
  } finally {
    showLoading(false);
  }
};

// (funções duplicadas removidas — definições únicas acima)

/**
 * 📡 API Helpers
 */
/**
 * Divide a legenda em variações separadas por uma linha contendo só "---".
 * Sem separador, retorna a legenda inteira como única variação.
 */
function parseCaptionVariations(raw) {
  const texto = (raw || '').trim();
  if (!texto) return [''];
  const partes = texto.split(/\n\s*---+\s*\n/).map(p => p.trim()).filter(Boolean);
  return partes.length ? partes : [''];
}

/**
 * Escolhe uma variação para o post de índice i, alternando em sequência.
 * Começa num ponto aleatório para duas cargas seguidas não saírem iguais.
 */
let _variationOffset = Math.floor(Math.random() * 1000);
function pickVariation(variations, i) {
  if (variations.length <= 1) return variations[0] || '';
  return variations[(i + _variationOffset) % variations.length];
}

async function uploadToImgbb(file) {
  const key = (STATE.globalConfig.imgbbKey || '').trim();
  if (!key) {
    throw new Error('Chave do ImgBB não configurada. Vá em Configurações → ImgBB API Key.');
  }

  const fd = new FormData();
  fd.append('image', file);

  let r;
  try {
    r = await fetch(`https://api.imgbb.com/1/upload?key=${key}`, { method: 'POST', body: fd });
  } catch {
    throw new Error('Sem conexão com o ImgBB. Verifique a internet.');
  }

  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const msg = data.error?.message || `ImgBB retornou ${r.status}`;
    throw new Error(/invalid.*key/i.test(msg) ? 'Chave do ImgBB inválida.' : msg);
  }
  return data.data.url;
}

async function uploadToCloudinary(file) {
  const nome = (STATE.globalConfig.cloudinaryName || '').trim();
  const preset = (STATE.globalConfig.cloudinaryPreset || '').trim();
  if (!nome || !preset) {
    throw new Error('Cloudinary não configurado. Preencha Cloud Name e Upload Preset em Configurações.');
  }

  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', preset);

  let r;
  try {
    r = await fetch(`https://api.cloudinary.com/v1_1/${nome}/auto/upload`, { method: 'POST', body: fd });
  } catch {
    throw new Error('Sem conexão com o Cloudinary. Verifique a internet.');
  }

  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    throw new Error(data.error?.message || `Cloudinary retornou ${r.status}`);
  }
  return data.secure_url;
}

function setupUIEvents() {
  console.log('[LEGACY] setupUIEvents restaurado para Configurações e Sincronização');

  // 1. Vincular Salvamento de Configurações
  const settingsForm = document.getElementById('settings-form');
  if (settingsForm) {
    settingsForm.onsubmit = async (e) => {
      e.preventDefault();
      const imgbbKey = document.getElementById('imgbb-key-input').value.trim();
      const cloudinaryName = document.getElementById('cloudinary-name-input').value.trim();
      const cloudinaryPreset = document.getElementById('cloudinary-preset-input').value.trim();

      showLoading(true, 'SALVANDO CONFIGURAÇÕES...');
      try {
        const res = await fetch(`${API_BASE}/save-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imgbbKey, cloudinaryName, cloudinaryPreset })
        });
        if (!res.ok) throw new Error('Falha ao salvar configurações.');
        showToast('CONFIGURAÇÕES SALVAS!', 'success');
        await loadData();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        showLoading(false);
      }
    };
  }

  // 1b. Formulário de agendamento (vídeos por dia)
  const schedulingForm = document.getElementById('scheduling-form');
  if (schedulingForm) {
    schedulingForm.onsubmit = async (e) => {
      e.preventDefault();
      const postsPerDay = parseInt(document.getElementById('posts-per-day-input').value, 10) || 3;
      showLoading(true, 'SALVANDO AGENDAMENTO...');
      try {
        const res = await fetch(`${API_BASE}/save-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postsPerDay })
        });
        if (!res.ok) throw new Error('Falha ao salvar.');
        showToast('AGENDAMENTO SALVO!', 'success');
        await loadData();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        showLoading(false);
      }
    };
  }

  // 2. Formulário Telegram (salvar token + chat id)
  const telegramForm = document.getElementById('telegram-form');
  if (telegramForm) {
    telegramForm.onsubmit = async (e) => {
      e.preventDefault();
      const telegramToken = document.getElementById('telegram-token-input').value.trim();
      const telegramChatId = document.getElementById('telegram-chatid-input').value.trim();
      if (!telegramToken || !telegramChatId) return showToast('Preencha o Token e o Chat ID.', 'warning');
      showLoading(true, 'SALVANDO TELEGRAM...');
      try {
        const res = await fetch(`${API_BASE}/save-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ telegramToken, telegramChatId })
        });
        if (!res.ok) throw new Error('Falha ao salvar configuração do Telegram.');
        STATE.globalConfig.telegramToken = telegramToken;
        STATE.globalConfig.telegramChatId = telegramChatId;
        showToast('TELEGRAM SALVO!', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        showLoading(false);
      }
    };
  }

  // 2b. Botão Testar Telegram
  const testTelegramBtn = document.getElementById('test-telegram-btn');
  if (testTelegramBtn) {
    testTelegramBtn.onclick = async () => {
      const token = document.getElementById('telegram-token-input').value.trim() || STATE.globalConfig.telegramToken;
      const chatId = document.getElementById('telegram-chatid-input').value.trim() || STATE.globalConfig.telegramChatId;
      if (!token || !chatId) return showToast('Preencha o Token e o Chat ID primeiro.', 'warning');
      showLoading(true, 'TESTANDO TELEGRAM...');
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: '✅ *InstaScheduler AI* conectado com sucesso!', parse_mode: 'Markdown' })
        });
        const data = await res.json();
        if (data.ok) showToast('Mensagem de teste enviada!', 'success');
        else throw new Error(data.description || 'Erro ao enviar mensagem de teste.');
      } catch (err) {
        showToast(`Erro: ${err.message}`, 'error');
      } finally {
        showLoading(false);
      }
    };
  }

  // 2c. Formulário Trocar Senha
  const passwordForm = document.getElementById('password-form');
  if (passwordForm) {
    passwordForm.onsubmit = async (e) => {
      e.preventDefault();
      const loginUser = document.getElementById('new-login-user').value.trim();
      const loginPass = document.getElementById('new-login-pass').value.trim();
      const loginPassConfirm = document.getElementById('new-login-pass-confirm').value.trim();
      if (!loginUser || !loginPass) return showToast('Preencha usuário e senha.', 'warning');
      if (loginPass !== loginPassConfirm) return showToast('As senhas não coincidem.', 'error');
      if (loginPass.length < 6) return showToast('Senha deve ter pelo menos 6 caracteres.', 'warning');
      showLoading(true, 'ALTERANDO CREDENCIAIS...');
      try {
        const res = await fetch(`${API_BASE}/save-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ loginUser, loginPass })
        });
        if (!res.ok) throw new Error('Falha ao salvar credenciais.');
        showToast('CREDENCIAIS ATUALIZADAS! Faça login novamente.', 'success');
        document.getElementById('password-form').reset();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        showLoading(false);
      }
    };
  }

  // 3. Vincular Sincronização Local
  const syncBtn = document.getElementById('btn-sync-local');
  if (syncBtn) {
    syncBtn.onclick = async () => {
      showLoading(true, 'SINCRONIZANDO VÍDEOS...');
      try {
        const res = await fetch(`${API_BASE}/import-local`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro na sincronização.');
        showToast('PASTA SINCRONIZADA!', 'success');
        await loadData();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        showLoading(false);
      }
    };
  }
  
  // 3. Vincular Preview de Legenda
  const captionInput = document.getElementById('post-caption');
  if (captionInput) {
    captionInput.oninput = (e) => {
      const preview = document.getElementById('preview-caption');
      if (preview) preview.innerText = e.target.value || 'Sua legenda aparecerá aqui.';
    };
  }

  // 4. Magic Link Generator (Login por Link)
  const btnGenMagic = document.getElementById('btn-gen-magic-link');
  if (btnGenMagic) {
    btnGenMagic.onclick = async () => {
      const days = parseInt(document.getElementById('magic-duration-select')?.value, 10) || 30;
      showLoading(true, 'GERANDO LINK MÁGICO...');
      try {
        const res = await fetch(`${API_BASE}/auth/magic-link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days })
        });
        const data = await res.json();
        if (res.ok && data.url) {
          document.getElementById('generated-magic-link-input').value = data.url;
          document.getElementById('magic-link-exp-date').innerText = new Date(data.expiresAt).toLocaleDateString('pt-BR');
          document.getElementById('magic-link-result-box').style.display = 'block';
          showToast('Link de acesso gerado com sucesso!', 'success');
        } else {
          throw new Error(data.error || 'Erro ao gerar link');
        }
      } catch (err) {
        showToast(`Erro: ${err.message}`, 'error');
      } finally {
        showLoading(false);
      }
    };
  }

  const btnCopyMagic = document.getElementById('btn-copy-magic-link');
  if (btnCopyMagic) {
    btnCopyMagic.onclick = () => {
      const link = document.getElementById('generated-magic-link-input').value;
      if (!link) return;
      navigator.clipboard.writeText(link);
      showToast('Link de acesso copiado para a área de transferência!', 'success');
    };
  }

  const btnSendMagicTelegram = document.getElementById('btn-send-magic-telegram');
  if (btnSendMagicTelegram) {
    btnSendMagicTelegram.onclick = async () => {
      const days = parseInt(document.getElementById('magic-duration-select')?.value, 10) || 30;
      showLoading(true, 'ENVIANDO VIA TELEGRAM...');
      try {
        const res = await fetch(`${API_BASE}/auth/send-magic-telegram`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days })
        });
        const data = await res.json();
        if (res.ok) {
          showToast('Link Mágico enviado para seu Telegram!', 'success');
        } else {
          throw new Error(data.error || 'Erro ao enviar para o Telegram');
        }
      } catch (err) {
        showToast(`Erro: ${err.message}`, 'error');
      } finally {
        showLoading(false);
      }
    };
  }

  // 5. Web Push Notification Enable Button
  const btnPush = document.getElementById('btn-enable-push');
  if (btnPush) {
    btnPush.onclick = async () => {
      await subscribeToPush();
    };
  }

  const btnTestPush = document.getElementById('btn-test-push');
  if (btnTestPush) {
    btnTestPush.onclick = async () => {
      const btn = e => e.target;
      try {
        const res = await fetch(`${API_BASE}/push/test`, { method: 'POST' });
        if (!res.ok) throw new Error('Erro ao enviar push de teste');
        showToast('Notificação de teste enviada!', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    };
  }
}

/**
 * 🔔 Web Push Client Logic
 */
function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** iPhone/iPad? (inclui iPad moderno, que se identifica como Mac com toque) */
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** O site foi aberto pelo ícone da Tela de Início (modo app), não pela aba? */
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}

async function setupPushNotifications() {
  const msgEl = document.getElementById('push-status-msg');
  const btn = document.getElementById('btn-enable-push');
  const iosHelp = document.getElementById('ios-push-help');

  // No iPhone, a Apple só permite notificação web quando o site está instalado
  // na Tela de Início. Na aba do Safari o botão até funciona, mas nada chega —
  // então explicamos e travamos o botão em vez de dar falsa sensação de sucesso.
  if (isIOS() && !isStandalone()) {
    if (iosHelp) iosHelp.style.display = 'block';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-mobile-screen"></i> Instale o app primeiro';
    }
    if (msgEl) msgEl.innerText = 'No iPhone: só funciona com o app na Tela de Início (passos acima).';
    return;
  }

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    if (msgEl) msgEl.innerText = 'Notificações não são suportadas neste navegador.';
    if (btn) btn.disabled = true;
    return;
  }

  try {
    const swReg = await navigator.serviceWorker.register('/sw.js');
    console.log('[PWA] Service Worker registrado', swReg);

    if (Notification.permission === 'granted') {
      if (msgEl) msgEl.innerText = 'Notificações já estão ativas neste dispositivo.';
      if (btn) {
         btn.disabled = true;
         btn.innerHTML = '<i class="fa-solid fa-check"></i> Ativado';
      }
    }
  } catch (err) {
    console.error('[PWA] Erro ao registrar SW', err);
  }
}

async function subscribeToPush() {
  const msgEl = document.getElementById('push-status-msg');

  if (isIOS() && !isStandalone()) {
    showToast('No iPhone, adicione o app à Tela de Início antes de ativar.', 'warning');
    return;
  }

  try {
    showLoading(true, 'SOLICITANDO PERMISSÃO...');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('Permissão negada pelo usuário.');
    }

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    
    if (!sub) {
      const res = await fetch(`${API_BASE}/push/public-key`);
      const data = await res.json();
      const applicationServerKey = urlB64ToUint8Array(data.publicKey);
      
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
    }

    const saveRes = await fetch(`${API_BASE}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub)
    });

    if (saveRes.ok) {
      showToast('Notificações ativadas com sucesso!', 'success');
      if (msgEl) msgEl.innerText = 'Tudo certo! Você receberá alertas de publicação.';
      const btn = document.getElementById('btn-enable-push');
      if(btn) {
         btn.disabled = true;
         btn.innerHTML = '<i class="fa-solid fa-check"></i> Ativado';
      }
    } else {
      throw new Error('Erro ao salvar inscrição no servidor.');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function saveAccount(accountId, username, accessToken, profilePictureUrl) {
  showLoading(true, 'CONECTANDO...');
  try {
    const res = await fetch(`${API_BASE}/save-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, username, accessToken, profilePictureUrl })
    });
    if (!res.ok) throw new Error('Falha ao salvar conta.');
    showToast('CONTA CONECTADA!', 'success');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    showLoading(false);
  }
}

function showLoading(show, message) {
  const overlay = document.getElementById('loading-overlay');
  overlay.style.display = show ? 'flex' : 'none';
  overlay.querySelector('span').innerText = message || 'AGUARDE...';
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  
  const icon = {
    'success': 'fa-circle-check',
    'error': 'fa-circle-xmark',
    'warning': 'fa-triangle-exclamation',
    'info': 'fa-circle-info'
  }[type];
  
  const color = {
    'success': '#10b981',
    'error': '#ef4444',
    'warning': '#f59e0b',
    'info': '#8b5cf6'
  }[type];

  toast.innerHTML = `
    <i class="fa-solid ${icon}" style="color: ${color}; font-size: 1.25rem;"></i>
    <span style="font-weight: 700; color: white;">${msg}</span>
  `;
  
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(120%)';
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

function renderSettings() {
  document.getElementById('imgbb-key-input').value = STATE.globalConfig.imgbbKey || '';
  document.getElementById('cloudinary-name-input').value = STATE.globalConfig.cloudinaryName || '';
  document.getElementById('cloudinary-preset-input').value = STATE.globalConfig.cloudinaryPreset || '';
  // Telegram
  const tToken = document.getElementById('telegram-token-input');
  const tChat = document.getElementById('telegram-chatid-input');
  if (tToken) tToken.value = STATE.globalConfig.telegramToken || '';
  if (tChat) tChat.value = STATE.globalConfig.telegramChatId || '';
}

// ============================================================
// 🚀 SCALEREELS FEATURES INTEGRATION FOR INSTA POST AI
// ============================================================

/**
 * 1. REELS EM MASSA (BULK REELS)
 */
function renderBulkReelsSection() {
  populateAccountSelector();
  const dateInput = document.getElementById('bulk-start-date');
  if (dateInput && !dateInput.value) {
    const today = new Date().toISOString().split('T')[0];
    dateInput.value = today;
  }
  setupBulkDropzone();
}

function setupBulkDropzone() {
  const dropzone = document.getElementById('bulk-dropzone');
  const fileInput = document.getElementById('bulk-file-input');
  if (!dropzone || !fileInput) return;

  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = (e) => handleBulkFilesSelect(Array.from(e.target.files));

  dropzone.ondragover = (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--primary)'; };
  dropzone.ondragleave = () => { dropzone.style.borderColor = 'var(--border-color)'; };
  dropzone.ondrop = (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--border-color)';
    if (e.dataTransfer.files?.length) {
      handleBulkFilesSelect(Array.from(e.dataTransfer.files));
    }
  };
}

function handleBulkFilesSelect(files) {
  const videoFiles = files.filter(f => f.type.startsWith('video/') || f.name.endsWith('.mp4'));
  if (videoFiles.length === 0) {
    showToast('Por favor selecione arquivos de vídeo (.mp4)', 'warning');
    return;
  }
  STATE.bulkFiles = videoFiles;
  const countEl = document.getElementById('bulk-files-count');
  const summaryEl = document.getElementById('bulk-files-summary');
  if (countEl) countEl.innerText = `${videoFiles.length} vídeos`;
  if (summaryEl) summaryEl.style.display = 'block';
  showToast(`${videoFiles.length} vídeos prontos para gerar fila!`, 'success');
}

function insertBulkPlaceholder(tag) {
  const el = document.getElementById('bulk-caption-input');
  if (!el) return;
  el.value += ' ' + tag + ' ';
  el.focus();
}

async function insertRandomCaptionBulk() {
  try {
    if (!STATE.captionsList.length) {
      const res = await fetch(`${API_BASE}/captions`);
      const data = await res.json();
      STATE.captionsList = data.captions || [];
    }
    if (STATE.captionsList.length === 0) {
      showToast('Nenhuma legenda salva na biblioteca ainda.', 'info');
      return;
    }
    const rand = STATE.captionsList[Math.floor(Math.random() * STATE.captionsList.length)];
    const el = document.getElementById('bulk-caption-input');
    if (el) el.value = rand.text;
    showToast(`Legenda "${rand.title}" inserida!`, 'info');
  } catch (err) {
    showToast('Erro ao buscar legenda.', 'error');
  }
}

function generateBulkQueue() {
  if (!STATE.bulkFiles || STATE.bulkFiles.length === 0) {
    showToast('Selecione os vídeos primeiro!', 'warning');
    return;
  }

  const accountId = document.getElementById('bulk-account-select')?.value || STATE.activeAccountId;
  const startDateStr = document.getElementById('bulk-start-date')?.value || new Date().toISOString().split('T')[0];
  const startTimeStr = document.getElementById('bulk-start-time')?.value || '10:00';
  const intervalMode = document.getElementById('bulk-interval-mode')?.value || 'slots';
  const varianceMinutes = parseInt(document.getElementById('bulk-variance')?.value || 5, 10);
  const captionBase = document.getElementById('bulk-caption-input')?.value || '';
  const useRotating = document.getElementById('bulk-use-rotating-captions')?.checked;

  const [startHour, startMinute] = startTimeStr.split(':').map(Number);
  let currentDate = new Date(`${startDateStr}T00:00:00`);
  currentDate.setHours(startHour, startMinute, 0, 0);

  const defaultSlots = [
    { h: 10, m: 0 },
    { h: 15, m: 0 },
    { h: 20, m: 0 }
  ];

  STATE.bulkQueue = [];
  let slotIndex = 0;

  STATE.bulkFiles.forEach((file, index) => {
    let itemDate = new Date(currentDate);

    if (intervalMode === 'slots') {
      const slot = defaultSlots[slotIndex % defaultSlots.length];
      const dayOffset = Math.floor(slotIndex / defaultSlots.length);
      itemDate = new Date(`${startDateStr}T00:00:00`);
      itemDate.setDate(itemDate.getDate() + dayOffset);
      itemDate.setHours(slot.h, slot.m, 0, 0);
      slotIndex++;
    } else if (intervalMode === 'hours') {
      itemDate = new Date(currentDate.getTime() + index * 4 * 60 * 60 * 1000);
    } else if (intervalMode === 'daily') {
      itemDate = new Date(currentDate.getTime() + index * 24 * 60 * 60 * 1000);
    }

    // Jitter / Variância Anti-Ban
    let jitterMinutes = 0;
    if (varianceMinutes > 0) {
      jitterMinutes = Math.floor(Math.random() * (varianceMinutes * 2 + 1)) - varianceMinutes;
      itemDate = new Date(itemDate.getTime() + jitterMinutes * 60 * 1000);
    }

    // Formatar Legenda com Placeholders
    const diasSemana = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    const diaNome = diasSemana[itemDate.getDay()];
    const horaFormatada = itemDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const dataFormatada = itemDate.toLocaleDateString('pt-BR');

    let itemCaption = captionBase
      .replace(/{dia}/gi, diaNome)
      .replace(/{hora}/gi, horaFormatada)
      .replace(/{data}/gi, dataFormatada);

    if (useRotating && STATE.captionsList.length > 0) {
      const randCap = STATE.captionsList[Math.floor(Math.random() * STATE.captionsList.length)];
      itemCaption = randCap.text
        .replace(/{dia}/gi, diaNome)
        .replace(/{hora}/gi, horaFormatada)
        .replace(/{data}/gi, dataFormatada);
    }

    STATE.bulkQueue.push({
      file,
      accountId,
      scheduledAt: itemDate.toISOString(),
      displayDate: itemDate.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }),
      caption: itemCaption,
      varianceMinutes,
      jitterMinutes,
      mediaType: 'REELS'
    });
  });

  renderBulkQueueList();
}

function renderBulkQueueList() {
  const container = document.getElementById('bulk-queue-list');
  const emptyEl = document.getElementById('bulk-queue-empty');
  const confirmBox = document.getElementById('bulk-confirm-container');
  const countEl = document.getElementById('bulk-queue-count');

  if (!container) return;

  if (STATE.bulkQueue.length === 0) {
    if (emptyEl) emptyEl.style.display = 'flex';
    container.style.display = 'none';
    if (confirmBox) confirmBox.style.display = 'none';
    if (countEl) countEl.innerText = '0';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  container.style.display = 'flex';
  if (confirmBox) confirmBox.style.display = 'block';
  if (countEl) countEl.innerText = String(STATE.bulkQueue.length);

  container.innerHTML = STATE.bulkQueue.map((item, idx) => `
    <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:10px; padding:10px 14px; gap:12px;">
      <div style="display:flex; align-items:center; gap:12px; flex:1; min-width:0;">
        <div style="width:32px; height:32px; border-radius:8px; background:var(--primary-bg); color:var(--primary); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:0.8rem;">
          #${idx + 1}
        </div>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600; font-size:0.85rem; color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${item.file.name}
          </div>
          <div style="font-size:0.72rem; color:var(--text-dim); display:flex; gap:8px; align-items:center; margin-top:2px;">
            <span><i class="fa-solid fa-clock" style="color:var(--accent);"></i> ${item.displayDate}</span>
            ${item.jitterMinutes ? `<span style="color:var(--success);"><i class="fa-solid fa-shield-halved"></i> Jitter ${item.jitterMinutes > 0 ? '+' : ''}${item.jitterMinutes}m</span>` : ''}
          </div>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="removeBulkQueueItem(${idx})" style="padding:4px 8px; color:var(--error);"><i class="fa-solid fa-trash"></i></button>
    </div>
  `).join('');
}

function removeBulkQueueItem(index) {
  STATE.bulkQueue.splice(index, 1);
  renderBulkQueueList();
}

function clearBulkQueue() {
  STATE.bulkQueue = [];
  STATE.bulkFiles = [];
  const summaryEl = document.getElementById('bulk-files-summary');
  if (summaryEl) summaryEl.style.display = 'none';
  renderBulkQueueList();
}

async function submitBulkQueue() {
  if (STATE.bulkQueue.length === 0) return;

  const btn = document.getElementById('btn-submit-bulk-queue');
  const progressBox = document.getElementById('bulk-progress-box');
  const progressBar = document.getElementById('bulk-progress-bar');
  const progressStatus = document.getElementById('bulk-progress-status');
  const progressPct = document.getElementById('bulk-progress-percentage');

  if (btn) btn.disabled = true;
  if (progressBox) progressBox.style.display = 'block';

  const cloudName = STATE.globalConfig.cloudinaryName;
  const cloudPreset = STATE.globalConfig.cloudinaryPreset;

  if (!cloudName || !cloudPreset) {
    showToast('Configure Cloud Name e Preset do Cloudinary nas Configurações!', 'error');
    if (btn) btn.disabled = false;
    if (progressBox) progressBox.style.display = 'none';
    return;
  }

  const scheduledPayload = [];

  for (let i = 0; i < STATE.bulkQueue.length; i++) {
    const item = STATE.bulkQueue[i];
    const pct = Math.round(((i) / STATE.bulkQueue.length) * 100);
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressPct) progressPct.innerText = `${pct}%`;
    if (progressStatus) progressStatus.innerText = `Enviando vídeo ${i + 1} de ${STATE.bulkQueue.length} (${item.file.name})...`;

    try {
      // Direct Cloudinary Upload
      const formData = new FormData();
      formData.append('file', item.file);
      formData.append('upload_preset', cloudPreset);
      formData.append('resource_type', 'video');

      const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/video/upload`, {
        method: 'POST',
        body: formData
      });

      const uploadData = await uploadRes.json();
      if (!uploadData.secure_url) throw new Error(uploadData.error?.message || 'Falha no upload do Cloudinary.');

      scheduledPayload.push({
        accountId: item.accountId,
        mediaType: 'REELS',
        imageUrl: uploadData.secure_url,
        caption: item.caption,
        scheduledAt: item.scheduledAt,
        varianceMinutes: item.varianceMinutes,
        sourceFile: item.file.name
      });
    } catch (err) {
      console.error('Bulk upload error on item:', err);
      showToast(`Erro ao enviar ${item.file.name}: ${err.message}`, 'error');
    }
  }

  if (scheduledPayload.length > 0) {
    if (progressStatus) progressStatus.innerText = 'Salvando agendamentos no banco de dados...';
    try {
      const res = await fetch(`${API_BASE}/posts/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posts: scheduledPayload })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`🎉 ${data.count} Reels agendados com sucesso!`, 'success');
        clearBulkQueue();
        await loadData();
        setTimeout(() => switchSection('schedule'), 800);
      } else {
        throw new Error(data.error);
      }
    } catch (e) {
      showToast(`Erro ao salvar lote: ${e.message}`, 'error');
    }
  }

  if (btn) btn.disabled = false;
  if (progressBox) progressBox.style.display = 'none';
}

/**
 * 2. CARROSSEL & FOTOS WIZARD
 */
function renderBulkCarouselSection() {
  populateAccountSelector();
  const dateInput = document.getElementById('carousel-date');
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().split('T')[0];
  }
  setupCarouselDropzone();
}

function setupCarouselDropzone() {
  const dropzone = document.getElementById('carousel-dropzone');
  const fileInput = document.getElementById('carousel-file-input');
  if (!dropzone || !fileInput) return;

  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = (e) => handleCarouselFiles(Array.from(e.target.files));

  dropzone.ondragover = (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--accent)'; };
  dropzone.ondragleave = () => { dropzone.style.borderColor = 'var(--border-color)'; };
  dropzone.ondrop = (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--border-color)';
    if (e.dataTransfer.files?.length) handleCarouselFiles(Array.from(e.dataTransfer.files));
  };
}

function handleCarouselFiles(files) {
  if (STATE.carouselSlides.length + files.length > 10) {
    showToast('O Instagram permite no máximo 10 slides por carrossel.', 'warning');
    return;
  }
  files.forEach(file => {
    const previewUrl = URL.createObjectURL(file);
    STATE.carouselSlides.push({ file, previewUrl, isVideo: file.type.startsWith('video/') });
  });
  renderCarouselSlides();
}

function renderCarouselSlides() {
  const container = document.getElementById('carousel-slides-container');
  const indicator = document.getElementById('carousel-slide-indicator');
  const previewBox = document.getElementById('carousel-preview-box');
  const previewDots = document.getElementById('carousel-preview-dots');

  if (!container) return;
  if (indicator) indicator.innerText = `${STATE.carouselSlides.length}/10 slides`;

  container.innerHTML = STATE.carouselSlides.map((slide, idx) => `
    <div class="carousel-slide-item">
      <span class="carousel-slide-badge">#${idx + 1}</span>
      <span class="carousel-slide-remove" onclick="removeCarouselSlide(${idx})"><i class="fa-solid fa-times"></i></span>
      ${slide.isVideo ? `<video src="${slide.previewUrl}" muted></video>` : `<img src="${slide.previewUrl}">`}
    </div>
  `).join('');

  if (STATE.carouselSlides.length > 0 && previewBox) {
    const first = STATE.carouselSlides[0];
    previewBox.innerHTML = first.isVideo 
      ? `<video src="${first.previewUrl}" controls style="width:100%;height:100%;object-fit:cover;"></video>`
      : `<img src="${first.previewUrl}" style="width:100%;height:100%;object-fit:cover;">`;
    
    if (previewDots) {
      previewDots.innerHTML = STATE.carouselSlides.map((_, idx) => `
        <div style="width:6px; height:6px; border-radius:50%; background:${idx === 0 ? 'var(--primary)' : 'var(--border-color)'};"></div>
      `).join('');
    }
  } else if (previewBox) {
    previewBox.innerHTML = '<span style="color:var(--text-dim); font-size:0.9rem;">Adicione slides para visualizar</span>';
    if (previewDots) previewDots.innerHTML = '';
  }
}

function removeCarouselSlide(index) {
  STATE.carouselSlides.splice(index, 1);
  renderCarouselSlides();
}

async function submitCarousel() {
  if (STATE.carouselSlides.length < 2) {
    showToast('Adicione pelo menos 2 slides para criar um carrossel!', 'warning');
    return;
  }

  const accountId = document.getElementById('carousel-account-select')?.value || STATE.activeAccountId;
  const dateStr = document.getElementById('carousel-date')?.value;
  const timeStr = document.getElementById('carousel-time')?.value || '18:00';
  const caption = document.getElementById('carousel-caption')?.value || '';

  if (!dateStr) { showToast('Selecione a data de agendamento.', 'warning'); return; }

  const scheduledDate = new Date(`${dateStr}T${timeStr}:00`);
  const cloudName = STATE.globalConfig.cloudinaryName;
  const cloudPreset = STATE.globalConfig.cloudinaryPreset;
  const imgbbKey = STATE.globalConfig.imgbbKey;

  showLoading(true, 'ENVIANDO SLIDES DO CARROSSEL...');

  try {
    const uploadedMediaUrls = [];

    for (let i = 0; i < STATE.carouselSlides.length; i++) {
      const slide = STATE.carouselSlides[i];
      if (slide.isVideo) {
        if (!cloudName || !cloudPreset) throw new Error('Cloudinary não configurado para upload de vídeos do carrossel.');
        const fd = new FormData();
        fd.append('file', slide.file);
        fd.append('upload_preset', cloudPreset);
        fd.append('resource_type', 'video');
        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/video/upload`, { method: 'POST', body: fd });
        const data = await res.json();
        if (!data.secure_url) throw new Error('Falha no upload do slide de vídeo.');
        uploadedMediaUrls.push(data.secure_url);
      } else {
        // Upload imagem via ImgBB ou Cloudinary
        if (imgbbKey) {
          const fd = new FormData();
          fd.append('image', slide.file);
          const res = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, { method: 'POST', body: fd });
          const data = await res.json();
          if (data.data?.url) uploadedMediaUrls.push(data.data.url);
          else throw new Error('Falha no upload de imagem via ImgBB.');
        } else if (cloudName && cloudPreset) {
          const fd = new FormData();
          fd.append('file', slide.file);
          fd.append('upload_preset', cloudPreset);
          const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: 'POST', body: fd });
          const data = await res.json();
          if (data.secure_url) uploadedMediaUrls.push(data.secure_url);
          else throw new Error('Falha no upload de imagem.');
        } else {
          throw new Error('Configure ImgBB Key ou Cloudinary nas Configurações.');
        }
      }
    }

    const newPostId = 'post_carousel_' + Date.now();
    const postPayload = {
      id: newPostId,
      accountId,
      mediaType: 'CAROUSEL',
      imageUrl: uploadedMediaUrls[0],
      mediaItems: uploadedMediaUrls,
      caption,
      scheduledAt: scheduledDate.toISOString(),
      status: 'pending'
    };

    const saveRes = await fetch(`${API_BASE}/save-post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postPayload)
    });

    if (saveRes.ok) {
      showToast('🎉 Carrossel agendado com sucesso!', 'success');
      STATE.carouselSlides = [];
      renderCarouselSlides();
      await loadData();
      setTimeout(() => switchSection('schedule'), 800);
    } else {
      const err = await saveRes.json();
      throw new Error(err.error || 'Erro ao salvar carrossel.');
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    showLoading(false);
  }
}

/**
 * 3. STORIES 24/7 LOOP
 */
function renderStoriesLoopSection() {
  populateAccountSelector();
  loadStoryLoopForAccount();
}

async function loadStoryLoopForAccount() {
  const accountId = document.getElementById('stories-account-select')?.value || STATE.activeAccountId;
  if (!accountId) return;

  try {
    const res = await fetch(`${API_BASE}/stories/loop?accountId=${encodeURIComponent(accountId)}`);
    const data = await res.json();
    if (data.loops && data.loops.length > 0) {
      const loop = data.loops[0];
      const enabledCheckbox = document.getElementById('story-loop-enabled');
      if (enabledCheckbox) enabledCheckbox.checked = loop.enabled === 1 || loop.enabled === true;

      try {
        STATE.storySlots = JSON.parse(loop.times || '["09:00", "13:00", "18:00", "21:00"]');
      } catch (e) {
        STATE.storySlots = ['09:00', '13:00', '18:00', '21:00'];
      }

      try {
        STATE.storyMediaPool = JSON.parse(loop.activeMedia || '[]');
      } catch (e) {
        STATE.storyMediaPool = [];
      }
    }
    renderStorySlots();
    renderStoryMediaPool();
  } catch (err) {
    console.error('Error loading story loop:', err);
  }
}

function renderStorySlots() {
  const container = document.getElementById('story-slots-container');
  if (!container) return;
  container.innerHTML = STATE.storySlots.map(time => `
    <span class="slot-chip">${time} <i class="fa-solid fa-times" onclick="removeStorySlot('${time}')"></i></span>
  `).join('');
}

function addStorySlot() {
  const input = document.getElementById('new-story-slot');
  if (!input || !input.value) return;
  if (!STATE.storySlots.includes(input.value)) {
    STATE.storySlots.push(input.value);
    STATE.storySlots.sort();
    renderStorySlots();
  }
}

function removeStorySlot(time) {
  STATE.storySlots = STATE.storySlots.filter(t => t !== time);
  renderStorySlots();
}

function renderStoryMediaPool() {
  const container = document.getElementById('story-media-pool');
  if (!container) return;

  if (STATE.storyMediaPool.length === 0) {
    container.innerHTML = '<p style="color:var(--text-dim); font-size:0.8rem; grid-column:1/-1;">Nenhuma mídia ativa no loop. Adicione do Acervo.</p>';
    return;
  }

  container.innerHTML = STATE.storyMediaPool.map((media, idx) => `
    <div style="position:relative; border-radius:8px; overflow:hidden; aspect-ratio:9/16; background:#000; border:1px solid var(--border-color);">
      <span style="position:absolute; top:4px; right:4px; background:rgba(239,68,68,0.85); color:#fff; width:18px; height:18px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:0.6rem; cursor:pointer;" onclick="removeStoryMedia(${idx})">
        <i class="fa-solid fa-times"></i>
      </span>
      <span style="position:absolute; bottom:4px; left:4px; background:rgba(0,0,0,0.7); color:var(--accent); font-size:0.65rem; padding:2px 6px; border-radius:4px; font-weight:700;">#${idx + 1}</span>
      ${media.toLowerCase().includes('.mp4') ? `<video src="${media}" style="width:100%;height:100%;object-fit:cover;"></video>` : `<img src="${media}" style="width:100%;height:100%;object-fit:cover;">`}
    </div>
  `).join('');
}

function removeStoryMedia(index) {
  STATE.storyMediaPool.splice(index, 1);
  renderStoryMediaPool();
}

async function saveStoryLoopConfig() {
  const accountId = document.getElementById('stories-account-select')?.value || STATE.activeAccountId;
  const enabled = document.getElementById('story-loop-enabled')?.checked ? 1 : 0;
  const varianceMinutes = parseInt(document.getElementById('story-loop-variance')?.value || 5, 10);

  try {
    const res = await fetch(`${API_BASE}/stories/loop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId,
        enabled,
        times: STATE.storySlots,
        varianceMinutes,
        activeMedia: STATE.storyMediaPool
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Configurações do Loop 24/7 salvas com sucesso!', 'success');
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    showToast('Erro ao salvar loop: ' + err.message, 'error');
  }
}

function openDriveSelectForStories() {
  switchSection('drive');
  showToast('Clique em uma mídia do Acervo para usar no seu Loop de Stories!', 'info');
}

/**
 * 4. LEGENDAS & HASHTAGS LIBRARY
 */
function renderCaptionsSection() {
  switchLibraryTab(STATE.libraryActiveTab || 'captions');
}

function switchLibraryTab(tab) {
  STATE.libraryActiveTab = tab;
  document.querySelectorAll('.btn-tab').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    b.classList.toggle('btn-primary', b.getAttribute('data-tab') === tab);
    b.classList.toggle('btn-ghost', b.getAttribute('data-tab') !== tab);
  });

  const capView = document.getElementById('tab-captions-view');
  const hashView = document.getElementById('tab-hashtags-view');
  const btnNew = document.getElementById('btn-new-library-item');

  if (tab === 'captions') {
    if (capView) capView.style.display = 'block';
    if (hashView) hashView.style.display = 'none';
    if (btnNew) btnNew.innerHTML = '<i class="fa-solid fa-plus"></i> Nova Legenda';
    loadCaptionsList();
  } else {
    if (capView) capView.style.display = 'none';
    if (hashView) hashView.style.display = 'block';
    if (btnNew) btnNew.innerHTML = '<i class="fa-solid fa-plus"></i> Novo Grupo de Hashtags';
    loadHashtagsList();
  }
}

async function loadCaptionsList() {
  const container = document.getElementById('captions-list-container');
  if (!container) return;
  try {
    const res = await fetch(`${API_BASE}/captions`);
    const data = await res.json();
    STATE.captionsList = data.captions || [];

    if (STATE.captionsList.length === 0) {
      container.innerHTML = '<p style="color:var(--text-dim); grid-column:1/-1;">Nenhuma legenda cadastrada ainda. Clique no botão acima para adicionar.</p>';
      return;
    }

    container.innerHTML = STATE.captionsList.map(item => `
      <div class="library-card">
        <div>
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
            <div style="font-weight:700; font-size:0.95rem; color:var(--text-main);">${item.title}</div>
            <span style="background:rgba(16,184,245,0.12); color:var(--accent); font-size:0.7rem; font-weight:700; padding:2px 8px; border-radius:6px;">${item.tag || 'Geral'}</span>
          </div>
          <div style="font-size:0.85rem; color:var(--text-secondary); line-height:1.5; white-space:pre-wrap; max-height:120px; overflow-y:auto; padding-right:4px;">
            ${item.text}
          </div>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-color); padding-top:10px; margin-top:8px;">
          <button class="btn btn-ghost btn-sm" onclick="copyToClipboard('${encodeURIComponent(item.text)}')" style="font-size:0.75rem;"><i class="fa-solid fa-copy"></i> Copiar</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCaption('${item.id}')" style="padding:4px 8px;"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error loading captions:', err);
  }
}

async function loadHashtagsList() {
  const container = document.getElementById('hashtags-list-container');
  if (!container) return;
  try {
    const res = await fetch(`${API_BASE}/hashtags`);
    const data = await res.json();
    STATE.hashtagsList = data.hashtags || [];

    if (STATE.hashtagsList.length === 0) {
      container.innerHTML = '<p style="color:var(--text-dim); grid-column:1/-1;">Nenhum grupo de hashtags cadastrado ainda.</p>';
      return;
    }

    container.innerHTML = STATE.hashtagsList.map(item => {
      const tagsArray = item.tags.split(/\s+/).filter(t => t.startsWith('#') || t.length > 0);
      return `
        <div class="library-card">
          <div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
              <div style="font-weight:700; font-size:0.95rem; color:var(--text-main);">${item.name}</div>
              <span style="color:var(--accent); font-size:0.75rem; font-weight:700;">${tagsArray.length} hashtags</span>
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:4px; max-height:100px; overflow-y:auto;">
              ${tagsArray.map(t => `<span style="background:rgba(255,255,255,0.04); color:var(--text-secondary); font-size:0.72rem; padding:2px 6px; border-radius:4px;">${t.startsWith('#') ? t : '#' + t}</span>`).join('')}
            </div>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-color); padding-top:10px; margin-top:8px;">
            <button class="btn btn-ghost btn-sm" onclick="copyToClipboard('${encodeURIComponent(item.tags)}')" style="font-size:0.75rem;"><i class="fa-solid fa-copy"></i> Copiar Grupo</button>
            <button class="btn btn-danger btn-sm" onclick="deleteHashtagGroup('${item.id}')" style="padding:4px 8px;"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Error loading hashtags:', err);
  }
}

function openNewLibraryItemModal() {
  if (STATE.libraryActiveTab === 'captions') {
    document.getElementById('caption-edit-id').value = '';
    document.getElementById('caption-title-input').value = '';
    document.getElementById('caption-text-input').value = '';
    document.getElementById('modal-caption-form').style.display = 'flex';
  } else {
    document.getElementById('hashtag-edit-id').value = '';
    document.getElementById('hashtag-name-input').value = '';
    document.getElementById('hashtag-tags-input').value = '';
    document.getElementById('modal-hashtag-form').style.display = 'flex';
  }
}

function closeCaptionModal() { document.getElementById('modal-caption-form').style.display = 'none'; }
function closeHashtagModal() { document.getElementById('modal-hashtag-form').style.display = 'none'; }

function insertInCaptionModal(tag) {
  const el = document.getElementById('caption-text-input');
  if (!el) return;
  el.value += ' ' + tag + ' ';
  el.focus();
}

function copyToClipboard(encodedText) {
  const text = decodeURIComponent(encodedText);
  navigator.clipboard.writeText(text);
  showToast('Copiado para a área de transferência!', 'success');
}

async function deleteCaption(id) {
  if (!confirm('Deseja excluir esta legenda?')) return;
  try {
    await fetch(`${API_BASE}/captions/${id}`, { method: 'DELETE' });
    showToast('Legenda removida.', 'info');
    loadCaptionsList();
  } catch (err) { showToast('Erro ao remover legenda.', 'error'); }
}

async function deleteHashtagGroup(id) {
  if (!confirm('Deseja excluir este grupo de hashtags?')) return;
  try {
    await fetch(`${API_BASE}/hashtags/${id}`, { method: 'DELETE' });
    showToast('Grupo de hashtags removido.', 'info');
    loadHashtagsList();
  } catch (err) { showToast('Erro ao remover grupo.', 'error'); }
}

// Event Listeners for library forms
document.addEventListener('DOMContentLoaded', () => {
  const capForm = document.getElementById('caption-item-form');
  if (capForm) {
    capForm.onsubmit = async (e) => {
      e.preventDefault();
      const id = document.getElementById('caption-edit-id').value;
      const title = document.getElementById('caption-title-input').value.trim();
      const tag = document.getElementById('caption-tag-input').value.trim();
      const text = document.getElementById('caption-text-input').value.trim();

      try {
        const res = await fetch(`${API_BASE}/captions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, title, tag, text })
        });
        if (res.ok) {
          showToast('Legenda salva com sucesso!', 'success');
          closeCaptionModal();
          loadCaptionsList();
        }
      } catch (err) { showToast('Erro ao salvar: ' + err.message, 'error'); }
    };
  }

  const hashForm = document.getElementById('hashtag-item-form');
  if (hashForm) {
    hashForm.onsubmit = async (e) => {
      e.preventDefault();
      const id = document.getElementById('hashtag-edit-id').value;
      const name = document.getElementById('hashtag-name-input').value.trim();
      const tags = document.getElementById('hashtag-tags-input').value.trim();

      try {
        const res = await fetch(`${API_BASE}/hashtags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, name, tags })
        });
        if (res.ok) {
          showToast('Grupo de hashtags salvo com sucesso!', 'success');
          closeHashtagModal();
          loadHashtagsList();
        }
      } catch (err) { showToast('Erro ao salvar: ' + err.message, 'error'); }
    };
  }
});

/**
 * 5. ACERVO / SHARED DRIVE
 */
function renderDriveSection() {
  loadDriveItems();
  setupDriveDropzone();
}

async function loadDriveItems() {
  const grid = document.getElementById('drive-items-grid');
  if (!grid) return;

  try {
    const res = await fetch(`${API_BASE}/drive`);
    const data = await res.json();
    STATE.driveFiles = data.files || [];

    if (STATE.driveFiles.length === 0) {
      grid.innerHTML = '<p style="color:var(--text-dim); grid-column:1/-1;">Nenhum arquivo no acervo ainda. Faça upload de vídeos e fotos para começar.</p>';
      return;
    }

    grid.innerHTML = STATE.driveFiles.map(file => `
      <div class="drive-card">
        ${file.url.toLowerCase().includes('.mp4') 
          ? `<video class="drive-thumb" src="${file.url}" controls></video>` 
          : `<img class="drive-thumb" src="${file.url}">`}
        <div class="drive-card-title" title="${file.filename}">${file.filename}</div>
        <div class="drive-card-meta">
          <span>${file.size || 'Nuvem'}</span>
          <span>${new Date(file.createdAt).toLocaleDateString('pt-BR')}</span>
        </div>
        <div style="display:flex; gap:6px; margin-top:4px;">
          <button class="btn btn-primary btn-sm" onclick="useDriveMediaInComposer('${file.url}')" style="flex:1; font-size:0.72rem; padding:4px;">
            <i class="fa-solid fa-calendar-plus"></i> Postar
          </button>
          <button class="btn btn-ghost btn-sm" onclick="addDriveMediaToStoryLoop('${file.url}')" style="font-size:0.72rem; padding:4px;" title="Adicionar ao Story Loop">
            <i class="fa-solid fa-arrows-spin"></i>
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteDriveItem('${file.id}')" style="padding:4px 6px;">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error loading drive items:', err);
  }
}

function openDriveUploadModal() {
  document.getElementById('modal-drive-upload').style.display = 'flex';
}

function closeDriveUploadModal() {
  document.getElementById('modal-drive-upload').style.display = 'none';
}

function setupDriveDropzone() {
  const dropzone = document.getElementById('drive-dropzone');
  const fileInput = document.getElementById('drive-file-input');
  if (!dropzone || !fileInput) return;

  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = (e) => uploadFilesToDrive(Array.from(e.target.files));
}

async function uploadFilesToDrive(files) {
  const cloudName = STATE.globalConfig.cloudinaryName;
  const cloudPreset = STATE.globalConfig.cloudinaryPreset;
  const imgbbKey = STATE.globalConfig.imgbbKey;

  const statusBox = document.getElementById('drive-upload-status');
  const filenameEl = document.getElementById('drive-upload-filename');
  const pctEl = document.getElementById('drive-upload-pct');
  const barEl = document.getElementById('drive-upload-bar');

  if (statusBox) statusBox.style.display = 'block';

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const isVideo = file.type.startsWith('video/') || file.name.endsWith('.mp4');
    const pct = Math.round(((i + 1) / files.length) * 100);

    if (filenameEl) filenameEl.innerText = `Enviando (${i + 1}/${files.length}): ${file.name}`;
    if (pctEl) pctEl.innerText = `${pct}%`;
    if (barEl) barEl.style.width = `${pct}%`;

    try {
      let uploadedUrl = '';
      if (isVideo) {
        if (!cloudName || !cloudPreset) throw new Error('Cloudinary não configurado.');
        const fd = new FormData();
        fd.append('file', file);
        fd.append('upload_preset', cloudPreset);
        fd.append('resource_type', 'video');
        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/video/upload`, { method: 'POST', body: fd });
        const data = await res.json();
        uploadedUrl = data.secure_url;
      } else {
        if (imgbbKey) {
          const fd = new FormData();
          fd.append('image', file);
          const res = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, { method: 'POST', body: fd });
          const data = await res.json();
          uploadedUrl = data.data?.url;
        } else if (cloudName && cloudPreset) {
          const fd = new FormData();
          fd.append('file', file);
          fd.append('upload_preset', cloudPreset);
          const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: 'POST', body: fd });
          const data = await res.json();
          uploadedUrl = data.secure_url;
        }
      }

      if (!uploadedUrl) throw new Error('Falha no upload.');

      await fetch(`${API_BASE}/drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          url: uploadedUrl,
          size: (file.size / (1024 * 1024)).toFixed(1) + ' MB'
        })
      });
    } catch (e) {
      console.error('Drive upload failed for file:', file.name, e);
    }
  }

  showToast('Arquivos adicionados ao acervo com sucesso!', 'success');
  if (statusBox) statusBox.style.display = 'none';
  closeDriveUploadModal();
  loadDriveItems();
}

function useDriveMediaInComposer(url) {
  switchSection('new-post');
  STATE.uploadedUrl = url;
  const previewBox = document.getElementById('preview-image-box');
  if (previewBox) {
    if (url.toLowerCase().includes('.mp4')) {
      previewBox.innerHTML = `<video src="${url}" controls style="width:100%;height:100%;object-fit:cover;"></video>`;
    } else {
      previewBox.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;">`;
    }
  }
  showToast('Mídia do acervo carregada no agendador!', 'success');
}

function addDriveMediaToStoryLoop(url) {
  if (!STATE.storyMediaPool.includes(url)) {
    STATE.storyMediaPool.push(url);
    saveStoryLoopConfig();
    showToast('Mídia adicionada ao Loop de Stories!', 'success');
  } else {
    showToast('Esta mídia já está no loop.', 'info');
  }
}

async function deleteDriveItem(id) {
  if (!confirm('Deseja excluir esta mídia do acervo?')) return;
  try {
    await fetch(`${API_BASE}/drive/${id}`, { method: 'DELETE' });
    showToast('Mídia excluída.', 'info');
    loadDriveItems();
  } catch (err) { showToast('Erro ao excluir mídia.', 'error'); }
}

/**
 * 6. ANALYTICS PRO CONSOLIDADO
 */
async function renderAnalyticsSection() {
  try {
    const res = await fetch(`${API_BASE}/analytics/summary`);
    const data = await res.json();
    const s = data.summary || {};

    const folEl = document.getElementById('analytics-total-followers');
    const pubEl = document.getElementById('analytics-total-published');
    const rateEl = document.getElementById('analytics-success-rate');
    const pendEl = document.getElementById('analytics-total-pending');

    if (pubEl) pubEl.innerText = s.published || 0;
    if (rateEl) rateEl.innerText = `${s.successRate || 100}%`;
    if (pendEl) pendEl.innerText = s.pending || 0;

    // Calcular seguidores somados de todas as contas
    let totalFollowers = 0;
    for (const acc of STATE.accounts) {
      const statsRes = await fetch(`${API_BASE}/account-stats?accountId=${encodeURIComponent(acc.accountId)}`);
      const stats = await statsRes.json();
      if (stats.followersCount) totalFollowers += stats.followersCount;
    }
    if (folEl) animateNumber(folEl, totalFollowers || 0);

    // Leaderboard
    const tableEl = document.getElementById('analytics-accounts-table');
    if (tableEl) {
      tableEl.innerHTML = `
        <table style="width:100%; border-collapse:collapse; font-size:0.85rem; text-align:left;">
          <thead>
            <tr style="border-bottom:1px solid var(--border-color); color:var(--text-dim); font-size:0.75rem;">
              <th style="padding:8px;">CONTA</th>
              <th style="padding:8px;">TOTAL AGENDADOS</th>
              <th style="padding:8px;">PUBLICADOS</th>
              <th style="padding:8px;">STATUS</th>
            </tr>
          </thead>
          <tbody>
            ${STATE.accounts.map(acc => {
              const accData = s.postsPerAccount?.find(p => p.accountId === acc.accountId) || { total: 0, published: 0 };
              return `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.03);">
                  <td style="padding:10px 8px; font-weight:600; color:var(--text-main);">@${acc.username}</td>
                  <td style="padding:10px 8px; color:var(--accent);">${accData.total}</td>
                  <td style="padding:10px 8px; color:var(--success); font-weight:600;">${accData.published}</td>
                  <td style="padding:10px 8px;"><span style="color:var(--success); font-size:0.75rem;"><i class="fa-solid fa-circle-check"></i> Ativa</span></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    }

    // Media Breakdown
    const chartEl = document.getElementById('analytics-media-chart');
    if (chartEl && s.mediaTypes) {
      const types = [
        { label: 'Reels', count: s.mediaTypes.reels || 0, color: 'var(--primary)' },
        { label: 'Carrossel', count: s.mediaTypes.carousel || 0, color: 'var(--accent)' },
        { label: 'Fotos', count: s.mediaTypes.image || 0, color: 'var(--success)' },
        { label: 'Stories', count: s.mediaTypes.stories || 0, color: '#A78BFA' }
      ];
      const max = Math.max(...types.map(t => t.count), 1);
      chartEl.innerHTML = types.map(t => `
        <div>
          <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:4px;">
            <span>${t.label}</span>
            <span style="font-weight:700; color:${t.color};">${t.count}</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${Math.round((t.count / max) * 100)}%; background:${t.color};"></div></div>
        </div>
      `).join('');
    }

    // Carregar Heatmap de Melhores Horários (Feature 4)
    loadBestTimesHeatmap();
  } catch (err) {
    console.error('Error rendering analytics:', err);
  }
}

/**
 * 7. TOKEN HEALTH CHECK DIAGNOSTIC
 */
function openHealthCheckModal() {
  const modal = document.getElementById('modal-health-check');
  if (!modal) return;
  modal.style.display = 'flex';
  runHealthCheck();
}

function closeHealthCheckModal() {
  const modal = document.getElementById('modal-health-check');
  if (modal) modal.style.display = 'none';
}

async function runHealthCheck() {
  const resultsContainer = document.getElementById('health-check-results');
  if (!resultsContainer) return;
  resultsContainer.innerHTML = '<div style="text-align:center; padding:2rem;"><div class="spinner"></div><p style="margin-top:1rem; font-size:0.85rem; color:var(--text-dim);">Testando tokens com a Meta Graph API...</p></div>';

  try {
    const res = await fetch(`${API_BASE}/accounts/health-check`);
    const data = await res.json();
    const accounts = data.accounts || [];

    if (accounts.length === 0) {
      resultsContainer.innerHTML = '<p style="color:var(--text-dim); text-align:center; padding:1.5rem;">Nenhuma conta cadastrada para verificar.</p>';
      return;
    }

    resultsContainer.innerHTML = accounts.map(acc => `
      <div style="display:flex; align-items:center; justify-content:space-between; padding:12px 14px; background:rgba(255,255,255,0.03); border:1px solid ${acc.valid ? 'rgba(52,211,153,0.3)' : 'rgba(239,68,68,0.35)'}; border-radius:10px;">
        <div style="display:flex; align-items:center; gap:12px;">
          <div style="width:34px; height:34px; border-radius:50%; background:${acc.valid ? 'rgba(52,211,153,0.15)' : 'rgba(239,68,68,0.15)'}; display:flex; align-items:center; justify-content:center; color:${acc.valid ? 'var(--success)' : 'var(--error)'}; font-size:0.9rem;">
            <i class="fa-solid ${acc.valid ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
          </div>
          <div>
            <div style="font-weight:700; font-size:0.9rem; color:var(--text-main);">@${acc.username}</div>
            <div style="font-size:0.72rem; color:${acc.valid ? 'var(--success)' : 'var(--error)'}; margin-top:2px;">
              ${acc.valid ? 'Token Válido · Permissão de Publicação Ativa' : (acc.error || 'Token expirado')}
            </div>
          </div>
        </div>
        <div>
          ${acc.valid 
            ? `<span style="background:rgba(52,211,153,0.15); color:var(--success); font-size:0.7rem; font-weight:700; padding:3px 8px; border-radius:6px;">60 DIAS (Long-Lived)</span>` 
            : `<a href="/auth/instagram" class="btn btn-sm btn-ghost" style="color:var(--error); border-color:rgba(239,68,68,0.3); font-size:0.72rem;"><i class="fa-solid fa-arrows-rotate"></i> Reconectar</a>`}
        </div>
      </div>
    `).join('');
  } catch (err) {
    resultsContainer.innerHTML = `<p style="color:var(--error); text-align:center; padding:1rem;">Falha ao executar diagnóstico: ${err.message}</p>`;
  }
}

/**
 * 8. DETECTOR DE MELHORES HORÁRIOS POR IA (HEATMAP & GOLDEN HOURS)
 */
async function loadBestTimesHeatmap() {
  const container = document.getElementById('best-times-heatmap-grid');
  const recContainer = document.getElementById('best-times-recommendations');
  const todayContainer = document.getElementById('today-slots-preview');
  if (!container) return;

  const targetAcc = (STATE.filterAccountId && STATE.filterAccountId !== 'all') ? STATE.filterAccountId : '';
  
  try {
    const res = await fetch(`${API_BASE}/accounts/best-times?accountId=${encodeURIComponent(targetAcc)}`);
    const data = await res.json();
    if (!data.success) return;

    STATE.bestTimesData = data;

    // Render 7x24 Matrix
    const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    let gridHtml = `
      <div style="display:grid; grid-template-columns: 45px repeat(24, 1fr); gap: 3px; font-size: 0.65rem; color: var(--text-dim); text-align: center; margin-bottom: 4px;">
        <div></div>
        ${Array.from({ length: 24 }, (_, h) => `<div>${h}h</div>`).join('')}
      </div>
    `;

    data.heatmap.forEach((dayData, dayIdx) => {
      const scores = dayData.scores || [];
      gridHtml += `
        <div style="display:grid; grid-template-columns: 45px repeat(24, 1fr); gap: 3px; align-items:center; margin-bottom: 3px;">
          <div style="font-weight:700; font-size:0.7rem; color:var(--text-secondary); text-align:right; padding-right:6px;">${dayNames[dayIdx]}</div>
          ${scores.map((score, hour) => {
            let bg = 'rgba(255,255,255,0.03)';
            let borderColor = 'rgba(255,255,255,0.05)';
            if (score >= 80) {
              bg = 'rgba(16, 184, 245, 0.85)';
              borderColor = '#10B8F5';
            } else if (score >= 65) {
              bg = 'rgba(16, 184, 245, 0.55)';
            } else if (score >= 45) {
              bg = 'rgba(16, 184, 245, 0.28)';
            } else if (score >= 25) {
              bg = 'rgba(16, 184, 245, 0.12)';
            }
            return `
              <div class="heatmap-cell" 
                   title="${dayNames[dayIdx]} às ${String(hour).padStart(2, '0')}:00 — Engajamento Estimado: ${score}%"
                   style="height: 22px; border-radius: 4px; background: ${bg}; border: 1px solid ${borderColor}; cursor: pointer; transition: transform 0.15s ease;"
                   onmouseover="this.style.transform='scale(1.2)';" 
                   onmouseout="this.style.transform='scale(1)';"
                   onclick="showToast('${dayNames[dayIdx]} às ${String(hour).padStart(2, '0')}:00 — Probabilidade Viral: ${score}%', 'info')">
              </div>
            `;
          }).join('')}
        </div>
      `;
    });

    container.innerHTML = gridHtml;

    // Render Golden Hours cards
    if (recContainer && data.goldenHours) {
      recContainer.innerHTML = data.goldenHours.map(slot => `
        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(16,184,245,0.25); border-radius:10px; padding:12px 14px; display:flex; align-items:center; justify-content:space-between;">
          <div>
            <div style="font-weight:700; font-size:0.92rem; color:var(--text-main); display:flex; align-items:center; gap:8px;">
              <i class="fa-solid fa-clock" style="color:var(--accent);"></i> ${slot.time}
              <span style="font-size:0.7rem; font-weight:700; background:rgba(16,184,245,0.15); color:var(--accent); padding:2px 6px; border-radius:4px;">${slot.label}</span>
            </div>
            <div style="font-size:0.75rem; color:var(--text-dim); margin-top:3px;">
              Janela ideal para engajamento e alcance orgânico
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-weight:800; font-size:1.1rem; color:var(--accent);">${slot.probability || (slot.score ? slot.score + '%' : '95%')}</div>
            <div style="font-size:0.65rem; color:var(--text-dim); text-transform:uppercase; font-weight:700;">Score IA</div>
          </div>
        </div>
      `).join('');
    }

    // Render Today Peak Slots
    const peakSlots = data.todayPeakSlots || data.recommendedSlots || [];
    if (todayContainer && peakSlots.length > 0) {
      todayContainer.innerHTML = peakSlots.map(timeStr => `
        <span style="background:rgba(16,184,245,0.15); color:var(--accent); border:1px solid rgba(16,184,245,0.3); padding:4px 10px; border-radius:8px; font-weight:700; font-size:0.8rem;">
          <i class="fa-solid fa-bolt"></i> ${timeStr}
        </span>
      `).join('');
    }
  } catch (err) {
    console.error('Error loading best times heatmap:', err);
  }
}

async function applyBestTimesToAutoScheduler() {
  const targetAcc = (STATE.filterAccountId && STATE.filterAccountId !== 'all') ? STATE.filterAccountId : (STATE.accounts[0]?.accountId || '');
  if (!targetAcc) return showToast('Nenhuma conta disponível.', 'warning');

  showLoading(true, 'APLICANDO MELHORES HORÁRIOS...');
  try {
    const res = await fetch(`${API_BASE}/accounts/apply-best-times`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: targetAcc })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`Horários de pico aplicados ao agendamento automático! (${data.slots.join(', ')})`, 'success');
      await loadData();
    } else {
      throw new Error(data.error || 'Erro ao aplicar horários');
    }
  } catch (err) {
    showToast(`Erro: ${err.message}`, 'error');
  } finally {
    showLoading(false);
  }
}

async function applyBestTimesToBulk() {
  showLoading(true, 'CALCULANDO HORÁRIOS DE PICO...');
  try {
    const targetAcc = document.getElementById('bulk-account-select')?.value || STATE.activeAccountId || '';
    const res = await fetch(`${API_BASE}/accounts/best-times?accountId=${encodeURIComponent(targetAcc)}`);
    const data = await res.json();
    if (data.todayPeakSlots && data.todayPeakSlots.length > 0) {
      const timeInputs = document.querySelectorAll('.bulk-time-slot');
      data.todayPeakSlots.slice(0, timeInputs.length).forEach((slot, idx) => {
        if (timeInputs[idx]) timeInputs[idx].value = slot;
      });
      showToast(`Horários otimizados pela IA inseridos no Bulk Reels!`, 'success');
    } else {
      showToast('Nenhum horário calculado.', 'info');
    }
  } catch (err) {
    showToast('Falha ao calcular horários: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

/**
 * 9. IMPORTAÇÃO NA NUVEM (GOOGLE DRIVE / DROPBOX)
 */
function openCloudImportModal() {
  const modal = document.getElementById('modal-cloud-import');
  if (modal) {
    document.getElementById('cloud-import-url').value = '';
    document.getElementById('cloud-import-name').value = '';
    modal.style.display = 'flex';
  }
}

function closeCloudImportModal() {
  const modal = document.getElementById('modal-cloud-import');
  if (modal) modal.style.display = 'none';
}

// Inicializar formulário de importação em nuvem
document.addEventListener('DOMContentLoaded', () => {
  const cloudForm = document.getElementById('cloud-import-form');
  if (cloudForm) {
    cloudForm.onsubmit = async (e) => {
      e.preventDefault();
      const rawUrl = document.getElementById('cloud-import-url').value.trim();
      const customName = document.getElementById('cloud-import-name').value.trim();

      if (!rawUrl) return showToast('Cole o link do Google Drive ou Dropbox.', 'warning');

      showLoading(true, 'IMPORTANDO DA NUVEM...');
      try {
        const res = await fetch(`${API_BASE}/drive/import-cloud`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: rawUrl, name: customName })
        });
        const data = await res.json();
        if (res.ok) {
          showToast(`Arquivo "${data.file.filename}" importado para o Acervo com sucesso!`, 'success');
          closeCloudImportModal();
          loadDriveItems();
        } else {
          throw new Error(data.error || 'Erro ao importar arquivo');
        }
      } catch (err) {
        showToast(`Erro na importação: ${err.message}`, 'error');
      } finally {
        showLoading(false);
      }
    };
  }

  // Formulário de conexão de conta Instagram por Link / Token Manual
  const connectLinkForm = document.getElementById('connect-by-link-form');
  if (connectLinkForm) {
    connectLinkForm.onsubmit = async (e) => {
      e.preventDefault();
      const linkOrToken = document.getElementById('ig-link-token-input').value.trim();
      if (!linkOrToken) return showToast('Cole o link ou token do Instagram.', 'warning');

      showLoading(true, 'CONECTANDO CONTA INSTAGRAM...');
      try {
        const res = await fetch(`${API_BASE}/accounts/connect-by-link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkOrToken })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(`Conta @${data.account.username} conectada com sucesso!`, 'success');
          closeConnectByLinkModal();
          await loadData();
        } else {
          throw new Error(data.error || 'Falha ao conectar conta.');
        }
      } catch (err) {
        showToast(`Erro na conexão: ${err.message}`, 'error');
      } finally {
        showLoading(false);
      }
    };
  }
});

/**
 * 10. CONEXÃO INSTAGRAM FORMATO SCALE (LINK & POLLING EM TEMPO REAL)
 * ============================================================
 */
let _igPollInterval = null;
let _initialAccountCount = 0;

async function openConnectInstagramModal() {
  const modal = document.getElementById('modal-connect-instagram');
  if (!modal) return;

  _initialAccountCount = (STATE.accounts || []).length;
  const copyInput = document.getElementById('ig-copy-login-url-input');
  const directBtn = document.getElementById('ig-direct-auth-btn');
  const manualBox = document.getElementById('manual-token-box');
  const manualInput = document.getElementById('ig-manual-token-input');

  if (copyInput) copyInput.value = 'Obtendo link de conexão seguro...';
  if (manualBox) manualBox.style.display = 'none';
  if (manualInput) manualInput.value = '';

  modal.style.display = 'flex';

  try {
    const res = await fetch('/api/auth/instagram-url');
    const data = await res.json();
    if (data.success && data.url) {
      if (copyInput) copyInput.value = data.url;
      if (directBtn) directBtn.href = data.url;
    } else {
      const errMsg = data.error || 'Configure IG_APP_ID e IG_APP_SECRET no servidor.';
      if (copyInput) copyInput.value = errMsg;
    }
  } catch (err) {
    if (copyInput) copyInput.value = 'Erro ao obter link: ' + err.message;
  }

  // Inicia Polling em tempo real (a cada 2.5s) para detectar autorização feita em outro navegador
  if (_igPollInterval) clearInterval(_igPollInterval);
  _igPollInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/data');
      if (!res.ok) return;
      const data = await res.json();
      const newAccounts = data.accounts || [];

      if (newAccounts.length > _initialAccountCount) {
        clearInterval(_igPollInterval);
        _igPollInterval = null;
        closeConnectInstagramModal();
        const latestAccount = newAccounts[newAccounts.length - 1];
        showToast(`🎉 Conta @${latestAccount ? latestAccount.username : 'Instagram'} conectada com sucesso!`, 'success');
        await loadData();
      }
    } catch (e) {
      // Falha silenciosa no polling
    }
  }, 2500);
}

function closeConnectInstagramModal() {
  if (_igPollInterval) {
    clearInterval(_igPollInterval);
    _igPollInterval = null;
  }
  const modal = document.getElementById('modal-connect-instagram');
  if (modal) modal.style.display = 'none';
}

function copyInstagramLoginLink() {
  const input = document.getElementById('ig-copy-login-url-input');
  if (!input || !input.value || !input.value.startsWith('http')) {
    showToast('Link de conexão indisponível no momento.', 'warning');
    return;
  }
  navigator.clipboard.writeText(input.value).then(() => {
    showToast('📋 Link do Instagram copiado! Cole em qualquer outro navegador para conectar.', 'success');
    const btn = document.getElementById('btn-copy-ig-login-link');
    if (btn) {
      const origHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-check"></i> Copiado!';
      setTimeout(() => { btn.innerHTML = origHtml; }, 2000);
    }
  }).catch(() => {
    input.select();
    document.execCommand('copy');
    showToast('Link copiado!', 'success');
  });
}

function shareInstagramLoginWhatsApp() {
  const input = document.getElementById('ig-copy-login-url-input');
  if (!input || !input.value || !input.value.startsWith('http')) {
    showToast('Link indisponível no momento.', 'warning');
    return;
  }
  const msg = encodeURIComponent(`Olá! Por favor, acesse o link oficial do Instagram abaixo para autorizar e conectar sua conta ao painel:\n\n${input.value}`);
  window.open(`https://api.whatsapp.com/send?text=${msg}`, '_blank');
}

function toggleManualTokenBox() {
  const box = document.getElementById('manual-token-box');
  if (box) {
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
  }
}

async function submitManualToken() {
  const input = document.getElementById('ig-manual-token-input');
  const token = input ? input.value.trim() : '';
  if (!token) return showToast('Insira um Access Token válido.', 'warning');

  showLoading(true, 'CONECTANDO TOKEN...');
  try {
    const res = await fetch(`${API_BASE}/accounts/connect-by-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Conta @${data.account.username} conectada com sucesso!`, 'success');
      closeConnectInstagramModal();
      await loadData();
    } else {
      throw new Error(data.error || 'Falha ao validar token.');
    }
  } catch (err) {
    showToast(`Erro na conexão: ${err.message}`, 'error');
  } finally {
    showLoading(false);
  }
}

// Aliases para compatibilidade
function openConnectByLinkModal() { openConnectInstagramModal(); }
function closeConnectByLinkModal() { closeConnectInstagramModal(); }
function openInviteClientModal() { openConnectInstagramModal(); }
function closeInviteClientModal() { closeConnectInstagramModal(); }
function copyInviteClientLink() { copyInstagramLoginLink(); }
function shareInviteWhatsApp() { shareInstagramLoginWhatsApp(); }

/**
 * 11. EDIÇÃO & SINCRONIZAÇÃO DE PERFIL DO INSTAGRAM
 * ============================================================
 */
function openEditAccountModal(accountId) {
  const acc = STATE.accounts.find(a => a.accountId === accountId);
  if (!acc) return showToast('Conta não encontrada.', 'error');

  const modal = document.getElementById('modal-edit-account');
  if (!modal) return;

  document.getElementById('edit-account-id').value = acc.accountId;
  const cleanUser = acc.username.startsWith('instagram_') ? '' : acc.username;
  document.getElementById('edit-account-username').value = cleanUser;
  document.getElementById('edit-account-avatar').value = acc.profilePictureUrl || '';

  updateEditAccountPreview(cleanUser || acc.username, acc.profilePictureUrl);
  modal.style.display = 'flex';
}

function closeEditAccountModal() {
  const modal = document.getElementById('modal-edit-account');
  if (modal) modal.style.display = 'none';
}

function updateEditAccountPreview(username, avatarUrl) {
  const previewUser = document.getElementById('edit-account-preview-user');
  const previewAvatar = document.getElementById('edit-account-preview-avatar');

  if (previewUser) previewUser.innerText = `@${username || 'usuario'}`;
  if (previewAvatar) {
    if (avatarUrl) {
      previewAvatar.innerHTML = `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;">`;
    } else {
      previewAvatar.innerHTML = '<i class="fa-brands fa-instagram"></i>';
    }
  }
}

// Live inputs update preview
document.addEventListener('DOMContentLoaded', () => {
  const userInput = document.getElementById('edit-account-username');
  const avatarInput = document.getElementById('edit-account-avatar');

  if (userInput) {
    userInput.addEventListener('input', () => {
      updateEditAccountPreview(userInput.value.trim().replace(/^@/, ''), avatarInput ? avatarInput.value.trim() : '');
    });
  }
  if (avatarInput) {
    avatarInput.addEventListener('input', () => {
      updateEditAccountPreview(userInput ? userInput.value.trim().replace(/^@/, '') : '', avatarInput.value.trim());
    });
  }

  const editForm = document.getElementById('edit-account-form');
  if (editForm) {
    editForm.onsubmit = async (e) => {
      e.preventDefault();
      const accountId = document.getElementById('edit-account-id').value;
      const username = document.getElementById('edit-account-username').value.trim();
      const avatarUrl = document.getElementById('edit-account-avatar').value.trim();

      if (!username) return showToast('Digite o nome de usuário.', 'warning');

      showLoading(true, 'SALVANDO PERFIL...');
      try {
        const res = await fetch(`${API_BASE}/accounts/update-profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId, username, profilePictureUrl: avatarUrl })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast(`Perfil @${data.account.username} atualizado com sucesso!`, 'success');
          closeEditAccountModal();
          await loadData();
        } else {
          throw new Error(data.error || 'Falha ao salvar perfil.');
        }
      } catch (err) {
        showToast(`Erro: ${err.message}`, 'error');
      } finally {
        showLoading(false);
      }
    };
  }
});

async function syncAccountFromMeta() {
  const accountId = document.getElementById('edit-account-id').value;
  if (!accountId) return;

  const btn = document.getElementById('btn-sync-meta-profile');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sincronizando...';

  try {
    const res = await fetch(`${API_BASE}/accounts/sync-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      document.getElementById('edit-account-username').value = data.username;
      if (data.profilePictureUrl) document.getElementById('edit-account-avatar').value = data.profilePictureUrl;
      updateEditAccountPreview(data.username, data.profilePictureUrl);
      showToast(`Dados sincronizados da Meta: @${data.username}`, 'success');
    } else {
      showToast(data.message || 'Meta não retornou o nome de usuário. Você pode preencher manualmente.', 'info');
    }
  } catch (e) {
    showToast('Erro ao consultar Meta: ' + e.message, 'error');
  } finally {
    if (btn) btn.innerHTML = origHtml;
  }
}


