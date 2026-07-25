/**
 * Grok real-UI registration content script for Jarvis Browser.
 *
 * - Smart page-mode detection (sign-in / sign-up / verify / credentials / done)
 * - Turnstile may appear on different steps; wait wherever it is
 * - Controllable: Start / Stop / Reset
 */
/* global jarvis */

(() => {
  // Allow re-binding controls on remount, but keep a single controller.
  const ROOT_KEY = "__GROK_EMAIL_REGISTER__";
  if (window[ROOT_KEY] && window[ROOT_KEY].alive) {
    window[ROOT_KEY].ensureOverlay();
    return;
  }

  const STORAGE_KEY = "grok-email-register:state";
  const CHANNEL_PREFIX = "grok-register:";

  /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map();

  const controller = {
    alive: true,
    running: false,
    stopRequested: false,
    runToken: 0,
    ensureOverlay,
  };
  window[ROOT_KEY] = controller;

  const state = loadState() || blankState();

  window.addEventListener("message", onWorkerMessage);
  ensureOverlay();
  sanitizeRestoredState();
  refreshPanel();

  // Soft autostart only on clear signup URLs, never on sign-in.
  if (shouldAutostart()) {
    setTimeout(() => {
      if (!controller.running && !state.ok && state.phase !== "done" && !controller.stopRequested) {
        if (!String(state.password || "").trim()) {
          setStatus("待填写密码", "注册密码为必填，填好后点「开始注册」");
          return;
        }
        if (!String(state.storagePath || "").trim()) {
          setStatus("待选择存储目录", "请先点「选择」指定保存位置");
          return;
        }
        void startRegister("auto");
      }
    }, 1500);
  }

  function blankState() {
    return {
      phase: "idle",
      email: "",
      password: "",
      storagePath: "",
      targets: {
        cpa: false,
        grok2api: false,
        sso: false,
      },
      given: "",
      family: "",
      code: "",
      error: "",
      startedAt: 0,
      finishedAt: 0,
      ok: false,
      stopped: false,
      lastResult: null,
      phaseLabel: "",
      lastSavedPath: "",
    };
  }

  /**
   * sessionStorage 可能残留上次成功态；在未登录/非注册流程页不要展示假“注册成功”。
   * 密码仍保留，方便连续注册。
   */
  function sanitizeRestoredState() {
    if (controller.running) return;
    const guest = looksLoggedOut();
    const href = String(location.href || "");
    const onAuthFlow = /accounts\.x\.ai/i.test(href)
      && (/\/sign-up\b|\/sign-in\b|verify|credential/i.test(href) || ["verify", "credentials", "sign-up", "sign-up-email", "sign-in"].includes(detectPageModeLoose()));

    // Active success only valid if we are not clearly a guest homepage.
    if (state.ok && guest) {
      archiveLastResult();
      demoteSuccessKeepPassword("页面未登录，已隐藏上次成功态");
      return;
    }

    // On grok.com guest/home without a live run, never keep phase=done/ok from storage.
    if (state.ok && !onAuthFlow && !looksActuallyLoggedIn()) {
      archiveLastResult();
      demoteSuccessKeepPassword("非注册完成页，已清除假成功信息");
    }
  }

  function archiveLastResult() {
    if (!state.ok && !state.email) return;
    state.lastResult = {
      ok: Boolean(state.ok),
      email: state.email,
      password: state.password,
      given: state.given,
      family: state.family,
      targets: normalizeTargets(state.targets),
      finishedAt: state.finishedAt || Date.now(),
    };
  }

  function demoteSuccessKeepPassword(reason) {
    const password = String(state.password || "");
    const storagePath = String(state.storagePath || "");
    const targets = normalizeTargets(state.targets);
    const lastResult = state.lastResult;
    Object.assign(state, blankState(), {
      password,
      storagePath,
      targets,
      lastResult,
      phase: "idle",
      ok: false,
      phaseLabel: "就绪",
      error: "",
    });
    saveState();
    setStatus("就绪", reason);
  }

  function detectPageModeLoose() {
    try {
      return detectPageMode();
    } catch (_e) {
      return "unknown";
    }
  }

  function shouldAutostart() {
    const href = String(location.href || "");
    if (!/accounts\.x\.ai/i.test(href)) return false;
    // Never autostart on sign-in pages.
    if (/\/sign-in\b/i.test(href)) return false;
    return /\/sign-up\b/i.test(href);
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const loaded = Object.assign(blankState(), JSON.parse(raw));
      loaded.targets = normalizeTargets(loaded.targets);
      return loaded;
    } catch (_e) {
      return null;
    }
  }

  function normalizeTargets(value) {
    const src = value && typeof value === "object" ? value : {};
    return {
      cpa: Boolean(src.cpa),
      grok2api: Boolean(src.grok2api),
      sso: Boolean(src.sso),
    };
  }

  function selectedTargetLabels(targets) {
    const t = normalizeTargets(targets);
    const labels = [];
    if (t.cpa) labels.push("CPA");
    if (t.grok2api) labels.push("Grok2Api");
    if (t.sso) labels.push("SSO");
    return labels;
  }

  function saveState() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_e) {}
  }

  function summarizeState() {
    const bits = [];
    if (state.email) bits.push(state.email);
    if (state.code) bits.push(`code=${state.code}`);
    if (String(state.password || "").trim()) bits.push("pwd=已填");
    else bits.push("pwd=未填");
    const storagePath = String(state.storagePath || "").trim();
    bits.push(storagePath ? `dir=${storagePath}` : "dir=未选");
    const targetLabels = selectedTargetLabels(state.targets);
    bits.push(targetLabels.length ? `to=${targetLabels.join(",")}` : "to=未选");
    const mode = detectPageMode();
    bits.push(`page=${mode}`);
    if (state.lastSavedPath) bits.push(`saved=${state.lastSavedPath}`);
    return bits.join(" · ");
  }


  function ensureOverlay() {
    let panel = document.getElementById("grok-email-register-panel");
    if (!panel) {
      const style = document.createElement("style");
      style.id = "grok-email-register-style";
      style.textContent = `
        #grok-email-register-panel {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483646;
          width: 340px;
          max-width: calc(100vw - 24px);
          font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: #e8eefc;
          background: rgba(12, 18, 32, 0.94);
          border: 1px solid rgba(120, 160, 255, 0.35);
          border-radius: 10px;
          box-shadow: 0 12px 40px rgba(0,0,0,.45);
          backdrop-filter: blur(8px);
          padding: 12px 12px 10px;
        }
        #grok-email-register-panel h3 {
          margin: 0 0 6px;
          font-size: 13px;
          font-weight: 650;
        }
        #grok-email-register-status {
          color: #9ec1ff;
          margin-bottom: 4px;
          word-break: break-word;
        }
        #grok-email-register-detail, #grok-email-register-result {
          color: #b7c3d9;
          word-break: break-all;
          white-space: pre-wrap;
          max-height: 96px;
          overflow: auto;
          margin-bottom: 8px;
        }
        #grok-email-register-result { color: #8dffb0; }
        #grok-email-register-actions {
          display: flex;
          gap: 8px;
        }
        #grok-email-register-panel button {
          flex: 1;
          border: 0;
          border-radius: 7px;
          padding: 7px 8px;
          cursor: pointer;
          font-weight: 600;
          font-size: 12px;
        }
        #grok-email-register-start { background: #3b82f6; color: white; }
        #grok-email-register-stop { background: #b45309; color: white; }
        #grok-email-register-reset { background: #243044; color: #d7e2f5; }
        #grok-email-register-panel button:disabled {
          opacity: .55;
          cursor: default;
        }
        #grok-email-register-password-label {
          display: block;
          margin: 0 0 8px;
          color: #c9d7ef;
          font-size: 12px;
          font-weight: 600;
        }
        #grok-email-register-password {
          display: block;
          width: 100%;
          box-sizing: border-box;
          margin-top: 4px;
          border: 1px solid rgba(120, 160, 255, 0.35);
          border-radius: 7px;
          padding: 7px 8px;
          background: rgba(8, 12, 22, 0.9);
          color: #e8eefc;
          font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
          outline: none;
        }
        #grok-email-register-password:focus {
          border-color: rgba(96, 165, 250, 0.9);
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
        }
        #grok-email-register-password:disabled {
          opacity: .65;
        }
        #grok-email-register-storage-label {
          display: block;
          margin: 0 0 8px;
          color: #c9d7ef;
          font-size: 12px;
          font-weight: 600;
        }
        #grok-email-register-storage-row {
          display: flex;
          gap: 6px;
          margin-top: 4px;
        }
        #grok-email-register-storage-path {
          flex: 1;
          min-width: 0;
          border: 1px solid rgba(120, 160, 255, 0.35);
          border-radius: 7px;
          padding: 7px 8px;
          background: rgba(8, 12, 22, 0.9);
          color: #e8eefc;
          font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
          outline: none;
        }
        #grok-email-register-storage-choose {
          flex: 0 0 auto;
          width: auto;
          min-width: 64px;
          background: #334155;
          color: #e8eefc;
        }
        #grok-email-register-storage-path:focus {
          border-color: rgba(96, 165, 250, 0.9);
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
        }
        #grok-email-register-storage-path:disabled,
        #grok-email-register-storage-choose:disabled {
          opacity: .65;
        }
        #grok-email-register-storage-hint {
          margin: 2px 0 6px;
          color: #8fa3c4;
          font-size: 11px;
          font-weight: 400;
          line-height: 1.35;
          word-break: break-all;
        }
        #grok-email-register-targets {
          display: flex;
          gap: 10px;
          align-items: center;
          margin: 0 0 8px;
          color: #c9d7ef;
          font-size: 12px;
          font-weight: 600;
        }
        #grok-email-register-targets label {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          cursor: pointer;
          user-select: none;
          font-weight: 600;
        }
        #grok-email-register-targets input[type="checkbox"] {
          width: 14px;
          height: 14px;
          margin: 0;
          accent-color: #3b82f6;
          cursor: pointer;
        }
        #grok-email-register-targets input[type="checkbox"]:disabled {
          cursor: default;
          opacity: .65;
        }
      `;
      document.documentElement.appendChild(style);

      panel = document.createElement("div");
      panel.id = "grok-email-register-panel";
      panel.innerHTML = `
        <h3>Grok 邮箱注册</h3>
        <label id="grok-email-register-password-label" for="grok-email-register-password">
          注册密码（必填）
          <input id="grok-email-register-password" type="text" autocomplete="new-password" spellcheck="false" placeholder="自己设置密码，必填" />
        </label>
        <label id="grok-email-register-storage-label" for="grok-email-register-storage-path">
          存储目录（必选）
          <div id="grok-email-register-storage-row">
            <input id="grok-email-register-storage-path" type="text" spellcheck="false" placeholder="点击选择… 任意本地目录" readonly />
            <button id="grok-email-register-storage-choose" type="button">选择</button>
          </div>
        </label>
        <div id="grok-email-register-storage-hint">通过 Electron 目录选择器选取；注册结果由主进程写入该目录</div>
        <div id="grok-email-register-targets">
          <label><input id="grok-email-register-target-cpa" type="checkbox" />CPA</label>
          <label><input id="grok-email-register-target-grok2api" type="checkbox" />Grok2Api</label>
          <label><input id="grok-email-register-target-sso" type="checkbox" />SSO</label>
        </div>
        <div id="grok-email-register-status">就绪</div>
        <div id="grok-email-register-detail"></div>
        <div id="grok-email-register-result"></div>
        <div id="grok-email-register-actions">
          <button id="grok-email-register-start" type="button">开始注册</button>
          <button id="grok-email-register-stop" type="button">停止</button>
          <button id="grok-email-register-reset" type="button">重置</button>
        </div>
      `;
      document.documentElement.appendChild(panel);
    }

    const startBtn = document.getElementById("grok-email-register-start");
    const stopBtn = document.getElementById("grok-email-register-stop");
    const resetBtn = document.getElementById("grok-email-register-reset");
    const passwordInput = document.getElementById("grok-email-register-password");
    const storagePathInput = document.getElementById("grok-email-register-storage-path");
    const storageChooseBtn = document.getElementById("grok-email-register-storage-choose");
    if (startBtn && !startBtn.dataset.bound) {
      startBtn.dataset.bound = "1";
      startBtn.addEventListener("click", () => { void startRegister("manual"); });
    }
    if (stopBtn && !stopBtn.dataset.bound) {
      stopBtn.dataset.bound = "1";
      stopBtn.addEventListener("click", () => { stopRegister("user"); });
    }
    if (resetBtn && !resetBtn.dataset.bound) {
      resetBtn.dataset.bound = "1";
      resetBtn.addEventListener("click", () => { resetState(); });
    }
    if (passwordInput && !passwordInput.dataset.bound) {
      passwordInput.dataset.bound = "1";
      passwordInput.addEventListener("input", () => {
        state.password = String(passwordInput.value || "");
        saveState();
        refreshPanel();
      });
    }
    if (storageChooseBtn && !storageChooseBtn.dataset.bound) {
      storageChooseBtn.dataset.bound = "1";
      storageChooseBtn.addEventListener("click", () => { void chooseStorageDirectory(); });
    }
    bindTargetCheckbox("grok-email-register-target-cpa", "cpa");
    bindTargetCheckbox("grok-email-register-target-grok2api", "grok2api");
    bindTargetCheckbox("grok-email-register-target-sso", "sso");
    if (passwordInput && passwordInput.value !== String(state.password || "")) {
      passwordInput.value = String(state.password || "");
    }
    if (storagePathInput) {
      const pathValue = String(state.storagePath || "");
      if (storagePathInput.value !== pathValue) storagePathInput.value = pathValue;
    }
    refreshPanel();
  }

  function syncTargetCheckbox(elementId, key) {
    const input = document.getElementById(elementId);
    if (!input) return;
    const checked = Boolean(state.targets && state.targets[key]);
    if (input.checked !== checked) input.checked = checked;
    input.disabled = controller.running;
  }

  function bindTargetCheckbox(elementId, key) {
    const input = document.getElementById(elementId);
    if (!input || input.dataset.bound) return;
    input.dataset.bound = "1";
    input.addEventListener("change", () => {
      state.targets = normalizeTargets(state.targets);
      state.targets[key] = Boolean(input.checked);
      saveState();
      refreshPanel();
    });
  }

  async function chooseStorageDirectory() {
    if (controller.running) return;
    try {
      setStatus("选择存储目录", "打开系统目录选择器…");
      const result = await requestWorker("grok-register:choose-storage", {
        defaultPath: String(state.storagePath || ""),
      }, 300000);
      if (result && result.canceled) {
        setStatus("已取消选择", String(state.storagePath || "仍未选择目录"));
        refreshPanel();
        return;
      }
      const chosen = String((result && result.path) || "").trim();
      if (!chosen) throw new Error("未返回目录路径");
      state.storagePath = chosen;
      saveState();
      setStatus("存储目录已选择", chosen);
      refreshPanel();
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setStatus("选择目录失败", message);
      refreshPanel();
    }
  }


  function refreshPanel() {
    const statusEl = document.getElementById("grok-email-register-status");
    const detailEl = document.getElementById("grok-email-register-detail");
    const resultEl = document.getElementById("grok-email-register-result");
    const startBtn = document.getElementById("grok-email-register-start");
    const stopBtn = document.getElementById("grok-email-register-stop");

    const guest = looksLoggedOut();
    if (statusEl) {
      if (controller.running) statusEl.textContent = state.phaseLabel || state.phase || "运行中";
      else if (state.stopped) statusEl.textContent = "已停止";
      else if (state.ok && !guest) statusEl.textContent = "注册成功";
      else if (state.error) statusEl.textContent = "失败 / 空闲";
      else statusEl.textContent = "就绪";
    }
    if (detailEl) {
      const lines = [summarizeState()];
      if (state.error) lines.push(`err: ${state.error}`);
      if (state.lastResult && state.lastResult.email && !(state.ok && !guest)) {
        lines.push(`上次: ${state.lastResult.email}`);
      }
      detailEl.textContent = lines.join("\n");
    }
    if (resultEl) {
      if (state.ok && !guest) {
        resultEl.textContent = JSON.stringify({
          ok: true,
          email: state.email,
          password: state.password,
          given: state.given,
          family: state.family,
          targets: normalizeTargets(state.targets),
        }, null, 2);
      } else if (!controller.running) {
        // Never keep stale green success blob on guest / non-success pages.
        resultEl.textContent = "";
      }
    }
    const passwordInput = document.getElementById("grok-email-register-password");
    if (passwordInput) {
      if (document.activeElement !== passwordInput) {
        const next = String(state.password || "");
        if (passwordInput.value !== next) passwordInput.value = next;
      }
      passwordInput.disabled = controller.running;
    }
    const storagePathInput = document.getElementById("grok-email-register-storage-path");
    const storageChooseBtn = document.getElementById("grok-email-register-storage-choose");
    const storageHint = document.getElementById("grok-email-register-storage-hint");
    const storagePath = String(state.storagePath || "").trim();
    if (storagePathInput) {
      if (storagePathInput.value !== storagePath) storagePathInput.value = storagePath;
      storagePathInput.disabled = controller.running;
    }
    if (storageChooseBtn) storageChooseBtn.disabled = controller.running;
    if (storageHint) {
      storageHint.textContent = storagePath
        ? `将写入：${storagePath}/accounts.jsonl 与 last-result.json`
        : "请先点击「选择」用系统目录选择器指定保存位置（必选）";
    }
    state.targets = normalizeTargets(state.targets);
    syncTargetCheckbox("grok-email-register-target-cpa", "cpa");
    syncTargetCheckbox("grok-email-register-target-grok2api", "grok2api");
    syncTargetCheckbox("grok-email-register-target-sso", "sso");
    const passwordOk = Boolean(String(state.password || "").trim());
    const storageOk = Boolean(storagePath);
    if (startBtn) startBtn.disabled = controller.running || !passwordOk || !storageOk;
    if (stopBtn) stopBtn.disabled = !controller.running;
  }


  function setStatus(status, detail) {
    state.phaseLabel = status;
    if (detail) state.lastDetail = detail;
    const statusEl = document.getElementById("grok-email-register-status");
    const detailEl = document.getElementById("grok-email-register-detail");
    if (statusEl) statusEl.textContent = status;
    if (detailEl) detailEl.textContent = [detail || "", summarizeState()].filter(Boolean).join("\n");
    pageLog(`${status}${detail ? ` | ${detail}` : ""}`);
    refreshPanel();
  }

  function setResult(text) {
    const resultEl = document.getElementById("grok-email-register-result");
    if (resultEl) resultEl.textContent = text || "";
  }

  function stopRegister(reason) {
    controller.stopRequested = true;
    controller.running = false;
    state.stopped = true;
    state.phase = "stopped";
    state.phaseLabel = "已停止";
    state.error = reason === "user" ? "用户停止" : String(reason || "stopped");
    state.finishedAt = Date.now();
    saveState();

    // Reject all pending worker waits so loops unwind.
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("stopped"));
      pending.delete(id);
    }

    setStatus("已停止", state.error);
    refreshPanel();
    pageLog(`stopped reason=${state.error}`);
  }

  function resetState() {
    stopRegister("reset");
    const password = String(state.password || "");
    const storagePath = String(state.storagePath || "");
    const targets = normalizeTargets(state.targets);
    Object.assign(state, blankState(), {
      password,
      storagePath,
      targets,
    });
    saveState();
    setResult("");
    controller.stopRequested = false;
    setStatus("已重置", storagePath ? `可重新开始 · ${storagePath}` : "可重新开始（请选择存储目录）");
    refreshPanel();
  }


  function assertRunning(token) {
    if (controller.stopRequested || !controller.running || token !== controller.runToken) {
      throw new Error("stopped");
    }
  }

  function pageLog(message) {
    try {
      jarvis.send("grok-register:log", { message: String(message || "") });
    } catch (_e) {}
  }

  function onWorkerMessage(event) {
    const data = event && event.data;
    if (!data || data.source !== "jarvis-script") return;
    const channel = String(data.channel || "");
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    const payload = data.payload || {};
    const requestId = String(payload.requestId || "");
    if (!requestId || !pending.has(requestId)) {
      if (channel === "grok-register:error" && payload.error) {
        setStatus("Worker 错误", String(payload.error));
      }
      return;
    }
    const entry = pending.get(requestId);
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (payload.ok === false || channel === "grok-register:error") {
      entry.reject(new Error(String(payload.error || "worker error")));
      return;
    }
    entry.resolve(payload);
  }

  function requestWorker(channel, data, timeoutMs) {
    const requestId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const waitMs = timeoutMs || 60000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`worker timeout ${channel} after ${waitMs}ms`));
      }, waitMs);
      pending.set(requestId, { resolve, reject, timer });
      try {
        jarvis.send(channel, Object.assign({ requestId }, data || {}));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  }

  async function startRegister(reason) {
    if (controller.running) return;
    controller.running = true;
    controller.stopRequested = false;
    controller.runToken += 1;
    const token = controller.runToken;

    state.startedAt = Date.now();
    state.error = "";
    state.ok = false;
    state.stopped = false;
    state.finishedAt = 0;
    state.phase = "start";
    saveState();
    setResult("");
    setStatus("开始注册", `trigger=${reason}`);
    refreshPanel();

    try {
      await requestWorker("grok-register:ping", {}, 15000);
      assertRunning(token);

      // Password + absolute storage directory are mandatory.
      syncPasswordFromPanel();
      const password = String(state.password || "").trim();
      if (!password) {
        throw new Error("请先在右下角面板填写注册密码（必填）");
      }
      const storagePath = String(state.storagePath || "").trim();
      if (!storagePath) {
        throw new Error("请先点击「选择」指定存储目录（系统目录选择器）");
      }
      state.password = password;
      state.storagePath = storagePath;
      saveState();


      if (!state.email) {
        setPhase("create_mailbox", "创建临时邮箱...");
        const box = await requestWorker("grok-register:create-mailbox", {}, 45000);
        assertRunning(token);
        state.email = String(box.email || "").trim();
        if (!state.email) throw new Error("mailbox empty");
        state.given = state.given || pickGiven();
        state.family = state.family || pickFamily();
        saveState();
        setStatus("邮箱已创建", state.email);
      } else {
        if (!state.given) state.given = pickGiven();
        if (!state.family) state.family = pickFamily();
        saveState();
        setStatus("沿用邮箱", state.email);
      }

      // Core flow with page-mode awareness.
      await ensureSignupContext(token);
      await dismissBanners();
      assertRunning(token);

      let mode = detectPageMode();
      setStatus("页面识别", mode);

      if (mode === "done" || looksRegistered()) {
        // already good
      } else if (mode === "credentials") {
        await fillCredentials(state.given, state.family, state.password);
        await maybeWaitTurnstile(token, "credentials");
        await submitCompleteSignup();
        await waitForSuccess(token, 90000);
      } else if (mode === "verify") {
        await ensureCode(token);
        await fillAndConfirmCode(state.code);
        await waitForMode(token, ["credentials", "done"], 45000, "credentials after code");
        if (detectPageMode() === "credentials") {
          await fillCredentials(state.given, state.family, state.password);
          await maybeWaitTurnstile(token, "credentials");
          await submitCompleteSignup();
        }
        await waitForSuccess(token, 90000);
      } else {
        // sign-in / sign-up landing / email form
        await ensureSignupContext(token);
        await openEmailSignup(token);
        await fillAndSubmitSignupEmail(token, state.email);
        await waitForMode(token, ["verify", "credentials", "done"], 45000, "verify step");

        mode = detectPageMode();
        if (mode === "verify") {
          await ensureCode(token);
          await fillAndConfirmCode(state.code);
          await waitForMode(token, ["credentials", "done"], 45000, "credentials after code");
        }

        if (detectPageMode() === "credentials") {
          await fillCredentials(state.given, state.family, state.password);
          await maybeWaitTurnstile(token, "credentials");
          await submitCompleteSignup();
        }
        await waitForSuccess(token, 90000);
      }

      assertRunning(token);
      state.ok = true;
      state.phase = "done";
      state.phaseLabel = "注册成功";
      state.finishedAt = Date.now();
      state.lastResult = {
        ok: true,
        email: state.email,
        password: state.password,
        given: state.given,
        family: state.family,
        targets: normalizeTargets(state.targets),
        finishedAt: state.finishedAt,
      };
      saveState();
      const summary = {
        ok: true,
        email: state.email,
        password: state.password,
        given: state.given,
        family: state.family,
        code: state.code,
        storagePath: String(state.storagePath || ""),
        targets: normalizeTargets(state.targets),
        url: location.href,
      };
      setResult(JSON.stringify(summary, null, 2));
      setStatus("注册成功", state.email);
      try {
        const saved = await requestWorker("grok-register:result", summary, 15000);
        if (saved && saved.path) {
          state.lastSavedPath = String(saved.path);
          summary.savedPath = state.lastSavedPath;
          setResult(JSON.stringify(summary, null, 2));
          setStatus("注册成功", `${state.email} → ${state.lastSavedPath}`);
          saveState();
        }
      } catch (_e) {}
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (message === "stopped" || controller.stopRequested) {
        state.stopped = true;
        state.phase = "stopped";
        state.error = state.error || "用户停止";
        setStatus("已停止", state.error);
      } else {
        state.error = message;
        state.phase = "error";
        state.finishedAt = Date.now();
        saveState();
        setStatus("注册失败", message);
        setResult(JSON.stringify({
          ok: false,
          email: state.email,
          password: state.password,
          error: message,
          page: detectPageMode(),
          url: location.href,
        }, null, 2));
        try {
          const saved = await requestWorker("grok-register:result", {
            ok: false,
            email: state.email,
            password: state.password,
            storagePath: String(state.storagePath || ""),
            targets: normalizeTargets(state.targets),
            error: message,
            url: location.href,
          }, 15000);
          if (saved && saved.path) {
            state.lastSavedPath = String(saved.path);
            saveState();
          }
        } catch (_e) {}
      }
    } finally {
      controller.running = false;
      refreshPanel();
    }
  }

  function setPhase(phase, message) {
    state.phase = phase;
    state.phaseLabel = message || phase;
    saveState();
    setStatus(message || phase, summarizeState());
  }

  function syncPasswordFromPanel() {
    const passwordInput = document.getElementById("grok-email-register-password");
    if (passwordInput) {
      state.password = String(passwordInput.value || "");
    }
  }


  function makePassword() {
    // kept only for manual debug; registration never auto-uses this
    const hex = () => Math.random().toString(16).slice(2, 10);
    return `N${hex()}!a7#${hex().slice(0, 6)}`;
  }

  function pickGiven() {
    const names = ["Ada", "Grace", "Alan", "Linus", "Nina", "Owen", "Vera", "Hugo", "Maya", "Leo"];
    return names[Math.floor(Math.random() * names.length)];
  }

  function pickFamily() {
    const names = ["Lovelace", "Hopper", "Turing", "Torvalds", "Curie", "Dijkstra", "Knuth", "Babbage"];
    return names[Math.floor(Math.random() * names.length)];
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function sleepCancellable(token, ms) {
    const step = 200;
    let left = ms;
    while (left > 0) {
      assertRunning(token);
      const chunk = Math.min(step, left);
      await sleep(chunk);
      left -= chunk;
    }
  }

  async function waitFor(token, predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertRunning(token);
      try {
        if (await predicate()) return true;
      } catch (_e) {}
      await sleepCancellable(token, 250);
    }
    throw new Error(`timeout waiting for ${label || "condition"} (${timeoutMs}ms)`);
  }

  function pageText() {
    return String((document.body && document.body.innerText) || document.documentElement.innerText || "");
  }

  function visible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function queryFirst(selectors) {
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const el of nodes) {
        if (visible(el)) return el;
      }
    }
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function findClickableByText(patterns) {
    const nodes = Array.from(document.querySelectorAll("button, a, [role='button'], input[type='submit']"));
    for (const pattern of patterns) {
      const re = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;
      for (const node of nodes) {
        const text = String(node.innerText || node.textContent || node.value || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        if (re.test(text) && visible(node) && !node.disabled) return node;
      }
    }
    return null;
  }

  async function clickEl(el) {
    if (!el) return false;
    try { el.focus(); } catch (_e) {}
    try {
      el.click();
      return true;
    } catch (_e) {
      try {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch (_e2) {
        return false;
      }
    }
  }

  async function setInputValue(el, value) {
    if (!el) return false;
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    el.focus();
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  /**
   * Smart page mode detection.
   * CF Turnstile can appear on sign-in, credentials, or intermediate challenge pages.
   */
  function detectPageMode() {
    const href = String(location.href || "");
    const text = pageText();

    if (looksRegistered()) return "done";

    // Public grok.com with guest chrome is not an auth flow page.
    if (/grok\.com/i.test(href) && !/accounts\.x\.ai/i.test(href) && looksLoggedOut()) {
      return "grok-guest";
    }

    // Verify email step
    if (queryFirst(['input[name="code"]', 'input[autocomplete="one-time-code"]'])) return "verify";
    if (/Verify your email|We've emailed|Confirm email|security code|Please enter it below/i.test(text)
      && !/使用您的邮箱登录|Sign in with|Forgot password|忘记密码/i.test(text)) {
      return "verify";
    }

    // Credentials / complete signup
    if (queryFirst(['input[name="givenName"]', 'input[name="familyName"]'])) return "credentials";
    if (/Complete your sign up|First name|Last name|Create your password/i.test(text)
      && queryFirst(['input[type="password"]', 'input[name="password"]'])) {
      return "credentials";
    }

    // Explicit sign-in page (must not treat as signup)
    const hasPassword = Boolean(queryFirst(['input[type="password"]', 'input[name="password"]', 'input[autocomplete="current-password"]']));
    const hasEmail = Boolean(queryFirst(['input[type="email"]', 'input[name="email"]', 'input[autocomplete="email"]', 'input[autocomplete="username"]']));
    const signInUrl = /\/sign-in\b/i.test(href);
    const signUpUrl = /\/sign-up\b/i.test(href);
    const signInText = /使用您的邮箱登录|Sign in with your email|Log in|登录|Forgot password|忘记密码|没有账户|Don't have an account/i.test(text);
    const signUpText = /Sign up with email|使用邮箱注册|Create your account|注册|Already have an account/i.test(text);
    const loginButton = Boolean(findClickableByText([/^登录$/, /^Log in$/i, /^Sign in$/i]));
    const signupButton = Boolean(findClickableByText([/^Sign up$/i, /^注册$/, /Sign up with email/i]));

    if (signInUrl || (hasEmail && hasPassword && (signInText || loginButton) && !queryFirst(['input[name="givenName"]']))) {
      // password+email with login CTA => sign-in
      if (!signUpUrl) return "sign-in";
    }

    if (signUpUrl || signUpText || signupButton) {
      if (hasEmail && !hasPassword) return "sign-up-email";
      return "sign-up";
    }

    if (hasEmail && !hasPassword) return "sign-up-email";
    if (hasTurnstile() && !hasEmail && !hasPassword) return "challenge";
    return "unknown";
  }

  function hasTurnstile() {
    if (document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]')) return true;
    if (document.querySelector('iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]')) return true;
    if (document.querySelector(".cf-turnstile, [data-sitekey]")) return true;
    return false;
  }

  function looksLoggedOut() {
    // grok.com header guest: both 登录 and 注册 visible
    const login = findClickableByText([/^登录$/, /^Log in$/i, /^Sign in$/i]);
    const signup = findClickableByText([/^注册$/, /^Sign up$/i, /^Create account$/i]);
    if (login && signup) return true;

    // Single obvious guest CTAs without account menu
    const href = String(location.href || "");
    if (/grok\.com/i.test(href) && !/accounts\.x\.ai/i.test(href)) {
      if (login || signup) {
        // If only one of them exists, still likely guest chrome
        const accountish = document.querySelector(
          '[aria-label*="Account" i], [aria-label*="账户" i], [data-testid*="user" i], [data-testid*="account" i]',
        );
        if (!accountish) return true;
      }
    }
    return false;
  }

  function looksActuallyLoggedIn() {
    if (looksLoggedOut()) return false;
    const href = String(location.href || "");
    const cookie = document.cookie || "";
    if (/sso=|xai\.session|__Secure-next-auth|session-token/i.test(cookie)) return true;
    if (/accounts\.x\.ai/i.test(href) && /sso|cookie-setter|callback|set-session/i.test(href)) return true;
    // account chrome
    if (document.querySelector('[aria-label*="Account" i], [aria-label*="账户" i], [data-testid*="user" i], [data-testid*="account" i]')) {
      return true;
    }
    const text = pageText();
    // Avoid matching public marketing copy; require stronger phrases.
    if (/Welcome to Grok|You're signed in|Signed in as/i.test(text)) return true;
    return false;
  }

  function looksRegistered() {
    // IMPORTANT: merely opening grok.com is NOT success.
    if (looksLoggedOut()) return false;
    return looksActuallyLoggedIn();
  }

  async function ensureSignupContext(token) {
    assertRunning(token);
    const mode = detectPageMode();
    const href = String(location.href || "");

    if (mode === "done" || mode === "verify" || mode === "credentials") return;
    if (mode === "sign-up" || mode === "sign-up-email") return;

    // On sign-in: go to sign-up via link or hard navigation.
    if (mode === "sign-in" || /\/sign-in\b/i.test(href)) {
      setPhase("goto_signup", "当前是登录页，切换到注册...");
      const link =
        document.querySelector('a[href*="sign-up"]')
        || findClickableByText([/^注册$/, /没有账户.*注册/, /Sign up$/i, /Create account/i, /Don't have an account/i]);
      if (link) {
        await clickEl(link);
        await sleepCancellable(token, 1200);
      } else {
        location.href = "https://accounts.x.ai/sign-up?redirect=grok-com";
        await sleepCancellable(token, 2000);
      }
      await waitFor(
        token,
        () => {
          const m = detectPageMode();
          return m === "sign-up" || m === "sign-up-email" || m === "verify" || m === "credentials" || /\/sign-up\b/i.test(location.href);
        },
        20000,
        "navigate to sign-up",
      );
    }
  }

  async function dismissBanners() {
    const selectors = ["#onetrust-accept-btn-handler", "button#onetrust-accept-btn-handler"];
    for (const selector of selectors) {
      const btn = document.querySelector(selector);
      if (btn && visible(btn)) {
        await clickEl(btn);
        await sleep(300);
      }
    }
    const textBtn = findClickableByText([/^Accept all$/i, /^Accept$/i, /Accept Cookies/i, /同意/, /接受全部/]);
    if (textBtn) {
      await clickEl(textBtn);
      await sleep(250);
    }
  }

  async function openEmailSignup(token) {
    setPhase("open_email_form", "打开邮箱注册表单...");
    if (queryFirst(['input[type="email"]', 'input[name="email"]', 'input[autocomplete="email"]'])) {
      // Make sure we are not on sign-in password form.
      if (detectPageMode() === "sign-in") {
        await ensureSignupContext(token);
      } else {
        return;
      }
    }

    const opened = findClickableByText([
      /Sign up with email/i,
      /使用邮箱注册/,
      /Continue with email/i,
      /Sign up with Email/i,
    ]);
    if (opened) await clickEl(opened);
    else {
      const btn = findClickableByText([/sign up.*email|email.*sign up/i]);
      if (btn) await clickEl(btn);
    }

    await waitFor(
      token,
      () => {
        const mode = detectPageMode();
        return mode === "sign-up-email" || mode === "sign-up" || mode === "verify"
          || Boolean(queryFirst(['input[type="email"]', 'input[name="email"]']));
      },
      15000,
      "email signup form",
    );

    if (detectPageMode() === "sign-in") {
      throw new Error("仍在登录页：请确认已打开注册而不是登录");
    }
  }

  async function fillAndSubmitSignupEmail(token, email) {
    setPhase("fill_email", `填写注册邮箱 ${email}`);

    // Hard guard: never submit login form as signup.
    if (detectPageMode() === "sign-in") {
      await ensureSignupContext(token);
      await openEmailSignup(token);
    }
    if (detectPageMode() === "sign-in") {
      throw new Error("拒绝在登录页提交邮箱；请先进入注册流程");
    }

    const input = queryFirst([
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
    ]);
    if (!input) throw new Error("email input missing");
    await setInputValue(input, email);
    await sleepCancellable(token, 350);

    // Prefer signup submit, never "登录"
    const strategies = [
      async () => {
        const btn = findClickableByText([/^Sign up$/i]);
        return btn ? clickEl(btn) : false;
      },
      async () => {
        // Avoid buttons that say 登录 / Sign in / Log in
        const nodes = Array.from(document.querySelectorAll('button[type="submit"], button'));
        for (const node of nodes) {
          const text = String(node.innerText || node.textContent || "").trim();
          if (!text) continue;
          if (/^(登录|Log in|Sign in)$/i.test(text)) continue;
          if (/sign up|注册|continue|下一步|next/i.test(text) && visible(node) && !node.disabled) {
            return clickEl(node);
          }
        }
        return false;
      },
      async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, keyCode: 13 }));
        return true;
      },
    ];

    for (const strategy of strategies) {
      assertRunning(token);
      await strategy();
      const reached = await waitFor(
        token,
        () => ["verify", "credentials", "done"].includes(detectPageMode()),
        7000,
        "post-email-mode",
      ).catch(() => false);
      if (reached) return;
    }

    await waitFor(
      token,
      () => ["verify", "credentials", "done"].includes(detectPageMode()),
      25000,
      "verify/credentials after email submit",
    );
  }

  async function ensureCode(token) {
    if (state.code) {
      setStatus("使用已有验证码", state.code);
      return state.code;
    }
    setPhase("wait_code", "等待邮箱验证码...");
    const codePayload = await requestWorker(
      "grok-register:wait-code",
      { email: state.email, timeoutMs: 180000 },
      190000,
    );
    assertRunning(token);
    state.code = String(codePayload.code || "").trim();
    if (!state.code) throw new Error("empty verification code");
    saveState();
    setStatus("已拿到验证码", state.code);
    return state.code;
  }

  async function fillAndConfirmCode(code) {
    setPhase("fill_code", `填写验证码 ${code}`);
    const clean = String(code).replace(/[^A-Za-z0-9]/g, "");
    const input = queryFirst([
      'input[name="code"]',
      'input[autocomplete="one-time-code"]',
      'input[inputmode="text"]',
      'input[inputmode="numeric"]',
    ]);
    if (!input) throw new Error("code input missing");
    await setInputValue(input, clean);
    await sleep(300);

    if (detectPageMode() === "credentials" || detectPageMode() === "done") return;

    const btn = findClickableByText([/Confirm email/i, /确认/, /^Verify$/i, /Verify email/i]);
    if (btn) await clickEl(btn);
    else {
      const submit = queryFirst(['button[type="submit"]']);
      if (submit) await clickEl(submit);
      else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, keyCode: 13 }));
    }
  }

  async function waitForMode(token, modes, timeoutMs, label) {
    await waitFor(token, () => modes.includes(detectPageMode()), timeoutMs, label);
  }

  async function fillCredentials(given, family, password) {
    setPhase("fill_credentials", "填写姓名和密码...");
    const givenInput = queryFirst([
      'input[name="givenName"]',
      'input[autocomplete="given-name"]',
      'input[data-testid="givenName"]',
    ]);
    const familyInput = queryFirst([
      'input[name="familyName"]',
      'input[autocomplete="family-name"]',
      'input[data-testid="familyName"]',
    ]);
    const passwordInput = queryFirst([
      'input[name="password"]',
      'input[type="password"]',
      'input[autocomplete="new-password"]',
    ]);
    if (givenInput) await setInputValue(givenInput, given);
    if (familyInput) await setInputValue(familyInput, family);
    if (passwordInput) await setInputValue(passwordInput, password);
    await sleep(600);
  }

  function readTurnstileToken() {
    const selectors = [
      'input[name="cf-turnstile-response"]',
      'textarea[name="cf-turnstile-response"]',
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.value && String(el.value).trim().length > 20) {
        return String(el.value).trim();
      }
    }
    try {
      if (window.turnstile && typeof window.turnstile.getResponse === "function") {
        const token = window.turnstile.getResponse();
        if (token && String(token).trim().length > 20) return String(token).trim();
      }
    } catch (_e) {}
    const nodes = document.querySelectorAll("input, textarea");
    for (const node of nodes) {
      const name = String(node.name || node.id || "");
      if (/turnstile/i.test(name) && node.value && String(node.value).trim().length > 20) {
        return String(node.value).trim();
      }
    }
    // Accessibility / text hint: widget may show 成功
    const text = pageText();
    if (/成功|Success/i.test(text) && hasTurnstile()) {
      // token may already be in hidden field but empty if cross-origin; still try fields again soon
    }
    return "";
  }

  function turnstileStatus() {
    if (readTurnstileToken()) return "passed";
    const text = pageText();
    if (/成功|Success!/i.test(text) && hasTurnstile()) return "passed-ui";
    if (/Checking your Browser|正在检查|验证您是真人/i.test(text)) return "checking";
    if (hasTurnstile()) return "present";
    return "absent";
  }

  async function tryClickTurnstile() {
    const frames = Array.from(document.querySelectorAll("iframe"));
    for (const frame of frames) {
      const src = String(frame.getAttribute("src") || "");
      if (!/turnstile|challenges\.cloudflare/i.test(src)) continue;
      try { frame.scrollIntoView({ block: "center", inline: "center" }); } catch (_e) {}
      const rect = frame.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) continue;
      const x = rect.left + Math.min(28, rect.width / 2);
      const y = rect.top + rect.height / 2;
      const target = document.elementFromPoint(x, y) || frame;
      for (const type of ["mousemove", "mousedown", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          view: window,
        }));
      }
    }
  }

  /**
   * Wait for Turnstile only when it is present/required on the current page.
   * Works for login-page CF, credentials-page CF, or standalone challenge.
   */
  async function maybeWaitTurnstile(token, where) {
    assertRunning(token);
    const status = turnstileStatus();
    if (status === "absent") {
      setStatus("无 Turnstile", `step=${where}`);
      return "";
    }
    if (status === "passed" || status === "passed-ui") {
      const t = readTurnstileToken();
      setStatus("Turnstile 已通过", `step=${where}`);
      return t || "ui-passed";
    }

    setPhase("wait_turnstile", `等待 Turnstile（${where}，可手动点选）...`);
    const deadline = Date.now() + 180000;
    let lastClick = 0;
    while (Date.now() < deadline) {
      assertRunning(token);
      if (looksRegistered()) return "already-registered";

      const st = turnstileStatus();
      const t = readTurnstileToken();
      if (t) {
        setStatus("Turnstile token 已拿到", t.slice(0, 24) + "...");
        return t;
      }
      if (st === "passed-ui") {
        setStatus("Turnstile UI 显示成功", `step=${where}`);
        // Give hidden field a moment to populate
        await sleepCancellable(token, 800);
        const t2 = readTurnstileToken();
        return t2 || "ui-passed";
      }

      if (Date.now() - lastClick > 4000) {
        lastClick = Date.now();
        await tryClickTurnstile();
      }
      setStatus(
        "等待 Turnstile",
        `step=${where} status=${st} · 若出现勾选框请手动点一下；点面板「停止」可中止`,
      );
      await sleepCancellable(token, 700);
    }
    throw new Error(`Turnstile timeout at ${where}`);
  }

  async function submitCompleteSignup() {
    const btn = findClickableByText([
      /Complete sign up/i,
      /Complete your sign up/i,
      /Create account/i,
      /^Sign up$/i,
      /完成注册/,
      /继续/,
    ]);
    // Never click 登录 on purpose here
    if (btn) {
      const text = String(btn.innerText || btn.textContent || "");
      if (!/^(登录|Log in|Sign in)$/i.test(text.trim())) {
        await clickEl(btn);
        return;
      }
    }
    const submit = queryFirst(['button[type="submit"]']);
    if (submit) {
      const text = String(submit.innerText || submit.textContent || "");
      if (!/^(登录|Log in|Sign in)$/i.test(text.trim())) {
        await clickEl(submit);
        return;
      }
    }
    const form = document.querySelector("form");
    if (form) {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    }
  }

  async function waitForSuccess(token, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertRunning(token);
      if (looksRegistered()) return true;
      // Still on guest grok.com after submit is NOT success.
      await sleepCancellable(token, 800);
    }
    if (looksRegistered()) return true;
    throw new Error("submit finished but login success not detected（页面仍像未登录）");
  }
})();
