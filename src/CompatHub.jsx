import { useState, useEffect } from "react";
import {
  Search, Plus, X, RefreshCw, Trash2, Gamepad2, Loader2,
  AlertTriangle, Settings2, History, Target, ChevronDown, ChevronUp,
  Star, Users, Trophy
} from "lucide-react";

const STORAGE_KEY = "compat-hub-data";

const PLATFORMS = [
  { id: "steam", label: "Steam", badge: "bg-sky-900 text-sky-300 border border-sky-700" },
  { id: "epic", label: "Epic Games", badge: "bg-zinc-800 text-zinc-200 border border-zinc-600" },
  { id: "gog", label: "GOG", badge: "bg-purple-900 text-purple-300 border border-purple-700" },
  { id: "amazon", label: "Amazon Games", badge: "bg-orange-900 text-orange-300 border border-orange-700" },
  { id: "retro", label: "Retro / ISO", badge: "bg-emerald-900 text-emerald-300 border border-emerald-700" },
  { id: "other", label: "Outro", badge: "bg-zinc-800 text-zinc-300 border border-zinc-600" },
];

const TIER_META = {
  5: { label: "Excelente", dot: "bg-emerald-500", text: "text-emerald-300", border: "border-emerald-600" },
  4: { label: "Bom", dot: "bg-sky-500", text: "text-sky-300", border: "border-sky-600" },
  3: { label: "OK", dot: "bg-amber-500", text: "text-amber-300", border: "border-amber-600" },
  2: { label: "Ruim", dot: "bg-orange-500", text: "text-orange-300", border: "border-orange-600" },
  1: { label: "Não roda", dot: "bg-red-500", text: "text-red-300", border: "border-red-600" },
};

const STATUSES = [
  { id: "backlog", label: "Quero jogar", badge: "bg-zinc-800 text-zinc-300 border border-zinc-600" },
  { id: "playing", label: "Jogando", badge: "bg-sky-900 text-sky-300 border border-sky-700" },
  { id: "completed", label: "Zerado", badge: "bg-emerald-900 text-emerald-300 border border-emerald-700" },
  { id: "abandoned", label: "Abandonado", badge: "bg-red-900 text-red-300 border border-red-700" },
];

function statusOf(id) {
  return STATUSES.find((s) => s.id === id) || null;
}

