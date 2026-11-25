(() => {
  const STORAGE_KEY = "fortnite_chest_counter_v2";
  const HANDLE_DB_NAME = "fortnite_chest_handles";
  const HANDLE_STORE_NAME = "handles";
  const DEMOS_HANDLE_KEY = "demos_dir";
  const DEMOS_PATH_TEXT = "%LOCALAPPDATA%\\FortniteGame\\Saved\\Demos";
  const TOKEN_BASE_DENOMINATOR = 137500;
  const SERVER_POLL_MS = 3000;
  const FOLDER_POLL_MS = 8000;
  const USE_LOCAL_SERVER =
    (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") &&
    window.location.port === "5050";
  const SUPPORTS_DIR_PICKER = "showDirectoryPicker" in window;

  const DEFAULT_STORE = {
    baseCount: 0,
    currentManualMatch: 0,
    countMode: "mine",
    ignoredFiles: [],
    matches: []
  };

  const els = {
    dropZone: document.getElementById("drop-zone"),
    watcherDot: document.getElementById("watcher-dot"),
    connectTitle: document.getElementById("connect-title"),
    watcherMessage: document.getElementById("watcher-message"),
    browserControls: document.getElementById("browser-connect-controls"),
    localServerControls: document.getElementById("local-server-controls"),
    btnConnectFolder: document.getElementById("btn-connect-folder"),
    btnReconnectFolder: document.getElementById("btn-reconnect-folder"),
    btnCopyPath: document.getElementById("btn-copy-path"),
    inputReplayFiles: document.getElementById("input-replay-files"),
    helpGuide: document.getElementById("help-guide"),
    btnScan: document.getElementById("btn-scan"),
    btnRescan: document.getElementById("btn-rescan"),
    totalCount: document.getElementById("total-count"),
    baseBadge: document.getElementById("base-badge"),
    baseCountLabel: document.getElementById("base-count-label"),
    btnModeMine: document.getElementById("btn-mode-mine"),
    btnModeSquad: document.getElementById("btn-mode-squad"),
    statMatches: document.getElementById("stat-matches"),
    statAvg: document.getElementById("stat-avg"),
    statBest: document.getElementById("stat-best"),
    statOdds: document.getElementById("stat-odds"),
    statOpened: document.getElementById("stat-opened"),
    statBroken: document.getElementById("stat-broken"),
    todayCount: document.getElementById("today-count"),
    todayMatches: document.getElementById("today-matches"),
    dateFilter: document.getElementById("date-filter"),
    btnFilterToday: document.getElementById("btn-filter-today"),
    btnFilterAll: document.getElementById("btn-filter-all"),
    selectedDateSummary: document.getElementById("selected-date-summary"),
    dailyList: document.getElementById("daily-list"),
    dailyEmpty: document.getElementById("daily-empty"),
    historyFilterLabel: document.getElementById("history-filter-label"),
    currentCount: document.getElementById("current-count"),
    btnAddOne: document.getElementById("btn-add-one"),
    btnSaveMatch: document.getElementById("btn-save-match"),
    btnResetCurrent: document.getElementById("btn-reset-current"),
    btnEditCurrent: document.getElementById("btn-edit-current"),
    btnSetBase: document.getElementById("btn-set-base"),
    btnExport: document.getElementById("btn-export"),
    inputImport: document.getElementById("input-import"),
    btnClearAll: document.getElementById("btn-clear-all"),
    historyList: document.getElementById("history-list"),
    historyEmpty: document.getElementById("history-empty"),
    statusBanner: document.getElementById("status-banner"),
    modal: document.getElementById("modal-number"),
    modalForm: document.getElementById("modal-form"),
    modalTitle: document.getElementById("modal-title"),
    modalDesc: document.getElementById("modal-desc"),
    modalInput: document.getElementById("modal-input"),
    modalCancel: document.getElementById("modal-cancel")
  };

  let store = structuredClone(DEFAULT_STORE);
  let watcher = {
    state: "idle",
    title: "Conecta tu carpeta de Fortnite",
    message: "Haz clic abajo para elegir tu carpeta Demos. Cuenta cofres abiertos y edificios rotos automáticamente."
  };
  let statusTimer = null;
  let modalMode = null;
  let selectedDate = "";
  let activeDirHandle = null;
  let savedDirHandle = null;
  let isScanningFolder = false;
  let workerInstance = null;
  let workerSeq = 0;
  const pendingWorkerJobs = new Map();
  const failedThisSession = new Set();

  function showStatus(message, type = "success") {
    els.statusBanner.textContent = message;
    els.statusBanner.className = `status-banner ${type}`;
    els.statusBanner.hidden = false;

    if (statusTimer) {
      clearTimeout(statusTimer);
    }
    statusTimer = setTimeout(() => {
      els.statusBanner.hidden = true;
    }, 4000);
  }

  function toNonNegativeInt(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function sanitizeStore(raw) {
    if (!raw || typeof raw !== "object") {
      return structuredClone(DEFAULT_STORE);
    }

    const matches = Array.isArray(raw.matches)
      ? raw.matches
          .filter((item) => item && typeof item === "object")
          .map((item, idx) => {
            const myOpened = toNonNegativeInt(item.myOpened ?? item.chests, 0);
            const myBroken = toNonNegativeInt(item.myBroken, 0);
            const myTotal = toNonNegativeInt(item.myTotal, myOpened + myBroken);
            const squadOpened = toNonNegativeInt(item.squadOpened, myOpened);
            const squadBroken = toNonNegativeInt(item.squadBroken, myBroken);
            const squadTotal = toNonNegativeInt(item.squadTotal, Math.max(myTotal, squadOpened + squadBroken));
            return {
              id: typeof item.id === "string" && item.id ? item.id : `m-${Date.now()}-${idx}`,
              source: item.source === "replay" ? "replay" : "manual",
              fileName: typeof item.fileName === "string" ? item.fileName : null,
              savedAt: typeof item.savedAt === "string" ? item.savedAt : new Date().toISOString(),
              lengthMs: toNonNegativeInt(item.lengthMs, 0),
              myOpened,
              myBroken,
              myTotal,
              squadOpened,
              squadBroken,
              squadTotal
            };
          })
      : [];

    return {
      baseCount: toNonNegativeInt(raw.baseCount, 0),
      currentManualMatch: toNonNegativeInt(raw.currentManualMatch, 0),
      countMode: raw.countMode === "squad" ? "squad" : "mine",
      ignoredFiles: Array.isArray(raw.ignoredFiles)
        ? raw.ignoredFiles.filter((x) => typeof x === "string" && x)
        : [],
      matches
    };
  }

  function formatDate(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return "Fecha desconocida";
    }
    return date.toLocaleString("es-ES", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatDuration(lengthMs) {
    if (!lengthMs || lengthMs <= 0) {
      return "";
    }
    return ` · ${Math.round(lengthMs / 60000)} min`;
  }

  function getMatchCounts(match) {
    if (store.countMode === "squad") {
      return {
        opened: toNonNegativeInt(match.squadOpened, 0),
        broken: toNonNegativeInt(match.squadBroken, 0),
        total: toNonNegativeInt(match.squadTotal, 0)
      };
    }
    return {
      opened: toNonNegativeInt(match.myOpened, 0),
      broken: toNonNegativeInt(match.myBroken, 0),
      total: toNonNegativeInt(match.myTotal, 0)
    };
  }

  function computeCumulativeOdds(totalChests) {
    if (totalChests <= 0) {
      return 0;
    }
    return (1 - Math.pow(1 - 1 / TOKEN_BASE_DENOMINATOR, totalChests)) * 100;
  }

  function setWatcher(state, message, title) {
    watcher.state = state;
    watcher.message = message;
    if (title) {
      watcher.title = title;
    }
    renderWatcher();
  }

  function renderWatcher() {
    els.watcherDot.className = `status-dot ${watcher.state || "idle"}`;
    els.connectTitle.textContent = watcher.title || "Detector automático (.replay)";
    els.watcherMessage.textContent = watcher.message || "";
    els.browserControls.hidden = USE_LOCAL_SERVER;
    els.localServerControls.hidden = !USE_LOCAL_SERVER;
    els.helpGuide.hidden = USE_LOCAL_SERVER;

    if (!USE_LOCAL_SERVER) {
      els.btnConnectFolder.hidden = !SUPPORTS_DIR_PICKER;
      els.btnConnectFolder.textContent = activeDirHandle
        ? "Cambiar carpeta Demos"
        : "Conectar carpeta Demos";
      els.btnReconnectFolder.hidden = !SUPPORTS_DIR_PICKER || Boolean(activeDirHandle) || !savedDirHandle;
    }
  }

  function getLocalDateKey(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function getTodayDateKey() {
    return getLocalDateKey(new Date().toISOString());
  }

  function formatDayLabel(dateKey) {
    if (!dateKey) return "Sin fecha";
    const [y, m, d] = dateKey.split("-").map((n) => Number.parseInt(n, 10));
    const date = new Date(y, m - 1, d);
    const todayKey = getTodayDateKey();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = getLocalDateKey(yesterday.toISOString());

    const formatted = date.toLocaleDateString("es-ES", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric"
    });
    if (dateKey === todayKey) return `Hoy · ${formatted}`;
    if (dateKey === yesterdayKey) return `Ayer · ${formatted}`;
    return formatted;
  }

  function buildDailyGroups() {
    const groups = new Map();
    for (const match of store.matches) {
      const key = getLocalDateKey(match.savedAt);
      if (!key) continue;
      if (!groups.has(key)) {
        groups.set(key, { dateKey: key, matches: 0, opened: 0, broken: 0, total: 0 });
      }
      const g = groups.get(key);
      const c = getMatchCounts(match);
      g.matches += 1;
      g.opened += c.opened;
      g.broken += c.broken;
      g.total += c.total;
    }
    return Array.from(groups.values()).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  }

  function renderDailySummary(groups) {
    const todayKey = getTodayDateKey();
    const todayGroup = groups.find((g) => g.dateKey === todayKey);
    els.todayCount.textContent = (todayGroup ? todayGroup.total : 0).toLocaleString("es-ES");
    const todayMatches = todayGroup ? todayGroup.matches : 0;
    els.todayMatches.textContent = `(${todayMatches} ${todayMatches === 1 ? "partida" : "partidas"})`;

    els.dateFilter.value = selectedDate;
    els.dailyList.replaceChildren();
    els.dailyEmpty.hidden = groups.length > 0;

    if (selectedDate) {
      const chosen = groups.find((g) => g.dateKey === selectedDate);
      els.selectedDateSummary.hidden = false;
      els.selectedDateSummary.textContent = chosen
        ? `${formatDayLabel(selectedDate)}: ${chosen.total.toLocaleString("es-ES")} cofres en ${chosen.matches} ${chosen.matches === 1 ? "partida" : "partidas"} (${chosen.opened} abiertos, ${chosen.broken} rotos).`
        : `${formatDayLabel(selectedDate)}: 0 cofres registrados en esta fecha.`;
    } else {
      els.selectedDateSummary.hidden = true;
    }

    for (const g of groups) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `daily-item${selectedDate === g.dateKey ? " active" : ""}`;
      btn.addEventListener("click", () => {
        selectedDate = selectedDate === g.dateKey ? "" : g.dateKey;
        render();
      });

      const meta = document.createElement("div");
      meta.className = "daily-meta";

      const title = document.createElement("span");
      title.className = "daily-date-title";
      title.textContent = formatDayLabel(g.dateKey);

      const sub = document.createElement("span");
      sub.className = "daily-sub";
      sub.textContent = `${g.matches} ${g.matches === 1 ? "partida" : "partidas"} · ${g.opened} abiertos, ${g.broken} rotos`;

      meta.append(title, sub);

      const total = document.createElement("span");
      total.className = "daily-chests";
      total.textContent = g.total.toLocaleString("es-ES");

      btn.append(meta, total);
      li.appendChild(btn);
      els.dailyList.appendChild(li);
    }
  }

  function renderHistory() {
    els.historyList.replaceChildren();
    const indexedMatches = store.matches.map((match, idx) => ({ match, matchNumber: idx + 1 }));
    const visibleMatches = selectedDate
      ? indexedMatches.filter((item) => getLocalDateKey(item.match.savedAt) === selectedDate)
      : indexedMatches;

    els.historyFilterLabel.textContent = selectedDate
      ? `Mostrando: ${formatDayLabel(selectedDate)}`
      : "";

    els.historyEmpty.hidden = visibleMatches.length > 0;

    visibleMatches
      .slice()
      .reverse()
      .forEach(({ match, matchNumber }) => {
        const counts = getMatchCounts(match);

        const li = document.createElement("li");
        li.className = "history-item";

        const meta = document.createElement("div");
        meta.className = "history-meta";

        const titleRow = document.createElement("div");
        titleRow.className = "history-title-row";

        const title = document.createElement("span");
        title.className = "history-title";
        title.textContent = `Partida #${matchNumber}`;

        const pill = document.createElement("span");
        pill.className = match.source === "replay" ? "source-pill" : "source-pill manual";
        pill.textContent = match.source === "replay" ? "Auto .replay" : "Manual";

        titleRow.append(title, pill);

        const sub = document.createElement("span");
        sub.className = "history-sub";
        if (match.source === "replay") {
          const extra = store.countMode === "mine" && match.squadTotal > counts.total
            ? ` · Equipo: ${match.squadTotal}`
            : "";
          sub.textContent = `${formatDate(match.savedAt)}${formatDuration(match.lengthMs)} · ${counts.opened} abiertos, ${counts.broken} rotos${extra}`;
        } else {
          sub.textContent = `${formatDate(match.savedAt)} · Registro manual`;
        }

        meta.append(titleRow, sub);

        const right = document.createElement("div");
        right.className = "history-right";

        const chests = document.createElement("span");
        chests.className = "history-chests";
        chests.textContent = `+${counts.total.toLocaleString("es-ES")}`;

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "btn-link danger";
        deleteBtn.textContent = "Eliminar";
        deleteBtn.addEventListener("click", () => deleteMatch(match.id));

        right.append(chests, deleteBtn);
        li.append(meta, right);
        els.historyList.appendChild(li);
      });
  }

  function render() {
    renderWatcher();

    let matchesSum = 0;
    let openedSum = 0;
    let brokenSum = 0;
    let best = 0;

    for (const match of store.matches) {
      const c = getMatchCounts(match);
      matchesSum += c.total;
      openedSum += c.opened;
      brokenSum += c.broken;
      if (c.total > best) {
        best = c.total;
      }
    }

    const totalChests = store.baseCount + matchesSum;
    const matchCount = store.matches.length;
    const avg = matchCount > 0 ? matchesSum / matchCount : 0;

    els.totalCount.textContent = totalChests.toLocaleString("es-ES");
    els.currentCount.textContent = store.currentManualMatch.toLocaleString("es-ES");
    els.baseBadge.hidden = store.baseCount === 0;
    els.baseCountLabel.textContent = store.baseCount.toLocaleString("es-ES");

    els.btnModeMine.classList.toggle("active", store.countMode === "mine");
    els.btnModeSquad.classList.toggle("active", store.countMode === "squad");

    els.statMatches.textContent = matchCount.toLocaleString("es-ES");
    els.statAvg.textContent = avg.toFixed(1);
    els.statBest.textContent = best.toLocaleString("es-ES");
    els.statOdds.textContent = `${computeCumulativeOdds(totalChests).toFixed(2)}%`;
    els.statOpened.textContent = openedSum.toLocaleString("es-ES");
    els.statBroken.textContent = brokenSum.toLocaleString("es-ES");

    renderDailySummary(buildDailyGroups());
    renderHistory();
  }

  function saveLocalStore() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (error) {
      console.error("Error guardando estado local:", error);
      showStatus("No se pudo guardar en el navegador (almacenamiento bloqueado o lleno).", "error");
    }
  }

  function loadLocalStore() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        store = sanitizeStore(JSON.parse(saved));
      }
    } catch (error) {
      console.error("Error cargando estado local:", error);
      store = structuredClone(DEFAULT_STORE);
    }
    render();
  }

  function openHandleDb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        resolve(null);
        return;
      }
      const req = indexedDB.open(HANDLE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(HANDLE_STORE_NAME)) {
          req.result.createObjectStore(HANDLE_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveDirectoryHandle(handle) {
    try {
      const db = await openHandleDb();
      if (!db) return;
      const tx = db.transaction(HANDLE_STORE_NAME, "readwrite");
      tx.objectStore(HANDLE_STORE_NAME).put(handle, DEMOS_HANDLE_KEY);
    } catch (error) {
      console.error("No se pudo guardar referencia de carpeta:", error);
    }
  }

  async function loadSavedDirectoryHandle() {
    try {
      const db = await openHandleDb();
      if (!db) return null;
      return await new Promise((resolve) => {
        const tx = db.transaction(HANDLE_STORE_NAME, "readonly");
        const req = tx.objectStore(HANDLE_STORE_NAME).get(DEMOS_HANDLE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (error) {
      console.error("No se pudo leer referencia de carpeta:", error);
      return null;
    }
  }

  const WASM_JOB_TIMEOUT_MS = 25000;

  function ensureWorker() {
    if (workerInstance) {
      return workerInstance;
    }
    workerInstance = new Worker("./parser.worker.js", { type: "module" });
    workerInstance.onmessage = (event) => {
      const { id, result } = event.data;
      const job = pendingWorkerJobs.get(id);
      if (!job) return;
      clearTimeout(job.timer);
      pendingWorkerJobs.delete(id);
      job.resolve(result);
    };
    workerInstance.onerror = (event) => {
      for (const [, job] of pendingWorkerJobs) {
        clearTimeout(job.timer);
        job.reject(new Error(event.message || "Error en el lector WebAssembly."));
      }
      pendingWorkerJobs.clear();
    };
    return workerInstance;
  }

  function analyzeBufferInWasm(fileName, buffer) {
    const worker = ensureWorker();
    const id = ++workerSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingWorkerJobs.delete(id);
        if (workerInstance) {
          workerInstance.terminate();
          workerInstance = null;
        }
        reject(new Error(`Tiempo agotado analizando ${fileName}`));
      }, WASM_JOB_TIMEOUT_MS);

      pendingWorkerJobs.set(id, { resolve, reject, timer });
      worker.postMessage({ id, fileName, buffer }, [buffer]);
    });
  }

  function addParsedReplayMatch(result) {
    if (store.matches.some((m) => m.fileName === result.fileName)) {
      return false;
    }
    store.matches.push({
      id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      source: "replay",
      fileName: result.fileName,
      savedAt: result.timestamp || new Date().toISOString(),
      lengthMs: toNonNegativeInt(result.lengthMs, 0),
      myOpened: toNonNegativeInt(result.myOpened, 0),
      myBroken: toNonNegativeInt(result.myBroken, 0),
      myTotal: toNonNegativeInt(result.myTotal, 0),
      squadOpened: toNonNegativeInt(result.squadOpened, 0),
      squadBroken: toNonNegativeInt(result.squadBroken, 0),
      squadTotal: toNonNegativeInt(result.squadTotal, 0)
    });
    store.matches.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
    saveLocalStore();
    return true;
  }

  async function processFileObjects(fileEntries) {
    const known = new Set(store.matches.map((m) => m.fileName).filter(Boolean));
    const ignored = new Set(store.ignoredFiles);
    const candidates = fileEntries.filter(
      (item) =>
        item.name.toLowerCase().endsWith(".replay") &&
        !known.has(item.name) &&
        !ignored.has(item.name) &&
        !failedThisSession.has(item.name)
    );

    if (candidates.length === 0) {
      if (activeDirHandle) {
        setWatcher(
          "connected",
          "Conectado a Demos · Todo al día. Esperando partidas nuevas al volver al lobby.",
          "Carpeta conectada automáticamente"
        );
      }
      return;
    }

    let addedCount = 0;
    let lockedOrActiveCount = 0;

    for (let idx = 0; idx < candidates.length; idx++) {
      const entry = candidates[idx];
      const remaining = candidates.length - idx;
      setWatcher(
        "analyzing",
        `Analizando ${entry.name} (${idx + 1}/${candidates.length})...`,
        "Leyendo repeticiones en tu navegador"
      );

      let file;
      let buffer;
      try {
        file = entry.getFile ? await entry.getFile() : entry.file;
        if (!file || file.size === 0) {
          lockedOrActiveCount++;
          continue;
        }
        buffer = await file.arrayBuffer();
      } catch (error) {
        lockedOrActiveCount++;
        continue;
      }

      try {
        const result = await analyzeBufferInWasm(entry.name, buffer);
        if (result.ok) {
          if (addParsedReplayMatch(result)) {
            addedCount++;
            render();
          }
        } else {
          // Si una partida está activa, el replay aún no tiene el cierre; se reintentará luego
          const ageMs = file.lastModified ? Date.now() - file.lastModified : 999999;
          if (ageMs < 5 * 60 * 1000) {
            lockedOrActiveCount++;
          } else {
            failedThisSession.add(entry.name);
          }
        }
      } catch (error) {
        console.error("Error analizando replay:", entry.name, error);
        failedThisSession.add(entry.name);
        const ageMs = file.lastModified ? Date.now() - file.lastModified : 999999;
        if (ageMs >= 5 * 60 * 1000 && !store.ignoredFiles.includes(entry.name)) {
          store.ignoredFiles.push(entry.name);
          saveLocalStore();
        }
      }
    }

    render();
    if (addedCount > 0) {
      showStatus(`Se sumaron +${addedCount} partida(s) nueva(s) automáticamente.`);
    }

    if (activeDirHandle) {
      if (lockedOrActiveCount > 0) {
        setWatcher(
          "in_match",
          "Partida en curso detectada. Se sumará sola en cuanto vuelvas al lobby.",
          "Carpeta conectada automáticamente"
        );
      } else {
        setWatcher(
          "connected",
          "Conectado a Demos · Todo al día. Deja esta pestaña abierta mientras juegas.",
          "Carpeta conectada automáticamente"
        );
      }
    }
  }

  async function scanConnectedDirectory() {
    if (!activeDirHandle || isScanningFolder) {
      return;
    }
    isScanningFolder = true;
    try {
      const perm = await activeDirHandle.queryPermission({ mode: "read" });
      if (perm !== "granted") {
        activeDirHandle = null;
        setWatcher(
          "warning",
          "Se perdió el permiso de lectura. Pulsa «Reconectar carpeta guardada».",
          "Permiso requerido"
        );
        return;
      }

      const entries = [];
      for await (const handle of activeDirHandle.values()) {
        if (handle.kind === "file" && handle.name.toLowerCase().endsWith(".replay")) {
          entries.push({
            name: handle.name,
            getFile: () => handle.getFile()
          });
        }
      }

      // Leer primero las partidas más recientes
      entries.sort((a, b) => b.name.localeCompare(a.name));
      await processFileObjects(entries);
    } catch (error) {
      console.error("Error leyendo carpeta Demos:", error);
      setWatcher("error", "No se pudo leer la carpeta seleccionada. Intenta conectarla de nuevo.");
    } finally {
      isScanningFolder = false;
    }
  }

  async function connectDirectoryWithPicker() {
    if (!SUPPORTS_DIR_PICKER) {
      showStatus("Tu navegador no soporta conectar carpeta directa; usa «Elegir archivos».", "error");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      activeDirHandle = handle;
      savedDirHandle = handle;
      await saveDirectoryHandle(handle);
      failedThisSession.clear();
      setWatcher(
        "analyzing",
        "Cargando el lector automático (solo tarda unos segundos la primera vez)...",
        "Carpeta conectada automáticamente"
      );
      await scanConnectedDirectory();
    } catch (error) {
      if (error && error.name === "AbortError") {
        return;
      }
      console.error("Error seleccionando carpeta:", error);
      showStatus("No se pudo abrir el selector de carpeta.", "error");
    }
  }

  async function reconnectSavedDirectory() {
    if (!savedDirHandle) {
      return;
    }
    try {
      const perm = await savedDirHandle.requestPermission({ mode: "read" });
      if (perm === "granted") {
        activeDirHandle = savedDirHandle;
        failedThisSession.clear();
        await scanConnectedDirectory();
      }
    } catch (error) {
      console.error("Error reconectando carpeta:", error);
      await connectDirectoryWithPicker();
    }
  }

  async function copyDemosPath() {
    try {
      await navigator.clipboard.writeText(DEMOS_PATH_TEXT);
      showStatus("Ruta copiada. Pégala con Ctrl + V al elegir la carpeta.");
    } catch (error) {
      showStatus(`Copia esta ruta: ${DEMOS_PATH_TEXT}`, "error");
    }
  }

  async function apiJson(url, options = {}) {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Error HTTP ${response.status}`);
    }
    return data;
  }

  async function syncFromServer() {
    if (!USE_LOCAL_SERVER) {
      return;
    }
    try {
      const data = await apiJson("/api/state");
      store = sanitizeStore(data.store);
      watcher = {
        ...data.watcher,
        title: "Servidor local conectado (Demos)"
      };
      render();
    } catch (error) {
      setWatcher("error", "Sin conexión con server.py. Ejecuta start_counter.bat.", "Servidor desconectado");
    }
  }

  async function updateSettings(patch) {
    Object.assign(store, patch);
    render();

    if (!USE_LOCAL_SERVER) {
      saveLocalStore();
      return;
    }

    try {
      const data = await apiJson("/api/settings", {
        method: "POST",
        body: JSON.stringify(patch)
      });
      store = sanitizeStore(data.store);
      render();
    } catch (error) {
      showStatus(error.message, "error");
    }
  }

  async function saveManualMatch() {
    const amount = store.currentManualMatch;
    if (amount <= 0) {
      showStatus("Suma al menos 1 cofre antes de guardar la partida.", "error");
      return;
    }

    if (!USE_LOCAL_SERVER) {
      store.matches.push({
        id: `m-${Date.now()}`,
        source: "manual",
        fileName: null,
        savedAt: new Date().toISOString(),
        lengthMs: 0,
        myOpened: amount,
        myBroken: 0,
        myTotal: amount,
        squadOpened: amount,
        squadBroken: 0,
        squadTotal: amount
      });
      store.currentManualMatch = 0;
      saveLocalStore();
      render();
      showStatus(`Partida manual guardada (+${amount} cofres).`);
      return;
    }

    try {
      const data = await apiJson("/api/matches/manual", {
        method: "POST",
        body: JSON.stringify({ chests: amount })
      });
      store = sanitizeStore(data.store);
      render();
      showStatus(`Partida manual guardada (+${amount} cofres).`);
    } catch (error) {
      showStatus(error.message, "error");
    }
  }

  async function deleteMatch(matchId) {
    if (!USE_LOCAL_SERVER) {
      const removed = store.matches.find((m) => m.id === matchId);
      store.matches = store.matches.filter((m) => m.id !== matchId);
      if (removed?.fileName && !store.ignoredFiles.includes(removed.fileName)) {
        store.ignoredFiles.push(removed.fileName);
      }
      saveLocalStore();
      render();
      showStatus("Partida eliminada del historial.");
      return;
    }

    try {
      const data = await apiJson(`/api/matches/${encodeURIComponent(matchId)}`, {
        method: "DELETE"
      });
      store = sanitizeStore(data.store);
      render();
      showStatus("Partida eliminada del historial.");
    } catch (error) {
      showStatus(error.message, "error");
    }
  }

  async function triggerServerScan(includeIgnored) {
    if (!USE_LOCAL_SERVER) {
      return;
    }
    try {
      const data = await apiJson("/api/scan", {
        method: "POST",
        body: JSON.stringify({ includeIgnored })
      });
      showStatus(
        data.enqueued > 0
          ? `Analizando ${data.enqueued} repetición(es) en segundo plano...`
          : "No hay repeticiones nuevas pendientes."
      );
      await syncFromServer();
    } catch (error) {
      showStatus(error.message, "error");
    }
  }

  async function clearAllData() {
    if (!window.confirm("¿Seguro que quieres borrar todas las partidas guardadas y reiniciar a 0?")) {
      return;
    }
    if (!USE_LOCAL_SERVER) {
      const ignored = Array.from(new Set([
        ...store.ignoredFiles,
        ...store.matches.map((m) => m.fileName).filter(Boolean)
      ]));
      store = { ...structuredClone(DEFAULT_STORE), ignoredFiles: ignored };
      saveLocalStore();
      render();
      showStatus("Historial reiniciado.");
      return;
    }
    try {
      const data = await apiJson("/api/reset", { method: "POST" });
      store = sanitizeStore(data.store);
      render();
      showStatus("Todo el historial ha sido reiniciado.");
    } catch (error) {
      showStatus(error.message, "error");
    }
  }

  function openNumberModal(mode) {
    modalMode = mode;
    if (mode === "base") {
      els.modalTitle.textContent = "Ajustar conteo base previo";
      els.modalDesc.textContent = "Si ya llevabas cofres contados antes (por ejemplo de las misiones del juego), ingrésalos aquí:";
      els.modalInput.value = String(store.baseCount);
    } else {
      els.modalTitle.textContent = "Editar partida manual";
      els.modalDesc.textContent = "Escribe la cantidad exacta de cofres de tu partida manual actual:";
      els.modalInput.value = String(store.currentManualMatch);
    }
    els.modal.showModal();
    els.modalInput.focus();
    els.modalInput.select();
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cofres-fortnite-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showStatus("Respaldo descargado en formato JSON.");
  }

  function importBackup(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = sanitizeStore(JSON.parse(String(reader.result)));
        if (!USE_LOCAL_SERVER) {
          store = parsed;
          saveLocalStore();
          render();
        } else {
          const data = await apiJson("/api/import", {
            method: "POST",
            body: JSON.stringify(parsed)
          });
          store = sanitizeStore(data.store);
          render();
        }
        showStatus("Respaldo importado correctamente.");
      } catch (error) {
        showStatus("El archivo seleccionado no es un respaldo válido.", "error");
      } finally {
        els.inputImport.value = "";
      }
    };
    reader.onerror = () => {
      showStatus("No se pudo leer el archivo seleccionado.", "error");
      els.inputImport.value = "";
    };
    reader.readAsText(file);
  }

  els.btnConnectFolder.addEventListener("click", connectDirectoryWithPicker);
  els.btnReconnectFolder.addEventListener("click", reconnectSavedDirectory);
  els.btnCopyPath.addEventListener("click", copyDemosPath);

  els.inputReplayFiles.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    await processFileObjects(files.map((file) => ({ name: file.name, file })));
    els.inputReplayFiles.value = "";
  });

  els.dropZone.addEventListener("dragover", (event) => {
    if (USE_LOCAL_SERVER) return;
    event.preventDefault();
    els.dropZone.classList.add("drag-over");
  });

  els.dropZone.addEventListener("dragleave", () => {
    els.dropZone.classList.remove("drag-over");
  });

  els.dropZone.addEventListener("drop", async (event) => {
    if (USE_LOCAL_SERVER) return;
    event.preventDefault();
    els.dropZone.classList.remove("drag-over");
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length > 0) {
      await processFileObjects(files.map((file) => ({ name: file.name, file })));
    }
  });

  els.btnScan.addEventListener("click", () => triggerServerScan(false));
  els.btnRescan.addEventListener("click", () => triggerServerScan(true));
  els.dateFilter.addEventListener("change", () => {
    selectedDate = els.dateFilter.value || "";
    render();
  });
  els.btnFilterToday.addEventListener("click", () => {
    selectedDate = getTodayDateKey();
    render();
  });
  els.btnFilterAll.addEventListener("click", () => {
    selectedDate = "";
    render();
  });
  els.btnModeMine.addEventListener("click", () => updateSettings({ countMode: "mine" }));
  els.btnModeSquad.addEventListener("click", () => updateSettings({ countMode: "squad" }));
  els.btnAddOne.addEventListener("click", () => {
    updateSettings({ currentManualMatch: store.currentManualMatch + 1 });
  });

  document.querySelectorAll("[data-delta]").forEach((button) => {
    button.addEventListener("click", () => {
      const delta = Number.parseInt(button.dataset.delta, 10);
      if (Number.isFinite(delta)) {
        updateSettings({ currentManualMatch: Math.max(0, store.currentManualMatch + delta) });
      }
    });
  });

  els.btnSaveMatch.addEventListener("click", saveManualMatch);
  els.btnResetCurrent.addEventListener("click", () => updateSettings({ currentManualMatch: 0 }));
  els.btnEditCurrent.addEventListener("click", () => openNumberModal("current"));
  els.btnSetBase.addEventListener("click", () => openNumberModal("base"));
  els.btnExport.addEventListener("click", exportBackup);
  els.inputImport.addEventListener("change", importBackup);
  els.btnClearAll.addEventListener("click", clearAllData);

  els.modalCancel.addEventListener("click", () => els.modal.close());
  els.modalForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = toNonNegativeInt(els.modalInput.value, -1);
    if (value < 0) {
      showStatus("Ingresa un número entero mayor o igual a 0.", "error");
      return;
    }

    if (modalMode === "base") {
      updateSettings({ baseCount: value });
      showStatus(`Conteo base actualizado a ${value.toLocaleString("es-ES")}.`);
    } else if (modalMode === "current") {
      updateSettings({ currentManualMatch: value });
      showStatus(`Partida manual ajustada a ${value.toLocaleString("es-ES")}.`);
    }
    els.modal.close();
  });

  if (USE_LOCAL_SERVER) {
    syncFromServer();
    setInterval(syncFromServer, SERVER_POLL_MS);
  } else {
    loadLocalStore();
    if (SUPPORTS_DIR_PICKER) {
      loadSavedDirectoryHandle().then((handle) => {
        if (handle) {
          savedDirHandle = handle;
          setWatcher(
            "warning",
            "Ya habías conectado tu carpeta Demos. Pulsa «Reconectar carpeta guardada» para seguir contando.",
            "Listo para reconectar"
          );
          renderWatcher();
        }
      });
      setInterval(() => {
        if (activeDirHandle) {
          scanConnectedDirectory();
        }
      }, FOLDER_POLL_MS);
    } else {
      setWatcher(
        "warning",
        "Tu navegador no permite vigilar carpetas; usa «Elegir archivos» o arrastra tus .replay aquí.",
        "Sube o arrastra tus .replay"
      );
    }
  }
})();
