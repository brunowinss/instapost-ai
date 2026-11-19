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

  // Lives
  document.getElementById('cl-canais').innerHTML = (est.canais || []).map(c => `
    <div class="cl-canal">
      <span class="cl-bola ${c.status === 'gravando' ? 'on' : ''}"></span>
      <div style="min-width:0;">
        <b>${clEsc(c.nome_bonito || c.nome)}</b> <span class="cl-plat">${clEsc(c.plataforma || '')}</span>
        <small>${c.status === 'gravando' ? '🔴 gravando e cortando — ' + clEsc(c.titulo || '') : clEsc(c.status || 'aguardando')}</small>
      </div>
    </div>`).join('') || '<span class="cl-dim">Nenhum canal configurado no aplicativo.</span>';

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

// O cadeado do menu já aparece certo desde o início.
document.addEventListener('DOMContentLoaded', () => setTimeout(() => clVerificarApp(false), 1500));
