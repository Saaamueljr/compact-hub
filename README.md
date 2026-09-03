# Compat Hub — versão standalone (grátis)

App de biblioteca de jogos com análise de compatibilidade de hardware via IA.
Nesta versão:

- **Hospedagem:** Cloudflare Pages (free tier)
- **IA + busca:** Google Gemini API (free tier, com Grounding with Google Search)
- **Chave protegida:** fica só no servidor, numa Cloudflare Pages Function (`functions/api/analyze.js`)
- **Progresso salvo:** `localStorage` do navegador (não sincroniza entre dispositivos)

## 1. Pegar uma chave grátis do Gemini

1. Acesse https://aistudio.google.com/apikey
2. Faça login com sua conta Google e clique em "Create API key"
3. Copie a chave — você vai usar no passo 4, **nunca** cole ela no código

O tier gratuito do Gemini (modelos Flash/Flash-Lite com busca) cobre bem mais uso do que uma biblioteca pessoal vai gerar. Se um dia mudar de ideia, o único lugar que precisa mudar é a variável `GEMINI_MODEL` no passo 4.

## 2. Instalar dependências e testar local (opcional)

```bash
npm install
npm run dev
```

Isso sobe só o frontend. Pra testar a function localmente também, use a Wrangler CLI da Cloudflare:

```bash
npm install -g wrangler
wrangler pages dev -- npm run dev
```

## 3. Subir pro GitHub

Crie um repositório novo (pode ser privado) e suba esta pasta:

```bash
git init
git add .
git commit -m "compat hub standalone"
git branch -M main
git remote add origin <URL_DO_SEU_REPO>
git push -u origin main
```

## 4. Deploy no Cloudflare (modelo "Workers" unificado)

1. Acesse https://dash.cloudflare.com/ → **Compute & AI** → **Workers & Pages**
2. Clique em **Create application**
3. Escolha a opção de conectar um repositório Git (**Import a repository** / **Connect to Git**) e selecione o repositório que você subiu
4. Configuração de build:
   - **Build command:** `npm run build`
   - **Deploy command:** deixe o padrão `npx wrangler deploy` (o `wrangler.jsonc` do projeto já diz pra ele servir `dist/` como site estático e usar `worker/index.js` como Worker da API)
   - **Builds for non-production branches:** pode deixar desmarcado — isso só cria URLs de preview pra branches além da `main`, não é necessário agora e não tem custo de qualquer forma
5. Antes de confirmar, vá em **Settings > Variables and Secrets** (pode aparecer só depois do primeiro deploy, tudo bem) e adicione:
   - `GEMINI_API_KEY` = a chave que você pegou no passo 1, marcada como **Secret** (criptografada, nunca visível de novo no painel)
   - (opcional) `GEMINI_MODEL` = `gemini-3.5-flash` (ou outro modelo, se esse for descontinuado)
   - (opcional, só se for usar a integração com RetroAchievements) `RA_USERNAME` = seu usuário no retroachievements.org, tipo **Plaintext**
   - (opcional, só se for usar a integração com RetroAchievements) `RA_API_KEY` = sua Web API Key do RetroAchievements (painel do seu perfil lá, seção "Keys"), marcada como **Secret**
6. Salve e deixe rodar o deploy. Em poucos minutos o Cloudflare te dá uma URL tipo `compat-hub.<seu-subdominio>.workers.dev`

Se você não configurou a variável antes do primeiro deploy, sem problema: adicione depois em Settings > Variables and Secrets e clique em "Retry deployment" (ou aguarde o próximo push) pra ela ser aplicada.

## 5. Confirmar que está tudo funcionando

- Abra a URL do deploy, clique em "Adicionar jogo", adicione um jogo qualquer
- Clique em "Analisar compatibilidade agora"
- Se der erro `GEMINI_API_KEY não configurada`, confirme que salvou a variável no passo 4 e refaça o deploy
- Pra testar o RetroAchievements: abra um jogo que tenha suporte no RA, cole o ID do jogo (número que aparece na URL dele em retroachievements.org) no campo "RetroAchievements" e clique no botão de atualizar — a capa é preenchida automaticamente se o jogo ainda não tiver uma

