// Worker principal (modelo unificado do Cloudflare, substitui o antigo
// functions/api/*.js do Pages). Duas responsabilidades:
// 1. Requisições pra /api/analyze -> chama o Gemini com a chave secreta
// 2. Qualquer outra requisição -> serve os arquivos estáticos de dist/ (via env.ASSETS)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Modelo padrão e um modelo de reserva pra quando o padrão está sobrecarregado
// (erro 503) — ajustável via env.GEMINI_MODEL / env.GEMINI_FALLBACK_MODEL se
// algum deles for descontinuado no futuro.
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const FALLBACK_GEMINI_MODEL = "gemini-2.5-flash";

// Chamada única ao Gemini, com toda a lógica de resiliência num lugar só:
// - 429 (cota de busca excedida) -> tenta de novo sem grounding
// - 503/500 (sobrecarga momentânea) -> até 2 retentativas com backoff curto
// - 503 persistente -> troca pro modelo de reserva antes de desistir
// - extrai e faz parse do JSON da resposta (objeto ou array)
async function callGeminiJSON(env, { systemInstruction, userPrompt, temperature = 0.4, allowGrounding = true }) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 500, error: "GEMINI_API_KEY não configurada no servidor (Settings > Variables and Secrets)." };
  }

  const primaryModel = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const fallbackModel = env.GEMINI_FALLBACK_MODEL || FALLBACK_GEMINI_MODEL;

  function buildUrl(model) {
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  }

  async function attempt(model, useGrounding) {
    const body = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature },
    };
    if (useGrounding) body.tools = [{ google_search: {} }];
    return fetch(buildUrl(model), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  let response;
  let usedGrounding = allowGrounding;
  let usedModel = primaryModel;
  let fellBackFromQuota = false;
  let fellBackFromOverload = false;

  try {
    response = await attempt(primaryModel, allowGrounding);

    // Cota de busca excedida — tenta de novo sem grounding, mesmo modelo.
    if (response.status === 429 && allowGrounding) {
      usedGrounding = false;
      fellBackFromQuota = true;
      response = await attempt(primaryModel, false);
    }

    // Sobrecarga momentânea (503) ou erro transiente (500) — algumas
    // retentativas rápidas com backoff antes de trocar de modelo.
    let retries = 0;
    const delays = [400, 1000];
    while ((response.status === 503 || response.status === 500) && retries < delays.length) {
      await sleep(delays[retries]);
      response = await attempt(primaryModel, usedGrounding);
      retries += 1;
    }

    // Ainda sobrecarregado depois das retentativas — troca pro modelo de
    // reserva antes de desistir de vez.
    if (response.status === 503 && fallbackModel && fallbackModel !== primaryModel) {
      fellBackFromOverload = true;
      usedModel = fallbackModel;
      response = await attempt(fallbackModel, usedGrounding);
    }
  } catch (e) {
    return { ok: false, status: 502, error: `Falha ao contatar o Gemini: ${e.message}` };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    const friendly =
      response.status === 503
        ? "O Gemini está sobrecarregado no momento (erro 503 do lado da Google). Tente de novo em alguns minutos."
        : `Gemini retornou erro ${response.status}: ${errText.slice(0, 300)}`;
    return { ok: false, status: 502, error: friendly };
  }

  const data = await response.json();
  const candidate = (data.candidates || [])[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("\n").trim();
  if (!text) return { ok: false, status: 502, error: "O Gemini não retornou texto na resposta." };

  const cleaned = text.replace(/^```json\s*|```$/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return { ok: false, status: 502, error: "Não foi possível interpretar a resposta do Gemini como JSON." };
      }
    } else {
      return { ok: false, status: 502, error: "Não foi possível interpretar a resposta do Gemini como JSON." };
    }
  }

  return { ok: true, data: parsed, usedGrounding, fellBackFromQuota, fellBackFromOverload, usedModel };
}

