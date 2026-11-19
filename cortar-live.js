/**
 * Cortar live — conversa com o aplicativo Cortador aberto no PC (http://127.0.0.1:47653).
 *
 * Sem o aplicativo (ex.: aberto só pelo navegador), a tela fica bloqueada e oferece o download.
 * Com o aplicativo: mostra as lives, os cortes (o vídeo vem direto do PC) e agenda nas contas
 * escolhidas. O app recebe o login do site ao abrir esta tela, então não precisa digitar senha.
 */
const CL_APP = 'http://127.0.0.1:47653';
const CL = { conectado: false, aba: 'prontos', timer: null, cfgCarregada: false, versao: '', lista: [], mostrando: 0 };

async function clFetch(caminho, corpo) {
  const init = corpo === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo)
  };
  init.signal = AbortSignal.timeout(corpo === undefined ? 4000 : 600000);
  const r = await fetch(CL_APP + caminho, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || `o aplicativo respondeu ${r.status}`);
  return j;
}

const clEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Verifica se o aplicativo está aberto e libera/bloqueia a tela e o cadeado do menu. */
async function clVerificarApp(manual) {
  let ok = false;
  try {
    const p = await clFetch('/api/ping');
    ok = p.app === 'cortador';
    CL.versao = p.versao || '';
  } catch { ok = false; }

  const mudou = ok !== CL.conectado;
  CL.conectado = ok;
  const cadeado = document.getElementById('cl-nav-lock');
  if (cadeado) cadeado.style.display = ok ? 'none' : '';
  clMostrarBotoesDePublicacao(ok);
  if (STATE.activeSection !== 'cortar-live') return ok;

  document.getElementById('cl-bloqueado').style.display = ok ? 'none' : '';
  document.getElementById('cl-app').style.display = ok ? '' : 'none';
  if (!ok) {
    const nota = document.getElementById('cl-nota-navegador');
    if (nota) nota.textContent = manual
      ? 'Ainda não encontramos o aplicativo. Confira se a janela do Cortador está aberta no seu PC (e permita o acesso à rede local, se o navegador pedir).'
      : 'Pelo navegador sem o aplicativo, esta função fica bloqueada.';
    return ok;
  }
  if (mudou || manual) {
    await clVincular();
    CL.cfgCarregada = false;
  }
  document.getElementById('cl-versao').textContent = CL.versao ? `versão ${CL.versao}` : '';
  await clAtualizar();
  return ok;
}

/** Entrega o login do site para o app poder agendar sozinho (sem digitar senha). */
async function clVincular() {
  const token = localStorage.getItem('insta_auth_token');
  if (!token) return;
  try { await clFetch('/api/vincular', { token, url: location.origin }); } catch (e) { console.warn('Cortador: vincular', e); }
}

function renderCortarLiveSection() {
  clVerificarApp(false);
  clearInterval(CL.timer);
  CL.timer = setInterval(() => {
    if (STATE.activeSection === 'cortar-live') clVerificarApp(false);
    else clearInterval(CL.timer);
  }, 5000);
}