## Novidades desta versão

- **Análises separadas por perfil de hardware:** cada análise agora guarda qual perfil foi usado. O resultado mostrado é sempre o do perfil ativo no momento; um resumo mostra rapidamente o resultado em outros perfis já testados
- **Capa automática via RetroAchievements:** se o jogo tiver um ID do RA vinculado e ainda não tiver capa manual, a boxart oficial do RA é usada
- **Tradução de conquistas:** botão "Traduzir para português" na seção de conquistas, usando o Gemini. As traduções ficam salvas (não precisa traduzir de novo depois)
- **Campo "Rodando via":** pra anotar qual emulador ou executável você usa pra rodar aquele jogo específico
- **Contador de troféus na grade principal:** aparece embaixo do nome do jogo, sem precisar abrir o detalhe

## Novidades (segunda leva)

- **Abas de perfil no histórico de análises:** dentro do detalhe do jogo, dá pra clicar entre os perfis de hardware pra ver o resultado de cada um lado a lado, sem precisar trocar o perfil ativo no topo
- **Correção importante:** o campo "Rodando via" agora é realmente enviado pro Gemini na hora da análise (antes existia na tela mas não influenciava o resultado — por isso a IA às vezes recomendava contra a versão mais recente de um emulador mesmo quando você ia usar uma versão antiga mais leve). Inclua a versão do emulador nesse campo (ex: "PCSX2 v1.6.0") pra deixar a análise mais precisa
- **Correção de bug:** o ID do RetroAchievements agora salva automaticamente ao sair do campo (antes só salvava se você clicasse no botão de atualizar — se fechasse o card sem clicar, perdia)
- **Nome e ícone do jogo sempre sincronizados com o RetroAchievements**, quando há um ID vinculado
- **"Última vez jogado"** exibido na seção de conquistas, quando disponível. Importante: o RetroAchievements não rastreia "horas jogadas" de forma confiável no PCSX2 (limitação do próprio serviço, não do app) — por isso não implementamos esse contador
- **Franquias:** campo pra marcar a franquia/série de um jogo (ex: "God of War"), com filtro dedicado na tela principal pra maratonar uma série. Jogos com status "Zerado" ganham um selo verde de check na capa, fácil de ver de relance
- **Ícone próprio ao adicionar à tela inicial do celular** (antes aparecia um ícone genérico de letra)

## Sobre custo

Enquanto o uso ficar dentro do tier gratuito do Gemini (na casa de milhares de consultas por mês, bem acima do que uma biblioteca pessoal gera) e do Cloudflare Pages (100 mil requisições/dia), **o custo é zero**. Se algum dia isso mudar de política, o único ponto de ajuste é o arquivo `functions/api/analyze.js` — o resto do app não muda.

## Novidades desta atualização: Google Drive, IGDB, PCGamingWiki e Notícias

### Google Drive (sincronização entre dispositivos)

O app agora sincroniza sua biblioteca (jogos, perfis, notas de franquia) num arquivo `compathub-library.json` guardado na sua própria conta do Google Drive, usando o escopo `drive.file` (o app só enxerga o arquivo que ele mesmo cria — não tem acesso ao resto do seu Drive). Resolução de conflito é **last-write-wins**: entre dois dispositivos editando offline, o salvamento mais recente vence.

**Sobre a sessão ficar conectada:** o login fica salvo em `localStorage`, então fechar e reabrir o app/aba não desconecta mais. O que ainda desconecta é a expiração natural do token do Google (~1h de duração, limitação do fluxo OAuth sem backend usado aqui) — quando isso acontece, o app volta sozinho pro botão "Conectar Drive" sem mostrar erro, é só clicar de novo.

O Client ID OAuth já está embutido em `src/CompatHub.jsx` (constante `GOOGLE_DRIVE_CLIENT_ID`) — ele não é segredo, é feito pra ficar exposto no client-side. Não precisa configurar nada a mais pra essa parte funcionar; só clicar em "Conectar Drive" no app já publicado.