async function handleAnalyze(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Corpo da requisição inválido." }, 400);
  }

  const { profile, game, notesText, platformLabel } = payload || {};
  if (!profile || !game || !game.name) {
    return json({ error: "Faltam dados do jogo ou do perfil de hardware." }, 400);
  }

  const systemInstruction = `Você é um analisador técnico de compatibilidade de jogos de PC. Avalie se o jogo informado roda bem nesta configuração:

CPU: ${profile.cpu}
GPU: ${profile.gpu}
RAM: ${profile.ram}
Sistema operacional: ${profile.os}

Preferências gerais do usuário: ${profile.preferences || "não informado"}

Considere sempre:
- Se a CPU não suporta AVX/AVX2 (comum em CPUs de até ~2011 como Core 2 Quad), jogos que exigem essas instruções não vão abrir, não importa a GPU.
- Se a GPU tem pouca VRAM, jogos de ~2016 em diante (remasters/remakes inclusos) costumam sofrer stutter, pop-in de textura ou travamento mesmo em configuração baixa quando a VRAM mínima recomendada é maior que a disponível.
- Remasters/remakes recentes de jogos antigos costumam ter requisitos bem mais altos que a versão original.
- Use a busca quando precisar confirmar requisitos mínimos/recomendados atualizados, principalmente para jogos recentes ou pouco conhecidos.
- Leve em conta o histórico de problemas já relatados e os objetivos do usuário para este jogo, se houver.
- IMPORTANTE sobre emuladores: se o usuário especificar qual emulador (e principalmente qual VERSÃO do emulador) vai usar, baseie sua análise NESSA versão específica, não na versão mais recente. Emuladores mais antigos costumam ser mais leves e compatíveis com hardware fraco/sem AVX, mesmo quando versões recentes do mesmo emulador pesam mais ou exigem instruções que a CPU não tem. Não presuma que o usuário vai usar a última versão a menos que ele diga isso.

Responda SOMENTE com um JSON válido, sem nenhum texto antes ou depois, sem markdown, sem crases, no formato exato:
{
  "tier": <1 a 6, sendo 6 excelente e 1 não roda>,
  "tierLabel": "Excelente|Bom|OK|Jogável|Ruim|Não roda",
  "veredito": "uma frase direta",
  "motivo": "2 a 3 frases explicando o porquê, citando CPU/GPU/VRAM quando relevante",
  "configuracaoRecomendada": "sugestão curta de configuração gráfica",
  "avisos": ["aviso curto, se houver"]
}

Escala de tier:
6 = Excelente (roda liso, configuração alta)
5 = Bom (roda bem, configuração média/alta)
4 = OK (roda de forma estável, configuração média/baixa, sem grandes ressalvas)
3 = Jogável (roda, mas capenga — quedas de fps frequentes, precisa abrir mão de bastante coisa, ou só funciona com ajustes/patches não oficiais)
2 = Ruim (abre e roda, mas a experiência é ruim a ponto de não valer a pena — travamentos constantes, fps muito baixo)
1 = Não roda (trava na tela de carregamento, crash constante, ou requisito mínimo que a configuração simplesmente não atende)`;

  const userPrompt = `Jogo: ${game.name}
Plataforma: ${platformLabel || "não informado"}
Rodando via (emulador/executável especificado pelo usuário): ${game.runningVia || "não especificado"}
Histórico de problemas registrados para este jogo: ${notesText || "nenhum registrado ainda"}
Objetivos do usuário para este jogo: ${game.goals || "nenhum especificado"}`;

  const result = await callGeminiJSON(env, { systemInstruction, userPrompt, temperature: 0.4 });
  if (!result.ok) return json({ error: result.error }, result.status);

  return json({
    ...result.data,
    usedGrounding: result.usedGrounding,
    fellBackFromQuota: result.fellBackFromQuota,
    fellBackFromOverload: result.fellBackFromOverload,
  });
}

// Igual ao handleAnalyze, mas pra um LOTE de jogos numa chamada só —
// usado na importação em massa via planilha (ver BulkImportModal no
// front). Sem grounding (busca): com dezenas de jogos por lote, permitir
// grounding deixaria a resposta lenta/instável demais pra pouco ganho de
// precisão. Cada jogo do lote é referenciado por índice (0..n-1) — mais
// seguro que casar por nome, que pode vir levemente diferente na resposta.
async function handleAnalyzeBatch(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Corpo da requisição inválido." }, 400);
  }

  const { profile, games, platformLabel } = payload || {};
  if (!profile || !Array.isArray(games) || games.length === 0) {
    return json({ error: "Faltam os jogos ou o perfil de hardware." }, 400);
  }
  if (games.length > 30) {
    return json({ error: "Lote grande demais (máximo 30 jogos por chamada)." }, 400);
  }

  const systemInstruction = `Você é um analisador técnico de compatibilidade de jogos de PC. Avalie CADA jogo da lista informada nesta configuração:

CPU: ${profile.cpu}
GPU: ${profile.gpu}
RAM: ${profile.ram}
Sistema operacional: ${profile.os}

Preferências gerais do usuário: ${profile.preferences || "não informado"}

Considere sempre:
- Se a CPU não suporta AVX/AVX2 (comum em CPUs de até ~2011 como Core 2 Quad), jogos que exigem essas instruções não vão abrir, não importa a GPU.
- Se a GPU tem pouca VRAM, jogos de ~2016 em diante (remasters/remakes inclusos) costumam sofrer stutter, pop-in de textura ou travamento mesmo em configuração baixa quando a VRAM mínima recomendada é maior que a disponível.
- Remasters/remakes recentes de jogos antigos costumam ter requisitos bem mais altos que a versão original.
- Baseie-se no seu conhecimento de requisitos de sistema; não há busca disponível nesta chamada em lote, então seja conservador quando não tiver certeza.

Responda SOMENTE com um JSON válido (array), sem texto antes ou depois, sem markdown, sem crases. Um item por jogo da lista, NA MESMA ORDEM E QUANTIDADE que a lista de entrada, no formato exato:
[{
  "index": <mesmo índice do jogo na lista de entrada>,
  "tier": <1 a 6, sendo 6 excelente e 1 não roda>,
  "tierLabel": "Excelente|Bom|OK|Jogável|Ruim|Não roda",
  "veredito": "uma frase direta",
  "motivo": "1 a 2 frases explicando o porquê",
  "configuracaoRecomendada": "sugestão curta de configuração gráfica",
  "avisos": ["aviso curto, se houver"]
}]

Escala de tier:
6 = Excelente (roda liso, configuração alta)
5 = Bom (roda bem, configuração média/alta)
4 = OK (roda de forma estável, configuração média/baixa, sem grandes ressalvas)
3 = Jogável (roda, mas capenga)
2 = Ruim (abre e roda, mas a experiência é ruim a ponto de não valer a pena)
1 = Não roda (trava, crash constante, ou requisito mínimo que a configuração não atende)`;

  const userPrompt = `Plataforma/loja de todos os jogos desta lista: ${platformLabel || "não informado"}
Lista de jogos (avalie TODOS, na ordem):
${games.map((g, i) => `${i}: ${g.name}`).join("\n")}`;

  const result = await callGeminiJSON(env, { systemInstruction, userPrompt, temperature: 0.3, allowGrounding: false });
  if (!result.ok) return json({ error: result.error }, result.status);

  if (!Array.isArray(result.data)) {
    return json({ error: "O Gemini não devolveu uma lista válida pra este lote." }, 502);
  }

  return json({ results: result.data });
}