async function clAtualizar() {
  let est;
  try { est = await clFetch('/api/estado'); } catch { return; }

  // Botão geral Ligar / Parar cortador
  const ligado = est.cortador_ligado !== false;
  CL.ligado = ligado;
  const btn = document.getElementById('cl-ligar');
  btn.className = 'btn ' + (ligado ? 'cl-btn-parar' : 'btn-primary');
  btn.innerHTML = ligado ? '<i class="fa-solid fa-stop"></i> Parar cortador' : '<i class="fa-solid fa-play"></i> Ligar cortador';

  // Status grande: dá pra saber na hora se está cortando ou não
  const canais = est.canais || [];
  const gravando = canais.filter(c => c.status === 'gravando');
  const ativos = canais.filter(c => c.ativo).length;
  let estado, titulo, sub;
  if (!ligado) {
    estado = 'parado'; titulo = '⏸ Cortador parado';
    sub = 'Nenhuma live está sendo gravada. Clique em Ligar cortador para começar.';
  } else if (gravando.length) {
    estado = 'cortando'; titulo = `🔴 CORTANDO AGORA — ${gravando.length} live${gravando.length > 1 ? 's' : ''}`;
    sub = 'Gravando: ' + gravando.map(c => c.nome_bonito).join(', ');
  } else if (!ativos) {
    estado = 'parado'; titulo = '⏸ Nenhum canal ligado';
    sub = 'Ligue pelo menos um canal em Lives monitoradas.';
  } else {
    estado = 'esperando'; titulo = '🟡 Ligado, esperando live';
    sub = `${ativos} canal(is) ligado(s); nenhum está ao vivo no GTA 6 agora. Começa sozinho quando entrarem.`;
  }
  document.getElementById('cl-barra').dataset.estado = estado;
  document.getElementById('cl-status-titulo').textContent = titulo;
  document.getElementById('cl-status-sub').textContent = sub;

  // Lives (cada uma com o botão Monitorar)
  document.getElementById('cl-canais').innerHTML = (est.canais || []).map(c => `
    <div class="cl-canal ${c.ativo ? '' : 'cl-off'}">
      <span class="cl-bola ${c.status === 'gravando' ? 'on' : ''}"></span>
      <div style="min-width:0; flex:1;">
        <b>${clEsc(c.nome_bonito)}</b> <span class="cl-plat">${clEsc(c.plataforma)}</span>
        <small>${c.status === 'gravando' ? '🔴 gravando e cortando — ' + clEsc(c.titulo || '') : clEsc(c.status)}</small>
      </div>
      <label class="cl-switch" title="${c.ativo ? 'Monitorando — clique para desligar' : 'Desligado — clique para monitorar'}">
        <input type="checkbox" ${c.ativo ? 'checked' : ''} onchange="clMonitorar('${clEsc(c.chave)}', this.checked)">
        <span></span>
      </label>
      <button type="button" class="cl-lixo" title="Abrir a pasta de cortes de ${clEsc(c.nome_bonito)} no PC" onclick="clFetch('/api/abrir', { canal: '${clEsc(c.nome_bonito)}' })"><i class="fa-solid fa-folder-open"></i></button>
      <button type="button" class="cl-lixo" title="Remover da lista" onclick="clRemoverCanal('${clEsc(c.chave)}', '${clEsc(c.nome_bonito)}')"><i class="fa-solid fa-trash-can"></i></button>
    </div>`).join('') || '<span class="cl-dim">Nenhum canal na lista. Adicione abaixo.</span>';

  // Contadores
  const n = est.contagens || {};
  document.getElementById('cl-n-prontos').textContent = n.prontos ?? 0;
  document.getElementById('cl-n-rascunhos').textContent = n.rascunhos ?? 0;
  document.getElementById('cl-n-agendados').textContent = n.agendados ?? 0;

  // Log
  const log = document.getElementById('cl-log');
  const noFim = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.innerHTML = (est.log || []).map(l => `<div><span>${clEsc(l.t)} [${clEsc(l.canal)}]</span> ${clEsc(l.msg)}</div>`).join('');
  if (noFim) log.scrollTop = log.scrollHeight;
  if (est.erro_agendador) document.getElementById('cl-msg-ag').innerHTML = `<span style="color:var(--error)">⚠ ${clEsc(est.erro_agendador)}</span>`;

  // Configuração de agendamento (só na primeira vez, para não apagar o que você está editando)
  if (!CL.cfgCarregada) {
    CL.cfgCarregada = true;
    const cfg = est.cfg_site || {};
    clRenderContas(new Set((cfg.contas || []).map(String)));
    document.getElementById('cl-horarios').value = (cfg.horarios || ['12:00', '18:00', '21:00']).join(', ');
    document.getElementById('cl-auto').checked = !!cfg.agendar_automatico;
    clCarregarCortes();
  }
}

async function clLigarCortador() {
  const ligar = !CL.ligado;
  if (!ligar && !confirm('Parar o cortador? Todas as lives param de ser gravadas até você ligar de novo.')) return;
  try { await clFetch('/api/cortador', { ligado: ligar }); } catch (e) { alert(e.message); }
  clAtualizar();
}

async function clMonitorar(chave, ativo) {
  try { await clFetch('/api/canais', { acao: 'monitorar', chave, ativo }); } catch (e) { alert(e.message); }
  clAtualizar();
}

