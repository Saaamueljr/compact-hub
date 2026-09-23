// src/lib/matchGame.js
// Detecção automática de qual item de uma biblioteca (Steam ou GOG)
// corresponde ao nome de um jogo já cadastrado no CompatHub. Sem
// dependência externa — é só normalização de texto + pontuação simples.

function normalize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[™®©]/g, "")
    .replace(/[:\-–—]/g, " ")
    .replace(/\b(the|a|an|edition|goty|game of the year|remastered|definitive|deluxe)\b/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Distância de Levenshtein simples (strings curtas, não precisa otimizar)
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Devolve o melhor item de `items` (cada um com um campo de nome/título)
// que corresponde a `targetName`, ou null se nada bater com confiança
// suficiente. `getTitle` extrai o título de cada item da lista.
function findBestMatch(targetName, items, getTitle) {
  const target = normalize(targetName);
  if (!target || !items?.length) return null;

  let best = null;
  let bestScore = Infinity;

  for (const item of items) {
    const title = normalize(getTitle(item));
    if (!title) continue;

    let score;
    if (title === target) {
      score = 0;
    } else if (title.startsWith(target) || target.startsWith(title)) {
      score = Math.abs(title.length - target.length) * 0.3;
    } else {
      score = levenshtein(target, title);
    }

    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }

  // limiar de confiança: a diferença não pode ser maior que ~35% do
  // tamanho do nome buscado, senão é melhor não sugerir nada errado
  const threshold = Math.max(2, target.length * 0.35);
  return bestScore <= threshold ? best : null;
}

export const matchGame = { findBestMatch };