function makeProfile(name, overrides = {}) {
  return {
    id: uid(),
    name,
    cpu: "",
    gpu: "",
    ram: "",
    os: "",
    preferences: "",
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

  const data = await response.json();
  const cleaned = (data.text || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Não consegui interpretar a resposta da análise.");
  }
}

function CoverThumb({ game, className }) {
  const [failed, setFailed] = useState(false);
  const hasCover = game.coverUrl && !failed;
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

  const [showAdd, setShowAdd] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [activeGameId, setActiveGameId] = useState(null);

  const [analyzing, setAnalyzing] = useState({});
  const [errors, setErrors] = useState({});

  const profile = profiles.find((p) => p.id === activeProfileId) || profiles[0];

  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(STORAGE_KEY);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          // Migração: dados antigos tinham um único "profile". Se não existir
          // "profiles" (array novo), converte o antigo em perfil "Principal".
          if (parsed.profiles && parsed.profiles.length > 0) {
            setProfiles(parsed.profiles);
            setActiveProfileId(parsed.activeProfileId || parsed.profiles[0].id);
          } else if (parsed.profile) {
            const migrated = [{ id: "default-profile", name: "Principal", ...parsed.profile }];
            setProfiles(migrated);
            setActiveProfileId(migrated[0].id);
          }
          setGames(parsed.games || []);
        }
      } catch {
        // sem dados salvos ainda — segue com os padrões
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function persist(nextProfiles, nextActiveProfileId, nextGames) {
    try {
      await storage.set(
        STORAGE_KEY,
        JSON.stringify({ profiles: nextProfiles, activeProfileId: nextActiveProfileId, games: nextGames })
      );
    } catch (e) {
      console.error("Erro ao salvar:", e);
    }
  }

  function updateGames(nextGames) {
    setGames(nextGames);
    persist(profiles, activeProfileId, nextGames);
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

  function addGame({ name, platform, steamAppId, coverUrl }) {
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
      createdAt: new Date().toISOString(),
    };
    updateGames([newGame, ...games]);
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
    updateGames(games.filter((g) => g.id !== id));
    if (activeGameId === id) setActiveGameId(null);
  }

  function updateGame(id, patch) {
    updateGames(games.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  }

  function addNote(id, text) {
    if (!text.trim()) return;
    const game = games.find((g) => g.id === id);
    const notes = [...(game.notes || []), { date: new Date().toISOString(), text: text.trim() }];
    updateGame(id, { notes });
  }

  async function analyze(id) {
    const game = games.find((g) => g.id === id);
    if (!game) return;
    setErrors((e) => ({ ...e, [id]: null }));
    setAnalyzing((a) => ({ ...a, [id]: true }));
    try {
      const notesText = (game.notes || []).map((n) => `- ${n.text}`).join("\n");
      const result = await callAnalysis({ profile, game, notesText });
      const entry = { ...result, date: new Date().toISOString() };
      const analyses = [entry, ...(game.analyses || [])];
      updateGame(id, { analyses });
    } catch (e) {
      setErrors((er) => ({ ...er, [id]: e.message || "Erro na análise" }));
    } finally {
      setAnalyzing((a) => ({ ...a, [id]: false }));
    }
  }

  const filteredGames = games.filter((g) => {
    const matchesQuery = g.name.toLowerCase().includes(query.toLowerCase());
    const matchesPlatform = platformFilter === "all" || g.platform === platformFilter;
    const matchesStatus = statusFilter === "all" || g.status === statusFilter;
    const matchesFavorite = !onlyFavorites || g.favorite;
    return matchesQuery && matchesPlatform && matchesStatus && matchesFavorite;
  });

  const activeGame = games.find((g) => g.id === activeGameId) || null;

  // Dashboard: contadores simples calculados a partir dos dados que já existem.
  const stats = games.reduce(
    (acc, g) => {
      acc.total += 1;
      const latest = (g.analyses || [])[0];
      if (latest) {
        acc.analyzed += 1;
        if (latest.tier === 5) acc.excellent += 1;
        else if (latest.tier === 4) acc.good += 1;
        else if (latest.tier === 3) acc.ok += 1;
        else if (latest.tier === 2) acc.bad += 1;
        else if (latest.tier === 1) acc.incompatible += 1;
      }
      return acc;
    },
    { total: 0, analyzed: 0, excellent: 0, good: 0, ok: 0, bad: 0, incompatible: 0 }
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
            <select
              value={activeProfileId}
              onChange={(e) => switchProfile(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-md px-2 py-1.5 text-xs text-zinc-300 outline-none max-w-[140px]"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <span className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-xs text-zinc-400">{profile.cpu}</span>
            <span className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-xs text-zinc-400">{profile.gpu}</span>
            <span className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-xs text-zinc-400">{profile.ram}</span>
          </div>

          <button
            onClick={() => setShowProfile(true)}
            className="ml-auto flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 border border-zinc-800 hover:border-zinc-600 rounded-md px-3 py-1.5 transition-colors"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Perfis de hardware
          </button>
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
              <span className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-amber-800 text-amber-300">
                <b>{stats.ok}</b> ok
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
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 transition-colors text-white text-sm font-medium rounded-lg px-4 py-2"
        >
          <Plus className="w-4 h-4" />
          Adicionar jogo
        </button>
      </div>

      {/* grid */}
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
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filteredGames.map((game) => {
              const latest = (game.analyses || [])[0];
              const gameStatus = statusOf(game.status);
              return (
                <div
                  key={game.id}
                  className="text-left group rounded-xl overflow-hidden border border-zinc-800 bg-zinc-900 hover:border-zinc-600 transition-colors relative"
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleFavorite(game.id); }}
                    className="absolute top-2 left-2 z-10 w-7 h-7 rounded-full bg-black/60 backdrop-blur flex items-center justify-center hover:bg-black/80 transition-colors"
                    aria-label="Favoritar"
                  >
                    <Star className={`w-3.5 h-3.5 ${game.favorite ? "fill-amber-400 text-amber-400" : "text-zinc-300"}`} />
                  </button>
                  <button onClick={() => setActiveGameId(game.id)} className="text-left w-full">
                    <div className="relative">
                      <CoverThumb game={game} className="aspect-video group-hover:opacity-90 transition-opacity" />
                      <div className="absolute top-2 right-2">
                        <TierBadge tier={latest?.tier} tierLabel={latest?.tierLabel} />
                      </div>
                    </div>
                    <div className="p-3">
                      <p className="text-sm font-medium line-clamp-1">{game.name}</p>
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
                  </button>
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
          onClose={() => setShowProfile(false)}
          onSave={(nextProfiles, nextActiveId) => { updateProfiles(nextProfiles, nextActiveId); setShowProfile(false); }}
        />
      )}

      {/* modal: detalhe do jogo */}
      {activeGame && (
        <GameDetailModal
          game={activeGame}
          analyzing={!!analyzing[activeGame.id]}
          error={errors[activeGame.id]}
          onClose={() => setActiveGameId(null)}
          onAnalyze={() => analyze(activeGame.id)}
          onAddNote={(text) => addNote(activeGame.id, text)}
          onUpdateGoals={(goals) => updateGame(activeGame.id, { goals })}
          onToggleFavorite={() => toggleFavorite(activeGame.id)}
          onSetStatus={(status) => setGameStatus(activeGame.id, status)}
          onUpdateRaGameId={(raGameId) => updateGame(activeGame.id, { raGameId })}
          onRemove={() => removeGame(activeGame.id)}
        />
      )}
    </div>
  );
}

function ModalShell({ children, onClose, maxW = "max-w-lg" }) {
  return (
    <div className="fixed inset-0 z-30 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div
        className={`w-full ${maxW} bg-zinc-900 border border-zinc-800 rounded-2xl max-h-screen overflow-y-auto`}
      >
        {children}
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

function AddGameModal({ games, onClose, onAdd }) {
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("steam");
  const [steamAppId, setSteamAppId] = useState("");
  const [coverUrl, setCoverUrl] = useState("");

  const previewCover = coverUrl.trim() || steamCoverUrl(steamAppId.trim());

  const trimmedName = name.trim().toLowerCase();
  const duplicate = trimmedName
    ? (games || []).find((g) => g.name.trim().toLowerCase() === trimmedName)
    : null;

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
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm mb-6 outline-none focus:border-indigo-600"
        />

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-200 px-4 py-2 transition-colors">
            Cancelar
          </button>
          <button
            disabled={!name.trim()}
            onClick={() => onAdd({ name, platform, steamAppId, coverUrl })}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 transition-colors text-white text-sm font-medium rounded-lg px-4 py-2"
          >
            Adicionar
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ProfileModal({ profiles, activeProfileId, onClose, onSave }) {
  const [list, setList] = useState(profiles);
  const [editingId, setEditingId] = useState(activeProfileId);
  const editing = list.find((p) => p.id === editingId) || list[0];

  function updateField(field, value) {
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

function RetroAchievementsSection({ game, onUpdateRaGameId }) {
  const [gameIdInput, setGameIdInput] = useState(game.raGameId || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [showAll, setShowAll] = useState(false);

  async function fetchProgress(id) {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/retroachievements?gameId=${encodeURIComponent(id)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
      setData(body);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id]);

  function handleSave() {
    const trimmed = gameIdInput.trim();
    onUpdateRaGameId(trimmed);
    if (trimmed) fetchProgress(trimmed);
  }

  const visibleAchievements = data ? (showAll ? data.achievements : data.achievements.slice(0, 6)) : [];
  const pct = data && data.numAchievements ? Math.round((data.numAwardedToUser / data.numAchievements) * 100) : 0;

  return (
    <div className="mb-5">
      <div className="flex items-center gap-1.5 text-xs text-zinc-400 mb-1.5">
        <Trophy className="w-3.5 h-3.5" /> RetroAchievements
      </div>

      <div className="flex gap-2 mb-2">
        <input
          value={gameIdInput}
          onChange={(e) => setGameIdInput(e.target.value)}
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
          conquistas aqui.
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
          <ul className="space-y-1.5">
            {visibleAchievements.map((a) => (
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
                <p className={`truncate ${a.earned ? "text-zinc-200" : "text-zinc-500"}`}>{a.title}</p>
                {a.earned && <span className="ml-auto text-amber-400 shrink-0">✓</span>}
              </li>
            ))}
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

function GameDetailModal({ game, analyzing, error, onClose, onAnalyze, onAddNote, onUpdateGoals, onToggleFavorite, onSetStatus, onUpdateRaGameId, onRemove }) {
  const [noteText, setNoteText] = useState("");
  const [goalsText, setGoalsText] = useState(game.goals || "");
  const [showHistory, setShowHistory] = useState(false);
  const latest = (game.analyses || [])[0];
  const older = (game.analyses || []).slice(1);

  return (
    <ModalShell onClose={onClose} maxW="max-w-2xl">
      <div>
        <CoverThumb game={game} className="w-full aspect-video" />
        <div className="p-6">
          <div className="flex items-start justify-between gap-3 mb-1">
            <h2 className="text-lg font-semibold">{game.name}</h2>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={onToggleFavorite}
                className="w-7 h-7 rounded-full bg-zinc-950 border border-zinc-800 flex items-center justify-center hover:border-zinc-600 transition-colors"
                aria-label="Favoritar"
              >
                <Star className={`w-3.5 h-3.5 ${game.favorite ? "fill-amber-400 text-amber-400" : "text-zinc-400"}`} />
              </button>
              <span className={`text-xs px-2 py-0.5 rounded-full ${platformOf(game.platform).badge}`}>
                {platformOf(game.platform).label}
              </span>
            </div>
          </div>
          <p className="text-xs text-zinc-500 mb-4">adicionado em {formatDate(game.createdAt)}</p>

          {/* status: quero jogar / jogando / zerado / abandonado */}
          <div className="flex flex-wrap gap-1.5 mb-6">
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

          {/* conquistas via RetroAchievements */}
          <RetroAchievementsSection game={game} onUpdateRaGameId={onUpdateRaGameId} />

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

          {/* analisar */}
          <button
            onClick={onAnalyze}
            disabled={analyzing}
            className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 transition-colors text-white text-sm font-medium rounded-lg px-4 py-2.5 mb-4"
          >
            {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {analyzing ? "Analisando com base no seu hardware..." : "Analisar compatibilidade agora"}
          </button>

          {error && (
            <div className="flex items-start gap-2 text-sm text-red-300 bg-red-950 border border-red-800 rounded-lg px-3 py-2 mb-4">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          {/* resultado */}
          {latest && (
            <div className={`rounded-xl border ${TIER_META[latest.tier]?.border || "border-zinc-700"} bg-zinc-950 p-4 mb-3`}>
              <div className="flex items-center justify-between mb-2">
                <TierBadge tier={latest.tier} tierLabel={latest.tierLabel} size="lg" />
                <span className="text-xs text-zinc-600">{formatDate(latest.date)}</span>
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
          )}

          {older.length > 0 && (
            <div className="mb-4">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {showHistory ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                Ver {older.length} análise(s) anterior(es)
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
