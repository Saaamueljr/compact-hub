import { useState, useEffect, useMemo, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { driveSync } from "./lib/driveSync";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
import {
  Search, Plus, X, RefreshCw, Trash2, Gamepad2, Loader2,
  AlertTriangle, Settings2, History, Target, ChevronDown, ChevronUp,
  Star, Users, Trophy, Award, Bell, Clock, Info, Cpu, Pencil, LayoutGrid, List, ArrowUpDown, BookOpen,
  ZoomIn, ZoomOut, ChevronLeft, ChevronRight, Cloud, CloudOff, CloudCog, Newspaper
} from "lucide-react";

const STORAGE_KEY = "compat-hub-data";

// Client ID OAuth do Google Cloud (não é segredo — é feito pra ficar exposto
// no client-side). Gerado em console.cloud.google.com > APIs e serviços >
// Credenciais > ID do cliente OAuth (tipo "Aplicativo da Web").
const GOOGLE_DRIVE_CLIENT_ID = "872251667165-n77afe9fcmgt69lmf0b1jmbennij5cho.apps.googleusercontent.com";

const PLATFORMS = [
  { id: "steam", label: "Steam", badge: "bg-sky-900 text-sky-300 border border-sky-700" },
  { id: "epic", label: "Epic Games", badge: "bg-zinc-800 text-zinc-200 border border-zinc-600" },
  { id: "gog", label: "GOG", badge: "bg-purple-900 text-purple-300 border border-purple-700" },
  { id: "amazon", label: "Amazon Games", badge: "bg-orange-900 text-orange-300 border border-orange-700" },
  { id: "retro", label: "Retro / ISO", badge: "bg-emerald-900 text-emerald-300 border border-emerald-700" },
  { id: "other", label: "Outro", badge: "bg-zinc-800 text-zinc-300 border border-zinc-600" },
];

const TIER_META = {
  6: { label: "Excelente", dot: "bg-emerald-500", text: "text-emerald-300", border: "border-emerald-600" },
  5: { label: "Bom", dot: "bg-sky-500", text: "text-sky-300", border: "border-sky-600" },
  4: { label: "OK", dot: "bg-teal-500", text: "text-teal-300", border: "border-teal-600" },
  3: { label: "Jogável", dot: "bg-amber-500", text: "text-amber-300", border: "border-amber-600" },
  2: { label: "Ruim", dot: "bg-orange-500", text: "text-orange-300", border: "border-orange-600" },
  1: { label: "Não roda", dot: "bg-red-500", text: "text-red-300", border: "border-red-600" },
};

// Corte mínimo pra um jogo ser considerado "compatível o suficiente" com um
// hardware — usado pelo filtro "só jogos compatíveis" na tela inicial.
const MIN_PLAYABLE_TIER = 3; // "Jogável"

// Migração de escala: versões antigas iam de 1 a 5 (Não roda/Ruim/OK/Bom/
// Excelente). Agora vai de 1 a 6, com "Jogável" inserido entre Ruim e OK —
// então tudo que era 3/4/5 precisa subir um número; 1 e 2 não mudam.
function migrateTierScale(games) {
  return (games || []).map((g) => ({
    ...g,
    analyses: (g.analyses || []).map((a) => {
      if (typeof a.tier !== "number" || a.tier < 3) return a;
      const newTier = a.tier + 1;
      return { ...a, tier: newTier, tierLabel: TIER_META[newTier]?.label || a.tierLabel };
    }),
  }));
}

const RUNNING_VIA_SUGGESTIONS = [
  "Executável nativo",
  "Steam",
  "Epic Games",
  "GOG Galaxy",
  "PCSX2 (PS2)",
  "RPCS3 (PS3)",
  "Dolphin (GameCube/Wii)",
  "PPSSPP (PSP)",
  "DuckStation (PS1)",
  "Xenia (Xbox 360)",
  "Cemu (Wii U)",
  "Yuzu/Ryujinx (Switch)",
];

const STATUSES = [
  { id: "backlog", label: "Quero jogar", badge: "bg-zinc-800 text-zinc-300 border border-zinc-600" },
  { id: "playing", label: "Jogando", badge: "bg-sky-900 text-sky-300 border border-sky-700" },
  { id: "completed", label: "Zerado", badge: "bg-emerald-900 text-emerald-300 border border-emerald-700" },
  { id: "abandoned", label: "Abandonado", badge: "bg-red-900 text-red-300 border border-red-700" },
];

function statusOf(id) {
  return STATUSES.find((s) => s.id === id) || null;
}

// "Platinado" tem duas origens possíveis:
// - jogos "retro" (RA vinculado): automático, 100% das conquistas da RA.
// - qualquer outra plataforma (Steam/GOG/Epic/Amazon/Outro): o CompactHub
//   não tem como ler conquistas dessas lojas, então é uma marcação manual
//   do usuário (game.manualPlatinum) — ver botão "Platinado" no detalhe.
function isPlatinum(game) {
  if (game.platform === "retro") {
    const p = game.raProgress;
    return !!(p && p.numAchievements > 0 && p.numAwardedToUser >= p.numAchievements);
  }
  return !!game.manualPlatinum;
}

// Rótulos em português pros valores de AwardKind que a API do RA retorna
// (mastered / completed / beaten-hardcore / beaten-softcore).
const RA_AWARD_LABELS = {
  mastered: "Mastery (100% hardcore)",
  completed: "Completo (100%)",
  "beaten-hardcore": "Zerado (hardcore)",
  "beaten-softcore": "Zerado (softcore)",
};

function makeProfile(name, overrides = {}) {
  return {
    id: uid(),
    name,
    cpu: "",
    gpu: "",
    ram: "",
    os: "",
    preferences: "",
    raLinked: false,
    emulators: [],
    ...overrides,
  };
}

const DEFAULT_PROFILES = [
  {
    id: "default-profile",
    name: "Principal",
    cpu: "Core 2 Quad Q9500",
    gpu: "GTX 750 Ti 1GB",
    ram: "8GB DDR2",
    os: "Windows 10 LTSC 2019 (1809)",
    preferences:
      "Prefiro estabilidade a gráficos altos. Aceito baixar resolução/textura antes de travar fps. Não me importo de aplicar patches da comunidade quando necessário.",
    raLinked: false,
    emulators: [],
  },
];

// --- Persistência local (substitui window.storage do ambiente de artifact) ---
// Fora do Claude.ai, localStorage funciona normalmente. Os dados ficam só
// neste navegador/dispositivo — não sincronizam entre PCs. Se quiser isso,
// troque esta camada por chamadas a um backend com banco (ex: Supabase).
const storage = {
  async get(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? null : { key, value: raw };
    } catch {
      return null;
    }
  },
  async set(key, value) {
    window.localStorage.setItem(key, value);
    return { key, value };
  },
};