// Resumo/lore + metadados básicos de UM jogo, gerado por IA (mesmo padrão de
// busca+fallback do handleAnalyze). Serve pra QUALQUER jogo, de qualquer
// plataforma — diferente do RetroAchievements, que só cobre jogos com
// conquistas cadastradas lá.
async function handleGameLore(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Corpo da requisição inválido." }, 400);
  }

  const { name, platformLabel } = payload || {};
  if (!name) return json({ error: "Falta o nome do jogo." }, 400);

  const systemInstruction = `Você é um historiador especialista na indústria de videogames, com foco em curiosidades e contexto histórico de jogos (retrô ou modernos).

Responda SOMENTE com um JSON válido, sem texto antes ou depois, sem markdown, sem crases, no formato exato:
{
  "developer": "estúdio desenvolvedor ou null se não souber",
  "publisher": "publicadora ou null se não souber",
  "genre": "gênero curto ou null",
  "released": "ano de lançamento (ou data) ou null",
  "franchise": "nome curto e canônico da franquia/série a que o jogo pertence (ex: 'God of War', 'Mario Kart', 'Final Fantasy') ou null se for um jogo standalone sem franquia",
  "lore": "2 a 4 frases em português, cobrindo contexto/lore do jogo e 1-2 feitos ou curiosidades marcantes dele na indústria (recepção histórica, inovação técnica, influência em outros jogos, polêmicas, recordes etc). Direto ao ponto, sem enrolação."
}`;

  const userPrompt = `Jogo: ${name}
Plataforma/loja: ${platformLabel || "não informado"}`;

  const result = await callGeminiJSON(env, { systemInstruction, userPrompt, temperature: 0.5 });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json(result.data);
}

// Ordem de jogo recomendada dentro de uma franquia (mesmo padrão de IA com
// busca) — substitui a ideia dos "Hubs" do RA, que não é exposta pela API
// pública deles hoje.
async function handleFranchiseOrder(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Corpo da requisição inválido." }, 400);
  }

  const { franchise, games } = payload || {};
  if (!franchise || !Array.isArray(games) || games.length === 0) {
    return json({ error: "Faltam a franquia ou a lista de jogos." }, 400);
  }

  const gamesList = games.map((g) => `- ${g.name} (${g.platformLabel || "plataforma não informada"})`).join("\n");

  const systemInstruction = `Você é um especialista em franquias de videogame. O usuário tem estes jogos da franquia "${franchise}" na biblioteca dele:
${gamesList}

Responda SOMENTE com um JSON válido, sem texto antes ou depois, sem markdown, sem crases, no formato exato:
{
  "summary": "1-2 frases sobre a franquia em geral",
  "order": [
    { "name": "nome exato do jogo como veio na lista", "reason": "1 frase curta do porquê dessa posição (cronologia da história, não de lançamento, a menos que sejam a mesma coisa)" }
  ]
}
A lista "order" deve conter TODOS os jogos da lista acima, na ordem recomendada de jogar pra melhor entender a história/lore da franquia (não necessariamente a ordem de lançamento).`;

  const result = await callGeminiJSON(env, {
    systemInstruction,
    userPrompt: `Franquia: ${franchise}`,
    temperature: 0.4,
  });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json(result.data);
}

// Proxy pro PDF de um link do Google Drive — o leitor embutido (PDF.js) roda
// no navegador e não consegue baixar direto do Drive por causa de CORS, então
// o worker busca os bytes do lado do servidor e repassa. Também lida com a
// página de confirmação que o Drive mostra em arquivos grandes (aviso de
// "não foi possível verificar vírus"), que aparece no lugar do PDF direto.
async function handlePdfProxy(request, env) {
  const url = new URL(request.url);
  const driveUrl = url.searchParams.get("url");
  if (!driveUrl) return json({ error: "Falta o parâmetro url." }, 400);

  const idMatch = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || driveUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  const fileId = idMatch ? idMatch[1] : null;
  if (!fileId) {
    return json({ error: "Não consegui identificar o ID do arquivo nesse link do Drive." }, 400);
  }

  async function fetchDrive(u) {
    try {
      return await fetch(u, { redirect: "follow" });
    } catch (e) {
      throw new Error(`Falha ao contatar o Google Drive: ${e.message}`);
    }
  }

  let response;
  try {
    response = await fetchDrive(`https://drive.google.com/uc?export=download&id=${fileId}`);

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      const html = await response.text();
      const tokenMatch = html.match(/confirm=([0-9A-Za-z_-]+)/) || html.match(/name="confirm"\s+value="([0-9A-Za-z_-]+)"/);
      const uuidMatch = html.match(/name="uuid"\s+value="([0-9A-Za-z_-]+)"/);
      if (!tokenMatch) {
        return json(
          {
            error:
              "O Drive não retornou o PDF diretamente. Confira se o link está compartilhado como \"qualquer pessoa com o link pode ver\".",
          },
          502
        );
      }
      let confirmUrl = `https://drive.google.com/uc?export=download&confirm=${tokenMatch[1]}&id=${fileId}`;
      if (uuidMatch) confirmUrl += `&uuid=${uuidMatch[1]}`;
      response = await fetchDrive(confirmUrl);
    }
  } catch (e) {
    return json({ error: e.message }, 502);
  }

  if (!response.ok) {
    return json({ error: `Google Drive retornou erro ${response.status}.` }, 502);
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Cache-Control": "private, max-age=3600",
      ...CORS_HEADERS,
    },
  });
}