**Importante — origens autorizadas:** no Google Cloud Console, em Credenciais > seu Client ID > "Origens JavaScript autorizadas", confirme que a URL final do seu deploy (ex: `https://compat-hub.SEU-SUBDOMINIO.workers.dev`) está cadastrada. Se você mudar de domínio depois (domínio próprio, por exemplo), adicione a nova origem lá, senão o login do Drive falha com erro de origem não autorizada.

Como a tela de consentimento OAuth está em modo **Teste**, só e-mails cadastrados em "Usuários de teste" (na mesma tela do Google Cloud Console) conseguem fazer login — isso é intencional pra um app de uso pessoal, não precisa publicar/verificar o app.

### IGDB (capas, sinopse, gêneros, jogos parecidos)

Endpoint novo: `/api/igdb?name=NOME_DO_JOGO`. Pra ativar, gere credenciais grátis em duas etapas:

1. Acesse https://dev.twitch.tv/console/apps → **Register Your Application**
2. Nome: qualquer um. Categoria: "Application Integration". OAuth Redirect URL: `https://localhost` (não é usado nesse fluxo, mas o campo é obrigatório)
3. Copie o **Client ID** gerado e clique em "New Secret" pra gerar o **Client Secret**
4. No painel do Cloudflare (Settings > Variables and Secrets), adicione:
   - `IGDB_CLIENT_ID` = o Client ID (Plaintext)
   - `IGDB_CLIENT_SECRET` = o Client Secret (Secret)

Sem essas duas variáveis, o endpoint responde com erro claro em vez de quebrar o resto do app.

### PCGamingWiki (dados técnicos)

Endpoint novo: `/api/pcgamingwiki?name=NOME_EXATO_DA_PAGINA`. Não precisa de chave — é uma consulta pública à extensão Cargo do MediaWiki deles. O `name` precisa bater com o título exato da página no PCGamingWiki (ex: "Cyberpunk 2077"); nomes muito diferentes do título oficial não retornam resultado.

### Notícias (`/api/news`)

Agrega RSS da IGN, Eurogamer e Steam num painel estilo revista (manchete grande + grid de cards), acessível pelo botão "Notícias" no topo do app. Não precisa de nenhuma chave — é leitura pública de RSS. Se uma das três fontes cair ou mudar de URL, as outras continuam funcionando normalmente (falha isolada por fonte, não derruba o painel inteiro).

**Tradução automática:** essas fontes publicam em inglês, então o Worker manda título + resumo de cada notícia pro Gemini traduzir pro português numa única chamada em lote (mesma `GEMINI_API_KEY` que você já configurou pra análise de compatibilidade — não precisa de nenhuma chave nova). Nomes próprios de jogos/empresas e termos técnicos (patch, DLC, framerate) são mantidos como estão. Se o Gemini falhar por qualquer motivo, o painel mostra as notícias no idioma original em vez de quebrar.

### Screenshots na tela de detalhe (via IGDB)

Assim que `IGDB_CLIENT_ID`/`IGDB_CLIENT_SECRET` estiverem configurados (ver seção do IGDB acima), a tela de detalhe de cada jogo passa a carregar uma galeria de screenshots automaticamente, com clique pra abrir em tela cheia. Se o IGDB não tiver aquele jogo ou as credenciais ainda não estiverem configuradas, a seção simplesmente não aparece — não gera erro visível.

## Migrando pra outro host

A arquitetura (frontend estático + 1 Worker que também serve a API) roda igual em Vercel ou Netlify, só muda onde fica o código do backend:
- Vercel: crie `api/analyze.js` no formato de handler do Vercel (`export default async function handler(req, res) {...}`) usando a mesma lógica de `worker/index.js`
- Netlify: crie `netlify/functions/analyze.js`, formato `exports.handler = async (event) => {...}`

A lógica interna (montar o prompt, chamar o Gemini, parsear o JSON) é a mesma em qualquer um dos três.
