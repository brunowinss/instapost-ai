/**
 * InstaScheduler AI — Master Frontend Logic
 * ============================================================ */

const STATE = {
  activeSection: 'dashboard',
  accounts: [],
  activeAccountId: '',
  globalConfig: {
    imgbbKey: '',
    cloudinaryName: '',
    cloudinaryPreset: ''
  },
  scheduledPosts: [],
  history: [],
  uploadedUrl: ''
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
        if (e.key === 'Enter') btnConfirm.onclick();
    };
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupForms();
  setupUIEvents();
  await loadData();
  
  // Real-time synchronization
  setInterval(loadData, 30000);
});

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

function renderSettingsAccounts() {
  const list = document.getElementById('accounts-list-settings');
  if (!list) return;
  
  if (STATE.accounts.length === 0) {
    list.innerHTML = '<p style="color:var(--text-dim); font-size:0.85rem;">Nenhuma conta conectada.</p>';
    return;
  }
  
  list.innerHTML = STATE.accounts.map(acc => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:1rem; background:rgba(255,255,255,0.03); border-radius:14px; border:1px solid var(--glass-border);">
      <div style="display:flex; align-items:center; gap:12px;">
        <div style="width:32px; height:32px; border-radius:50%; background:linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888);"></div>
        <div style="font-weight:700; font-size:0.9rem;">@${acc.username}</div>
      </div>
      <span style="font-size:0.65rem; padding:4px 8px; border-radius:6px; background:rgba(16,185,129,0.1); color:var(--success); border:1px solid currentColor; font-weight:800;">ATIVO</span>
    </div>
  `).join('');
}

function updateHeaderUI() {
  const authStatus = document.getElementById('auth-status');
  const accountName = document.getElementById('active-account-name');
  
  const activeAcc = STATE.accounts.find(a => a.accountId === STATE.activeAccountId);
  
  if (activeAcc) {
    authStatus.style.background = 'var(--success)';
    authStatus.style.boxShadow = '0 0 10px var(--success)';
    accountName.innerText = `@${activeAcc.username}`;
  } else {
    authStatus.style.background = 'var(--error)';
    authStatus.style.boxShadow = '0 0 10px var(--error)';
    accountName.innerText = 'Login Pendente';
  }
}

function renderDashboard() {
  const successCount = STATE.history.filter(h => h.status === 'success').length;
  const scheduledCount = STATE.scheduledPosts.length;
  
  // Weekly Goal Calculation (last 7 days)
  const now = new Date();
  const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weeklyCount = STATE.history.filter(h => h.status === 'success' && new Date(h.publishedAt) >= lastWeek).length;
  const weeklyGoal = 7;
  const weeklyPercent = Math.min((weeklyCount / weeklyGoal) * 100, 100);

  document.getElementById('stat-total').innerText = successCount;
  document.getElementById('stat-scheduled').innerText = scheduledCount;
  
  // Update progress bars
  document.getElementById('progress-total').style.width = `${Math.min(successCount * 5, 100)}%`;
  document.getElementById('progress-scheduled').style.width = `${Math.min(scheduledCount * 10, 100)}%`;

  // Update Weekly Goal UI
  const goalCard = document.querySelector('#section-dashboard .card:last-child');
  if (goalCard) {
    const goalText = goalCard.querySelector('div[style*="font-size:3rem"]');
    if (goalText) goalText.innerText = `${weeklyCount}/${weeklyGoal}`;
    const goalFill = goalCard.querySelector('.progress-fill');
    if (goalFill) goalFill.style.width = `${weeklyPercent}%`;
  }

  const next = STATE.scheduledPosts[0];
  if (next) {
    const date = new Date(next.scheduledAt);
    document.getElementById('stat-next-label').innerText = `Próximo: ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    document.getElementById('stat-next-label').innerText = 'Sem agendamentos';
  }
    
  // Render activity list with thumbnails
  const list = document.getElementById('recent-activity-list');
  if (STATE.history.length === 0) {
    list.innerHTML = '<p style="text-align:center; padding:3rem; color:var(--text-dim);">Silêncio total por aqui...</p>';
    return;
  }
  
  list.innerHTML = STATE.history.slice(0, 5).map(h => `
    <div class="activity-item">
      <img src="${h.imageUrl || 'https://via.placeholder.com/60'}" class="activity-thumb" onerror="this.src='https://cdn-icons-png.flaticon.com/512/174/174855.png'">
      <div class="activity-info">
        <div style="font-weight:700; font-size:0.95rem; margin-bottom:4px;">${h.caption ? h.caption.substring(0, 35) + '...' : 'Publicação sem legenda'}</div>
        <div style="font-size:0.75rem; color:var(--text-dim); display:flex; align-items:center; gap:6px;">
          <i class="fa-solid fa-calendar-day"></i> ${new Date(h.publishedAt).toLocaleString()}
        </div>
      </div>
      <span class="activity-status" style="background:${h.status === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'}; color:${h.status === 'success' ? 'var(--success)' : 'var(--error)'}; border:1px solid currentColor;">${h.status}</span>
    </div>
  `).join('');
}

