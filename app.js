/**
 * InstaScheduler AI — Master Frontend Logic
 * ============================================================ */

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
    cloudinaryPreset: ''
  },
  scheduledPosts: [],
  history: [],
  uploadedUrl: '',
  scheduleMode: 'auto'
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
      const input = document.createElement('input');
      input.id = `modal-inp-${inp.id}`;
      input.placeholder = inp.placeholder || '';
      input.type = inp.type || 'text';
      input.className = 'input';
      container.appendChild(input);
    });

    modal.style.display = 'flex';
    container.querySelector('input').focus();

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
  // Check if already logged in
  const token = localStorage.getItem('insta_auth_token');
  const loginScreen = document.getElementById('login-screen');
  
  if (token) {
    // Already logged in - hide login, show dashboard
    loginScreen.style.display = 'none';
    initApp();
  } else {
    // Show login screen
    loginScreen.style.display = 'flex';
  }
  
  // Login form handler
  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const user = document.getElementById('login-user').value;
    const pass = document.getElementById('login-pass').value;
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

function initApp() {
  setupNavigation();
  setupForms();
  setupUIEvents();
  loadData();
  setInterval(loadData, 30000);
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
  document.querySelector(`.nav-item[data-section="${name}"]`).classList.add('active');
  
  // Update Header
  const titles = {
    'dashboard': { t: 'Dashboard', s: 'Acompanhe seus resultados e agendamentos.' },
    'new-post': { t: 'Novo Post', s: 'Crie a próxima publicação viral agora.' },
    'schedule': { t: 'Agendados', s: 'Organize seu calendário de conteúdo.' },
    'settings': { t: 'Configurações', s: 'Gerencie suas conexões e chaves de API.' }
  };
  
  document.getElementById('page-title').innerText = titles[name].t;
  document.getElementById('page-subtitle').innerText = titles[name].s;
  
  // Show/Hide Sections
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(`section-${name}`).classList.add('active');
  
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
    populateAccountSelector();
    renderActiveSection();
  } catch (err) {
    console.error('Sync Error:', err);
  }
}

function renderActiveSection() {
  const n = STATE.activeSection;
  if (n === 'dashboard') renderDashboard();
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
}

