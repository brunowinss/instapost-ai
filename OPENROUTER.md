# Legendas e hashtags com OpenRouter

A geração de legendas e hashtags utiliza a API do **[OpenRouter](https://openrouter.ai)**.

## 1. Obter a chave de API

1. Acesse [openrouter.ai/keys](https://openrouter.ai/keys) (ou [openrouter.ai/workspaces/default/keys](https://openrouter.ai/workspaces/default/keys)).
2. Crie uma nova chave de API (o formato começa com `sk-or-v1-...`).
3. Certifique-se de que sua conta possui créditos para uso da API (o OpenRouter possui modelos rápidos e econômicos como `openai/gpt-4o-mini`, `google/gemini-2.0-flash-001` ou gratuitos como `meta-llama/llama-3.3-70b-instruct:free`).

## 2. Configurar na aplicação

Existem duas formas de configurar sua chave:

### Pelo Painel (Recomendado)
1. Abra o painel do sistema e acesse **Configurações → Inteligência artificial**.
2. Cole a chave de API (`sk-or-v1-...`).
3. Clique em **Salvar e validar**.
4. O sistema testará a conexão imediatamente e exibirá a confirmação de validação.

### Por Variável de Ambiente (`.env`)
No arquivo `.env` do servidor:
```env
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=openai/gpt-4o-mini
```

## 3. Como usar

O botão **✦ Gerar com IA** está disponível em:
- Criação de nova publicação (legenda).
- Publicações em massa (Reels).
- Biblioteca de legendas e hashtags.

Informe sobre o que é a publicação, selecione o tom desejado e clique em **Gerar com IA**.