function renderScheduleGrid() {
  const container = document.getElementById('scheduled-posts-container');
  if (STATE.scheduledPosts.length === 0) {
    container.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:4rem; color:var(--text-dim);"><i class="fa-solid fa-calendar-xmark" style="font-size:3rem; margin-bottom:1rem; opacity:0.3;"></i><p>Nada agendado para o futuro.</p></div>';
    return;
  }
  
  container.innerHTML = STATE.scheduledPosts.map(p => `
    <div class="card" style="padding:0; overflow:hidden;">
      <div style="height:200px; overflow:hidden; position:relative;">
        <img src="${p.imageUrl}" style="width:100%; height:100%; object-fit:cover;">
        <div style="position:absolute; top:10px; right:10px; padding:4px 10px; border-radius:8px; background:rgba(0,0,0,0.6); backdrop-filter:blur(5px); font-size:0.7rem; font-weight:700;">${p.mediaType}</div>
      </div>
      <div style="padding:1.5rem;">
        <p style="font-size:0.9rem; margin-bottom:1rem; height:45px; overflow:hidden;">${p.caption}</p>
        <div style="display:flex; align-items:center; gap:8px; font-size:0.8rem; font-weight:600; color:var(--purple-main); margin-bottom:1.5rem;">
          <i class="fa-solid fa-clock"></i> ${new Date(p.scheduledAt).toLocaleString()}
        </div>
        <button class="btn btn-ghost" style="width:100%; font-size:0.85rem;" onclick="publishNow('${p.id}')">
          <i class="fa-solid fa-paper-plane"></i> POSTAR AGORA
        </button>
      </div>
    </div>
  `).join('');
}