function renderSettingsAccounts() {
  const list = document.getElementById('accounts-list-settings');
  if (!list) return;
  
  if (STATE.accounts.length === 0) {
    list.innerHTML = '<p style="color:var(--text-dim); font-size:0.85rem;">Nenhuma conta conectada.</p>';
    return;
  }
  
  list.innerHTML = STATE.accounts.map(acc => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:1rem; background:rgba(255,255,255,0.03); border-radius:14px; border:1px solid var(--glass-border); margin-bottom:0.8rem;">
      <div style="display:flex; align-items:center; gap:12px;">
        <div style="width:36px; height:36px; border-radius:50%; background:linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888); display:flex; align-items:center; justify-content:center; color:white; overflow:hidden;">
          ${acc.profilePictureUrl ? `<img src="${acc.profilePictureUrl}" style="width:100%;height:100%;object-fit:cover;">` : '<i class="fa-brands fa-instagram"></i>'}
        </div>
        <div>
          <div style="font-weight:700; font-size:0.95rem;">@${acc.username}</div>
          <div style="font-size:0.7rem; color:var(--text-dim);">ID: ${acc.accountId}</div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:10px;">
        <span style="font-size:0.6rem; padding:3px 8px; border-radius:6px; background:rgba(16,185,129,0.1); color:var(--success); border:1px solid rgba(16,185,129,0.2); font-weight:800; letter-spacing:0.5px;">ATIVO</span>
        <button class="btn btn-sm btn-ghost btn-delete" onclick="deleteAccount('${acc.accountId}')" style="padding:0.5rem; width:32px; height:32px; color:var(--error); border-color:rgba(239,68,68,0.2);">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    </div>
  `).join('');
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
  const sel = document.getElementById('post-account-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = STATE.accounts.map(a => 
    `<option value="${a.accountId}" ${a.accountId === prev ? 'selected' : ''}>@${a.username}</option>`
  ).join('');
  
  sel.onchange = () => {
    STATE.activeAccountId = sel.value;
    updateHeaderUI();
  };

  if (!prev && STATE.accounts.length > 0) {
    STATE.activeAccountId = STATE.accounts[0].accountId;
    updateHeaderUI();
  }
}

function renderDashboard() {
  const successCount = STATE.history.filter(h => h.status === 'success').length;
  const scheduledCount = STATE.scheduledPosts.length;
  
  const now = new Date();
  const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weeklyCount = STATE.history.filter(h => h.status === 'success' && new Date(h.publishedAt) >= lastWeek).length;
  const weeklyGoal = 7;
  const weeklyPercent = Math.min((weeklyCount / weeklyGoal) * 100, 100);

  document.getElementById('stat-total').innerText = successCount;
  document.getElementById('stat-scheduled').innerText = scheduledCount;
  document.getElementById('stat-accounts').innerText = STATE.accounts.length;
  
  const ptEl = document.getElementById('progress-total');
  if (ptEl) ptEl.style.width = `${Math.min(successCount * 5, 100)}%`;
  const psEl = document.getElementById('progress-scheduled');
  if (psEl) psEl.style.width = `${Math.min(scheduledCount * 10, 100)}%`;

  const next = STATE.scheduledPosts[0];
  if (next) {
    const date = new Date(next.scheduledAt);
    document.getElementById('stat-next-label').innerText = `Próximo: ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
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
    return `
    <div class="activity-item">
      <div style="width:46px; height:46px; border-radius:12px; background:rgba(139,92,246,0.1); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
        <i class="fa-solid ${h.mediaType === 'REELS' ? 'fa-film' : 'fa-image'}" style="color:var(--purple-main);"></i>
      </div>
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
  const postDates = new Set();
  filteredPosts.forEach(p => {
    const d = new Date(p.scheduledAt);
    if (d.getMonth() === month && d.getFullYear() === year) {
      postDates.add(d.getDate());
    }
  });

  let html = '<div class="cal-header">';
  ['DOM','SEG','TER','QUA','QUI','SEX','SÁB'].forEach(d => html += `<div class="cal-header-cell">${d}</div>`);
  html += '</div><div class="cal-grid">';

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = today.getDate() === day && today.getMonth() === month && today.getFullYear() === year;
    const hasPosts = postDates.has(day);
    const classes = ['cal-day'];
    if (isToday) classes.push('today');
    if (hasPosts) classes.push('has-posts');
    html += `<div class="${classes.join(' ')}">${day}</div>`;
  }

  html += '</div>';
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

  container.innerHTML = posts.map(p => {
    const acc = STATE.accounts.find(a => a.accountId === p.accountId);
    const accName = acc ? `@${acc.username}` : p.accountId;
    const date = new Date(p.scheduledAt);
    const dateStr = date.toLocaleDateString('pt-BR', { day:'2-digit', month:'short' });
    const timeStr = date.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
    const thumbUrl = getThumbnailUrl(p.imageUrl);
    const isSelected = STATE.selectedPostIds.includes(p.id);
    
    return `
    <div class="sched-card ${isSelected ? 'selected' : ''}" onclick="${STATE.selectionMode ? `togglePostSelection('${p.id}')` : ''}">
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
        <div style="font-size:0.78rem; color:var(--text-dim); display:flex; align-items:center; gap:6px;">
          <i class="fa-solid fa-calendar"></i> ${dateStr} às ${timeStr}
        </div>
        <div style="display:flex; gap:8px;">
          ${!STATE.selectionMode ? `
            <button class="btn btn-sm btn-ghost btn-delete" onclick="deletePost('${p.id}')" style="font-size:0.7rem; padding:0.5rem 0.8rem; color:var(--error);">
              <i class="fa-solid fa-trash"></i>
            </button>
            <button class="btn btn-sm btn-ghost" onclick="publishNow('${p.id}')" style="font-size:0.7rem; padding:0.5rem 0.8rem;">
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

function calculateNextSlot(lastDate) {
  const SLOTS = [10, 15, 20];
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
          caption: caption || '',
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
  
  const res = await showCustomModal({
    title: 'TRANSFERIR AGENDAMENTOS',
    message: `Mover todos os posts pendentes de @${fromAcc.username} para:`,
    inputs: [{ id: 'targetAccountId', placeholder: 'ID da conta de destino', type: 'text' }]
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

// NEW ACTIONS
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
  
  const res = await showCustomModal({
    title: 'TRANSFERIR AGENDAMENTOS',
    message: `Mover todos os posts pendentes de @${fromAcc.username} para:`,
    inputs: [{ id: 'targetAccountId', placeholder: 'ID da conta de destino', type: 'text' }]
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
      throw new Error(data.error);
    }
  } catch (err) {
    showToast(`Erro: ${err.message}`, 'error');
  } finally {
    showLoading(false);
  }
};

/**
 * 📡 API Helpers
 */
async function uploadToImgbb(file) {
  const fd = new FormData();
  fd.append('image', file);
  const r = await fetch(`https://api.imgbb.com/1/upload?key=${STATE.globalConfig.imgbbKey}`, {
    method: 'POST',
    body: fd
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.data.url;
}

async function uploadToCloudinary(file) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', STATE.globalConfig.cloudinaryPreset);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${STATE.globalConfig.cloudinaryName}/auto/upload`, {
    method: 'POST',
    body: fd
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
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

  // 2. Vincular Sincronização Local
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
}
// Force deploy: 04/04/2026 18:04:07