async function clRemoverCanal(chave, nome) {
  if (!confirm(`Remover ${nome} da lista? Os cortes já feitos continuam salvos.`)) return;
  try { await clFetch('/api/canais', { acao: 'remover', chave }); } catch (e) { alert(e.message); }
  clAtualizar();
}

async function clAdicionarCanal() {
  const msg = document.getElementById('cl-msg-canal');
  try {
    await clFetch('/api/canais', {
      acao: 'adicionar',
      plataforma: document.getElementById('cl-add-plat').value,
      usuario: document.getElementById('cl-add-usuario').value,
      nome: document.getElementById('cl-add-nome').value
    });
    document.getElementById('cl-add-usuario').value = '';
    document.getElementById('cl-add-nome').value = '';
    msg.innerHTML = '<span style="color:var(--success)">Canal adicionado e já sendo monitorado.</span>';
  } catch (e) {
    msg.innerHTML = `<span style="color:var(--error)">${clEsc(e.message)}</span>`;
  }
  clAtualizar();
}

function clRenderContas(selecionadas) {
  const grupos = [
    ['instagram', 'fa-brands fa-instagram', STATE.accounts || []],
    ['facebook', 'fa-brands fa-facebook', STATE.facebookAccounts || []],
    ['youtube', 'fa-brands fa-youtube', STATE.youtubeAccounts || []],
  ];
  const html = grupos.flatMap(([plat, icone, contas]) => contas.map(a => `
    <label class="cl-check">
      <input type="checkbox" value="${clEsc(a.accountId)}" ${selecionadas.has(String(a.accountId)) ? 'checked' : ''}>
      <i class="${icone}"></i> ${clEsc(a.username || a.accountId)} <span class="cl-plat">${plat === 'youtube' ? 'Shorts' : 'Reels'}</span>
    </label>`)).join('');
  document.getElementById('cl-contas').innerHTML = html || '<span class="cl-dim">Conecte uma conta em Contas / Canais / Páginas.</span>';
}

async function clSalvarAgendamento() {
  const contas = [...document.querySelectorAll('#cl-contas input:checked')].map(i => i.value);
  const horarios = document.getElementById('cl-horarios').value.split(/[,;\s]+/).map(h => h.trim()).filter(Boolean)
    .map(h => (h.length === 4 ? '0' + h : h));
  const msg = document.getElementById('cl-msg-ag');
  try {
    await clFetch('/api/salvar_site', { contas, horarios, agendar_automatico: document.getElementById('cl-auto').checked });
    msg.innerHTML = `<span style="color:var(--success)">Salvo: ${contas.length} conta(s), horários ${clEsc(horarios.join(', '))}.</span>`;
  } catch (e) {
    msg.innerHTML = `<span style="color:var(--error)">${clEsc(e.message)}</span>`;
  }
}

function clTrocarAba(tipo) {
  CL.aba = tipo;
  document.querySelectorAll('.cl-aba').forEach(b => b.classList.toggle('active', b.dataset.tipo === tipo));
  clCarregarCortes();
}

async function clCarregarCortes() {
  const grade = document.getElementById('cl-cortes');
  const dicas = {
    prontos: 'Cortes já com legenda e card. Clique em Agendar. "Agendar sozinho" vale só para os cortes editados de agora em diante.',
    rascunhos: 'Cortes que o aplicativo fez e ainda não têm legenda e card. Peça a edição ao Claude.',
    agendados: 'Cortes já enviados e agendados nas suas contas.'
  };
  document.getElementById('cl-dica').textContent = dicas[CL.aba];
  grade.innerHTML = '<span class="cl-dim">Carregando…</span>';
  let r;
  try { r = await clFetch('/api/cortes?tipo=' + CL.aba); } catch (e) { grade.innerHTML = `<span style="color:var(--error)">${clEsc(e.message)}</span>`; return; }
  CL.lista = r.cortes || [];
  CL.mostrando = 0;
  grade.innerHTML = '';
  if (!CL.lista.length) { grade.innerHTML = '<span class="cl-dim">Nenhum corte aqui ainda.</span>'; return; }
  clMostrarMais();
}

