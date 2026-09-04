// src/lib/driveSync.js
// Camada de sincronização com Google Drive para o CompatHub.
// Estratégia: arquivo único (compathub-library.json) guardado no escopo
// privado do app (drive.file — o app só enxerga o que ele mesmo criou),
// resolução de conflito por last-write-wins usando o campo `updatedAt`.
//
// Uso (já plugado em CompatHub.jsx, ver objeto `storage`):
//   await driveSync.init(GOOGLE_CLIENT_ID);
//   await driveSync.signIn();
//   const remote = await driveSync.load();
//   await driveSync.save(estado);

const FILE_NAME = "compathub-library.json";
const MIME_TYPE = "application/json";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
const TOKEN_STORAGE_KEY = "compathub-drive-token";
// Margem de segurança: trata o token como expirado um pouco antes da hora
// real, pra nunca tentar usar um token que expira no meio de uma chamada.
const EXPIRY_SAFETY_MARGIN_MS = 60 * 1000;

class DriveSync {
  constructor() {
    this.clientId = null;
    this.tokenClient = null;
    this.accessToken = null;
    this.fileId = null;
    this._gisLoadPromise = null;
  }

  _loadGisScript() {
    if (this._gisLoadPromise) return this._gisLoadPromise;
    this._gisLoadPromise = new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) return resolve();
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Falha ao carregar Google Identity Services."));
      document.head.appendChild(script);
    });
    return this._gisLoadPromise;
  }

  async init(clientId) {
    if (!clientId) throw new Error("driveSync.init() precisa de um Client ID do Google Cloud.");
    this.clientId = clientId;
    await this._loadGisScript();
    this.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: SCOPES,
      callback: () => {},
    });

    // Restaura um token salvo em localStorage (sobrevive a fechar o
    // app/aba — ao contrário de sessionStorage). Só restaura se ainda não
    // tiver expirado; token vencido é descartado pra não fingir "conectado"
    // e falhar na primeira chamada real ao Drive.
    try {
      const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved?.token && saved?.expiresAt > Date.now() + EXPIRY_SAFETY_MARGIN_MS) {
          this.accessToken = saved.token;
        } else {
          localStorage.removeItem(TOKEN_STORAGE_KEY);
        }
      }
    } catch {
      // localStorage indisponível ou corrompido — segue sem restaurar
    }
  }

  signIn() {
    return new Promise((resolve, reject) => {
      if (!this.tokenClient) {
        return reject(new Error("Chame driveSync.init() antes de signIn()."));
      }
      this.tokenClient.callback = (response) => {
        if (response.error) return reject(response);
        this.accessToken = response.access_token;
        try {
          const expiresAt = Date.now() + (response.expires_in || 3600) * 1000;
          localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token: response.access_token, expiresAt }));
        } catch {
          // ignora — só perde a persistência entre reaberturas do app
        }
        resolve(response.access_token);
      };
      this.tokenClient.requestAccessToken({ prompt: "" });
    });
  }

  signOut() {
    if (this.accessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(this.accessToken, () => {});
    }
    this.accessToken = null;
    this.fileId = null;
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // ignora
    }
  }

  isSignedIn() {
    return !!this.accessToken;
  }

  _authHeaders(extra = {}) {
    if (!this.accessToken) throw new Error("Usuário não autenticado no Google Drive.");
    return { Authorization: `Bearer ${this.accessToken}`, ...extra };
  }

  // Se o token expirou no meio do uso (~1h), o Google responde 401. Limpa o
  // estado local e sinaliza isso de forma distinguível, pra quem chama saber
  // que é "sessão expirada, precisa reconectar" e não um erro genérico.
  _checkAuthError(res) {
    if (res.status === 401) {
      this.accessToken = null;
      try {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      } catch {
        // ignora
      }
      throw new Error("SESSION_EXPIRED: sua sessão do Google Drive expirou, reconecte.");
    }
  }

  async _findFileId() {
    if (this.fileId) return this.fileId;

    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `name='${FILE_NAME}' and trashed=false`);
    url.searchParams.set("spaces", "drive");
    url.searchParams.set("fields", "files(id,name,modifiedTime)");

    const res = await fetch(url, { headers: this._authHeaders() });
    this._checkAuthError(res);
    if (!res.ok) throw new Error(`Erro ao buscar arquivo no Drive: ${res.status}`);
    const data = await res.json();

    if (data.files && data.files.length > 0) {
      this.fileId = data.files[0].id;
      return this.fileId;
    }
    return null;
  }

  async load() {
    const fileId = await this._findFileId();
    if (!fileId) return null;

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: this._authHeaders() }
    );
    this._checkAuthError(res);
    if (!res.ok) throw new Error(`Erro ao ler arquivo do Drive: ${res.status}`);
    return res.json();
  }

  async save(state) {
    const payload = { ...state, updatedAt: new Date().toISOString() };
    const fileId = await this._findFileId();
    if (!fileId) return this._createFile(payload);
    return this._updateFile(fileId, payload);
  }

  async _createFile(payload) {
    const metadata = { name: FILE_NAME, mimeType: MIME_TYPE };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", new Blob([JSON.stringify(payload)], { type: MIME_TYPE }));

    const res = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      { method: "POST", headers: this._authHeaders(), body: form }
    );
    this._checkAuthError(res);
    if (!res.ok) throw new Error(`Erro ao criar arquivo no Drive: ${res.status}`);
    const data = await res.json();
    this.fileId = data.id;
    return payload;
  }

  async _updateFile(fileId, payload) {
    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      {
        method: "PATCH",
        headers: this._authHeaders({ "Content-Type": MIME_TYPE }),
        body: JSON.stringify(payload),
      }
    );
    this._checkAuthError(res);
    if (!res.ok) throw new Error(`Erro ao atualizar arquivo no Drive: ${res.status}`);
    return payload;
  }

  // Reconciliação real de last-write-wins: compara o `updatedAt` do que está
  // salvo local com o que está no Drive, e mantém o mais recente. Se o local
  // não tiver `updatedAt` (dados antigos, salvos antes dessa correção), dá o
  // benefício da dúvida pro local — é o que está na tela agora, mais seguro
  // do que sobrescrever silenciosamente com algo potencialmente desatualizado.
  async reconcile(localPayload) {
    const remote = await this.load();

    if (!remote) {
      if (localPayload) await this.save(localPayload);
      return { source: "local", data: localPayload };
    }
    if (!localPayload) {
      return { source: "remote", data: remote };
    }

    const localTime = localPayload.updatedAt ? Date.parse(localPayload.updatedAt) : Date.now();
    const remoteTime = remote.updatedAt ? Date.parse(remote.updatedAt) : 0;

    if (localTime >= remoteTime) {
      await this.save(localPayload);
      return { source: "local", data: localPayload };
    }
    return { source: "remote", data: remote };
  }
}

export const driveSync = new DriveSync();
