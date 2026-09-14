# Legendas e hashtags com AIsa

Em Configurações → Inteligência artificial, cole a chave, clique em **Salvar chave da IA** e depois em **Validar conexão**. Salvar não significa validar: somente uma geração real bem-sucedida confirma a conexão. A validação e a geração consomem créditos da AIsa.

A chave é guardada no banco do servidor, não é devolvida pela API de dados e não deve ser adicionada ao Git. Como alternativa, `AISA_API_KEY` pode ser definida no ambiente do servidor; nesse caso a edição pelo painel fica desabilitada. `AISA_MODEL` permite trocar o modelo; o padrão é `gpt-4.1`.

O botão **Gerar com IA** está disponível na biblioteca, no formulário de nova publicação, nos Reels em massa e nos formulários de legenda/hashtags. Informe o tema, escolha o tom e gere uma legenda, hashtags ou ambos. O conteúdo pode ser editado antes de aplicar à publicação ou salvar na biblioteca. A geração usa apenas a descrição textual: não analisa arquivos nem publica automaticamente.

Integração: [documentação oficial da AIsa](https://aisa.one/docs/guides/getting-started-with-aisa), endpoint `https://api.aisa.one/v1/chat/completions`. Respostas inválidas, erros de credenciais, saldo/limites e indisponibilidade produzem mensagens específicas. Há limite de uma solicitação a cada cinco segundos e uma geração por vez no servidor.

A prévia visual (`npm run preview`) não armazena chaves e não chama serviços pagos. Salvar e validar a chave funciona no aplicativo com o servidor normal (`npm start`), após entrar na conta.
