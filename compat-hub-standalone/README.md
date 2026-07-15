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

O tier gratuito do Gemini (modelo `gemini-2.5-flash`, com busca) cobre bem mais uso do que uma biblioteca pessoal vai gerar. Confira a disponibilidade e os limites atuais em https://ai.google.dev/gemini-api/docs/pricing — se um dia esse modelo for descontinuado, o único lugar que precisa mudar é a variável `GEMINI_MODEL` no passo 4.

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

## 4. Deploy no Cloudflare Pages

1. Acesse https://dash.cloudflare.com/ → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Selecione o repositório que você acabou de subir
3. Configuração de build:
   - **Framework preset:** Vite
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
4. Antes de clicar em "Save and Deploy", vá em **Environment variables** e adicione:
   - `GEMINI_API_KEY` = a chave que você pegou no passo 1 (marque como **Secret**)
   - (opcional) `GEMINI_MODEL` = `gemini-2.5-flash` (ou outro modelo do free tier, se esse for descontinuado)
5. Clique em Deploy. Em ~1-2 minutos o Cloudflare te dá uma URL tipo `compat-hub.pages.dev`

A pasta `functions/api/` é detectada automaticamente pelo Cloudflare Pages — não precisa configurar nada além da variável de ambiente.

## 5. Confirmar que está tudo funcionando

- Abra a URL do deploy, clique em "Adicionar jogo", adicione um jogo qualquer
- Clique em "Analisar compatibilidade agora"
- Se der erro `GEMINI_API_KEY não configurada`, confirme que salvou a variável de ambiente no passo 4 e refaça o deploy (Cloudflare Pages → seu projeto → Deployments → Retry deployment)

## Sobre custo

Enquanto o uso ficar dentro do tier gratuito do Gemini (na casa de milhares de consultas por mês, bem acima do que uma biblioteca pessoal gera) e do Cloudflare Pages (100 mil requisições/dia), **o custo é zero**. Se algum dia isso mudar de política, o único ponto de ajuste é o arquivo `functions/api/analyze.js` — o resto do app não muda.

## Migrando pra outro host

A arquitetura (frontend estático + 1 function serverless) roda igual em Vercel ou Netlify, só muda:
- Vercel: mover `functions/api/analyze.js` pra `api/analyze.js` e adaptar pro formato de handler do Vercel (`export default async function handler(req, res) {...}`)
- Netlify: mover pra `netlify/functions/analyze.js`, formato `exports.handler = async (event) => {...}`

A lógica interna (montar o prompt, chamar o Gemini, parsear o JSON) é a mesma nos três.