// Capa via SteamGridDB — pra jogos de lojas sem API pública decente
// (GOG/Epic/Amazon). Busca por NOME (essas lojas não têm um "ID" universal
// consultável), pega o primeiro resultado com imagem disponível.
async function handleCoverArt(request, env) {
  const url = new URL(request.url);
  const name = url.searchParams.get("name");
  if (!name) return json({ error: "Falta o parâmetro name." }, 400);

  const apiKey = env.STEAMGRIDDB_API_KEY;
  if (!apiKey) return json({ error: "STEAMGRIDDB_API_KEY não configurada no servidor." }, 500);

  const headers = { Authorization: `Bearer ${apiKey}` };

  let searchRes;
  try {
    searchRes = await fetch(
      `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(name)}`,
      { headers }
    );
  } catch (e) {
    return json({ error: `Falha ao contatar o SteamGridDB: ${e.message}` }, 502);
  }
  if (!searchRes.ok) return json({ error: `SteamGridDB retornou erro ${searchRes.status} na busca.` }, 502);
  const searchData = await searchRes.json().catch(() => null);
  const match = searchData?.data?.[0];
  if (!match) return json({ error: "Nenhum jogo encontrado no SteamGridDB com esse nome." }, 404);

  let gridRes;
  try {
    gridRes = await fetch(
      `https://www.steamgriddb.com/api/v2/grids/game/${match.id}?dimensions=460x215,920x430`,
      { headers }
    );
  } catch (e) {
    return json({ error: `Falha ao contatar o SteamGridDB: ${e.message}` }, 502);
  }
  if (!gridRes.ok) return json({ error: `SteamGridDB retornou erro ${gridRes.status} nas capas.` }, 502);
  const gridData = await gridRes.json().catch(() => null);
  // O card do CompactHub é 16:9 (aspect-video) — o formato "horizontal" do
  // SteamGridDB (460x215/920x430) é o mais próximo disso (a proporção exata
  // 16:9 não existe nas opções deles). Entre os resultados, pega sempre o de
  // MAIOR resolução disponível, pra ficar nítido tanto no grid quanto no
  // card ampliado do modal — object-cover cuida do encaixe sem esticar.
  let grid = pickLargestGrid(gridData?.data);

  // Sem resultado no formato "landscape" preferido — tenta qualquer formato.
  if (!grid) {
    try {
      const fallbackRes = await fetch(`https://www.steamgriddb.com/api/v2/grids/game/${match.id}`, { headers });
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json().catch(() => null);
        grid = pickLargestGrid(fallbackData?.data);
      }
    } catch {
      // ignora — cai no erro abaixo
    }
  }

  if (!grid) return json({ error: "O jogo foi encontrado, mas não tem capas disponíveis no SteamGridDB." }, 404);

  return json({ coverUrl: grid.url, matchedName: match.name });
}

function pickLargestGrid(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return [...list].sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
}

// --- IGDB (via Twitch OAuth) ---
// Cache do token de app-access em memória do isolate. Não é garantido
// persistir entre requisições (Workers podem reciclar o isolate a qualquer
// momento), mas quando persiste evita repetir o handshake OAuth a cada
// busca — o token do Twitch dura ~60 dias.
let igdbTokenCache = { token: null, expiresAt: 0 };

