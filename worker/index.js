// Worker principal (modelo unificado do Cloudflare, substitui o antigo
// functions/api/*.js do Pages). Duas responsabilidades:
// 1. Requisições pra /api/analyze -> chama o Gemini com a chave secreta
// 2. Qualquer outra requisição -> serve os arquivos estáticos de dist/ (via env.ASSETS)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

  let geminiResponse;
  try {
    geminiResponse = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.4 },
      }),
    });
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

  return json({ text });
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

    // qualquer outra rota: serve o build estático (index.html, JS, CSS, imagens)
    return env.ASSETS.fetch(request);
  },
};
