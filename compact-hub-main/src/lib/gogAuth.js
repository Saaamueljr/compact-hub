// src/lib/gogAuth.js
// Camada de integração com a GOG para o CompatHub.
//
// IMPORTANTE: a GOG não tem API pública oficial de conquistas. Isso usa os
// mesmos endpoints internos não-documentados que o site gog.com e o cliente
// GOG Galaxy usam por trás dos panos (documentados de forma não-oficial em
// https://gogapidocs.readthedocs.io). Pode quebrar a qualquer momento sem
// aviso da GOG — não há nada que o CompatHub possa fazer a respeito além de
// consertar quando (se) isso acontecer.
//
// Fluxo de login (tem que ser manual — a GOG pode pedir captcha, por isso
// precisa de um navegador de verdade, não dá pra automatizar via servidor):
//   1. gogAuth.getAuthUrl() -> abre num navegador/nova aba
//   2. Usuário loga normalmente na GOG
//   3. GOG redireciona pra embed.gog.com/on_login_success?code=XXXX
//   4. Usuário copia o "code" da URL e cola no CompatHub
//   5. gogAuth.exchangeCode(code) -> troca por access/refresh token
//
// O refresh_token fica salvo no localStorage (mesmo padrão do driveSync.js)
// porque a GOG pode rotacioná-lo a cada uso — guardar isso como secret fixo
// no Worker exigiria redeploy toda vez que expirasse.

const STORAGE_KEY = "compathub-gog-auth";

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveStored(auth) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
}

function clearStored() {
  localStorage.removeItem(STORAGE_KEY);
}

// Se uma chamada devolver um refreshToken novo (a GOG rotacionou), atualiza
// o que está salvo no localStorage sem precisar de login de novo.
function maybeUpdateRefreshToken(newRefreshToken) {
  if (!newRefreshToken) return;
  const current = loadStored();
  if (current && current.refreshToken !== newRefreshToken) {
    saveStored({ ...current, refreshToken: newRefreshToken });
  }
}

async function getAuthUrl() {
  const res = await fetch("/api/gog/auth-url");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Falha ao gerar o link de login da GOG.");
  return data.authUrl;
}

async function exchangeCode(code) {
  const res = await fetch(`/api/gog/exchange?code=${encodeURIComponent(code)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Falha ao trocar o código pela sessão da GOG.");
  saveStored({ refreshToken: data.refreshToken, userId: data.userId });
  return data;
}

function isConnected() {
  const stored = loadStored();
  return Boolean(stored?.refreshToken && stored?.userId);
}

function disconnect() {
  clearStored();
}

async function getLibrary() {
  const stored = loadStored();
  if (!stored) throw new Error("GOG não conectada. Faça login primeiro.");
  const res = await fetch(`/api/gog/games?refreshToken=${encodeURIComponent(stored.refreshToken)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Falha ao ler a biblioteca da GOG.");
  maybeUpdateRefreshToken(data.refreshToken);
  return data.productIds || [];
}

async function getAchievements(productId) {
  const stored = loadStored();
  if (!stored) throw new Error("GOG não conectada. Faça login primeiro.");
  const params = new URLSearchParams({
    productId: String(productId),
    refreshToken: stored.refreshToken,
    userId: stored.userId,
  });
  const res = await fetch(`/api/gog?${params.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Falha ao buscar conquistas na GOG.");
  maybeUpdateRefreshToken(data.refreshToken);
  return data;
}

export const gogAuth = {
  getAuthUrl,
  exchangeCode,
  isConnected,
  disconnect,
  getLibrary,
  getAchievements,
};
