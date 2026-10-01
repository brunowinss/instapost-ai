# Publicação no YouTube

A publicação de vídeos/Shorts no YouTube usa a **YouTube Data API v3**, com OAuth do Google. Diferente do Instagram, o fluxo de autorização é feito direto pelo painel (aba **YouTube**), sem precisar colar token manualmente.

## 1. Criar o client OAuth no Google Cloud Console

1. Acesse [console.cloud.google.com](https://console.cloud.google.com/) e crie um projeto (ou use um existente).
2. Em **APIs e serviços → Biblioteca**, ative a **YouTube Data API v3**.
3. Em **Tela de permissão OAuth**: tipo *Externo*, preencha nome e e-mail. Enquanto o app estiver em modo *Teste*, adicione os e-mails das contas Google donas dos canais em **Usuários de teste** (o acesso de um app em teste vence a cada 7 dias e a autorização precisa ser refeita).
4. Em **Credenciais → Criar credenciais → ID do cliente OAuth**, escolha o tipo **"Aplicativo da Web"** (diferente do app de automação local, que usa "App para computador" — aqui o servidor já fica online, então o Google precisa de um `redirect_uri` fixo, não de loopback).
5. Em **URIs de redirecionamento autorizados**, cadastre exatamente: `https://seudominio.com/auth/youtube/callback` (troque pelo seu domínio real).
6. Copie o **Client ID** e o **Client Secret**.

## 2. Configurar no `.env` do servidor

```env
YOUTUBE_CLIENT_ID=seu-client-id.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=seu-client-secret
YOUTUBE_REDIRECT_URI=https://seudominio.com/auth/youtube/callback
```

No Render, defina as três variáveis no painel do serviço (igual a `IG_APP_ID`/`IG_APP_SECRET`).

## 3. Conectar um canal

Na aba **YouTube** do painel, clique em **Conectar canal** → autorize com a conta Google do canal → o canal aparece na lista. É possível conectar vários canais.

## 4. Como funciona a publicação

- O upload acontece quando o agendador do painel (o mesmo que publica no Instagram) percebe que o horário marcado já passou — não usa o agendamento nativo do YouTube (`publishAt`). O vídeo sobe e é publicado como **público** na hora.
- Título e descrição vêm da legenda do post: a primeira linha é o título, o resto é a descrição. `#hashtags` na legenda também são enviadas como tags do vídeo.
- Para Shorts, o painel adiciona `#Shorts` na descrição e a tag `Shorts` automaticamente.

## 5. Limites importantes (regras do próprio YouTube, não deste app)

- **Cota de upload:** 100 vídeos por dia por canal (separada da cota geral de 10.000 unidades/dia da API).
- **Vídeo travado como privado:** canais vinculados a um app OAuth sem auditoria do Google podem ter os vídeos enviados pela API travados como privados automaticamente, mesmo pedindo `público`. Para resolver, é preciso passar pela [auditoria de compliance](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits) do Google e publicar o app OAuth (verificação).
- **Token de teste:** com o app OAuth em modo *Teste*, o acesso de cada canal vence a cada 7 dias — reconecte o canal na aba YouTube quando isso acontecer.
