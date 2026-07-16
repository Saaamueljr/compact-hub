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
- Pra testar o RetroAchievements: abra um jogo que tenha suporte no RA, cole o ID do jogo (número que aparece na URL dele em retroachievements.org) no campo "RetroAchievements" e clique no botão de atualizar

## Sobre custo

Enquanto o uso ficar dentro do tier gratuito do Gemini (na casa de milhares de consultas por mês, bem acima do que uma biblioteca pessoal gera) e do Cloudflare Pages (100 mil requisições/dia), **o custo é zero**. Se algum dia isso mudar de política, o único ponto de ajuste é o arquivo `functions/api/analyze.js` — o resto do app não muda.

## Migrando pra outro host

A arquitetura (frontend estático + 1 Worker que também serve a API) roda igual em Vercel ou Netlify, só muda onde fica o código do backend:
- Vercel: crie `api/analyze.js` no formato de handler do Vercel (`export default async function handler(req, res) {...}`) usando a mesma lógica de `worker/index.js`
- Netlify: crie `netlify/functions/analyze.js`, formato `exports.handler = async (event) => {...}`

A lógica interna (montar o prompt, chamar o Gemini, parsear o JSON) é a mesma em qualquer um dos três.
