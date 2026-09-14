# Legendas e hashtags com IA (OpenRouter)

Em Configurações → Inteligência artificial, cole a sua chave do OpenRouter (`sk-or-v1-...`) e clique em **Salvar e validar**. O sistema salva e inicia o teste automaticamente. Somente uma geração real bem-sucedida confirma a conexão; em caso de falha, a tela informa que a chave foi salva mas não validada. Use **Validar conexão** para repetir o teste. A validação e a geração consomem créditos do OpenRouter.

A chave é guardada no banco do servidor, não é devolvida pela API de dados e não deve ser adicionada ao Git. Como alternativa, `OPENROUTER_API_KEY` pode ser definida no ambiente do servidor; nesse caso a edição pelo painel fica desabilitada. `OPENROUTER_MODEL` permite trocar o modelo; o padrão é `openai/gpt-4o-mini`.

O botão **Gerar com IA** está disponível na biblioteca, no formulário de nova publicação, nos Reels em massa e nos formulários de legenda/hashtags. Informe o tema, escolha o tom e gere uma legenda, hashtags ou ambos. O conteúdo pode ser editado antes de aplicar à publicação ou salvar na biblioteca. A geração usa apenas a descrição textual: não analisa arquivos nem publica automaticamente.

Integração: [OpenRouter](https://openrouter.ai/keys), endpoint `https://openrouter.ai/api/v1/chat/completions`. Respostas inválidas, erros de credenciais, saldo/limites e indisponibilidade produzem mensagens específicas. Há limite de uma solicitação a cada cinco segundos e uma geração por vez no servidor.

A prévia visual (`npm run preview`) não armazena chaves e não chama serviços pagos. Salvar e validar a chave funciona no aplicativo com o servidor normal (`npm start`), após entrar na conta.