/** Mostra 24 cortes por vez: com muitos cortes, carregar todos de uma vez travava a página. */
function clMostrarMais() {
  const grade = document.getElementById('cl-cortes');
  document.getElementById('cl-mais')?.remove();
  const lote = CL.lista.slice(CL.mostrando, CL.mostrando + 24);
  CL.mostrando += lote.length;
  grade.insertAdjacentHTML('beforeend', lote.map(clCartao).join(''));
  if (CL.mostrando < CL.lista.length) {
    grade.insertAdjacentHTML('beforeend', `<button type="button" id="cl-mais" class="btn btn-ghost" style="grid-column:1/-1;" onclick="clMostrarMais()">
      Carregar mais (${CL.lista.length - CL.mostrando} restantes)</button>`);
  }
}

/** Troca a miniatura pelo vídeo só quando você clica (vídeo é pesado). */
function clTocar(el, src) {
  const v = document.createElement('video');
  v.src = src; v.controls = true; v.autoplay = true; v.playsInline = true;
  el.replaceWith(v);
}

function clCartao(c) {
  return `
    <div class="cl-corte" id="cl-c-${clEsc(c.id)}">
      <div class="cl-thumb" onclick="clTocar(this, '${CL_APP}${clEsc(c.video)}')" title="Assistir">
        <img src="${CL_APP}${clEsc(c.thumb)}" loading="lazy" decoding="async" alt="">
        <span class="cl-play"><i class="fa-solid fa-play"></i></span>
      </div>
      <div class="cl-info">
        <div class="cl-canal-nome">${clEsc(c.canal)}</div>
        ${c.faixa ? `<div class="cl-faixa">${clEsc(c.faixa)}</div>` : ''}
        ${c.titulo ? `<div class="cl-titulo">${clEsc(c.titulo)}</div>` : `<div class="cl-dim">${clEsc(c.fala || 'sem fala transcrita')}</div>`}
        ${c.agendado ? `<div class="cl-agendado">✔ ${c.agendado.map(a => clEsc(`${a.plataforma} @${a.conta} ${a.quando}`)).join(' · ')}</div>` : ''}
        ${CL.aba === 'prontos' ? `<button type="button" class="btn btn-primary btn-sm" onclick="clAgendar('${clEsc(c.id)}', this)"><i class="fa-solid fa-calendar-plus"></i> Agendar</button>` : ''}
      </div>
    </div>`;
}

async function clAgendar(id, botao) {
  botao.disabled = true;
  botao.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enviando e agendando…';
  try {
    const r = await clFetch('/api/agendar', { id });
    const lista = (r.agendamentos || []).map(a => `${a.plataforma} @${a.conta} ${a.quando}`).join(' · ');
    botao.outerHTML = `<div class="cl-agendado">✔ ${clEsc(lista)}</div>`;
    if (typeof loadData === 'function') loadData();
    if (typeof showToast === 'function') showToast('Corte agendado!', 'success');
  } catch (e) {
    botao.disabled = false;
    botao.innerHTML = '<i class="fa-solid fa-calendar-plus"></i> Agendar';
    alert('Não foi possível agendar: ' + e.message);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * "Escolher dos cortes prontos" nas telas de publicação (Instagram, Facebook,
 * YouTube, Várias redes, Acervo). Só aparece com o aplicativo aberto no PC.
 * Os cortes escolhidos entram na tela como se você tivesse enviado o arquivo,
 * e a tela agenda do jeito que ela já agenda.
 * ───────────────────────────────────────────────────────────────────────── */
const CL_TELAS = ['file-input', 'bulk-file-input', 'crosspost-file-input', 'youtube-file-input',
  'youtube-bulk-file-input', 'facebook-file-input', 'facebook-bulk-file-input', 'drive-file-input'];

function clInstalarBotoesDePublicacao() {
  CL_TELAS.forEach(id => {
    const input = document.getElementById(id);
    if (!input || document.getElementById(`cl-pick-${id}`)) return;
    const ancora = input.closest('.dropzone') || input.parentElement;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `cl-pick-${id}`;
    btn.className = 'btn btn-ghost btn-sm cl-pick-btn';
    btn.style.display = 'none';
    btn.innerHTML = '<i class="fa-solid fa-scissors"></i> Escolher dos cortes prontos';
    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); clAbrirSeletor(input); };
    ancora.insertAdjacentElement('afterend', btn);
  });
}