function platformOf(id) {
  return PLATFORMS.find((p) => p.id === id) || PLATFORMS[PLATFORMS.length - 1];
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function formatSeconds(sec) {
  if (sec === null || sec === undefined) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m}min`;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

function formatDaySpan(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const from = new Date(fromIso.replace(" ", "T"));
  const to = new Date(toIso.replace(" ", "T"));
  const days = Math.max(0, Math.round((to - from) / (1000 * 60 * 60 * 24)));
  if (days === 0) return "menos de um dia";
  return days === 1 ? "1 dia" : `${days} dias`;
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function steamCoverUrl(appId) {
  if (!appId) return null;
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
}

// Chama a Function serverless em /api/analyze — a chave do Gemini nunca
// chega no navegador, fica só no servidor (ver functions/api/analyze.js).
async function callAnalysis({ profile, game, notesText }) {
  const platformLabel = platformOf(game.platform).label;

  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, game, notesText, platformLabel }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `Falha na análise (HTTP ${response.status})`);
  }

  // O worker já faz o parse do JSON do Gemini no servidor (ver
  // handleAnalyze em worker/index.js) e devolve os campos prontos
  // (tier, veredito, motivo...), então não precisamos reparsear nada aqui.
  const data = await response.json();
  if (typeof data.tier !== "number" || !data.tierLabel) {
    throw new Error(
      `Resposta da análise veio incompleta (faltou tier/tierLabel). Recebido: ${JSON.stringify(data).slice(0, 200)}`
    );
  }
  return data;
}

// Gera um conjunto de "estrelas" com posições pseudo-aleatórias e ESTÁVEIS
// pro mesmo jogo (mesma seed = mesmo layout, mas cada jogo tem o seu, sem
// padrão repetido entre capas). Piscam de forma independente — sem nenhum
// movimento circular/uniforme entre elas.
// mode "edge": espalhadas numa faixa perto da borda (pra usar em cima da
//   capa, sem cobrir a arte do jogo).
// mode "field": espalhadas por toda a área (pra usar como fundo denso atrás
//   de texto, numa área sólida escura).
function useFrameStars(seed, count = 16, mode = "edge") {
  return useMemo(() => {
    let s = 0;
    const str = String(seed);
    for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0;
    function rand() {
      s = (s * 1103515245 + 12345) >>> 0;
      return (s % 10000) / 10000;
    }
    const stars = [];
    for (let i = 0; i < count; i++) {
      let top, left;
      if (mode === "field") {
        top = rand() * 100;
        left = rand() * 100;
      } else {
        const edge = Math.floor(rand() * 4); // 0 topo, 1 direita, 2 baixo, 3 esquerda
        const along = rand() * 100;
        const inset = 1 + rand() * 9;
        if (edge === 0) { top = inset; left = along; }
        else if (edge === 1) { top = along; left = 100 - inset; }
        else if (edge === 2) { top = 100 - inset; left = along; }
        else { top = along; left = inset; }
      }
      stars.push({
        top: `${top}%`,
        left: `${left}%`,
        size: 1 + rand() * (mode === "field" ? 1.8 : 2.2),
        delay: `${(rand() * 4.5).toFixed(2)}s`,
        duration: `${(2 + rand() * 3).toFixed(2)}s`,
      });
    }
    return stars;
  }, [seed, count, mode]);
}

const FRAME_THEMES = {
  // zerado — dourado, inspirado nos troféus (não é uma cópia literal)
  gold: {
    solid: "#d97706",
    highlight: "#fde68a",
    glow: "rgba(245, 158, 11, 0.5)",
    star: "#fff6da",
  },
  // platinado — "galáxia" azul royal profundo
  galaxy: {
    solid: "#3730a3",
    highlight: "#a5b4fc",
    glow: "rgba(79, 70, 229, 0.55)",
    star: "#e0e7ff",
  },
};

// "Platinado" (RA automático ou marcação manual) → azul-galáxia.
// "Zerado" → dourado. Usado tanto pra moldura quanto pro selo do troféu.
function frameVariantOf(game) {
  if (isPlatinum(game)) return "galaxy";
  if (game.status === "completed") return "gold";
  return null;
}

// Moldura "premium" ao redor do card INTEIRO (capa + informações), não só
// da capa — dois anéis (borda sólida + friso interno mais claro) com brilho
// e cantos arredondados de verdade (border-radius normal, sem mask/
// border-image, que não renderizavam de forma confiável em cima da capa).
function CardFrame({ variant, seed, rounded = "rounded-xl" }) {
  const theme = FRAME_THEMES[variant];
  const stars = useFrameStars(`edge-${variant}-${seed}`, 18, "edge");
  if (!theme) return null;
  return (
    <div className={`absolute inset-0 pointer-events-none z-20 ${rounded}`} aria-hidden="true">
      <div
        className={`absolute inset-0 ${rounded}`}
        style={{
          border: `3px solid ${theme.solid}`,
          boxShadow: `0 0 18px 2px ${theme.glow}, inset 0 0 16px 0 ${theme.glow}`,
        }}
      />
      <div className={`absolute inset-[3px] ${rounded}`} style={{ border: `1px solid ${theme.highlight}`, opacity: 0.6 }} />
      {stars.map((star, i) => (
        <span
          key={i}
          className="absolute rounded-full"
          style={{
            top: star.top,
            left: star.left,
            width: star.size,
            height: star.size,
            background: theme.star,
            boxShadow: `0 0 3px 1px ${theme.star}`,
            animation: `chub-twinkle ${star.duration} ease-in-out ${star.delay} infinite`,
          }}
        />
      ))}
    </div>
  );
}

// Fundo de estrelas mais denso — pra usar atrás do texto/informações do
// jogo (fundo escuro), não em cima da capa. Fica no fundo (z-0); quem usa
// precisa colocar o conteúdo de texto num wrapper "relative z-10" por cima.
function StarField({ variant, seed, count = 30 }) {
  const theme = FRAME_THEMES[variant];
  const stars = useFrameStars(`field-${variant}-${seed}`, count, "field");
  if (!theme) return null;
  return (
    <div className="absolute inset-0 pointer-events-none -z-10 overflow-hidden" aria-hidden="true">
      {stars.map((star, i) => (
        <span
          key={i}
          className="absolute rounded-full"
          style={{
            top: star.top,
            left: star.left,
            width: star.size,
            height: star.size,
            background: theme.star,
            opacity: 0.8,
            boxShadow: `0 0 2px 1px ${theme.star}`,
            animation: `chub-twinkle ${star.duration} ease-in-out ${star.delay} infinite`,
          }}
        />
      ))}
    </div>
  );
}

function CoverThumb({ game, className, frame = false }) {
  const [failed, setFailed] = useState(false);
  const hasCover = game.coverUrl && !failed;
  const variant = frame ? frameVariantOf(game) : null;
  const platinum = variant === "galaxy";

  return (
    <div className={`relative overflow-hidden bg-zinc-800 ${className}`}>
      {hasCover ? (
        <img
          src={game.coverUrl}
          alt={game.name}
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-zinc-800 to-zinc-900">
          <Gamepad2 className="w-8 h-8 text-zinc-600" />
          <span className="text-zinc-600 text-xs px-2 text-center line-clamp-2">{game.name}</span>
        </div>
      )}
      {variant && (
        <div
          className="absolute bottom-2 right-2 w-6 h-6 rounded-full bg-black/70 backdrop-blur flex items-center justify-center"
          title={platinum ? "Platinado (100% das conquistas)" : "Zerado"}
        >
          {platinum ? (
            <Award className="w-3.5 h-3.5 text-indigo-300" />
          ) : (
            <Trophy
              className="w-3.5 h-3.5 text-amber-300"
              style={{ filter: "drop-shadow(0 0 3px #f59e0b) drop-shadow(0 0 6px #f59e0b)" }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Colunas ordenáveis pela visualização em lista.
const LIST_COLUMNS = [
  { key: "name", label: "Título" },
  { key: "platform", label: "Plataforma" },
  { key: "achievements", label: "Conquistas" },
  { key: "released", label: "Lançamento" },
  { key: "progress", label: "Progresso" },
  { key: "playtime", label: "Tempo jogado" },
  { key: "timeToMaster", label: "Tempo p/ platinar" },
];

function listSortValue(game, activeProfileId, key) {
  switch (key) {
    case "name":
      return game.name.toLowerCase();
    case "platform":
      return game.raMeta?.consoleName || platformOf(game.platform).label;
    case "achievements":
      return game.raProgress ? game.raProgress.numAwardedToUser / Math.max(1, game.raProgress.numAchievements) : -1;
    case "released":
      return game.raMeta?.released || game.loreData?.released || "";
    case "progress": {
      const latest = (game.analyses || []).find((a) => !a.profileId || a.profileId === activeProfileId);
      return latest?.tier ?? -1;
    }
    case "playtime":
      return game.playtimeHours ?? -1;
    case "timeToMaster":
      return game.raProgression?.medianTimeToMasterSeconds ?? -1;
    default:
      return "";
  }
}

function ListView({ games, activeProfileId, onOpen }) {
  const [sortKey, setSortKey] = useState("name");
  const [sortDir, setSortDir] = useState("asc");

  function toggleSort(key) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sorted = [...games].sort((a, b) => {
    const va = listSortValue(a, activeProfileId, sortKey);
    const vb = listSortValue(b, activeProfileId, sortKey);
    let cmp;
    if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb), "pt-BR");
    return sortDir === "asc" ? cmp : -cmp;
  });

  return (
    <div className="border border-zinc-800 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-900 border-b border-zinc-800 text-left text-zinc-400">
              {LIST_COLUMNS.map((col) => (
                <th key={col.key} className="px-3 py-2 font-medium whitespace-nowrap">
                  <button
                    onClick={() => toggleSort(col.key)}
                    className={`flex items-center gap-1 hover:text-zinc-200 transition-colors ${
                      sortKey === col.key ? "text-zinc-100" : ""
                    }`}
                  >
                    {col.label}
                    <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((game) => {
              const latest = (game.analyses || []).find((a) => !a.profileId || a.profileId === activeProfileId);
              const gameStatus = statusOf(game.status);
              const platinum = isPlatinum(game);
              return (
                <tr
                  key={game.id}
                  onClick={() => onOpen(game.id)}
                  className="border-b border-zinc-900 last:border-0 hover:bg-zinc-900/60 cursor-pointer transition-colors"
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 min-w-[200px]">
                      <CoverThumb game={game} frame className="w-10 h-10 rounded shrink-0" />
                      <span className="font-medium truncate">{game.name}</span>
                      {platinum && <Award className="w-3.5 h-3.5 text-indigo-300 shrink-0" />}
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${platformOf(game.platform).badge}`}>
                      {game.raMeta?.consoleName || platformOf(game.platform).label}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-zinc-400">
                    {game.raProgress ? `${game.raProgress.numAwardedToUser}/${game.raProgress.numAchievements}` : "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-zinc-400">
                    {game.raMeta?.released || game.loreData?.released || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {latest ? (
                      <TierBadge tier={latest.tier} tierLabel={latest.tierLabel} />
                    ) : gameStatus ? (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${gameStatus.badge}`}>{gameStatus.label}</span>
                    ) : (
                      <span className="text-xs text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-zinc-400">
                    {game.playtimeHours != null ? `${game.playtimeHours}h` : "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-zinc-400">
                    {game.raProgression?.medianTimeToMasterSeconds
                      ? formatSeconds(game.raProgression.medianTimeToMasterSeconds)
                      : game.platform === "retro"
                      ? "abra o jogo pra buscar"
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TierBadge({ tier, tierLabel, size = "sm" }) {
  const meta = TIER_META[tier] || null;
  if (!meta) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-400 px-2.5 py-1 text-xs">
        Não analisado
      </span>
    );
  }
  const pad = size === "lg" ? "px-3 py-1.5 text-sm" : "px-2.5 py-1 text-xs";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-zinc-900 border ${meta.border} ${meta.text} ${pad}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      {tierLabel || meta.label}
    </span>
  );
}

export default function CompatHub() {
  const [profiles, setProfiles] = useState(DEFAULT_PROFILES);
  const [activeProfileId, setActiveProfileId] = useState(DEFAULT_PROFILES[0].id);
  const [games, setGames] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const [query, setQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [onlyPlatinum, setOnlyPlatinum] = useState(false);
  const [onlyCompatible, setOnlyCompatible] = useState(true);
  const [viewMode, setViewMode] = useState("grid");
  const [franchiseFilter, setFranchiseFilter] = useState("all");

  const [showAdd, setShowAdd] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showNews, setShowNews] = useState(false);
  const [activeGameId, setActiveGameId] = useState(null);

  const [analyzing, setAnalyzing] = useState({});
  const [errors, setErrors] = useState({});

  const [weeklyEvent, setWeeklyEvent] = useState(null);
  const [showWeeklyBanner, setShowWeeklyBanner] = useState(false);
  // Perfil da conta RA (avatar, rank, pontos) — só é EXIBIDO quando o perfil
  // de hardware ativo estiver marcado como vinculado ao RA (raLinked), no
  // painel de escolha de perfil. É buscado uma vez, sem depender de qual
  // perfil está ativo (é dado leve e a mesma conta serve pra qualquer perfil).
  const [raProfile, setRaProfile] = useState(null);

  // Cache de informações de franquia (lore geral + ordem recomendada de
  // jogo), gerado por IA e guardado pra não precisar buscar de novo toda
  // vez que a franquia for aberta. Chave = nome da franquia em minúsculo.
  const [franchiseNotes, setFranchiseNotes] = useState({});

  // --- Google Drive sync ---
  // 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'error'
  const [driveStatus, setDriveStatus] = useState("disconnected");
  const [driveError, setDriveError] = useState("");
  const driveInitedRef = useRef(false);
  const driveSaveTimerRef = useRef(null);

  const profile = profiles.find((p) => p.id === activeProfileId) || profiles[0];

  // Aplica um payload carregado (de localStorage OU do Drive) no estado do
  // React. Centralizado aqui porque tanto o boot normal quanto a conexão
  // com o Drive (que pode trazer um snapshot mais novo) precisam disso.
  function applyLoadedData(parsed) {
    if (!parsed) return;
    if (parsed.profiles && parsed.profiles.length > 0) {
      setProfiles(parsed.profiles);
      setActiveProfileId(parsed.activeProfileId || parsed.profiles[0].id);
    } else if (parsed.profile) {
      const migrated = [{ id: "default-profile", name: "Principal", ...parsed.profile }];
      setProfiles(migrated);
      setActiveProfileId(migrated[0].id);
    }
    const schemaVersion = parsed.tierSchemaVersion || 1;
    const loadedGames = parsed.games || [];
    setGames(schemaVersion < 2 ? migrateTierScale(loadedGames) : loadedGames);
    setFranchiseNotes(parsed.franchiseNotes || {});
  }

  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(STORAGE_KEY);
        if (res && res.value) {
          applyLoadedData(JSON.parse(res.value));
        }
      } catch {
        // sem dados salvos ainda — segue com os padrões
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // Tenta restaurar uma sessão de Drive já autorizada anteriormente (o token
  // do Google dura ~1h e fica em sessionStorage — ver driveSync.js). Se
  // existir, puxa o snapshot mais recente do Drive por cima do que acabou de
  // carregar do localStorage (o Drive é a fonte de verdade quando conectado).
  useEffect(() => {
    if (!loaded) return;
    (async () => {
      try {
        await driveSync.init(GOOGLE_DRIVE_CLIENT_ID);
        driveInitedRef.current = true;
        if (driveSync.isSignedIn()) {
          setDriveStatus("syncing");
          const remote = await driveSync.load();
          if (remote) applyLoadedData(remote);
          setDriveStatus("connected");
        }
      } catch (e) {
        // token expirado ou GIS indisponível — usuário precisa reconectar
        // manualmente, sem quebrar o app (segue funcionando local).
        setDriveStatus("disconnected");
      }
    })();
  }, [loaded]);

  async function connectDrive() {
    setDriveError("");
    setDriveStatus("connecting");
    try {
      if (!driveInitedRef.current) {
        await driveSync.init(GOOGLE_DRIVE_CLIENT_ID);
        driveInitedRef.current = true;
      }
      await driveSync.signIn();
      const { data } = await driveSync.migrateFromLocalStorageIfNeeded(STORAGE_KEY);
      if (data) applyLoadedData(data);
      setDriveStatus("connected");
    } catch (e) {
      setDriveStatus("error");
      setDriveError(e?.message || "Falha ao conectar com o Google Drive.");
    }
  }

  function disconnectDrive() {
    driveSync.signOut();
    setDriveStatus("disconnected");
  }

  // Evento da semana (Achievement of the Week) e perfil da conta do RA —
  // buscados uma vez ao abrir o app. Falha silenciosamente se o RA não
  // estiver configurado no servidor (env RA_USERNAME/RA_API_KEY). O perfil
  // do RA só é mostrado na UI quando o perfil de hardware ativo tiver
  // raLinked=true (ver painel de escolha de perfil).
  useEffect(() => {
    fetch("/api/retroachievements/week")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (body) { setWeeklyEvent(body); setShowWeeklyBanner(true); } })
      .catch(() => {});
    fetch("/api/retroachievements/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (body) setRaProfile(body); })
      .catch(() => {});
  }, []);

  async function persist(nextProfiles, nextActiveProfileId, nextGames, nextFranchiseNotes = franchiseNotes) {
    const payload = {
      profiles: nextProfiles,
      activeProfileId: nextActiveProfileId,
      games: nextGames,
      franchiseNotes: nextFranchiseNotes,
      tierSchemaVersion: 2,
    };
    try {
      await storage.set(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.error("Erro ao salvar localmente:", e);
    }
    scheduleDriveSave(payload);
  }

  // Escreve no Drive com debounce — evita disparar uma requisição a cada
  // pequena mudança (ex: editando o campo de horas jogadas tecla a tecla).
  // Só age se o usuário estiver conectado; falha silenciosamente no console
  // se o Drive der erro, já que o dado já está seguro no localStorage.
  function scheduleDriveSave(payload) {
    if (!driveSync.isSignedIn()) return;
    if (driveSaveTimerRef.current) clearTimeout(driveSaveTimerRef.current);
    driveSaveTimerRef.current = setTimeout(async () => {
      setDriveStatus("syncing");
      try {
        await driveSync.save(payload);
        setDriveStatus("connected");
      } catch (e) {
        console.error("Erro ao sincronizar com o Drive:", e);
        setDriveStatus("error");
        setDriveError(e?.message || "Falha ao sincronizar com o Google Drive.");
      }
    }, 1500);
  }

  function updateFranchiseNotes(key, data) {
    setFranchiseNotes((prev) => {
      const next = { ...prev, [key]: data };
      persist(profiles, activeProfileId, games, next);
      return next;
    });
  }

  // CORREÇÃO DE BUG (regressão de capas sumindo): antes, updateGames recebia
  // o array já pronto e updateGame fazia `games.map(...)` fechando sobre a
  // variável `games` da render atual. Quando várias atualizações disparavam
  // em sequência síncrona (ex: puxar progresso do RA, que chama capa + nome
  // + ícone uma atrás da outra), o React agrupa (batching) essas chamadas de
  // setState — só que cada uma calculava o próximo array a partir do MESMO
  // `games` antigo, então só a última sobrevivia e as outras (ex: a capa)
  // eram perdidas. A correção: aceitar uma função updater e usar a forma
  // funcional do setState, que sempre recebe o estado mais recente de
  // verdade, nunca uma cópia presa no closure.
  function updateGames(updater) {
    setGames((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      persist(profiles, activeProfileId, next);
      return next;
    });
  }

  function updateProfiles(nextProfiles, nextActiveProfileId) {
    setProfiles(nextProfiles);
    setActiveProfileId(nextActiveProfileId);
    persist(nextProfiles, nextActiveProfileId, games);
  }

  function switchProfile(id) {
    setActiveProfileId(id);
    persist(profiles, id, games);
  }

  function addGame({ name, platform, steamAppId, coverUrl, raGameId, raIconUrl, raProgress, raMeta }) {
    const finalCover = coverUrl?.trim() || steamCoverUrl(steamAppId?.trim());
    const newGame = {
      id: uid(),
      name: name.trim(),
      platform,
      steamAppId: steamAppId?.trim() || "",
      coverUrl: finalCover || "",
      goals: "",
      notes: [],
      analyses: [],
      favorite: false,
      status: null,
      franchise: "",
      runningVia: "",
      raGameId: raGameId?.trim() || "",
      raIconUrl: raIconUrl || "",
      raProgress: raProgress || null,
      raMeta: raMeta || null,
      createdAt: new Date().toISOString(),
    };
    updateGames((prev) => [newGame, ...prev]);
    setShowAdd(false);
    setActiveGameId(newGame.id);
  }

  function toggleFavorite(id) {
    const game = games.find((g) => g.id === id);
    if (!game) return;
    updateGame(id, { favorite: !game.favorite });
  }

  function setGameStatus(id, status) {
    const game = games.find((g) => g.id === id);
    if (!game) return;
    updateGame(id, { status: game.status === status ? null : status });
  }

  function removeGame(id) {
    const game = games.find((g) => g.id === id);
    const hasHistory = (game?.notes?.length || 0) > 0 || (game?.analyses?.length || 0) > 0;
    const message = hasHistory
      ? `Remover "${game.name}"? Isso apaga também o histórico de problemas e as análises salvas. Essa ação não pode ser desfeita.`
      : `Remover "${game?.name}"?`;
    if (!window.confirm(message)) return;
    updateGames((prev) => prev.filter((g) => g.id !== id));
    if (activeGameId === id) setActiveGameId(null);
  }

  function updateGame(id, patch) {
    updateGames((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }

  function addNote(id, text) {
    if (!text.trim()) return;
    const entry = { date: new Date().toISOString(), text: text.trim() };
    updateGames((prev) => prev.map((g) => (g.id === id ? { ...g, notes: [...(g.notes || []), entry] } : g)));
  }

  async function analyze(id) {
    const game = games.find((g) => g.id === id);
    if (!game) return;
    setErrors((e) => ({ ...e, [id]: null }));
    setAnalyzing((a) => ({ ...a, [id]: true }));
    try {
      const notesText = (game.notes || []).map((n) => `- ${n.text}`).join("\n");
      const result = await callAnalysis({ profile, game, notesText });
      const entry = {
        ...result,
        date: new Date().toISOString(),
        profileId: profile.id,
        profileName: profile.name,
      };
      const analyses = [entry, ...(game.analyses || [])];
      updateGame(id, { analyses });
    } catch (e) {
      setErrors((er) => ({ ...er, [id]: e.message || "Erro na análise" }));
    } finally {
      setAnalyzing((a) => ({ ...a, [id]: false }));
    }
  }

  const franchises = Array.from(new Set(games.map((g) => g.franchise).filter(Boolean))).sort();

  const filteredGames = games.filter((g) => {
    const matchesQuery = g.name.toLowerCase().includes(query.toLowerCase());
    const matchesPlatform = platformFilter === "all" || g.platform === platformFilter;
    const matchesStatus = statusFilter === "all" || g.status === statusFilter;
    const matchesFavorite = !onlyFavorites || g.favorite;
    const matchesPlatinum = !onlyPlatinum || isPlatinum(g);
    const matchesFranchise = franchiseFilter === "all" || g.franchise === franchiseFilter;
    // jogo sem análise pra ESTE perfil continua aparecendo (senão não dá pra
    // nem achar ele pra analisar) — só some quando já foi analisado e ficou
    // abaixo do corte de "jogável" nesse hardware específico.
    const latestForProfile = (g.analyses || []).find((a) => !a.profileId || a.profileId === activeProfileId);
    const matchesCompat = !onlyCompatible || !latestForProfile || latestForProfile.tier >= MIN_PLAYABLE_TIER;
    return matchesQuery && matchesPlatform && matchesStatus && matchesFavorite && matchesPlatinum && matchesFranchise && matchesCompat;
  });

  const activeGame = games.find((g) => g.id === activeGameId) || null;

  // Dashboard: contadores simples, calculados só com base no perfil de hardware
  // ativo no momento (uma análise feita no PC Retrô não deveria contar como
  // "excelente" quando você está olhando o perfil do PC Principal).
  const stats = games.reduce(
    (acc, g) => {
      acc.total += 1;
      const latest = (g.analyses || []).find((a) => !a.profileId || a.profileId === activeProfileId);
      if (latest) {
        acc.analyzed += 1;
        if (latest.tier === 6) acc.excellent += 1;
        else if (latest.tier === 5) acc.good += 1;
        else if (latest.tier === 4) acc.ok += 1;
        else if (latest.tier === 3) acc.playable += 1;
        else if (latest.tier === 2) acc.bad += 1;
        else if (latest.tier === 1) acc.incompatible += 1;
      }
      return acc;
    },
    { total: 0, analyzed: 0, excellent: 0, good: 0, ok: 0, playable: 0, bad: 0, incompatible: 0 }
  );

  if (!loaded) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-zinc-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* notificação: evento da semana do RetroAchievements (Achievement of
          the Week) — topo cheio no celular, canto superior direito no web */}
      {showWeeklyBanner && weeklyEvent && (
        <div className="fixed top-3 inset-x-3 sm:inset-x-auto sm:right-4 sm:left-auto sm:w-80 z-40">
          <div className="flex items-start gap-3 bg-zinc-900 border border-indigo-700 rounded-xl p-3 shadow-lg shadow-black/40">
            {weeklyEvent.badgeUrl && (
              <img src={weeklyEvent.badgeUrl} alt="" className="w-10 h-10 rounded shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-xs text-indigo-300 font-medium mb-0.5">
                <Bell className="w-3.5 h-3.5" /> Conquista da semana
              </p>
              <p className="text-sm font-medium truncate">{weeklyEvent.achievementTitle}</p>
              {weeklyEvent.gameTitle && (
                <p className="text-xs text-zinc-500 truncate">{weeklyEvent.gameTitle}</p>
              )}
            </div>
            <button
              onClick={() => setShowWeeklyBanner(false)}
              className="text-zinc-500 hover:text-zinc-200 transition-colors shrink-0"
              aria-label="Fechar notificação"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* header */}
      <div className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-5 py-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
              <Gamepad2 className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-none">Compat Hub</h1>
              <p className="text-xs text-zinc-500 leading-none mt-1">sua biblioteca × seu hardware</p>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-2 ml-2">
            <ProfileSwitcher
              profiles={profiles}
              activeProfileId={activeProfileId}
              raProfile={raProfile}
              onSwitch={switchProfile}
            />
            <span className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-xs text-zinc-400">{profile.cpu}</span>
            <span className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-xs text-zinc-400">{profile.gpu}</span>
            <span className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-xs text-zinc-400">{profile.ram}</span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setShowNews(true)}
              className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 border border-zinc-800 hover:border-zinc-600 rounded-md px-3 py-1.5 transition-colors"
            >
              <Newspaper className="w-3.5 h-3.5" />
              Notícias
            </button>

            <DriveSyncButton
              status={driveStatus}
              error={driveError}
              onConnect={connectDrive}
              onDisconnect={disconnectDrive}
            />

          <button
            onClick={() => setShowProfile(true)}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 border border-zinc-800 hover:border-zinc-600 rounded-md px-3 py-1.5 transition-colors"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Perfis de hardware
          </button>
          </div>
        </div>
      </div>

      {/* dashboard simples */}
      {stats.total > 0 && (
        <div className="max-w-6xl mx-auto px-5 pt-5">
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300">
              <b className="text-zinc-100">{stats.total}</b> jogos
            </span>
            <span className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400">
              <b className="text-zinc-200">{stats.analyzed}</b> analisados
            </span>
            {stats.excellent > 0 && (
              <span className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-emerald-800 text-emerald-300">
                <b>{stats.excellent}</b> excelentes
              </span>
            )}
            {stats.good > 0 && (
              <span className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-sky-800 text-sky-300">
                <b>{stats.good}</b> bons
              </span>
            )}
            {stats.ok > 0 && (
              <span className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-teal-800 text-teal-300">
                <b>{stats.ok}</b> ok
              </span>
            )}
            {stats.playable > 0 && (
              <span className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-amber-800 text-amber-300">
                <b>{stats.playable}</b> jogáveis
              </span>
            )}
            {stats.bad > 0 && (
              <span className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-orange-800 text-orange-300">
                <b>{stats.bad}</b> ruins
              </span>
            )}
            {stats.incompatible > 0 && (
              <span className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-red-800 text-red-300">
                <b>{stats.incompatible}</b> incompatíveis
              </span>
            )}
          </div>
        </div>
      )}

      {/* toolbar */}
      <div className="max-w-6xl mx-auto px-5 pt-6 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 flex-1 min-w-56">
          <Search className="w-4 h-4 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar na sua biblioteca..."
            className="bg-transparent outline-none text-sm w-full placeholder:text-zinc-600"
          />
        </div>

        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-300 outline-none"
        >
          <option value="all">Todas as plataformas</option>
          {PLATFORMS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-300 outline-none"
        >
          <option value="all">Todos os status</option>
          {STATUSES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>

        {franchises.length > 0 && (
          <select
            value={franchiseFilter}
            onChange={(e) => setFranchiseFilter(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-300 outline-none"
          >
            <option value="all">Todas as franquias</option>
            {franchises.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        )}

        <button
          onClick={() => setOnlyFavorites(!onlyFavorites)}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm border transition-colors ${
            onlyFavorites
              ? "bg-amber-900/40 border-amber-700 text-amber-300"
              : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Star className={`w-4 h-4 ${onlyFavorites ? "fill-amber-400" : ""}`} />
          Favoritos
        </button>

        <button
          onClick={() => setOnlyPlatinum(!onlyPlatinum)}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm border transition-colors ${
            onlyPlatinum
              ? "bg-amber-900/40 border-amber-700 text-amber-300"
              : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Award className="w-4 h-4" />
          Platinados
        </button>

        <button
          onClick={() => setOnlyCompatible(!onlyCompatible)}
          title={`Esconde jogos já analisados abaixo de "${TIER_META[MIN_PLAYABLE_TIER].label}" no perfil ativo (${profile.name})`}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm border transition-colors ${
            onlyCompatible
              ? "bg-teal-900/40 border-teal-700 text-teal-300"
              : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Cpu className="w-4 h-4" />
          Compatíveis com {profile.name}
        </button>

        <div className="flex items-center rounded-lg border border-zinc-800 overflow-hidden ml-auto sm:ml-0">
          <button
            onClick={() => setViewMode("grid")}
            title="Visualização em grade"
            className={`p-2 transition-colors ${viewMode === "grid" ? "bg-zinc-800 text-zinc-100" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"}`}
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button
            onClick={() => setViewMode("list")}
            title="Visualização em lista"
            className={`p-2 transition-colors ${viewMode === "list" ? "bg-zinc-800 text-zinc-100" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"}`}
          >
            <List className="w-4 h-4" />
          </button>
        </div>

        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 transition-colors text-white text-sm font-medium rounded-lg px-4 py-2"
        >
          <Plus className="w-4 h-4" />
          Adicionar jogo
        </button>
      </div>

      {/* painel de franquia — aparece quando um filtro de franquia específico
          está selecionado, com lore geral + ordem recomendada (cacheado) */}
      {franchiseFilter !== "all" && (
        <div className="max-w-6xl mx-auto px-5 pt-2">
          <p className="text-xs text-zinc-500 mb-1.5">Franquia: <span className="text-zinc-300">{franchiseFilter}</span></p>
          <FranchiseOrderSection
            franchise={franchiseFilter}
            games={games}
            cached={franchiseNotes[franchiseFilter.toLowerCase()]}
            onSave={(data) => updateFranchiseNotes(franchiseFilter.toLowerCase(), data)}
          />
        </div>
      )}

      {/* grid / lista */}
      <div className="max-w-6xl mx-auto px-5 py-6">
        {filteredGames.length === 0 ? (
          <div className="border border-dashed border-zinc-800 rounded-xl py-16 flex flex-col items-center gap-3 text-center">
            <Gamepad2 className="w-8 h-8 text-zinc-700" />
            <p className="text-zinc-500 text-sm max-w-sm">
              {games.length === 0
                ? "Sua biblioteca está vazia. Adicione um jogo da Steam, Epic, GOG, Amazon Games ou de qualquer outro lugar pra começar a analisar."
                : "Nenhum jogo encontrado com esse filtro."}
            </p>
            {games.length === 0 && (
              <button
                onClick={() => setShowAdd(true)}
                className="mt-2 flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 transition-colors text-white text-sm font-medium rounded-lg px-4 py-2"
              >
                <Plus className="w-4 h-4" /> Adicionar primeiro jogo
              </button>
            )}
          </div>
        ) : viewMode === "list" ? (
          <ListView games={filteredGames} activeProfileId={activeProfileId} onOpen={setActiveGameId} />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filteredGames.map((game) => {
              const latest = (game.analyses || []).find((a) => !a.profileId || a.profileId === activeProfileId);
              const gameStatus = statusOf(game.status);
              const variant = frameVariantOf(game);
              return (
                <div
                  key={game.id}
                  className="text-left group rounded-xl overflow-hidden border border-zinc-800 bg-zinc-900 hover:border-zinc-600 transition-colors relative"
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleFavorite(game.id); }}
                    className="absolute top-2 left-2 z-30 w-7 h-7 rounded-full bg-black/60 backdrop-blur flex items-center justify-center hover:bg-black/80 transition-colors"
                    aria-label="Favoritar"
                  >
                    <Star className={`w-3.5 h-3.5 ${game.favorite ? "fill-amber-400 text-amber-400" : "text-zinc-300"}`} />
                  </button>
                  <button onClick={() => setActiveGameId(game.id)} className="text-left w-full">
                    <div className="relative">
                      <CoverThumb game={game} frame className="aspect-video group-hover:opacity-90 transition-opacity" />
                      <div className="absolute top-2 right-2 z-30">
                        <TierBadge tier={latest?.tier} tierLabel={latest?.tierLabel} />
                      </div>
                    </div>
                    <div className="relative overflow-hidden p-3">
                      {variant && <StarField variant={variant} seed={game.id} count={22} />}
                      <div className="relative z-10">
                        <p className="text-sm font-medium line-clamp-1 flex items-center gap-1.5">
                          {game.name}
                          {game.guideUrl && <BookOpen className="w-3 h-3 text-zinc-500 shrink-0" />}
                        </p>
                        {(game.raProgress || game.runningVia) && (
                          <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                            {game.raProgress && (
                              <span className="flex items-center gap-1">
                                <Trophy className="w-3 h-3 text-amber-500" />
                                {game.raProgress.numAwardedToUser}/{game.raProgress.numAchievements}
                              </span>
                            )}
                            {game.runningVia && <span className="truncate">{game.runningVia}</span>}
                          </div>
                        )}
                        <div className="flex items-center justify-between mt-2 gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${platformOf(game.platform).badge}`}>
                            {platformOf(game.platform).label}
                          </span>
                          {gameStatus && (
                            <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${gameStatus.badge}`}>
                              {gameStatus.label}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                  {variant && <CardFrame variant={variant} seed={game.id} rounded="rounded-xl" />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* modal: adicionar jogo */}
      {showAdd && <AddGameModal games={games} onClose={() => setShowAdd(false)} onAdd={addGame} />}

      {/* modal: perfis de hardware */}
      {showProfile && (
        <ProfileModal
          profiles={profiles}
          activeProfileId={activeProfileId}
          games={games}
          raProfile={raProfile}
          onClose={() => setShowProfile(false)}
          onSave={(nextProfiles, nextActiveId) => { updateProfiles(nextProfiles, nextActiveId); setShowProfile(false); }}
        />
      )}

      {/* modal: notícias e wiki (estilo revista) */}
      {showNews && <NewsModal onClose={() => setShowNews(false)} />}

      {/* modal: detalhe do jogo */}
      {activeGame && (
        <GameDetailModal
          game={activeGame}
          games={games}
          analyzing={!!analyzing[activeGame.id]}
          error={errors[activeGame.id]}
          activeProfileId={activeProfileId}
          activeProfileName={profile.name}
          profiles={profiles}
          onClose={() => setActiveGameId(null)}
          onAnalyze={() => analyze(activeGame.id)}
          onAddNote={(text) => addNote(activeGame.id, text)}
          onUpdateGoals={(goals) => updateGame(activeGame.id, { goals })}
          onToggleFavorite={() => toggleFavorite(activeGame.id)}
          onSetStatus={(status) => setGameStatus(activeGame.id, status)}
          onToggleManualPlatinum={() => updateGame(activeGame.id, { manualPlatinum: !activeGame.manualPlatinum })}
          onUpdateRaGameId={(raGameId) => updateGame(activeGame.id, { raGameId })}
          onUpdateRunningVia={(runningVia) => updateGame(activeGame.id, { runningVia })}
          onUpdateFranchise={(franchise) => updateGame(activeGame.id, { franchise })}
          onUpdateName={(name) => updateGame(activeGame.id, { name })}
          onUpdatePlatform={(platform) => updateGame(activeGame.id, { platform })}
          onUpdatePlaytime={(playtimeHours) => updateGame(activeGame.id, { playtimeHours })}
          onUpdateGuideUrl={(guideUrl) => updateGame(activeGame.id, { guideUrl })}
          onSaveTranslations={(raTranslations) => updateGame(activeGame.id, { raTranslations })}
          onApplyRaData={(patch) => updateGame(activeGame.id, patch)}
          franchiseNotes={franchiseNotes}
          onUpdateFranchiseNotes={updateFranchiseNotes}
          onRemove={() => removeGame(activeGame.id)}
        />
      )}
    </div>
  );
}

// Leitor de PDF embutido (detonados/revistas digitais vinculados via link do
// Drive). Usa PDF.js — renderiza só a página atual num canvas, então
// carrega rápido mesmo em PDFs grandes (revista inteira escaneada), com zoom
// de verdade em vez do preview truncado do Drive.
function PdfReaderModal({ url, title, onClose }) {
  const [doc, setDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(1.4);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [turning, setTurning] = useState(false);
  const [error, setError] = useState("");
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const touchStartX = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const proxyUrl = `/api/pdf-proxy?url=${encodeURIComponent(url)}`;
    pdfjsLib
      .getDocument(proxyUrl)
      .promise.then((pdf) => {
        if (cancelled) return;
        setDoc(pdf);
        setNumPages(pdf.numPages);
        setPageNum(1);
        setPageInput("1");
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message || "Não foi possível abrir o PDF.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    setRendering(true);
    // se trocar de página/zoom rápido, cancela a renderização anterior em
    // vez de deixar acumular — evita travar em PDFs grandes.
    if (renderTaskRef.current) {
      try {
        renderTaskRef.current.cancel();
      } catch {
        // ok cancelar uma renderização que já tinha terminado
      }
    }
    doc.getPage(pageNum).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");

      // Correção de nitidez: sem isso, o canvas renderiza em resolução
      // "lógica" (CSS) e a tela redimensiona/borra em qualquer monitor com
      // devicePixelRatio > 1 (praticamente todo mundo hoje). Renderiza na
      // resolução FÍSICA da tela e escala de volta via CSS.
      const outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

      const task = page.render({ canvasContext: ctx, viewport, transform });
      renderTaskRef.current = task;
      task.promise
        .then(() => {
          if (!cancelled) {
            setRendering(false);
            setTurning(false);
          }
        })
        .catch(() => {
          if (!cancelled) setRendering(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [doc, pageNum, scale]);

  function goToPage(n) {
    const clamped = Math.max(1, Math.min(numPages, n));
    if (clamped === pageNum) return;
    setTurning(true);
    setPageNum(clamped);
    setPageInput(String(clamped));
  }

  // navegação por teclado — setas do lado, como num leitor de verdade
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "ArrowRight") goToPage(pageNum + 1);
      if (e.key === "ArrowLeft") goToPage(pageNum - 1);
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum, numPages]);

  // clique na própria página: metade direita = próxima, esquerda = anterior
  // — é assim que qualquer leitor de revista/quadrinho funciona, bem mais
  // natural que só os botõezinhos lá em cima.
  function handlePageClick(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    if (clickX > rect.width / 2) goToPage(pageNum + 1);
    else goToPage(pageNum - 1);
  }

  function handleTouchStart(e) {
    touchStartX.current = e.touches[0].clientX;
  }
  function handleTouchEnd(e) {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(delta) > 50) {
      if (delta < 0) goToPage(pageNum + 1);
      else goToPage(pageNum - 1);
    }
    touchStartX.current = null;
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/90 flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 bg-zinc-950 border-b border-zinc-800 shrink-0">
        <BookOpen className="w-4 h-4 text-zinc-500 shrink-0" />
        <p className="text-sm text-zinc-300 truncate flex-1 min-w-0">{title}</p>

        {numPages > 0 && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => goToPage(pageNum - 1)}
              disabled={pageNum <= 1}
              className="p-1.5 rounded hover:bg-zinc-800 disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <input
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") goToPage(Number(pageInput) || 1); }}
              onBlur={() => goToPage(Number(pageInput) || 1)}
              className="w-12 bg-zinc-900 border border-zinc-800 rounded px-1.5 py-1 text-xs text-center outline-none focus:border-indigo-600"
            />
            <span className="text-xs text-zinc-500">/ {numPages}</span>
            <button
              onClick={() => goToPage(pageNum + 1)}
              disabled={pageNum >= numPages}
              className="p-1.5 rounded hover:bg-zinc-800 disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="flex items-center gap-1.5 shrink-0 border-l border-zinc-800 pl-2.5 ml-1">
          <button onClick={() => setScale((s) => Math.max(0.4, s - 0.2))} className="p-1.5 rounded hover:bg-zinc-800 transition-colors">
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-zinc-500 w-10 text-center">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale((s) => Math.min(4, s + 0.2))} className="p-1.5 rounded hover:bg-zinc-800 transition-colors">
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>

        <button onClick={onClose} className="p-1.5 rounded hover:bg-zinc-800 transition-colors ml-1 shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-auto flex items-start justify-center p-4">
        {loading && (
          <div className="flex flex-col items-center gap-2 text-zinc-500 mt-20">
            <Loader2 className="w-6 h-6 animate-spin" />
            <p className="text-sm">Abrindo revista...</p>
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center gap-2 text-center mt-20 max-w-sm">
            <AlertTriangle className="w-6 h-6 text-rose-400" />
            <p className="text-sm text-rose-400">{error}</p>
            <p className="text-xs text-zinc-600">
              Confira se o link do Drive está compartilhado como "qualquer pessoa com o link pode ver".
            </p>
          </div>
        )}
        {!loading && !error && (
          <div
            className="relative select-none cursor-pointer"
            onClick={handlePageClick}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            title="Clique na direita pra avançar, na esquerda pra voltar (ou use as setas do teclado)"
          >
            {rendering && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 z-10">
                <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
              </div>
            )}
            <canvas
              ref={canvasRef}
              className={`shadow-2xl shadow-black/60 bg-white transition-all duration-200 ${
                turning ? "opacity-40 scale-[0.985]" : "opacity-100 scale-100"
              }`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ModalShell({ children, onClose, maxW = "max-w-lg", frameVariant, frameSeed }) {
  return (
    <div className="fixed inset-0 z-30 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className={`relative w-full ${maxW} max-h-screen`}>
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-h-screen overflow-y-auto">
          {children}
        </div>
        {/* a moldura fica num wrapper à parte (não-scrollável) do lado de
            fora do conteúdo, senão ela rolaria junto com o scroll interno
            do modal em vez de ficar fixa ao redor do card inteiro */}
        {frameVariant && <CardFrame variant={frameVariant} seed={frameSeed} rounded="rounded-2xl" />}
      </div>
      <button
        onClick={onClose}
        className="fixed top-5 right-5 text-zinc-400 hover:text-white transition-colors"
        aria-label="Fechar"
      >
        <X className="w-5 h-5" />
      </button>
    </div>
  );
}

// Cor por fonte, no mesmo espírito do badge de plataforma — cada fonte tem
// uma identidade visual fixa, então a "revista" fica escaneável de longe.
const NEWS_SOURCE_META = {
  IGN: { badge: "bg-red-900/60 text-red-300 border border-red-700" },
  Eurogamer: { badge: "bg-purple-900/60 text-purple-300 border border-purple-700" },
  Steam: { badge: "bg-sky-900/60 text-sky-300 border border-sky-700" },
};

function sourceMeta(source) {
  return NEWS_SOURCE_META[source] || { badge: "bg-zinc-800 text-zinc-300 border border-zinc-700" };
}

function timeAgo(pubDate) {
  if (!pubDate) return null;
  const ts = Date.parse(pubDate);
  if (Number.isNaN(ts)) return null;
  const diffMs = Date.now() - ts;
  const hours = Math.floor(diffMs / 3600000);
  if (hours < 1) return "agora há pouco";
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  return `há ${days}d`;
}

// Painel de notícias estilo "revista": manchete grande em destaque + grid de
// cards com foto, fonte e resumo. Alimentado por /api/news (RSS agregado,
// sem chave de API necessária — ver worker/index.js).
function NewsModal({ onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [feedErrors, setFeedErrors] = useState([]);
  const [activeSource, setActiveSource] = useState("all");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch("/api/news");
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Falha ao carregar notícias.");
        setItems(body.items || []);
        setFeedErrors(body.feedErrors || []);
      } catch (e) {
        setError(e.message || "Falha ao carregar notícias.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const sources = useMemo(() => Array.from(new Set(items.map((i) => i.source))), [items]);
  const filtered = activeSource === "all" ? items : items.filter((i) => i.source === activeSource);
  const [hero, ...rest] = filtered;

  return (
    <ModalShell onClose={onClose} maxW="max-w-4xl">
      <div className="p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
            <Newspaper className="w-5 h-5 text-zinc-400" />
            Notícias &amp; wiki
          </h2>
        </div>

        {sources.length > 1 && (
          <div className="flex flex-wrap gap-2 mb-5">
            <button
              onClick={() => setActiveSource("all")}
              className={`text-xs rounded-full px-3 py-1 border transition-colors ${
                activeSource === "all"
                  ? "bg-zinc-100 text-zinc-900 border-zinc-100"
                  : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200"
              }`}
            >
              Todas
            </button>
            {sources.map((s) => (
              <button
                key={s}
                onClick={() => setActiveSource(s)}
                className={`text-xs rounded-full px-3 py-1 border transition-colors ${
                  activeSource === s
                    ? "bg-zinc-100 text-zinc-900 border-zinc-100"
                    : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-16 text-zinc-500 gap-2 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Carregando notícias...
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center gap-2 text-sm text-red-300 bg-red-950/40 border border-red-900 rounded-lg px-4 py-3">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <p className="text-sm text-zinc-500 py-10 text-center">Nenhuma notícia encontrada no momento.</p>
        )}

        {!loading && !error && hero && (
          <a
            href={hero.link}
            target="_blank"
            rel="noreferrer"
            className="group block rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950 mb-5"
          >
            <div className="relative aspect-[21/9] bg-zinc-900">
              {hero.image ? (
                <img
                  src={hero.image}
                  alt=""
                  className="w-full h-full object-cover group-hover:opacity-90 transition-opacity"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Newspaper className="w-10 h-10 text-zinc-700" />
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-5">
                <span className={`inline-block text-[11px] font-medium rounded-full px-2.5 py-1 mb-2 ${sourceMeta(hero.source).badge}`}>
                  {hero.source}
                </span>
                <h3 className="text-white text-xl font-semibold leading-snug">{hero.title}</h3>
                {timeAgo(hero.pubDate) && (
                  <p className="text-zinc-300 text-xs mt-1">{timeAgo(hero.pubDate)}</p>
                )}
              </div>
            </div>
          </a>
        )}

        {!loading && !error && rest.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {rest.map((item, i) => (
              <a
                key={`${item.link}-${i}`}
                href={item.link}
                target="_blank"
                rel="noreferrer"
                className="group flex gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 hover:border-zinc-600 transition-colors"
              >
                <div className="w-24 h-16 shrink-0 rounded-md overflow-hidden bg-zinc-900">
                  {item.image ? (
                    <img src={item.image} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Newspaper className="w-5 h-5 text-zinc-700" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex flex-col">
                  <span className={`inline-block self-start text-[10px] font-medium rounded-full px-2 py-0.5 mb-1 ${sourceMeta(item.source).badge}`}>
                    {item.source}
                  </span>
                  <p className="text-sm text-zinc-200 font-medium leading-snug line-clamp-2 group-hover:text-white">
                    {item.title}
                  </p>
                  {timeAgo(item.pubDate) && (
                    <p className="text-[11px] text-zinc-500 mt-auto pt-1">{timeAgo(item.pubDate)}</p>
                  )}
                </div>
              </a>
            ))}
          </div>
        )}

        {!loading && feedErrors.length > 0 && (
          <p className="text-[11px] text-zinc-600 mt-5">
            Algumas fontes falharam ao carregar: {feedErrors.join(" · ")}
          </p>
        )}
      </div>
    </ModalShell>
  );
}

function AddGameModal({ games, onClose, onAdd }) {
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("steam");
  const [steamAppId, setSteamAppId] = useState("");
  const [coverUrl, setCoverUrl] = useState("");
  const [searchingCover, setSearchingCover] = useState(false);
  const [coverSearchError, setCoverSearchError] = useState("");

  const [raGameId, setRaGameId] = useState("");
  const [raData, setRaData] = useState(null);
  const [searchingRa, setSearchingRa] = useState(false);
  const [raError, setRaError] = useState("");

  const previewCover = raData?.boxArtUrl || coverUrl.trim() || steamCoverUrl(steamAppId.trim());

  const trimmedName = name.trim().toLowerCase();
  const duplicate = trimmedName
    ? (games || []).find((g) => g.name.trim().toLowerCase() === trimmedName)
    : null;

  // Pra jogos Retro/ISO, o ID do RA já traz tudo de uma vez: título oficial,
  // capa, ícone e progresso de conquistas — sem precisar de um segundo passo
  // depois de criar o jogo.
  async function searchRaGame() {
    if (!raGameId.trim()) return;
    setSearchingRa(true);
    setRaError("");
    try {
      const res = await fetch(`/api/retroachievements?gameId=${encodeURIComponent(raGameId.trim())}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
      setRaData(body);
      if (!name.trim()) setName(body.gameTitle);
    } catch (e) {
      setRaError(e.message);
      setRaData(null);
    } finally {
      setSearchingRa(false);
    }
  }

  // GOG/Epic/Amazon não têm um "ID" público consultável pra puxar capa —
  // então buscamos pelo NOME no SteamGridDB (banco comunitário de capas,
  // cobre praticamente qualquer jogo de qualquer loja).
  async function searchCoverArt() {
    if (!name.trim()) return;
    setSearchingCover(true);
    setCoverSearchError("");
    try {
      const res = await fetch(`/api/coverart?name=${encodeURIComponent(name.trim())}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
      setCoverUrl(body.coverUrl);
    } catch (e) {
      setCoverSearchError(e.message);
    } finally {
      setSearchingCover(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <div className="p-6">
        <h2 className="text-base font-semibold mb-1">Adicionar jogo</h2>
        <p className="text-xs text-zinc-500 mb-5">Steam, Epic, GOG, Amazon Games, ISO retrô — qualquer plataforma.</p>

        <div className="aspect-video w-full rounded-lg overflow-hidden bg-zinc-800 mb-4 flex items-center justify-center">
          {previewCover ? (
            <img src={previewCover} alt="" className="w-full h-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
          ) : (
            <Gamepad2 className="w-8 h-8 text-zinc-600" />
          )}
        </div>

        <label className="text-xs text-zinc-400 mb-1 block">Nome do jogo</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ex: Mafia III: Definitive Edition"
          className={`w-full bg-zinc-950 border rounded-lg px-3 py-2 text-sm outline-none ${
            duplicate ? "border-amber-600 focus:border-amber-500" : "border-zinc-800 focus:border-indigo-600"
          } ${duplicate ? "mb-2" : "mb-4"}`}
        />
        {duplicate && (
          <p className="flex items-start gap-1.5 text-xs text-amber-300 mb-4">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            Você já tem "{duplicate.name}" na biblioteca. Pode adicionar mesmo assim se for uma versão/plataforma diferente.
          </p>
        )}

        <label className="text-xs text-zinc-400 mb-1 block">Plataforma</label>
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm mb-4 outline-none"
        >
          {PLATFORMS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        {platform === "steam" && (
          <>
            <label className="text-xs text-zinc-400 mb-1 block">Steam App ID (opcional, puxa a capa automaticamente)</label>
            <input
              value={steamAppId}
              onChange={(e) => setSteamAppId(e.target.value)}
              placeholder="ex: 1091500"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm mb-4 outline-none focus:border-indigo-600"
            />
          </>
        )}

        <label className="text-xs text-zinc-400 mb-1 block">URL da capa (opcional — sobrescreve a automática)</label>
        <input
          value={coverUrl}
          onChange={(e) => setCoverUrl(e.target.value)}
          placeholder="https://..."
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
        />

        {platform !== "retro" && (
          <div className="mb-6 mt-2">
            <button
              type="button"
              disabled={!name.trim() || searchingCover}
              onClick={searchCoverArt}
              className="flex items-center gap-1.5 text-xs text-indigo-300 hover:text-indigo-200 disabled:opacity-40 transition-colors"
            >
              {searchingCover ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              Buscar capa automaticamente (SteamGridDB, pelo nome)
            </button>
            {coverSearchError && (
              <p className="flex items-center gap-1.5 text-xs text-rose-400 mt-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {coverSearchError}
              </p>
            )}
          </div>
        )}
        {platform === "retro" && (
          <div className="mb-6 mt-2">
            <label className="text-xs text-zinc-400 mb-1 block">ID do jogo no RetroAchievements</label>
            <div className="flex gap-2">
              <input
                value={raGameId}
                onChange={(e) => { setRaGameId(e.target.value); setRaData(null); }}
                placeholder="ex: 1163"
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
              />
              <button
                type="button"
                disabled={!raGameId.trim() || searchingRa}
                onClick={searchRaGame}
                className="flex items-center gap-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 px-3 rounded-lg transition-colors"
              >
                {searchingRa ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                Buscar
              </button>
            </div>
            {raError && (
              <p className="flex items-center gap-1.5 text-xs text-rose-400 mt-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {raError}
              </p>
            )}
            {raData && (
              <p className="flex items-center gap-1.5 text-xs text-emerald-400 mt-1.5">
                {raData.imageIcon && <img src={raData.imageIcon} alt="" className="w-4 h-4 rounded" />}
                {raData.gameTitle} · {raData.consoleName} · {raData.numAchievements} conquistas
              </p>
            )}
            <p className="text-xs text-zinc-600 mt-1">
              O ID é o número que aparece na URL da página do jogo em retroachievements.org/game/&lt;ID&gt;.
              Traz título, capa, ícone e progresso automaticamente.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-200 px-4 py-2 transition-colors">
            Cancelar
          </button>
          <button
            disabled={!name.trim()}
            onClick={() => onAdd({
              name,
              platform,
              steamAppId,
              coverUrl: raData?.boxArtUrl || coverUrl,
              raGameId: raData ? raGameId : "",
              raIconUrl: raData?.imageIcon || "",
              raProgress: raData
                ? { numAwardedToUser: raData.numAwardedToUser, numAchievements: raData.numAchievements }
                : null,
              raMeta: raData
                ? { developer: raData.developer, publisher: raData.publisher, genre: raData.genre, released: raData.released }
                : null,
            })}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 transition-colors text-white text-sm font-medium rounded-lg px-4 py-2"
          >
            Adicionar
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// Dropdown customizado pra trocar de perfil de hardware (substitui o
// <select> nativo, que não permite mostrar imagem/avatar nas opções). O
// perfil marcado como raLinked mostra o avatar da conta RA em vez do ícone
// genérico — tanto no botão (quando ativo) quanto na lista.
// Botão + dropdown de status da sincronização com o Google Drive. Fica no
// header, ao lado de "Perfis de hardware". Estados possíveis: desconectado
// (botão neutro "Conectar Drive"), conectando, sincronizado (nuvem verde),
// sincronizando (nuvem girando) e erro (nuvem vermelha + tooltip do erro).
function DriveSyncButton({ status, error, onConnect, onDisconnect }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  if (status === "disconnected") {
    return (
      <button
        onClick={onConnect}
        className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 border border-zinc-800 hover:border-zinc-600 rounded-md px-3 py-1.5 transition-colors"
      >
        <CloudOff className="w-3.5 h-3.5" />
        Conectar Drive
      </button>
    );
  }

  const isSyncing = status === "connecting" || status === "syncing";
  const isError = status === "error";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={isError ? error : isSyncing ? "Sincronizando..." : "Sincronizado com o Google Drive"}
        className={`flex items-center gap-1.5 text-xs border rounded-md px-3 py-1.5 transition-colors ${
          isError
            ? "text-red-300 border-red-800 hover:border-red-600"
            : "text-emerald-300 border-emerald-800 hover:border-emerald-600"
        }`}
      >
        {isSyncing ? (
          <CloudCog className="w-3.5 h-3.5 animate-spin" />
        ) : isError ? (
          <CloudOff className="w-3.5 h-3.5" />
        ) : (
          <Cloud className="w-3.5 h-3.5" />
        )}
        Drive
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-56 bg-zinc-950 border border-zinc-800 rounded-lg shadow-xl p-3 z-30 text-xs">
          <p className="text-zinc-300 mb-2">
            {isError
              ? error || "Erro ao sincronizar com o Drive."
              : isSyncing
              ? "Sincronizando sua biblioteca..."
              : "Sua biblioteca está sincronizada com o Google Drive."}
          </p>
          <button
            onClick={() => {
              onDisconnect();
              setOpen(false);
            }}
            className="w-full text-left text-zinc-400 hover:text-red-300 transition-colors"
          >
            Desconectar
          </button>
        </div>
      )}
    </div>
  );
}

function ProfileSwitcher({ profiles, activeProfileId, raProfile, onSwitch }) {
  const [open, setOpen] = useState(false);
  const active = profiles.find((p) => p.id === activeProfileId) || profiles[0];
  const activeIsRaLinked = active?.raLinked && raProfile?.avatarUrl;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-md pl-1.5 pr-2 py-1 text-xs text-zinc-300 hover:border-zinc-600 transition-colors max-w-[160px]"
      >
        {activeIsRaLinked ? (
          <img src={raProfile.avatarUrl} alt="" className="w-5 h-5 rounded-full ring-1 ring-indigo-400" />
        ) : (
          <span className="w-5 h-5 rounded-full bg-zinc-800 flex items-center justify-center">
            <Users className="w-3 h-3 text-zinc-500" />
          </span>
        )}
        <span className="truncate">{active?.name}</span>
        <ChevronDown className="w-3 h-3 shrink-0 text-zinc-500" />
      </button>

      {open && (
        <>
          {/* overlay só pra fechar ao clicar fora — não usa listener global */}
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-40 min-w-[180px] bg-zinc-900 border border-zinc-800 rounded-lg shadow-lg shadow-black/40 py-1">
            {profiles.map((p) => {
              const showAvatar = p.raLinked && raProfile?.avatarUrl;
              return (
                <button
                  key={p.id}
                  onClick={() => { onSwitch(p.id); setOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-zinc-800 transition-colors ${
                    p.id === activeProfileId ? "text-indigo-300" : "text-zinc-300"
                  }`}
                >
                  {showAvatar ? (
                    <img src={raProfile.avatarUrl} alt="" className="w-5 h-5 rounded-full ring-1 ring-indigo-400 shrink-0" />
                  ) : (
                    <span className="w-5 h-5 rounded-full bg-zinc-800 flex items-center justify-center shrink-0">
                      <Users className="w-3 h-3 text-zinc-500" />
                    </span>
                  )}
                  <span className="truncate">{p.name}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Lista de emuladores (nome + versão exata) vinculados a um perfil de
// hardware — fica salvo com o perfil, então "PC Retrô: PCSX2 v2.2.0" não
// se perde, e o campo "Rodando via" de cada jogo pode sugerir essas versões
// exatas em vez do usuário ter que redigitar toda vez.
function EmulatorsField({ emulators, onChange }) {
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");

  function addEmulator() {
    if (!name.trim()) return;
    onChange([...emulators, { id: uid(), name: name.trim(), version: version.trim() }]);
    setName("");
    setVersion("");
  }

  function removeEmulator(id) {
    onChange(emulators.filter((e) => e.id !== id));
  }

  return (
    <div className="mb-4">
      <label className="text-xs text-zinc-400 mb-1 block">Emuladores deste perfil (com a versão exata)</label>
      {emulators.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {emulators.map((e) => (
            <span
              key={e.id}
              className="flex items-center gap-1.5 text-xs bg-zinc-950 border border-zinc-800 rounded-full pl-2.5 pr-1.5 py-1 text-zinc-300"
            >
              {e.name}{e.version && <span className="text-zinc-500">v{e.version}</span>}
              <button onClick={() => removeEmulator(e.id)} className="text-zinc-600 hover:text-red-400 transition-colors">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <input
          value={name}
          onChange={(ev) => setName(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addEmulator(); } }}
          placeholder="ex: PCSX2"
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
        />
        <input
          value={version}
          onChange={(ev) => setVersion(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addEmulator(); } }}
          placeholder="versão (ex: 2.2.0)"
          className="w-32 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
        />
        <button
          type="button"
          onClick={addEmulator}
          disabled={!name.trim()}
          className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 px-3 rounded-lg text-sm transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
      <p className="text-xs text-zinc-600 mt-1">
        Essas versões aparecem como sugestão no campo "Rodando via" de cada jogo, quando este perfil está ativo.
      </p>
    </div>
  );
}

function ProfileModal({ profiles, activeProfileId, games = [], raProfile, onClose, onSave }) {
  const [list, setList] = useState(profiles);
  const [editingId, setEditingId] = useState(activeProfileId);
  const editing = list.find((p) => p.id === editingId) || list[0];

  // Contexto RetroAchievements x perfil de hardware: o RA em si é uma conta
  // única (não sabe "qual PC" jogou), então não dá pra puxar dados do RA
  // filtrados por perfil de verdade. O que dá pra mostrar com honestidade é
  // quantos jogos deste perfil têm RA vinculado e já foram analisados
  // rodando neste hardware — útil pra saber quais jogos de emulador (que é
  // onde o RA funciona) estão ativos num perfil como o "PC Retrô".
  const raLinkedInProfile = games.filter(
    (g) => g.raGameId && (g.analyses || []).some((a) => a.profileId === editing.id)
  ).length;

  function updateField(field, value) {
    if (field === "raLinked" && value === true) {
      // só um perfil pode estar vinculado à conta RA por vez
      setList(list.map((p) => ({ ...p, raLinked: p.id === editing.id })));
      return;
    }
    setList(list.map((p) => (p.id === editing.id ? { ...p, [field]: value } : p)));
  }

  function addProfile() {
    const created = makeProfile(`Perfil ${list.length + 1}`);
    setList([...list, created]);
    setEditingId(created.id);
  }

  function removeProfile(id) {
    if (list.length === 1) {
      window.alert("Precisa manter ao menos um perfil de hardware.");
      return;
    }
    if (!window.confirm("Remover este perfil de hardware?")) return;
    const next = list.filter((p) => p.id !== id);
    setList(next);
    if (editingId === id) setEditingId(next[0].id);
  }

  return (
    <ModalShell onClose={onClose} maxW="max-w-xl">
      <div className="p-6">
        <h2 className="text-base font-semibold mb-1">Perfis de hardware</h2>
        <p className="text-xs text-zinc-500 mb-4">
          Crie um perfil pra cada PC (ex: Retrô, Principal, Notebook) e troque com um clique no topo da tela.
        </p>

        {/* abas dos perfis */}
        <div className="flex flex-wrap gap-2 mb-5">
          {list.map((p) => (
            <button
              key={p.id}
              onClick={() => setEditingId(p.id)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                editing.id === p.id
                  ? "bg-indigo-600 border-indigo-500 text-white"
                  : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Users className="w-3 h-3" />
              {p.name || "Sem nome"}
            </button>
          ))}
          <button
            onClick={addProfile}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-dashed border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
          >
            <Plus className="w-3 h-3" /> Novo perfil
          </button>
        </div>

        {/* edição do perfil selecionado */}
        <div className="mb-4">
          <label className="text-xs text-zinc-400 mb-1 block uppercase">Nome do perfil</label>
          <input
            value={editing.name}
            onChange={(e) => updateField("name", e.target.value)}
            placeholder="ex: PC Retrô"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
          />
        </div>

        {/* vínculo com a conta RetroAchievements — só esse painel mostra
            informações da conta RA em todo o app */}
        <label className="flex items-center gap-2 mb-4 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={!!editing.raLinked}
            onChange={(e) => updateField("raLinked", e.target.checked)}
            className="w-4 h-4 accent-indigo-600"
          />
          <span className="text-xs text-zinc-300">Vincular conta RetroAchievements a este perfil</span>
        </label>

        {editing.raLinked && (
          <div className="mb-4 bg-zinc-950 border border-indigo-800/60 rounded-lg p-3">
            {raProfile ? (
              <>
                <div className="flex items-center gap-3">
                  {raProfile.avatarUrl && (
                    <img src={raProfile.avatarUrl} alt="" className="w-11 h-11 rounded-full ring-2 ring-indigo-400" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{raProfile.username}</p>
                    <p className="text-xs text-zinc-500">
                      {raProfile.points} pts · {raProfile.truePoints} true pts
                      {raProfile.rank ? ` · rank #${raProfile.rank}` : ""}
                    </p>
                  </div>
                </div>

                {raProfile.motto && (
                  <p className="text-xs text-indigo-300/80 italic mt-2">"{raProfile.motto}"</p>
                )}

                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-600 mt-2">
                  {raProfile.memberSince && <span>na RA desde {formatDate(raProfile.memberSince)}</span>}
                </div>

                {raProfile.lastGame && (
                  <p className="text-xs text-zinc-500 mt-2 pt-2 border-t border-zinc-800">
                    Último jogo: <span className="text-zinc-300">{raProfile.lastGame.title}</span>
                    {raProfile.lastGame.consoleName && <span className="text-zinc-600"> ({raProfile.lastGame.consoleName})</span>}
                  </p>
                )}

                {raProfile.progressionByPlatform?.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-zinc-800">
                    <p className="text-xs text-zinc-500 mb-1">Progressão por plataforma</p>
                    <div className="flex flex-wrap gap-1.5">
                      {raProfile.progressionByPlatform.slice(0, 8).map((p) => (
                        <span key={p.console} className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400">
                          {p.console}: {p.masteredCount}/{p.gamesCount}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {raProfile.recentAchievements?.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-zinc-800">
                    <p className="text-xs text-zinc-500 mb-1">Progresso recente</p>
                    <div className="space-y-1">
                      {raProfile.recentAchievements.map((a, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          {a.badgeUrl && <img src={a.badgeUrl} alt="" className="w-5 h-5 rounded shrink-0" />}
                          <span className="text-zinc-400 truncate">{a.title}</span>
                          <span className="text-zinc-600 truncate shrink-0">— {a.gameTitle}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-zinc-500">Conta RA não configurada no servidor (ou ainda carregando).</p>
            )}
            {raLinkedInProfile > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-amber-300 mt-2 pt-2 border-t border-zinc-800">
                <Trophy className="w-3.5 h-3.5 shrink-0" />
                {raLinkedInProfile} jogo(s) com RA vinculado analisado(s) neste perfil
              </p>
            )}
          </div>
        )}

        {["cpu", "gpu", "ram", "os"].map((field) => (
          <div key={field} className="mb-4">
            <label className="text-xs text-zinc-400 mb-1 block uppercase">{field}</label>
            <input
              value={editing[field]}
              onChange={(e) => updateField(field, e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
            />
          </div>
        ))}

        <EmulatorsField
          emulators={editing.emulators || []}
          onChange={(next) => updateField("emulators", next)}
        />

        <label className="text-xs text-zinc-400 mb-1 block">Preferências gerais / objetivos</label>
        <textarea
          value={editing.preferences}
          onChange={(e) => updateField("preferences", e.target.value)}
          rows={3}
          placeholder="ex: prefiro estabilidade a gráficos, aceito rodar em 720p..."
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm mb-3 outline-none focus:border-indigo-600 resize-none"
        />

        <button
          onClick={() => removeProfile(editing.id)}
          className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-red-400 transition-colors mb-6"
        >
          <Trash2 className="w-3.5 h-3.5" /> Remover este perfil
        </button>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-200 px-4 py-2 transition-colors">
            Cancelar
          </button>
          <button
            onClick={() => onSave(list, list.some((p) => p.id === editingId) ? editingId : list[0].id)}
            className="bg-indigo-600 hover:bg-indigo-500 transition-colors text-white text-sm font-medium rounded-lg px-4 py-2"
          >
            Salvar
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function RetroAchievementsSection({
  game, onUpdateRaGameId, onSaveTranslations, onApplyRaData,
}) {
  const [gameIdInput, setGameIdInput] = useState(game.raGameId || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [progression, setProgression] = useState(game.raProgression || null);
  const [showAll, setShowAll] = useState(false);
  const [translations, setTranslations] = useState(game.raTranslations || {});
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState("");

  async function fetchProgress(id) {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/retroachievements?gameId=${encodeURIComponent(id)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
      setData(body);

      // IMPORTANTE: um único patch, uma única chamada de updateGame — é isso
      // que evita a regressão de capa/nome/progresso se sobrescreverem entre
      // si (ver comentário em updateGames no componente principal).
      const patch = {
        raProgress: { numAwardedToUser: body.numAwardedToUser, numAchievements: body.numAchievements },
        name: body.gameTitle,
        raIconUrl: body.imageIcon,
        raMeta: {
          developer: body.developer,
          publisher: body.publisher,
          genre: body.genre,
          released: body.released,
          consoleName: body.consoleName,
        },
        raAward: { kind: body.highestAwardKind, date: body.highestAwardDate },
        raPlaySpan: { first: body.firstUnlockDate, last: body.lastUnlockDate },
      };
      // Se o jogo ainda não tem capa manual, usa a boxart do RetroAchievements.
      if (!game.coverUrl && body.boxArtUrl) patch.coverUrl = body.boxArtUrl;
      onApplyRaData(patch);

      // Tempo médio da comunidade (não bloqueia a UI principal se falhar).
      // Guardado permanentemente no jogo (não só no estado local) pra
      // aparecer na visualização em lista sem precisar reabrir o card.
      fetch(`/api/retroachievements/progression?gameId=${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => {
          setProgression(p);
          if (p) onApplyRaData({ raProgression: p });
        })
        .catch(() => setProgression(null));
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  // Se o jogo já tem um ID salvo, busca o progresso automaticamente ao abrir.
  useEffect(() => {
    if (game.raGameId) fetchProgress(game.raGameId);
    setTranslations(game.raTranslations || {});
    setGameIdInput(game.raGameId || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id]);

  // Salva o ID assim que o campo perde o foco — sem isso, digitar o ID e só
  // fechar o card sem clicar no botão perdia a informação (bug reportado).
  function handleBlurSave() {
    const trimmed = gameIdInput.trim();
    if (trimmed !== (game.raGameId || "")) {
      onUpdateRaGameId(trimmed);
    }
  }

  function handleSave() {
    const trimmed = gameIdInput.trim();
    onUpdateRaGameId(trimmed);
    if (trimmed) fetchProgress(trimmed);
  }

  async function handleTranslate() {
    if (!data || !data.achievements.length) return;
    setTranslating(true);
    setTranslateError("");
    try {
      // Só traduz o que ainda não foi traduzido antes (economiza cota do Gemini).
      const pending = data.achievements.filter((a) => !translations[a.id]);
      if (pending.length === 0) {
        setTranslating(false);
        return;
      }
      const res = await fetch("/api/translate-achievements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ achievements: pending.map((a) => ({ id: a.id, title: a.title, description: a.description })) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
      const merged = { ...translations };
      for (const t of body.translations || []) {
        merged[t.id] = { title: t.title, description: t.description };
      }
      setTranslations(merged);
      onSaveTranslations(merged);
    } catch (e) {
      setTranslateError(e.message);
    } finally {
      setTranslating(false);
    }
  }

  const visibleAchievements = data ? (showAll ? data.achievements : data.achievements.slice(0, 6)) : [];
  const pct = data && data.numAchievements ? Math.round((data.numAwardedToUser / data.numAchievements) * 100) : 0;
  const hasTranslations = Object.keys(translations).length > 0;

  return (
    <div className="mb-5">
      <div className="flex items-center gap-1.5 text-xs text-zinc-400 mb-1.5">
        <Trophy className="w-3.5 h-3.5" /> RetroAchievements
      </div>

      <div className="flex gap-2 mb-2">
        <input
          value={gameIdInput}
          onChange={(e) => setGameIdInput(e.target.value)}
          onBlur={handleBlurSave}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          placeholder="ID do jogo no RetroAchievements (ex: 14402)"
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600 font-mono"
        />
        <button
          onClick={handleSave}
          disabled={loading || !gameIdInput.trim()}
          className="text-sm bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 transition-colors rounded-lg px-3 flex items-center justify-center"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </div>

      {!game.raGameId && !gameIdInput.trim() && (
        <p className="text-xs text-zinc-600 mb-2">
          Cole o ID do jogo no RetroAchievements (o número que aparece na URL do jogo no site) pra acompanhar suas
          conquistas e puxar a capa automaticamente.
        </p>
      )}

      {error && (
        <div className="flex items-start gap-2 text-xs text-red-300 bg-red-950 border border-red-800 rounded-lg px-3 py-2 mb-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {data && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">
              {data.numAwardedToUser}/{data.numAchievements} conquistas
            </span>
            <span className="text-xs text-zinc-500">{data.userCompletion}</span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden mb-3">
            <div className="h-full bg-amber-500" style={{ width: `${pct}%` }} />
          </div>

          {(data.developer || data.publisher || data.genre || data.released) && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500 mb-3">
              {data.developer && <span>Dev: <span className="text-zinc-400">{data.developer}</span></span>}
              {data.publisher && <span>Publisher: <span className="text-zinc-400">{data.publisher}</span></span>}
              {data.genre && <span>Gênero: <span className="text-zinc-400">{data.genre}</span></span>}
              {data.released && <span>Lançamento: <span className="text-zinc-400">{data.released}</span></span>}
            </div>
          )}

          {data.highestAwardKind && (
            <div className="flex items-center gap-1.5 text-xs text-amber-300 bg-amber-950/40 border border-amber-800 rounded-lg px-3 py-2 mb-3">
              <Award className="w-3.5 h-3.5 shrink-0" />
              {RA_AWARD_LABELS[data.highestAwardKind] || data.highestAwardKind}
              {data.highestAwardDate && <span className="text-amber-400/70 ml-1">— {formatDate(data.highestAwardDate)}</span>}
            </div>
          )}

          {data.lastPlayed && (
            <p className="text-xs text-zinc-500 mb-1">Última vez jogado: {formatDate(data.lastPlayed)}</p>
          )}

          {data.firstUnlockDate && data.lastUnlockDate ? (
            <p className="flex items-start gap-1.5 text-xs text-zinc-500 mb-1">
              <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              Tempo aproximado (1ª à última conquista): ~{formatDaySpan(data.firstUnlockDate, data.lastUnlockDate)}
            </p>
          ) : (
            <p className="text-xs text-zinc-600 mb-1">
              Sem conquistas suficientes ainda pra estimar um tempo aproximado.
            </p>
          )}
          <p className="flex items-start gap-1 text-xs text-zinc-700 mb-3">
            <Info className="w-3 h-3 shrink-0 mt-0.5" />
            O RetroAchievements não expõe horas jogadas reais via API — essa é só uma estimativa baseada no
            intervalo entre conquistas, melhor que nada mas não é o tempo exato.
          </p>

          {progression && (progression.medianTimeToCompleteSeconds || progression.medianTimeToMasterSeconds) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500 mb-3 bg-zinc-900/60 rounded-lg px-3 py-2">
              <span className="text-zinc-400">Mediana da comunidade:</span>
              {progression.medianTimeToCompleteSeconds && (
                <span>zerar: <span className="text-zinc-300">{formatSeconds(progression.medianTimeToCompleteSeconds)}</span></span>
              )}
              {progression.medianTimeToMasterSeconds && (
                <span>platinar: <span className="text-zinc-300">{formatSeconds(progression.medianTimeToMasterSeconds)}</span></span>
              )}
            </div>
          )}

          <button
            onClick={handleTranslate}
            disabled={translating}
            className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50 transition-colors mb-2"
          >
            {translating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {hasTranslations ? "Atualizar tradução" : "Traduzir para português"}
          </button>
          {translateError && <p className="text-xs text-red-400 mb-2">{translateError}</p>}

          <ul className="space-y-1.5">
            {visibleAchievements.map((a) => {
              const t = translations[a.id];
              return (
                <li
                  key={a.id}
                  className={`flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg ${
                    a.earned ? "bg-zinc-900" : "bg-zinc-900/40 opacity-50"
                  }`}
                >
                  <img
                    src={`https://i.retroachievements.org/Badge/${a.badgeName}${a.earned ? "" : "_lock"}.png`}
                    alt=""
                    className="w-6 h-6 rounded shrink-0"
                    onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
                  />
                  <div className="min-w-0">
                    <p className={`truncate ${a.earned ? "text-zinc-200" : "text-zinc-500"}`}>{t?.title || a.title}</p>
                    {t && <p className="truncate text-zinc-600">{a.title}</p>}
                  </div>
                  {a.earned && <span className="ml-auto text-amber-400 shrink-0">✓</span>}
                </li>
              );
            })}
          </ul>
          {data.achievements.length > 6 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mt-2"
            >
              {showAll ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {showAll ? "Ver menos" : `Ver todas (${data.achievements.length})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Lore geral da franquia + ordem recomendada de jogo, via IA (o RA tem um
// recurso parecido no site — "Hubs" — mas não está exposto na API pública).
// Cruza com os jogos da própria biblioteca que têm o mesmo texto em
// "Franquia". Usa um cache compartilhado (guardado no app) — busca só na
// primeira vez que a franquia é aberta, igual ao GameLoreSection.
function FranchiseOrderSection({ franchise, games, cached, onSave }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const siblings = games.filter(
    (g) => (g.franchise || "").trim().toLowerCase() === franchise.toLowerCase()
  );

  async function fetchOrder() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/franchise-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          franchise,
          games: siblings.map((g) => ({ name: g.name, platformLabel: platformOf(g.platform).label })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
      onSave(body);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!cached && siblings.length >= 2) fetchOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [franchise, siblings.length]);

  if (siblings.length < 2) {
    return (
      <p className="text-xs text-zinc-600 mb-5">
        Adicione mais jogos com "{franchise}" no campo Franquia pra ver a ordem recomendada de jogo.
      </p>
    );
  }

  return (
    <div className="mb-5 bg-zinc-950 border border-zinc-800 rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="text-xs text-zinc-400">
          {siblings.length} jogos de "{franchise}" na sua biblioteca
        </p>
        <button
          onClick={fetchOrder}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-indigo-300 hover:text-indigo-200 disabled:opacity-40 transition-colors shrink-0"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Target className="w-3.5 h-3.5" />}
          {cached ? "atualizar" : "buscar"}
        </button>
      </div>

      {loading && !cached && (
        <p className="flex items-center gap-1.5 text-xs text-zinc-500 mt-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> buscando contexto da franquia...
        </p>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-xs text-rose-400 mt-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
        </p>
      )}

      {cached && (
        <div className="mt-2 pt-2 border-t border-zinc-800">
          {cached.summary && <p className="text-xs text-zinc-500 mb-2 leading-relaxed">{cached.summary}</p>}
          <ol className="space-y-1.5">
            {(cached.order || []).map((item, i) => {
              const match = siblings.find((g) => g.name === item.name);
              return (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="shrink-0 w-4 h-4 rounded-full bg-zinc-800 text-zinc-400 flex items-center justify-center text-[10px] mt-0.5">
                    {i + 1}
                  </span>
                  <span>
                    <span className={match?.status === "completed" || isPlatinum(match || {}) ? "text-emerald-400" : "text-zinc-300"}>
                      {item.name}
                    </span>
                    {item.reason && <span className="text-zinc-500"> — {item.reason}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

function GameLoreSection({ game, onApplyLore }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const lore = game.loreData;

  async function fetchLore() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/game-lore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: game.name, platformLabel: platformOf(game.platform).label }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
      onApplyLore(body);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!game.loreData) fetchLore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id]);

  // Metadados oficiais da RA (quando o jogo é vinculado) são mais confiáveis
  // que os do Gemini — preferimos eles quando disponíveis.
  const meta = {
    developer: game.raMeta?.developer || lore?.developer,
    publisher: game.raMeta?.publisher || lore?.publisher,
    genre: game.raMeta?.genre || lore?.genre,
    released: game.raMeta?.released || lore?.released,
  };
  const hasMeta = meta.developer || meta.publisher || meta.genre || meta.released;

  return (
    <div className="mb-5">
      {hasMeta && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500 mb-2">
          {meta.developer && <span>Dev: <span className="text-zinc-400">{meta.developer}</span></span>}
          {meta.publisher && <span>Publisher: <span className="text-zinc-400">{meta.publisher}</span></span>}
          {meta.genre && <span>Gênero: <span className="text-zinc-400">{meta.genre}</span></span>}
          {meta.released && <span>Lançamento: <span className="text-zinc-400">{meta.released}</span></span>}
        </div>
      )}

      {loading && (
        <p className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> buscando contexto do jogo...
        </p>
      )}

      {!loading && lore?.lore && (
        <p className="text-sm text-zinc-400 leading-relaxed">{lore.lore}</p>
      )}

      {!loading && error && (
        <p className="flex items-center gap-1.5 text-xs text-rose-400">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
          <button onClick={fetchLore} className="underline hover:text-rose-300">tentar de novo</button>
        </p>
      )}

      {!loading && !error && lore && (
        <button onClick={fetchLore} className="mt-1 text-xs text-zinc-600 hover:text-zinc-400 underline">
          atualizar resumo
        </button>
      )}
    </div>
  );
}

function GameDetailModal({
  game, games = [], analyzing, error, activeProfileId, activeProfileName, profiles,
  onClose, onAnalyze, onAddNote, onUpdateGoals, onToggleFavorite, onSetStatus, onToggleManualPlatinum,
  onUpdateRaGameId, onUpdateRunningVia, onUpdateFranchise, onUpdateName, onUpdatePlatform, onUpdatePlaytime, onUpdateGuideUrl, onSaveTranslations, onApplyRaData,
  franchiseNotes, onUpdateFranchiseNotes,
  onRemove,
}) {
  const [noteText, setNoteText] = useState("");
  const [goalsText, setGoalsText] = useState(game.goals || "");
  const [runningViaText, setRunningViaText] = useState(game.runningVia || "");
  const [playtimeText, setPlaytimeText] = useState(game.playtimeHours ?? "");

  useEffect(() => {
    setPlaytimeText(game.playtimeHours ?? "");
  }, [game.playtimeHours]);
  const [guideUrlText, setGuideUrlText] = useState(game.guideUrl || "");
  const [showReader, setShowReader] = useState(false);
  useEffect(() => {
    setGuideUrlText(game.guideUrl || "");
  }, [game.guideUrl]);
  const [franchiseText, setFranchiseText] = useState(game.franchise || "");
  const [editingName, setEditingName] = useState(false);
  const [nameText, setNameText] = useState(game.name);
  const [fetchingCover, setFetchingCover] = useState(false);
  const [coverError, setCoverError] = useState("");
  const [editingCover, setEditingCover] = useState(false);
  const [coverUrlInput, setCoverUrlInput] = useState(game.coverUrl || "");

  useEffect(() => {
    setCoverUrlInput(game.coverUrl || "");
  }, [game.coverUrl]);

  function saveCoverUrl() {
    const trimmed = coverUrlInput.trim();
    if (trimmed) onApplyRaData({ coverUrl: trimmed });
    setEditingCover(false);
  }

  useEffect(() => {
    setNameText(game.name);
  }, [game.name]);

  function saveName() {
    const trimmed = nameText.trim();
    if (trimmed && trimmed !== game.name) onUpdateName(trimmed);
    else setNameText(game.name);
    setEditingName(false);
  }

  async function fetchCoverArt() {
    setFetchingCover(true);
    setCoverError("");
    try {
      const res = await fetch(`/api/coverart?name=${encodeURIComponent(game.name)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
      onApplyRaData({ coverUrl: body.coverUrl });
    } catch (e) {
      setCoverError(e.message);
    } finally {
      setFetchingCover(false);
    }
  }

  // Qualquer jogo sem capa — de qualquer plataforma — busca sozinho no
  // SteamGridDB assim que o card é aberto (o botão manual abaixo continua
  // ali como retentativa, caso a busca automática não encontre nada).
  useEffect(() => {
    if (!game.coverUrl) fetchCoverArt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id]);

  useEffect(() => {
    setFranchiseText(game.franchise || "");
  }, [game.franchise]);
  const [showHistory, setShowHistory] = useState(false);
  const [viewedProfileId, setViewedProfileId] = useState(activeProfileId);
  const allAnalyses = game.analyses || [];

  // Aba de perfil selecionada pra VER o histórico (pode ser diferente do
  // perfil ativo no topo da tela — nova análise sempre usa o perfil ativo).
  const analysesForViewedProfile = allAnalyses.filter((a) => !a.profileId || a.profileId === viewedProfileId);
  const latest = analysesForViewedProfile[0];
  const older = analysesForViewedProfile.slice(1);
  const viewedProfile = profiles.find((p) => p.id === viewedProfileId);

  return (
    <ModalShell onClose={onClose} maxW="max-w-2xl" frameVariant={frameVariantOf(game)} frameSeed={game.id}>
      <div>
        <div className="relative">
          <CoverThumb game={game} frame className="w-full aspect-video" />
          <div className="absolute bottom-2 right-2 z-30 flex flex-col items-end gap-1.5">
            {editingCover ? (
              <div className="flex items-center gap-1.5 bg-black/80 backdrop-blur p-1.5 rounded-lg border border-zinc-700">
                <input
                  autoFocus
                  value={coverUrlInput}
                  onChange={(e) => setCoverUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveCoverUrl(); if (e.key === "Escape") setEditingCover(false); }}
                  placeholder="URL da capa"
                  className="w-48 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs outline-none focus:border-indigo-600"
                />
                <button onClick={saveCoverUrl} className="text-xs text-emerald-400 hover:text-emerald-300 px-1.5">salvar</button>
                <button onClick={() => setEditingCover(false)} className="text-xs text-zinc-500 hover:text-zinc-300 px-1">✕</button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setEditingCover(true)}
                  className="flex items-center gap-1.5 text-xs bg-black/70 backdrop-blur text-zinc-300 hover:text-zinc-100 px-2.5 py-1.5 rounded-lg border border-zinc-700 transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  URL manual
                </button>
                <button
                  onClick={fetchCoverArt}
                  disabled={fetchingCover}
                  className="flex items-center gap-1.5 text-xs bg-black/70 backdrop-blur text-indigo-300 hover:text-indigo-200 disabled:opacity-50 px-2.5 py-1.5 rounded-lg border border-zinc-700 transition-colors"
                >
                  {fetchingCover ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  {fetchingCover ? "buscando..." : game.coverUrl ? "trocar capa (SteamGridDB)" : "buscar capa (SteamGridDB)"}
                </button>
              </div>
            )}
            {coverError && <p className="text-xs text-rose-400 text-right max-w-[260px]">{coverError}</p>}
          </div>
        </div>
        <div className="relative overflow-hidden p-6">
          {frameVariantOf(game) && <StarField variant={frameVariantOf(game)} seed={game.id} count={40} />}
          <div className="flex items-start justify-between gap-3 mb-1">
            <div className="flex items-center gap-2 min-w-0">
              {game.raIconUrl && (
                <img
                  src={game.raIconUrl}
                  alt=""
                  className={`w-7 h-7 rounded shrink-0 ${
                    isPlatinum(game)
                      ? "ring-2 ring-indigo-400"
                      : game.status === "completed"
                      ? "ring-2 ring-amber-400"
                      : ""
                  }`}
                />
              )}
              {editingName ? (
                <input
                  autoFocus
                  value={nameText}
                  onChange={(e) => setNameText(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setNameText(game.name); setEditingName(false); } }}
                  className="text-lg font-semibold bg-zinc-950 border border-indigo-600 rounded-md px-2 py-0.5 outline-none min-w-0 flex-1"
                />
              ) : (
                <button
                  onClick={() => setEditingName(true)}
                  className="flex items-center gap-1.5 min-w-0 group/name text-left"
                  title="Clique pra editar o nome"
                >
                  <h2 className="text-lg font-semibold truncate">{game.name}</h2>
                  <Pencil className="w-3.5 h-3.5 text-zinc-600 group-hover/name:text-zinc-400 shrink-0 transition-colors" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={onToggleFavorite}
                className="w-7 h-7 rounded-full bg-zinc-950 border border-zinc-800 flex items-center justify-center hover:border-zinc-600 transition-colors"
                aria-label="Favoritar"
              >
                <Star className={`w-3.5 h-3.5 ${game.favorite ? "fill-amber-400 text-amber-400" : "text-zinc-400"}`} />
              </button>
              <select
                value={game.platform}
                onChange={(e) => onUpdatePlatform(e.target.value)}
                className={`text-xs px-2 py-0.5 rounded-full outline-none cursor-pointer appearance-none text-center ${platformOf(game.platform).badge}`}
                title="Clique pra mudar a plataforma"
              >
                {PLATFORMS.map((p) => (
                  <option key={p.id} value={p.id} className="bg-zinc-900 text-zinc-200">
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-zinc-500 mb-4">adicionado em {formatDate(game.createdAt)}</p>

          {/* metadados + lore/história do jogo (gerado por IA, funciona pra
              qualquer plataforma) — fica antes dos status, como pedido */}
          <GameLoreSection
            game={game}
            onApplyLore={(patch) => {
              const next = { loreData: patch };
              // só preenche a franquia sozinho se o campo ainda estiver
              // vazio — nunca sobrescreve o que o usuário já escreveu
              if (!game.franchise && patch.franchise) next.franchise = patch.franchise;
              onApplyRaData(next);
            }}
          />

          {/* status: quero jogar / jogando / zerado / abandonado */}
          <div className="flex flex-wrap gap-1.5 mb-2">
            {STATUSES.map((s) => (
              <button
                key={s.id}
                onClick={() => onSetStatus(s.id)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  game.status === s.id ? s.badge : "bg-transparent border-zinc-800 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* platinado manual — só pra plataformas onde o CompactHub NÃO lê
              conquistas via API (tudo, exceto Retro/ISO, que já é automático
              via RetroAchievements). O usuário sinaliza que zerou as
              conquistas na própria loja (GOG, Steam, etc). */}
          {game.platform !== "retro" && (
            <button
              onClick={() => onToggleManualPlatinum()}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors mb-6 ${
                game.manualPlatinum
                  ? "bg-indigo-950/60 border-indigo-600 text-indigo-300"
                  : "bg-transparent border-zinc-800 text-zinc-500 hover:text-zinc-300"
              }`}
              title="Marca como platinado mesmo sem conquistas do RetroAchievements (ex: 100% na GOG/Steam/Epic)"
            >
              <Award className="w-3.5 h-3.5" />
              Platinado
            </button>
          )}
          {game.platform === "retro" && <div className="mb-6" />}

          {/* conquistas via RetroAchievements — só faz sentido pra jogos
              retrô/ISO rodando via emulador, que é o que a RA cobre */}
          {game.platform === "retro" && (
            <RetroAchievementsSection
              game={game}
              onUpdateRaGameId={onUpdateRaGameId}
              onSaveTranslations={onSaveTranslations}
              onApplyRaData={onApplyRaData}
            />
          )}

          {/* rodando via: emulador ou executável */}
          <div className="mb-5">
            <div className="flex items-center gap-1.5 text-xs text-zinc-400 mb-1.5">
              <Gamepad2 className="w-3.5 h-3.5" /> Rodando via
            </div>
            <input
              list="running-via-options"
              value={runningViaText}
              onChange={(e) => setRunningViaText(e.target.value)}
              onBlur={() => onUpdateRunningVia(runningViaText)}
              placeholder="ex: PCSX2 v1.6.0 (versão antiga, mais leve)"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
            />
            <datalist id="running-via-options">
              {RUNNING_VIA_SUGGESTIONS.map((opt) => (
                <option key={opt} value={opt} />
              ))}
              {/* versões exatas cadastradas no perfil de hardware ativo —
                  ver aba "Perfis de hardware" > Emuladores deste perfil */}
              {(profiles.find((p) => p.id === activeProfileId)?.emulators || []).map((e) => (
                <option key={e.id} value={e.version ? `${e.name} v${e.version}` : e.name} />
              ))}
            </datalist>
            <p className="text-xs text-zinc-600 mt-1">
              Se você já sabe que vai usar uma versão específica (ex: uma mais antiga por compatibilidade), inclua
              aqui — a análise passa a considerar isso em vez de assumir a versão mais recente. As versões
              cadastradas no perfil "{activeProfileName}" aparecem como sugestão automática.
            </p>
          </div>

          {/* tempo jogado manual — pra plataformas sem fonte automática
              (Steam/GOG/Epic/Amazon). Pra Retro/ISO o RA já dá uma estimativa
              (intervalo entre conquistas), mas esse campo funciona pra
              qualquer plataforma se você preferir registrar à mão. */}
          <div className="mb-5">
            <label className="flex items-center gap-1.5 text-xs text-zinc-400 mb-1.5">
              <Clock className="w-3.5 h-3.5" /> Tempo jogado (horas, manual)
            </label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={playtimeText}
              onChange={(e) => setPlaytimeText(e.target.value)}
              onBlur={() => onUpdatePlaytime(playtimeText === "" ? null : Number(playtimeText))}
              placeholder="ex: 24"
              className="w-32 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
            />
          </div>

          {/* link do detonado / revista digital — guardado na nuvem
              (Drive, etc), só um link, o CompactHub não hospeda o arquivo */}
          <div className="mb-5">
            <label className="flex items-center gap-1.5 text-xs text-zinc-400 mb-1.5">
              <BookOpen className="w-3.5 h-3.5" /> Detonado / revista digital
            </label>
            <div className="flex gap-2">
              <input
                value={guideUrlText}
                onChange={(e) => setGuideUrlText(e.target.value)}
                onBlur={() => onUpdateGuideUrl(guideUrlText.trim())}
                placeholder="link do Drive, OneDrive, etc"
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
              />
              {game.guideUrl && (
                /drive\.google\.com/.test(game.guideUrl) ? (
                  <button
                    onClick={() => setShowReader(true)}
                    className="flex items-center gap-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 rounded-lg transition-colors shrink-0"
                  >
                    <BookOpen className="w-3.5 h-3.5" /> abrir
                  </button>
                ) : (
                  <a
                    href={game.guideUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Leitor embutido só funciona com links do Google Drive por enquanto — abrindo em nova aba"
                    className="flex items-center gap-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 rounded-lg transition-colors shrink-0"
                  >
                    <BookOpen className="w-3.5 h-3.5" /> abrir
                  </a>
                )
              )}
            </div>
          </div>

          {showReader && (
            <PdfReaderModal url={game.guideUrl} title={game.name} onClose={() => setShowReader(false)} />
          )}

          {/* franquia */}
          <div className="mb-5">
            <div className="flex items-center gap-1.5 text-xs text-zinc-400 mb-1.5">
              <Users className="w-3.5 h-3.5" /> Franquia
            </div>
            <input
              value={franchiseText}
              onChange={(e) => setFranchiseText(e.target.value)}
              onBlur={() => onUpdateFranchise(franchiseText)}
              placeholder="ex: God of War, Mafia, Resident Evil..."
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
            />
            <p className="text-xs text-zinc-600 mt-1">
              Jogos com a mesma franquia (mesmo texto) ficam agrupados no filtro "Franquia" da tela principal —
              útil pra maratonar uma série e ver de cara quais já estão zerados.
            </p>
          </div>

          {franchiseText.trim() && (
            <FranchiseOrderSection
              franchise={franchiseText.trim()}
              games={games}
              cached={franchiseNotes[franchiseText.trim().toLowerCase()]}
              onSave={(data) => onUpdateFranchiseNotes(franchiseText.trim().toLowerCase(), data)}
            />
          )}

          {/* objetivos */}
          <div className="mb-5">
            <div className="flex items-center gap-1.5 text-xs text-zinc-400 mb-1.5">
              <Target className="w-3.5 h-3.5" /> Objetivos para este jogo
            </div>
            <textarea
              value={goalsText}
              onChange={(e) => setGoalsText(e.target.value)}
              onBlur={() => onUpdateGoals(goalsText)}
              rows={2}
              placeholder="ex: só quero terminar a campanha, não preciso de 60fps..."
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600 resize-none"
            />
          </div>

          {/* historico de problemas */}
          <div className="mb-5">
            <div className="flex items-center gap-1.5 text-xs text-zinc-400 mb-1.5">
              <History className="w-3.5 h-3.5" /> Histórico de problemas
            </div>
            {game.notes && game.notes.length > 0 && (
              <ul className="space-y-1.5 mb-2">
                {game.notes.slice().reverse().map((n, i) => (
                  <li key={i} className="text-sm text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2">
                    <span className="text-zinc-600 text-xs block mb-0.5">{formatDate(n.date)}</span>
                    {n.text}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <input
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && noteText.trim()) { onAddNote(noteText); setNoteText(""); } }}
                placeholder="ex: travou na área do porto em baixo"
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
              />
              <button
                onClick={() => { if (noteText.trim()) { onAddNote(noteText); setNoteText(""); } }}
                className="text-sm bg-zinc-800 hover:bg-zinc-700 transition-colors rounded-lg px-3 py-2"
              >
                Registrar
              </button>
            </div>
          </div>

          {/* analisar — sempre roda com o perfil ativo no topo da tela */}
          <button
            onClick={onAnalyze}
            disabled={analyzing}
            className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-colors text-white text-sm font-medium rounded-lg px-4 py-2.5 mb-1.5"
          >
            {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {analyzing ? "Analisando com base no seu hardware..." : "Analisar compatibilidade agora"}
          </button>
          <p className="text-xs text-zinc-600 text-center mb-4">roda com o perfil ativo: {activeProfileName}</p>

          {error && (
            <div className="flex items-start gap-2 text-sm text-red-300 bg-red-950 border border-red-800 rounded-lg px-3 py-2 mb-4">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          {/* abas: escolha qual perfil ver o histórico de análises */}
          {profiles.length > 1 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {profiles.map((p) => {
                const hasAnalysis = allAnalyses.some((a) => (a.profileId || activeProfileId) === p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => setViewedProfileId(p.id)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      viewedProfileId === p.id
                        ? "bg-indigo-600 border-indigo-500 text-white"
                        : hasAnalysis
                        ? "bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-500"
                        : "bg-transparent border-zinc-800 text-zinc-600"
                    }`}
                  >
                    {p.name}{!hasAnalysis && " (sem análise)"}
                  </button>
                );
              })}
            </div>
          )}

          {/* resultado do perfil selecionado na aba */}
          {latest ? (
            <div className={`rounded-xl border ${TIER_META[latest.tier]?.border || "border-zinc-700"} bg-zinc-950 p-4 mb-3`}>
              <div className="flex items-center justify-between mb-2">
                <TierBadge tier={latest.tier} tierLabel={latest.tierLabel} size="lg" />
                <div className="text-right">
                  <span className="text-xs text-zinc-600 block">{formatDate(latest.date)}</span>
                  <span className="text-xs text-zinc-500">perfil: {latest.profileName || viewedProfile?.name}</span>
                </div>
              </div>
              <p className="text-sm font-medium mb-1.5">{latest.veredito}</p>
              <p className="text-sm text-zinc-400 mb-3">{latest.motivo}</p>
              {latest.configuracaoRecomendada && (
                <p className="text-xs text-zinc-500 mb-2">
                  <span className="text-zinc-400 font-medium">Configuração sugerida: </span>
                  {latest.configuracaoRecomendada}
                </p>
              )}
              {latest.avisos && latest.avisos.length > 0 && (
                <ul className="space-y-1 mt-2">
                  {latest.avisos.map((a, i) => (
                    <li key={i} className="text-xs text-amber-300 flex items-start gap-1.5">
                      <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" /> {a}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            viewedProfileId !== activeProfileId && (
              <p className="text-xs text-zinc-600 mb-3">
                Ainda não analisado no perfil "{viewedProfile?.name}". Troque o perfil ativo no topo da tela pra
                {" "}"{viewedProfile?.name}" e clique em analisar.
              </p>
            )
          )}

          {older.length > 0 && (
            <div className="mb-4">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {showHistory ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                Ver {older.length} análise(s) anterior(es) neste perfil
              </button>
              {showHistory && (
                <div className="mt-2 space-y-2">
                  {older.map((a, i) => (
                    <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <TierBadge tier={a.tier} tierLabel={a.tierLabel} />
                        <span className="text-xs text-zinc-600">{formatDate(a.date)}</span>
                      </div>
                      <p className="text-xs text-zinc-500">{a.motivo}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            onClick={onRemove}
            className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-red-400 transition-colors mt-2"
          >
            <Trash2 className="w-3.5 h-3.5" /> Remover jogo da biblioteca
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
