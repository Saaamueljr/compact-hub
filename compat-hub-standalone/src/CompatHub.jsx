import { useState, useEffect } from "react";
import {
  Search, Plus, X, RefreshCw, Trash2, Gamepad2, Loader2,
  AlertTriangle, Settings2, History, Target, ChevronDown, ChevronUp
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

const DEFAULT_PROFILE = {
  cpu: "Core 2 Quad Q9500",
  gpu: "GTX 750 Ti 1GB",
  ram: "8GB DDR2",
  os: "Windows 10 LTSC 2019 (1809)",
  preferences:
    "Prefiro estabilidade a gráficos altos. Aceito baixar resolução/textura antes de travar fps. Não me importo de aplicar patches da comunidade quando necessário.",
};

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
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [games, setGames] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const [query, setQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState("all");

  const [showAdd, setShowAdd] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [activeGameId, setActiveGameId] = useState(null);

  const [analyzing, setAnalyzing] = useState({});
  const [errors, setErrors] = useState({});

  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(STORAGE_KEY);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          setProfile(parsed.profile || DEFAULT_PROFILE);
          setGames(parsed.games || []);
        }
      } catch {
        // sem dados salvos ainda — segue com os padrões
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function persist(nextProfile, nextGames) {
    try {
      await storage.set(STORAGE_KEY, JSON.stringify({ profile: nextProfile, games: nextGames }));
    } catch (e) {
      console.error("Erro ao salvar:", e);
    }
  }

  function updateGames(nextGames) {
    setGames(nextGames);
    persist(profile, nextGames);
  }

  function updateProfile(nextProfile) {
    setProfile(nextProfile);
    persist(nextProfile, games);
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
      createdAt: new Date().toISOString(),
    };
    updateGames([newGame, ...games]);
    setShowAdd(false);
    setActiveGameId(newGame.id);
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
    return matchesQuery && matchesPlatform;
  });

  const activeGame = games.find((g) => g.id === activeGameId) || null;

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

          <div className="hidden md:flex items-center gap-2 text-xs text-zinc-400 ml-2">
            <span className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800">{profile.cpu}</span>
            <span className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800">{profile.gpu}</span>
            <span className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800">{profile.ram}</span>
          </div>

          <button
            onClick={() => setShowProfile(true)}
            className="ml-auto flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-100 border border-zinc-800 hover:border-zinc-600 rounded-md px-3 py-1.5 transition-colors"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Configuração
          </button>
        </div>
      </div>

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
              return (
                <button
                  key={game.id}
                  onClick={() => setActiveGameId(game.id)}
                  className="text-left group rounded-xl overflow-hidden border border-zinc-800 bg-zinc-900 hover:border-zinc-600 transition-colors"
                >
                  <div className="relative">
                    <CoverThumb game={game} className="aspect-video group-hover:opacity-90 transition-opacity" />
                    <div className="absolute top-2 right-2">
                      <TierBadge tier={latest?.tier} tierLabel={latest?.tierLabel} />
                    </div>
                  </div>
                  <div className="p-3">
                    <p className="text-sm font-medium line-clamp-1">{game.name}</p>
                    <div className="flex items-center justify-between mt-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${platformOf(game.platform).badge}`}>
                        {platformOf(game.platform).label}
                      </span>
                      {latest && <span className="text-xs text-zinc-600">{formatDate(latest.date)}</span>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* modal: adicionar jogo */}
      {showAdd && <AddGameModal games={games} onClose={() => setShowAdd(false)} onAdd={addGame} />}

      {/* modal: perfil / hardware */}
      {showProfile && (
        <ProfileModal
          profile={profile}
          onClose={() => setShowProfile(false)}
          onSave={(p) => { updateProfile(p); setShowProfile(false); }}
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

function ProfileModal({ profile, onClose, onSave }) {
  const [form, setForm] = useState(profile);

  return (
    <ModalShell onClose={onClose}>
      <div className="p-6">
        <h2 className="text-base font-semibold mb-1">Sua configuração</h2>
        <p className="text-xs text-zinc-500 mb-5">Usado em toda análise. Atualize quando trocar de peça.</p>

        {["cpu", "gpu", "ram", "os"].map((field) => (
          <div key={field} className="mb-4">
            <label className="text-xs text-zinc-400 mb-1 block uppercase">{field}</label>
            <input
              value={form[field]}
              onChange={(e) => setForm({ ...form, [field]: e.target.value })}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-600"
            />
          </div>
        ))}

        <label className="text-xs text-zinc-400 mb-1 block">Preferências gerais / objetivos</label>
        <textarea
          value={form.preferences}
          onChange={(e) => setForm({ ...form, preferences: e.target.value })}
          rows={3}
          placeholder="ex: prefiro estabilidade a gráficos, aceito rodar em 720p..."
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm mb-6 outline-none focus:border-indigo-600 resize-none"
        />

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-200 px-4 py-2 transition-colors">
            Cancelar
          </button>
          <button
            onClick={() => onSave(form)}
            className="bg-indigo-600 hover:bg-indigo-500 transition-colors text-white text-sm font-medium rounded-lg px-4 py-2"
          >
            Salvar
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function GameDetailModal({ game, analyzing, error, onClose, onAnalyze, onAddNote, onUpdateGoals, onRemove }) {
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
            <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${platformOf(game.platform).badge}`}>
              {platformOf(game.platform).label}
            </span>
          </div>
          <p className="text-xs text-zinc-500 mb-6">adicionado em {formatDate(game.createdAt)}</p>

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