function clMostrarBotoesDePublicacao(ok) {
  document.querySelectorAll('.cl-pick-btn').forEach(b => { b.style.display = ok ? '' : 'none'; });
}

async function clAbrirSeletor(input) {
  const unico = !input.multiple;
  let lista;
  try { lista = (await clFetch('/api/cortes?tipo=prontos')).cortes || []; }
  catch (e) { alert('Não consegui falar com o aplicativo: ' + e.message); return; }
  lista.sort((a, b) => (a.usado ? 1 : 0) - (b.usado ? 1 : 0));

  const fundo = document.createElement('div');
  fundo.className = 'cl-modal-fundo';
  fundo.innerHTML = `
    <div class="cl-modal" role="dialog" aria-modal="true" aria-label="Escolher cortes prontos">
      <div class="cl-modal-topo">
        <b><i class="fa-solid fa-scissors"></i> Cortes prontos ${unico ? '(escolha 1)' : '(escolha quantos quiser)'}</b>
        <button type="button" class="cl-lixo" data-fechar aria-label="Fechar"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <p class="cl-dim" style="margin:0 0 10px;">O nome de cada arquivo já é a legenda com hashtags. Os já usados aparecem no fim.</p>
      <div class="cl-modal-grade">${lista.map(c => `
        <label class="cl-pick">
          <input type="${unico ? 'radio' : 'checkbox'}" name="cl-pick" value="${clEsc(c.id)}">
          <img src="${CL_APP}${clEsc(c.thumb)}" loading="lazy" alt="">
          ${c.usado ? '<span class="cl-usado">já usado</span>' : ''}
          <span class="cl-pick-txt">${clEsc(c.faixa || c.titulo)}</span>
        </label>`).join('') || '<span class="cl-dim">Nenhum corte pronto ainda.</span>'}
      </div>
      <div class="cl-modal-rodape">
        <span class="cl-dim" id="cl-pick-status"></span>
        <button type="button" class="btn btn-ghost btn-sm" data-fechar>Cancelar</button>
        <button type="button" class="btn btn-primary btn-sm" id="cl-pick-ok"><i class="fa-solid fa-check"></i> Usar selecionados</button>
      </div>
    </div>`;
  document.body.appendChild(fundo);
  const fechar = () => fundo.remove();
  fundo.querySelectorAll('[data-fechar]').forEach(b => b.onclick = fechar);
  fundo.addEventListener('click', e => { if (e.target === fundo) fechar(); });

  fundo.querySelector('#cl-pick-ok').onclick = async () => {
    const ids = [...fundo.querySelectorAll('input[name="cl-pick"]:checked')].map(i => i.value);
    if (!ids.length) return;
    const ok = fundo.querySelector('#cl-pick-ok');
    const status = fundo.querySelector('#cl-pick-status');
    ok.disabled = true;
    try {
      const dt = new DataTransfer();
      for (let i = 0; i < ids.length; i++) {
        const c = lista.find(x => x.id === ids[i]);
        status.textContent = `Pegando ${i + 1} de ${ids.length} do seu PC…`;
        const r = await fetch(CL_APP + c.video);
        if (!r.ok) throw new Error('o aplicativo não entregou o vídeo ' + (c.faixa || c.id));
        const blob = await r.blob();
        dt.items.add(new File([blob], c.arquivo || `${c.id}.mp4`, { type: 'video/mp4' }));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      clFetch('/api/marcar_usado', { ids }).catch(() => {});
      fechar();
      if (typeof showToast === 'function') showToast(`${ids.length} corte(s) adicionado(s). Agora é só agendar.`, 'success');
    } catch (e) {
      ok.disabled = false;
      status.textContent = '';
      alert(e.message);
    }
  };
}

// Instala os botões e mantém o cadeado/botões certos mesmo fora da tela Cortar live.
document.addEventListener('DOMContentLoaded', () => {
  clInstalarBotoesDePublicacao();
  setTimeout(() => clVerificarApp(false), 1500);
  setInterval(() => { if (STATE.activeSection !== 'cortar-live') clVerificarApp(false); }, 15000);
});