function setupForms() {
  // File Upload Handling
  const fileInput = document.getElementById('file-input');
  const dropzone = document.getElementById('dropzone');
  
  dropzone.onclick = () => fileInput.click();
  
  fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    showLoading(true, 'ENVIANDO MÍDIA...');
    
    try {
      const type = document.querySelector('.btn-media.active').dataset.type;
      let url;
      
      if (type === 'IMAGE') {
        if (!STATE.globalConfig.imgbbKey) throw new Error('API Key do ImgBB faltando!');
        url = await uploadToImgbb(file);
      } else {
        if (!STATE.globalConfig.cloudinaryPreset) throw new Error('Cloudinary Preset faltando!');
        url = await uploadToCloudinary(file);
      }
      
      STATE.uploadedUrl = url;
      updatePreview(url, type);
      showToast('UPLOAD CONCLUÍDO!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      showLoading(false);
    }
  };

  // Type Selector
  document.querySelectorAll('.btn-media').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.btn-media').forEach(b => b.classList.remove('active', 'btn-ghost'));
      btn.classList.add('active');
      document.querySelectorAll('.btn-media:not(.active)').forEach(b => b.classList.add('btn-ghost'));
    };
  });

  // Post Submission
  document.getElementById('post-form').onsubmit = async (e) => {
    e.preventDefault();
    if (!STATE.uploadedUrl) return showToast('Selecione uma imagem primeiro!', 'warning');
    
    const date = document.getElementById('post-date').value;
    const time = document.getElementById('post-time').value;
    if (!date || !time) return showToast('Defina a data e hora!', 'warning');
    
    const post = {
      id: `post_${Date.now()}`,
      accountId: STATE.activeAccountId,
      mediaType: document.querySelector('.btn-media.active').dataset.type,
      imageUrl: STATE.uploadedUrl,
      caption: document.getElementById('post-caption').value,
      scheduledAt: new Date(`${date}T${time}`).toISOString()
    };
    
    showLoading(true, 'AGENDANDO...');
    try {
      const res = await fetch(`${API_BASE}/save-post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(post)
      });
      if (!res.ok) throw new Error('Erro ao salvar no servidor.');
      
      showToast('AGENDAMENTO REALIZADO!', 'success');
      switchSection('schedule');
      await loadData();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      showLoading(false);
    }
  };

  // Settings Save
  document.getElementById('settings-form').onsubmit = async (e) => {
    e.preventDefault();
    const config = {
      imgbbKey: document.getElementById('imgbb-key-input').value,
      cloudinaryName: document.getElementById('cloudinary-name-input').value,
      cloudinaryPreset: document.getElementById('cloudinary-preset-input').value
    };
    
    showLoading(true, 'SALVANDO...');
    try {
      const res = await fetch(`${API_BASE}/save-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      
      if (!res.ok) throw new Error('Falha ao salvar no banco de dados.');
      
      STATE.globalConfig = config;
      showToast('CONFIGURAÇÕES SALVAS!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      showLoading(false);
    }
  };
}

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

function updatePreview(url, type) {
  const box = document.getElementById('preview-image-box');
  const preview = document.getElementById('file-preview');
  const container = document.getElementById('file-preview-container');
  
  if (type === 'IMAGE') {
    box.innerHTML = `<img src="${url}" style="width:100%; height:100%; object-fit:cover; border-radius:12px;">`;
    preview.src = url;
    container.style.display = 'block';
  } else {
    box.innerHTML = `<video src="${url}" autoplay muted loop style="width:100%; height:100%; object-fit:cover; border-radius:12px;"></video>`;
    container.style.display = 'none';
  }
}

async function publishNow(id) {
  const post = STATE.scheduledPosts.find(p => p.id === id);
  if (!post) return;
  
  showLoading(true, 'PUBLICANDO AGORA...');
  try {
    const res = await fetch(`${API_BASE}/publish-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao publicar.');
    
    showToast('POST PUBLICADO!', 'success');
    await loadData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    showLoading(false);
  }
}

function setupUIEvents() {
  document.getElementById('btn-add-account').onclick = async () => {
    const result = await showCustomModal({
      title: 'CONECTAR NOVA CONTA',
      message: 'Insira o ID da conta e o Token de Acesso da Meta para sincronizar.',
      inputs: [
        { id: 'accountId', placeholder: 'Instagram Business Account ID', type: 'text' },
        { id: 'token', placeholder: 'User Access Token (Meta)', type: 'password' }
      ]
    });
    
    if (!result || !result.accountId || !result.token) return;

    showLoading(true, 'CONECTANDO COM A META...');
    try {
      const { accountId, token } = result;
      // Fetch username automatically to avoid manual typing
      const baseUrl = token.startsWith('IGAA') ? 'https://graph.instagram.com/v21.0' : 'https://graph.facebook.com/v21.0';
      const r = await fetch(`${baseUrl}/${accountId}?fields=username&access_token=${token}`);
      const data = await r.json();
      
      if (data.error) throw new Error(`Falha na Meta: ${data.error.message}`);
      if (!data.username) throw new Error('Campo "username" não retornado pela API.');

      showToast(`CONTA @${data.username} ENCONTRADA!`, 'info');
      await saveAccount(accountId, data.username, token);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      showLoading(false);
    }
  };

  document.getElementById('btn-sync-local').onclick = async () => {
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
  
  document.getElementById('post-caption').oninput = (e) => {
    document.getElementById('preview-caption').innerText = e.target.value || 'Sua legenda aparecerá aqui.';
  };
}

async function saveAccount(accountId, username, accessToken) {
  showLoading(true, 'CONECTANDO...');
  try {
    const res = await fetch(`${API_BASE}/save-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, username, accessToken })
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