async function getIgdbToken(env) {
  const clientId = env.IGDB_CLIENT_ID;
  const clientSecret = env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("IGDB_CLIENT_ID / IGDB_CLIENT_SECRET não configurados no servidor.");
  }

  if (igdbTokenCache.token && igdbTokenCache.expiresAt > Date.now()) {
    return igdbTokenCache.token;
  }

  const url = `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`Falha ao autenticar no Twitch/IGDB: ${res.status}`);
  const data = await res.json();
  igdbTokenCache = {
    token: data.access_token,
    // Renova um pouco antes de expirar de verdade (margem de 5 min).
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  };
  return igdbTokenCache.token;
}

// Busca metadados ricos de um jogo (capa, screenshots, sinopse, gêneros,
// jogos parecidos) pelo nome. Usado pra enriquecer os cards além da capa
// simples que já vem do SteamGridDB.
async function handleIgdbSearch(request, env) {
  const url = new URL(request.url);
  const name = url.searchParams.get("name");
  if (!name) return json({ error: "Falta o parâmetro name." }, 400);

  let token;
  try {
    token = await getIgdbToken(env);
  } catch (e) {
    return json({ error: e.message }, 500);
  }

  const clientId = env.IGDB_CLIENT_ID;
  const escaped = name.replace(/"/g, '\\"');
  // Apicalypse: pede só os campos que a UI usa, limita a 1 resultado (o
  // melhor match do próprio IGDB pra busca textual).
  const body = `search "${escaped}"; fields name,summary,genres.name,first_release_date,cover.url,screenshots.url,similar_games.name; limit 1;`;

  let res;
  try {
    res = await fetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: {
        "Client-ID": clientId,
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body,
    });
  } catch (e) {
    return json({ error: `Falha ao contatar o IGDB: ${e.message}` }, 502);
  }
  if (!res.ok) return json({ error: `IGDB retornou erro ${res.status}.` }, 502);

  const data = await res.json().catch(() => []);
  const match = data?.[0];
  if (!match) return json({ error: "Nenhum jogo encontrado no IGDB com esse nome." }, 404);

  // A URL de imagem do IGDB vem em formato //thumb, protocol-relative e em
  // baixa resolução por padrão — troca pro tamanho grande e completa o https.
  function bigImage(igdbUrl) {
    if (!igdbUrl) return null;
    return `https:${igdbUrl.replace("t_thumb", "t_1080p")}`;
  }

  return json({
    name: match.name,
    summary: match.summary || null,
    genres: (match.genres || []).map((g) => g.name),
    releaseDate: match.first_release_date ? match.first_release_date * 1000 : null,
    coverUrl: bigImage(match.cover?.url),
    screenshots: (match.screenshots || []).map((s) => bigImage(s.url)).filter(Boolean),
    similarGames: (match.similar_games || []).map((g) => g.name),
  });
}

// --- PCGamingWiki ---
// Sem OAuth — é um MediaWiki com extensão Cargo, consultado como se fosse
// uma tabela. Traz dados técnicos que complementam a análise do Gemini com
// fatos concretos (engine, versão de Direct3D, VRAM mínima etc).
async function handlePcgamingwiki(request, env) {
  const url = new URL(request.url);
  const name = url.searchParams.get("name");
  if (!name) return json({ error: "Falta o parâmetro name." }, 400);

  const api = new URL("https://www.pcgamingwiki.com/w/api.php");
  api.searchParams.set("action", "cargoquery");
  api.searchParams.set("format", "json");
  api.searchParams.set("tables", "Infobox_game");
  api.searchParams.set(
    "fields",
    "Infobox_game._pageName=Page,Engine,Direct3D_versions,VRAM_min,Steam_input_API,Denuvo"
  );
  api.searchParams.set("where", `Infobox_game._pageName="${name.replace(/"/g, '')}"`);
  api.searchParams.set("limit", "1");

  let res;
  try {
    res = await fetch(api, { headers: { "User-Agent": "CompatHub/1.0 (uso pessoal)" } });
  } catch (e) {
    return json({ error: `Falha ao contatar o PCGamingWiki: ${e.message}` }, 502);
  }
  if (!res.ok) return json({ error: `PCGamingWiki retornou erro ${res.status}.` }, 502);

  const data = await res.json().catch(() => null);
  const row = data?.cargoquery?.[0]?.title;
  if (!row) return json({ error: "Página não encontrada no PCGamingWiki com esse nome exato." }, 404);

  return json({
    page: row.Page || name,
    engine: row.Engine || null,
    direct3dVersions: row.Direct3D_versions || null,
    vramMin: row.VRAM_min || null,
    steamInputApi: row.Steam_input_API || null,
    denuvo: row.Denuvo || null,
    pageUrl: `https://www.pcgamingwiki.com/wiki/${encodeURIComponent((row.Page || name).replace(/ /g, "_"))}`,
  });
}

// --- Notícias (RSS agregado, sem chave de API) ---
// Agrega alguns feeds RSS de sites de games num formato unificado. Parsing
// feito com regex simples (sem lib de XML) porque RSS 2.0 é bem regular e
// isso evita adicionar uma dependência só pra isso.
const NEWS_FEEDS = [
  { url: "https://www.ign.com/rss/articles/feed", source: "IGN" },
  { url: "https://www.eurogamer.net/feed", source: "Eurogamer" },
  { url: "https://store.steampowered.com/feeds/news.xml", source: "Steam" },
];

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return null;
  return match[1]
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function extractImage(itemXml) {
  const enclosure = itemXml.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image[^"]*"/i);
  if (enclosure) return enclosure[1];
  const mediaContent = itemXml.match(/<media:content[^>]*url="([^"]+)"/i);
  if (mediaContent) return mediaContent[1];
  const imgTag = itemXml.match(/<img[^>]+src="([^"]+)"/i);
  if (imgTag) return imgTag[1];
  return null;
}

function parseRssItems(xml, source) {
  const items = [];
  const itemMatches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const itemXml of itemMatches.slice(0, 12)) {
    const title = extractTag(itemXml, "title");
    const link = extractTag(itemXml, "link");
    const pubDate = extractTag(itemXml, "pubDate");
    const description = extractTag(itemXml, "description");
    if (!title || !link) continue;
    items.push({
      title,
      link,
      pubDate,
      description: description ? description.slice(0, 220) : null,
      image: extractImage(itemXml),
      source,
    });
  }
  return items;
}

