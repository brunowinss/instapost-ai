# Publicação em Páginas do Facebook

A aba **Facebook** publica **texto, fotos e vídeos** em Páginas que você administra, na hora ou agendado (inclusive nos horários inteligentes). Usa o **mesmo app da Meta** do Instagram, com o produto *Login do Facebook para Empresas*.

## O que precisa estar configurado

**No app da Meta** (painel de desenvolvedores):
1. Produto **Login do Facebook para Empresas** adicionado.
2. Em *Configurações → URIs de redirecionamento do OAuth válidos*, o endereço `https://SEU-DOMINIO/auth/facebook/callback`.
3. Em *Configurações* (do produto), uma **configuração** de login com token de acesso do usuário e as permissões `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` e `publish_video`. O ID dela vai em `FACEBOOK_CONFIG_ID`.

**No servidor (Render):**

| Variável | O que é |
|---|---|
| `FACEBOOK_APP_ID` | ID do app da Meta (o do app, não o "ID do app do Instagram") |
| `FACEBOOK_APP_SECRET` | Chave secreta do app (Configurações do app → Básico). Se ausente, usa `APP_SECRET` |
| `FACEBOOK_CONFIG_ID` | ID da configuração de login criada acima |
| `FACEBOOK_REDIRECT_URI` | Opcional; por padrão `<seu domínio>/auth/facebook/callback` |

## Conectar uma Página

Aba **Facebook → Conectar Página** → entre com a conta que administra a Página e **marque as Páginas** que quer conectar. O painel guarda o token de cada Página (não vence) e nunca o envia para o navegador.

## Limites importantes

- **Modo de desenvolvimento:** com o app em desenvolvimento, só quem tem função no app (administrador, desenvolvedor, testador) consegue conectar e publicar. Para Páginas de outras pessoas é preciso passar o app para o modo ao vivo, com revisão de permissões e verificação da empresa pela Meta.
- **Perfil pessoal não funciona:** a API da Meta só publica em Páginas.
- **Vídeo:** a Meta processa o vídeo depois do envio; ele pode levar alguns minutos para aparecer na Página.
- **Reels em Página** ainda não estão incluídos (têm um fluxo de envio próprio).
- Se a Meta devolver erro de token (código 190), reconecte a Página na aba Facebook.
