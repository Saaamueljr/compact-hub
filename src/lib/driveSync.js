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

    // Tenta restaurar um token salvo nesta sessão do navegador (evita pedir
    // login de novo a cada refresh — o token do GIS dura ~1h, então isso só
    // ajuda dentro da mesma sessão, não entre dias).
    try {
      const saved = sessionStorage.getItem(TOKEN_STORAGE_KEY);
      if (saved) this.accessToken = saved;
    } catch {
      // sessionStorage indisponível — segue sem restaurar
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
          sessionStorage.setItem(TOKEN_STORAGE_KEY, response.access_token);
        } catch {
          // ignora — só perde a persistência entre refreshes
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
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
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

  async _findFileId() {
    if (this.fileId) return this.fileId;

    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `name='${FILE_NAME}' and trashed=false`);
    url.searchParams.set("spaces", "drive");
    url.searchParams.set("fields", "files(id,name,modifiedTime)");

    const res = await fetch(url, { headers: this._authHeaders() });
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
    if (!res.ok) throw new Error(`Erro ao atualizar arquivo no Drive: ${res.status}`);
    return payload;
  }

  // Migração única do localStorage pro Drive — só roda se ainda não existir
  // arquivo lá (ou seja, primeira vez que este usuário conecta a conta).
  async migrateFromLocalStorageIfNeeded(localStorageKey) {
    const existing = await this.load();
    if (existing) return { migrated: false, data: existing };

    const raw = localStorage.getItem(localStorageKey);
    if (!raw) return { migrated: false, data: null };

    const localData = JSON.parse(raw);
    const saved = await this.save(localData);
    return { migrated: true, data: saved };
  }
}

export const driveSync = new DriveSync();