async function handleNews(request, env) {
  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async (feed) => {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "CompatHub/1.0 (uso pessoal, agregador RSS)" },
      });
      if (!res.ok) throw new Error(`${feed.source} retornou ${res.status}`);
      const xml = await res.text();
      return parseRssItems(xml, feed.source);
    })
  );

  const items = [];
  const feedErrors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else feedErrors.push(`${NEWS_FEEDS[i].source}: ${r.reason?.message || "erro desconhecido"}`);
  });

  // Ordena pelas mais recentes quando dá pra interpretar a data; itens sem
  // data reconhecida vão pro fim, mas não são descartados.
  items.sort((a, b) => {
    const da = a.pubDate ? Date.parse(a.pubDate) : 0;
    const db = b.pubDate ? Date.parse(b.pubDate) : 0;
    return (db || 0) - (da || 0);
  });

  // As fontes (IGN, Eurogamer, Steam) publicam em inglês. Traduz título +
  // resumo pro português numa chamada em lote ao Gemini, no mesmo padrão de
  // handleTranslateAchievements. Se o Gemini falhar ou não estiver
  // configurado, devolve as notícias no idioma original em vez de quebrar
  // o painel — tradução é um "nice to have", não deveria derrubar a feature.
  const top = items.slice(0, 20);
  if (top.length > 0 && env.GEMINI_API_KEY) {
    try {
      const listForPrompt = top.map((it, i) => ({ id: i, title: it.title, description: it.description }));
      const systemInstruction = `Você traduz manchetes e resumos de notícias de games do inglês pro português do Brasil.
Mantenha nomes próprios de jogos, empresas e termos técnicos (ex: "patch", "DLC", "framerate") como estão.
Responda SOMENTE com um JSON válido (array), sem texto antes ou depois, sem markdown, no formato exato:
[{"id": 0, "title": "...", "description": "..."}]
Se "description" for null no item original, mantenha null na resposta.`;

      const result = await callGeminiJSON(env, {
        systemInstruction,
        userPrompt: JSON.stringify(listForPrompt),
        temperature: 0.2,
        allowGrounding: false,
      });

      if (result.ok && Array.isArray(result.data)) {
        for (const t of result.data) {
          if (top[t.id]) {
            if (t.title) top[t.id].title = t.title;
            if (t.description !== undefined) top[t.id].description = t.description;
          }
        }
      }
    } catch {
      // segue com o conteúdo original em inglês — melhor mostrar algo do
      // que derrubar o painel inteiro por causa da tradução
    }
  }

  return json({ items, feedErrors: feedErrors.length ? feedErrors : undefined });
}

// Avatar + pontos/rank da conta do RA — usado SÓ no painel de escolha de
// perfil de hardware, pro perfil marcado como vinculado ao RA (ver raLinked).
async function handleRetroAchievementsProfile(request, env) {
  const apiKey = env.RA_API_KEY;
  const username = env.RA_USERNAME;
  if (!apiKey || !username) return json({ error: "RA não configurado no servidor." }, 500);

  const qs = `u=${encodeURIComponent(username)}&y=${encodeURIComponent(apiKey)}`;

  // Várias chamadas em paralelo — cada uma cobre uma parte do resumo do
  // perfil. Uma falhar isoladamente não derruba as outras (Promise.allSettled).
  const [summaryRes, profileRes, recentGameRes, recentAchRes, completionRes] = await Promise.allSettled([
    fetch(`https://retroachievements.org/API/API_GetUserSummary.php?${qs}`).then((r) => (r.ok ? r.json() : null)),
    fetch(`https://retroachievements.org/API/API_GetUserProfile.php?${qs}`).then((r) => (r.ok ? r.json() : null)),
    fetch(`https://retroachievements.org/API/API_GetUserRecentlyPlayedGames.php?${qs}&c=1`).then((r) => (r.ok ? r.json() : null)),
    fetch(`https://retroachievements.org/API/API_GetUserRecentAchievements.php?${qs}&m=10080`).then((r) => (r.ok ? r.json() : null)), // últimos 7 dias
    fetch(`https://retroachievements.org/API/API_GetUserCompletionProgress.php?${qs}&c=500`).then((r) => (r.ok ? r.json() : null)),
  ]);

  const summary = summaryRes.status === "fulfilled" ? summaryRes.value : null;
  const profileData = profileRes.status === "fulfilled" ? profileRes.value : null;
  const recentGames = recentGameRes.status === "fulfilled" ? recentGameRes.value : null;
  const recentAchievements = recentAchRes.status === "fulfilled" ? recentAchRes.value : null;
  const completion = completionRes.status === "fulfilled" ? completionRes.value : null;

  if (!summary && !profileData) {
    return json({ error: "Não foi possível carregar o perfil do RetroAchievements." }, 502);
  }

  const lastGameEntry = Array.isArray(recentGames) ? recentGames[0] : null;

  // "Progression Status" — quantos jogos (e quantos 100%) por plataforma/
  // console, agregado a partir do progresso completo do usuário.
  let progressionByPlatform = [];
  if (completion?.Results) {
    const byConsole = {};
    for (const g of completion.Results) {
      const key = g.ConsoleName || "Outro";
      if (!byConsole[key]) byConsole[key] = { console: key, gamesCount: 0, masteredCount: 0 };
      byConsole[key].gamesCount += 1;
      if (g.HighestAwardKind === "mastered" || g.HighestAwardKind === "completed") {
        byConsole[key].masteredCount += 1;
      }
    }
    progressionByPlatform = Object.values(byConsole).sort((a, b) => b.gamesCount - a.gamesCount);
  }

  const recentAchievementsList = Array.isArray(recentAchievements)
    ? recentAchievements.slice(0, 6).map((a) => ({
        title: a.Title,
        gameTitle: a.GameTitle,
        consoleName: a.ConsoleName,
        points: a.Points,
        date: a.Date,
        badgeUrl: a.BadgeName ? `https://i.retroachievements.org/Badge/${a.BadgeName}.png` : null,
      }))
    : [];

  return json({
    username: summary?.User || profileData?.User || username,
    avatarUrl: (summary?.UserPic || profileData?.UserPic)
      ? `https://media.retroachievements.org${summary?.UserPic || profileData?.UserPic}`
      : null,
    rank: summary?.Rank ?? null,
    points: summary?.TotalPoints ?? profileData?.TotalPoints ?? 0,
    truePoints: summary?.TotalTruePoints ?? profileData?.TotalTruePoints ?? 0,
    memberSince: summary?.MemberSince || profileData?.MemberSince || null,
    motto: profileData?.Motto || null,
    lastGame: lastGameEntry
      ? { title: lastGameEntry.Title, consoleName: lastGameEntry.ConsoleName, lastPlayed: lastGameEntry.LastPlayed }
      : null,
    progressionByPlatform,
    recentAchievements: recentAchievementsList,
  });
}

