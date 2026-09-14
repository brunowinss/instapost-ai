// Generated content remains a draft until the user applies or saves it.
(() => {
  let target = null;
  let busy = false;
  const dialog = document.createElement('dialog');
  dialog.className = 'ai-dialog';
  dialog.innerHTML = `
    <form id="ai-generation-form">
      <div class="ai-heading"><h2>Legendas e hashtags com IA</h2><button type="button" class="btn btn-ghost" id="ai-close" aria-label="Fechar gerador">×</button></div>
      <p class="stat-desc">Conte o que aparece no post. A IA usa sua descrição; não analisa o vídeo ou a imagem.</p>
      <label class="label" for="ai-topic">Sobre o que é a publicação?</label>
      <textarea class="input" id="ai-topic" rows="4" minlength="3" maxlength="2000" required placeholder="Ex.: bastidores da preparação de um cappuccino na nossa cafeteria"></textarea>
      <div class="ai-fields">
        <div><label class="label" for="ai-tone">Tom da legenda</label><select class="input" id="ai-tone"><option value="natural">Natural</option><option value="professional">Profissional</option><option value="fun">Descontraído</option><option value="sales">Vendas</option></select></div>
        <div><label class="label" for="ai-kind">O que gerar</label><select class="input" id="ai-kind"><option value="both">Legenda e hashtags</option><option value="caption">Só legenda</option><option value="hashtags">Só hashtags</option></select></div>
      </div>
      <p class="stat-desc">Cada geração usa créditos da sua conta AIsa. Revise o resultado antes de usar.</p>
      <button type="submit" class="btn btn-primary" id="ai-generate">Gerar com IA</button>
      <p id="ai-message" role="status" aria-live="polite"></p>
    </form>
    <div id="ai-result" hidden>
      <label class="label" for="ai-caption-result">Legenda — você pode editar</label><textarea class="input" id="ai-caption-result" rows="5" maxlength="1500"></textarea>
      <label class="label" for="ai-tags-result">Hashtags — você pode editar</label><textarea class="input" id="ai-tags-result" rows="2" maxlength="500"></textarea>
      <div class="ai-actions"><button class="btn btn-primary" id="ai-apply">Usar nesta publicação</button><button class="btn btn-ghost" id="ai-save-caption">Salvar legenda na biblioteca</button><button class="btn btn-ghost" id="ai-save-tags">Salvar hashtags na biblioteca</button></div>
    </div>`;
  document.body.append(dialog);
  const el = id => document.getElementById(id);
  const message = text => { el('ai-message').textContent = text; };
  async function api(route, body) {
    const response = await fetch('/api/ai/' + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível concluir.');
    return data;
  }
  function open(input) {
    if (busy) return;
    target = input;
    el('ai-kind').value = input?.id === 'hashtag-tags-input' ? 'hashtags' : 'both';
    el('ai-apply').hidden = !input;
    if (!busy) { el('ai-result').hidden = true; message(''); }
    dialog.showModal();
    el('ai-topic').focus();
  }
  el('ai-close').onclick = () => dialog.close();
  el('ai-generation-form').onsubmit = async e => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    el('ai-generate').disabled = true;
    el('ai-result').hidden = true;
    message('Criando seu conteúdo…');
    try {
      const data = await api('generate', { topic: el('ai-topic').value.trim(), tone: el('ai-tone').value, kind: el('ai-kind').value });
      el('ai-caption-result').value = data.caption;
      el('ai-tags-result').value = data.hashtags.join(' ');
      el('ai-save-caption').disabled = !data.caption;
      el('ai-save-tags').disabled = !data.hashtags.length;
      el('ai-result').hidden = false;
      message('Pronto! Revise ou edite o texto abaixo.');
    } catch (err) { message(err.message); }
    finally { busy = false; el('ai-generate').disabled = false; }
  };
  el('ai-apply').onclick = () => {
    if (!target) return;
    const caption = el('ai-caption-result').value.trim();
    const tags = el('ai-tags-result').value.trim();
    // When generating hashtags only, keep the caption the user already wrote.
    target.value = target.id === 'hashtag-tags-input' ? tags : [caption || target.value.trim(), tags].filter(Boolean).join('\n\n');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    dialog.close();
  };
  async function save(kind, button) {
    const text = el(kind === 'captions' ? 'ai-caption-result' : 'ai-tags-result').value.trim();
    if (!text) return message('Preencha o texto antes de salvar.');
    button.disabled = true;
    const title = el('ai-topic').value.trim().slice(0, 80);
    try {
      const response = await fetch('/api/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(kind === 'captions' ? { title, text, tag: 'IA' } : { name: title, tags: text }) });
      if (!response.ok) throw new Error('Não foi possível salvar na biblioteca.');
      message('Salvo na biblioteca.');
      if (kind === 'captions') loadCaptionsList(); else loadHashtagsList();
    } catch (err) { button.disabled = false; message(err.message); }
  }
  el('ai-save-caption').onclick = e => save('captions', e.currentTarget);
  el('ai-save-tags').onclick = e => save('hashtags', e.currentTarget);
  for (const id of ['post-caption', 'bulk-caption-input', 'caption-text-input', 'hashtag-tags-input']) {
    const input = el(id);
    if (!input) continue;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'btn btn-ghost ai-trigger'; button.textContent = '✦ Gerar com IA';
    button.onclick = () => open(input);
    input.before(button);
  }
  const libraryButton = document.createElement('button');
  libraryButton.type = 'button'; libraryButton.className = 'btn btn-primary ai-trigger'; libraryButton.textContent = '✦ Criar legendas e hashtags com IA';
  libraryButton.onclick = () => open(null);
  el('section-captions').prepend(libraryButton);

  const settings = document.createElement('div');
  settings.className = 'card';
  settings.innerHTML = `<h3 class="card-title">Inteligência artificial · AIsa</h3><p class="stat-desc" id="ai-key-status" role="status" aria-live="polite">Configure sua chave para gerar legendas e hashtags.</p><form id="ai-key-form"><label class="label" for="ai-key">Chave API AIsa</label><input class="input" type="password" id="ai-key" autocomplete="off" placeholder="Cole sua chave AIsa" required><p class="stat-desc">A chave é salva no servidor e não é exibida novamente. Para trocar, cole e salve a nova chave.</p><button class="btn btn-primary" type="submit">Salvar chave da IA</button></form><button type="button" class="btn btn-ghost" id="ai-validate" style="margin-top:12px">Validar conexão</button><p class="stat-desc">A validação faz uma pequena geração real e usa créditos da AIsa. O resultado confirma a conexão no momento do teste.</p>`;
  document.querySelector('.settings-grid').append(settings);
  async function status() {
    try {
      const data = await api('status');
      el('ai-key-status').textContent = data.configured ? 'Chave salva. Clique em Validar conexão para testar.' : 'Nenhuma chave salva. Adicione sua chave para começar.';
      el('ai-validate').disabled = !data.configured;
      el('ai-key-form').hidden = !!data.managedByEnvironment;
    } catch (err) { el('ai-key-status').textContent = err.message; el('ai-validate').disabled = true; }
  }
  document.querySelector('[data-section="settings"]').addEventListener('click', status);
  el('ai-key-form').onsubmit = async e => {
    e.preventDefault();
    const button = e.currentTarget.querySelector('button'); button.disabled = true;
    try { await api('key', { apiKey: el('ai-key').value.trim() }); el('ai-key').value = ''; await status(); }
    catch (err) { el('ai-key-status').textContent = err.message; }
    finally { button.disabled = false; }
  };
  el('ai-key').addEventListener('input', () => {
    el('ai-validate').disabled = true;
    el('ai-key-status').textContent = 'Salve a chave antes de validar a conexão.';
  });
  el('ai-validate').disabled = true;
  el('ai-validate').onclick = async () => {
    const button = el('ai-validate');
    button.disabled = true;
    el('ai-key').disabled = true;
    el('ai-key-form').querySelector('button').disabled = true;
    el('ai-key-status').textContent = 'Validando com a AIsa…';
    try {
      const data = await api('validate', {});
      el('ai-key-status').textContent = data.valid ? '✓ Validada — a AIsa respondeu ao teste com sucesso.' : 'Não foi possível validar a chave.';
    } catch (err) { el('ai-key-status').textContent = 'Não validada: ' + err.message; }
    finally { button.disabled = false; el('ai-key').disabled = false; el('ai-key-form').querySelector('button').disabled = false; }
  };
})();
