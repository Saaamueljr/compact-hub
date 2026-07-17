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

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: "GEMINI_API_KEY não configurada no servidor (Settings > Variables and Secrets)." }, 500);
  }

  // gemini-3-flash / gemini-3-flash-lite: modelos com tier gratuito com busca.
  // Ajuste via variável de ambiente GEMINI_MODEL se um deles for descontinuado.
  const model = env.GEMINI_MODEL || "gemini-3-flash";

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

Responda SOMENTE com um JSON válido, sem nenhum texto antes ou depois, sem markdown, sem crases, no formato exato:
{
  "tier": <1 a 5, sendo 5 excelente e 1 não roda>,
  "tierLabel": "Excelente|Bom|OK|Ruim|Não roda",
  "veredito": "uma frase direta",
  "motivo": "2 a 3 frases explicando o porquê, citando CPU/GPU/VRAM quando relevante",
  "configuracaoRecomendada": "sugestão curta de configuração gráfica",
  "avisos": ["aviso curto, se houver"]
}`;

  const userPrompt = `Jogo: ${game.name}
Plataforma: ${platformLabel || "não informado"}
Histórico de problemas registrados para este jogo: ${notesText || "nenhum registrado ainda"}
Objetivos do usuário para este jogo: ${game.goals || "nenhum especificado"}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Tenta primeiro com busca (grounding) pra ter dados atualizados sobre o jogo.
  // A cota de grounding é bem mais restrita que a de geração de texto normal,
  // então se vier 429 (cota excedida), tenta de novo sem a busca — o modelo
  // ainda responde bem usando só o que já sabe, especialmente pra jogos antigos.
  async function callGemini(useGrounding) {
    const body = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.4 },
    };
    if (useGrounding) {
      body.tools = [{ google_search: {} }];
    }
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  let geminiResponse;
  let usedGrounding = true;
  let fellBackFromQuota = false;
  try {
    geminiResponse = await callGemini(true);

    if (geminiResponse.status === 429) {
      // Cota de busca provavelmente excedida — tenta de novo sem grounding.
      usedGrounding = false;
      fellBackFromQuota = true;
      geminiResponse = await callGemini(false);
    }
  } catch (e) {
    return json({ error: `Falha ao contatar o Gemini: ${e.message}` }, 502);
  }

  if (!geminiResponse.ok) {
    const errText = await geminiResponse.text().catch(() => "");
    return json({ error: `Gemini retornou erro ${geminiResponse.status}: ${errText.slice(0, 300)}` }, 502);
  }

  const data = await geminiResponse.json();
  const candidate = (data.candidates || [])[0];
  const text = (candidate?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n")
    .trim();

  if (!text) {
    return json({ error: "O Gemini não retornou texto na resposta." }, 502);
  }

  return json({ text, usedGrounding, fellBackFromQuota });
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

  return json({
    gameTitle: data.Title,
    consoleName: data.ConsoleName,
    imageIcon: data.ImageIcon ? `https://retroachievements.org${data.ImageIcon}` : null,
    boxArtUrl: data.ImageBoxArt ? `https://retroachievements.org${data.ImageBoxArt}` : null,
    numAchievements: data.NumAchievements || 0,
    numAwardedToUser: data.NumAwardedToUser || 0,
    userCompletion: data.UserCompletion || "0.00%",
    achievements,
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

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: "GEMINI_API_KEY não configurada no servidor." }, 500);
  }
  const model = env.GEMINI_MODEL || "gemini-3-flash";

  // Manda id + título + descrição em lote, pede de volta um JSON na mesma
  // ordem/ids — assim traduz tudo numa chamada só em vez de uma por conquista.
  const listForPrompt = achievements.map((a) => ({ id: a.id, title: a.title, description: a.description }));

  const systemInstruction = `Você traduz conquistas de jogos (achievements) do inglês pro português do Brasil.
Mantenha nomes próprios, referências e trocadilhos do jogo o quanto for possível, adaptando pra soar natural em português.
Responda SOMENTE com um JSON válido (array), sem texto antes ou depois, sem markdown, no formato exato:
[{ "id": <mesmo id recebido>, "title": "título traduzido", "description": "descrição traduzida" }]`;

  const userPrompt = JSON.stringify(listForPrompt);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
    });
  } catch (e) {
    return json({ error: `Falha ao contatar o Gemini: ${e.message}` }, 502);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    return json({ error: `Gemini retornou erro ${response.status}: ${errText.slice(0, 300)}` }, 502);
  }

  const data = await response.json();
  const candidate = (data.candidates || [])[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("\n").trim();
  const cleaned = text.replace(/```json|```/g, "").trim();

  let translations;
  try {
    translations = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        translations = JSON.parse(match[0]);
      } catch {
        return json({ error: "Não consegui interpretar a tradução retornada." }, 502);
      }
    } else {
      return json({ error: "Não consegui interpretar a tradução retornada." }, 502);
    }
  }

  return json({ translations });
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

    if (url.pathname === "/api/retroachievements") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET") {
        return handleRetroAchievements(request, env);
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