async function handleRetroAchievements(request, env) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get("gameId");

  if (!gameId) {
    return json({ error: "Falta o parâmetro gameId." }, 400);
  }

  const username = env.RA_USERNAME;
  const apiKey = env.RA_API_KEY;
  if (!username || !apiKey) {
    return json(
      { error: "RA_USERNAME e/ou RA_API_KEY não configurados no servidor (Settings > Variables and Secrets)." },
      500
    );
  }

  const raUrl = `https://retroachievements.org/API/API_GetGameInfoAndUserProgress.php?g=${encodeURIComponent(
    gameId
  )}&u=${encodeURIComponent(username)}&y=${encodeURIComponent(apiKey)}`;

  let raResponse;
  try {
    raResponse = await fetch(raUrl);
  } catch (e) {
    return json({ error: `Falha ao contatar o RetroAchievements: ${e.message}` }, 502);
  }

  if (!raResponse.ok) {
    const errText = await raResponse.text().catch(() => "");
    return json({ error: `RetroAchievements retornou erro ${raResponse.status}: ${errText.slice(0, 300)}` }, 502);
  }

  const data = await raResponse.json().catch(() => null);
  if (!data || !data.Title) {
    return json({ error: "ID de jogo não encontrado no RetroAchievements. Confira o número na URL do jogo no site." }, 404);
  }

  // "Última vez jogado" vem de um endpoint separado (histórico recente do
  // usuário). Nem todo jogo aparece aqui — só os jogados nos últimos períodos.
  // O "award" (Mastery/Beaten) também vem de um endpoint separado, que lista
  // o progresso em TODOS os jogos do usuário — filtramos pelo gameId.
  // As duas chamadas rodam em paralelo pra não somar latência.
  // OBS: o RetroAchievements NÃO expõe "horas jogadas" via API pra nenhum
  // console/emulador (é uma limitação conhecida do próprio serviço, não do
  // app) — o que usamos como aproximação é o intervalo entre a primeira e a
  // última conquista desbloqueada, que é só uma estimativa, não o tempo real.
  let lastPlayed = null;
  let highestAwardKind = null;
  let highestAwardDate = null;

  const recentUrl = `https://retroachievements.org/API/API_GetUserRecentlyPlayedGames.php?u=${encodeURIComponent(
    username
  )}&y=${encodeURIComponent(apiKey)}&c=100`;
  const completionUrl = `https://retroachievements.org/API/API_GetUserCompletionProgress.php?u=${encodeURIComponent(
    username
  )}&y=${encodeURIComponent(apiKey)}&c=500`;

  const [recentResult, completionResult] = await Promise.allSettled([
    fetch(recentUrl).then((r) => (r.ok ? r.json() : null)),
    fetch(completionUrl).then((r) => (r.ok ? r.json() : null)),
  ]);

  if (recentResult.status === "fulfilled" && Array.isArray(recentResult.value)) {
    const match = recentResult.value.find((g) => String(g.GameID) === String(gameId));
    if (match) lastPlayed = match.LastPlayed || null;
  }
  if (completionResult.status === "fulfilled" && completionResult.value?.Results) {
    const match = completionResult.value.Results.find((g) => String(g.GameID) === String(gameId));
    if (match) {
      highestAwardKind = match.HighestAwardKind || null;
      highestAwardDate = match.HighestAwardDate || null;
    }
  }

  // Devolve só o que a UI precisa, num formato mais simples que o bruto da RA.
  const achievements = Object.values(data.Achievements || {}).map((a) => ({
    id: a.ID,
    title: a.Title,
    description: a.Description,
    points: a.Points,
    badgeName: a.BadgeName,
    earned: Boolean(a.DateEarned),
    earnedHardcore: Boolean(a.DateEarnedHardcore),
    dateEarned: a.DateEarned || null,
  }));

  // Conquistas destravadas primeiro (mais recentes), depois as que faltam.
  achievements.sort((a, b) => {
    if (a.earned !== b.earned) return a.earned ? -1 : 1;
    return 0;
  });

  // Estimativa (não é tempo real jogado): intervalo entre a primeira e a
  // última conquista desbloqueada, ordenando as datas que existem.
  const earnedDates = achievements.map((a) => a.dateEarned).filter(Boolean).sort();
  const firstUnlockDate = earnedDates[0] || null;
  const lastUnlockDate = earnedDates[earnedDates.length - 1] || null;

  return json({
    gameTitle: data.Title,
    consoleName: data.ConsoleName,
    imageIcon: data.ImageIcon ? `https://retroachievements.org${data.ImageIcon}` : null,
    boxArtUrl: data.ImageBoxArt ? `https://retroachievements.org${data.ImageBoxArt}` : null,
    numAchievements: data.NumAchievements || 0,
    numAwardedToUser: data.NumAwardedToUser || 0,
    userCompletion: data.UserCompletion || "0.00%",
    developer: data.Developer || null,
    publisher: data.Publisher || null,
    genre: data.Genre || null,
    released: data.Released || null,
    lastPlayed,
    highestAwardKind,
    highestAwardDate,
    firstUnlockDate,
    lastUnlockDate,
    achievements,
  });
}

// Tempo médio (mediana entre todos os jogadores) pra zerar/platinar um jogo —
// dado da comunidade, não é o tempo pessoal do usuário.
async function handleRetroAchievementsProgression(request, env) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get("gameId");
  if (!gameId) return json({ error: "Falta o parâmetro gameId." }, 400);

  const apiKey = env.RA_API_KEY;
  if (!apiKey) return json({ error: "RA_API_KEY não configurada no servidor." }, 500);

  const raUrl = `https://retroachievements.org/API/API_GetGameProgression.php?i=${encodeURIComponent(
    gameId
  )}&y=${encodeURIComponent(apiKey)}`;

  let raResponse;
  try {
    raResponse = await fetch(raUrl);
  } catch (e) {
    return json({ error: `Falha ao contatar o RetroAchievements: ${e.message}` }, 502);
  }
  if (!raResponse.ok) {
    return json({ error: `RetroAchievements retornou erro ${raResponse.status}.` }, 502);
  }
  const data = await raResponse.json().catch(() => null);
  if (!data) return json({ error: "Não foi possível interpretar a resposta do RetroAchievements." }, 502);

  // Todos os campos de tempo vêm em segundos.
  return json({
    numDistinctPlayers: data.NumDistinctPlayers || 0,
    medianTimeToBeatSeconds: data.MedianTimeToBeat ?? null,
    medianTimeToBeatHardcoreSeconds: data.MedianTimeToBeatHardcore ?? null,
    medianTimeToCompleteSeconds: data.MedianTimeToComplete ?? null,
    medianTimeToMasterSeconds: data.MedianTimeToMaster ?? null,
  });
}

// "Achievement of the Week" — o dado de evento semanal mais confiável que a
// API do RetroAchievements expõe de forma estruturada.
async function handleRetroAchievementsWeek(request, env) {
  const apiKey = env.RA_API_KEY;
  const username = env.RA_USERNAME;
  if (!apiKey || !username) return json({ error: "RA não configurado no servidor." }, 500);

  const raUrl = `https://retroachievements.org/API/API_GetAchievementOfTheWeek.php?y=${encodeURIComponent(
    apiKey
  )}`;

  let raResponse;
  try {
    raResponse = await fetch(raUrl);
  } catch (e) {
    return json({ error: `Falha ao contatar o RetroAchievements: ${e.message}` }, 502);
  }
  if (!raResponse.ok) return json({ error: `RetroAchievements retornou erro ${raResponse.status}.` }, 502);
  const data = await raResponse.json().catch(() => null);
  if (!data || !data.Achievement) return json({ error: "Sem evento da semana disponível." }, 404);

  return json({
    achievementTitle: data.Achievement.Title,
    achievementDescription: data.Achievement.Description,
    badgeUrl: data.Achievement.BadgeName
      ? `https://i.retroachievements.org/Badge/${data.Achievement.BadgeName}.png`
      : null,
    gameTitle: data.Game?.Title || null,
    consoleName: data.Console?.Title || null,
    totalPlayers: data.TotalPlayers ?? null,
    totalAwarded: data.UniqueTotalPlayers ?? null,
  });
}

async function handleTranslateAchievements(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Corpo da requisição inválido." }, 400);
  }

  const { achievements } = payload || {};
  if (!Array.isArray(achievements) || achievements.length === 0) {
    return json({ error: "Nenhuma conquista pra traduzir." }, 400);
  }

  // Manda id + título + descrição em lote, pede de volta um JSON na mesma
  // ordem/ids — assim traduz tudo numa chamada só em vez de uma por conquista.
  const listForPrompt = achievements.map((a) => ({ id: a.id, title: a.title, description: a.description }));

  const systemInstruction = `Você traduz conquistas de jogos (achievements) do inglês pro português do Brasil.
Mantenha nomes próprios, referências e trocadilhos do jogo o quanto for possível, adaptando pra soar natural em português.
Responda SOMENTE com um JSON válido (array), sem texto antes ou depois, sem markdown, no formato exato:
[{ "id": <mesmo id recebido>, "title": "título traduzido", "description": "descrição traduzida" }]`;

  const result = await callGeminiJSON(env, {
    systemInstruction,
    userPrompt: JSON.stringify(listForPrompt),
    temperature: 0.2,
    allowGrounding: false, // tradução não precisa de busca
  });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json({ translations: result.data });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/analyze") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "POST") {
        return handleAnalyze(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/analyze-batch") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "POST") {
        return handleAnalyzeBatch(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/retroachievements") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET") {
        return handleRetroAchievements(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/retroachievements/progression") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET") {
        return handleRetroAchievementsProgression(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/retroachievements/week") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET") {
        return handleRetroAchievementsWeek(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/retroachievements/profile") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET") {
        return handleRetroAchievementsProfile(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/game-lore") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "POST") {
        return handleGameLore(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/franchise-order") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "POST") {
        return handleFranchiseOrder(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/coverart") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET") {
        return handleCoverArt(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/igdb") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET") {
        return handleIgdbSearch(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/pcgamingwiki") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET") {
        return handlePcgamingwiki(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/news") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET") {
        return handleNews(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/pdf-proxy") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET") {
        return handlePdfProxy(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    if (url.pathname === "/api/translate-achievements") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "POST") {
        return handleTranslateAchievements(request, env);
      }
      return json({ error: "Método não permitido." }, 405);
    }

    // qualquer outra rota: serve o build estático (index.html, JS, CSS, imagens)
    return env.ASSETS.fetch(request);
  },
};
