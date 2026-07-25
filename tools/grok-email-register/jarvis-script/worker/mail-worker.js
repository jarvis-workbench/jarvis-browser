/**
 * Grok email-register worker
 * - create mailbox + poll OTP
 * - panel config persistence in script data dir
 * - absolute-path storage for account/cpa/grok2api/sso
 * - OAuth (authorization code + PKCE, referrer=grok-build)
 */
/* global exports, module, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, TextDecoder, TextEncoder, crypto, btoa, atob */

const DEFAULT_CONFIG = {
  mailBase: "https://mailapi.icmk.top",
  adminPassword: "2434981942a@A",
  domains: ["icmk.top"],
  authMode: "x-admin-auth",
  customAuth: "",
  createPath: "/admin/new_address",
  messagesPath: "/api/mails",
  detailPath: "/api/mail",
  pollIntervalMs: 2000,
  codeTimeoutMs: 180000,
};

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const OIDC_ISSUER = "https://auth.x.ai";
const DEVICE_CODE_URL = `${OIDC_ISSUER}/oauth2/device/code`;
const DEVICE_TOKEN_URL = `${OIDC_ISSUER}/oauth2/token`;
const DEVICE_VERIFY_URL = `${OIDC_ISSUER}/oauth2/device/verify`;
const DEVICE_APPROVE_URL = `${OIDC_ISSUER}/oauth2/device/approve`;
const DEVICE_UI_BASE = "https://accounts.x.ai/oauth2/device";
const REDIRECT_URI = "http://127.0.0.1:56121/callback";
const GROK_REFERRER = "grok-build";
const GROK_PLAN = "generic";
const GROK_VERSION = "0.2.93";
const GROK_TOKEN_UA = `grok-pager/${GROK_VERSION} grok-shell/${GROK_VERSION} (linux; x86_64)`;
const SCOPES = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const CPA_TOKEN_ENDPOINT = DEVICE_TOKEN_URL;
const CPA_GROK_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const CPA_GROK_HEADERS = {
  "User-Agent": GROK_TOKEN_UA,
  "X-XAI-Token-Auth": "xai-grok-cli",
  "x-authenticateresponse": "authenticate-response",
  "x-grok-client-identifier": "grok-pager",
  "x-grok-client-version": GROK_VERSION,
};

/** @type {Map<string, string>} */
const mailboxTokens = new Map();
/** @type {any} */
let apiRef = null;
/** @type {typeof DEFAULT_CONFIG} */
let config = { ...DEFAULT_CONFIG };
/** @type {{ siteId?: string, sessionId?: string }} */
let lastRequestContext = {};
/** @type {Map<string, any>} */
const deviceSessions = new Map();

exports.activate = async function activate(api) {
  apiRef = api;
  config = await loadMailConfig(api);
  api.log(
    `[mail] ready base=${config.mailBase} domains=${config.domains.join(",")} create=${config.createPath}`,
  );
};

exports.onMonitorEvent = async function onMonitorEvent(event, api) {
  if (!event || event.name !== "dom:message") return;
  const payload = event.payload || {};
  const channel = String(payload.channel || "");
  if (!channel.startsWith("grok-register:")) return;

  const data = normalizeData(payload.data);
  const requestId = String(data.requestId || "");
  const siteId = event.context && event.context.siteId;
  const sessionId = event.context && event.context.sessionId;
  // Keep the latest page session so cookie reads hit the same partition as the active BrowserView.
  if (siteId || sessionId) {
    lastRequestContext = {
      siteId: siteId || lastRequestContext.siteId,
      sessionId: sessionId || lastRequestContext.sessionId,
    };
  }

  try {
    if (channel === "grok-register:ping") {
      reply(api, {
        channel: "grok-register:pong",
        siteId,
        sessionId,
        payload: { requestId, ok: true, config: publicConfig() },
      });
      return;
    }

    if (channel === "grok-register:load-panel-config") {
      const panel = await loadPanelConfig(api);
      reply(api, {
        channel: "grok-register:panel-config",
        siteId,
        sessionId,
        payload: { requestId, ok: true, config: panel },
      });
      return;
    }

    if (channel === "grok-register:save-panel-config") {
      const panel = normalizePanelConfig(data.config || data);
      await savePanelConfig(api, panel);
      reply(api, {
        channel: "grok-register:panel-config-saved",
        siteId,
        sessionId,
        payload: { requestId, ok: true, config: panel },
      });
      return;
    }

    if (channel === "grok-register:create-mailbox") {
      const box = await createMailbox(api);
      mailboxTokens.set(box.email.toLowerCase(), box.jwt);
      await persistMailbox(api, box);
      api.log(`[mail] created ${box.email}`);
      reply(api, {
        channel: "grok-register:mailbox",
        siteId,
        sessionId,
        payload: { requestId, ok: true, email: box.email, jwt: box.jwt },
      });
      return;
    }

    if (channel === "grok-register:wait-code") {
      const email = String(data.email || "").trim();
      if (!email) throw new Error("wait-code missing email");
      const timeoutMs = Number(data.timeoutMs || config.codeTimeoutMs) || config.codeTimeoutMs;
      api.log(`[mail] waiting code for ${email} timeout=${timeoutMs}ms`);
      const code = await waitVerificationCode(api, email, timeoutMs);
      api.log(`[mail] got code=${code} for ${email}`);
      reply(api, {
        channel: "grok-register:code",
        siteId,
        sessionId,
        payload: { requestId, ok: true, email, code },
      });
      return;
    }

    if (channel === "grok-register:save-pending-job") {
      const job = data.job && typeof data.job === "object" ? data.job : data;
      await api.writeText("pending-job.json", JSON.stringify({
        ...job,
        updatedAt: new Date().toISOString(),
      }, null, 2));
      reply(api, {
        channel: "grok-register:pending-job-saved",
        siteId,
        sessionId,
        payload: { requestId, ok: true },
      });
      return;
    }

    if (channel === "grok-register:load-pending-job") {
      let job = null;
      try {
        job = JSON.parse(await api.readText("pending-job.json"));
      } catch (_e) {
        job = null;
      }
      reply(api, {
        channel: "grok-register:pending-job",
        siteId,
        sessionId,
        payload: { requestId, ok: true, job },
      });
      return;
    }

    if (channel === "grok-register:clear-pending-job") {
      try {
        await api.writeText("pending-job.json", "");
      } catch (_e) {}
      // overwrite with empty object marker
      await api.writeText("pending-job.json", JSON.stringify({ cleared: true, at: new Date().toISOString() }));
      reply(api, {
        channel: "grok-register:pending-job-cleared",
        siteId,
        sessionId,
        payload: { requestId, ok: true },
      });
      return;
    }

    if (channel === "grok-register:choose-storage") {
      assertDialogApi(api);
      const picked = await api.chooseDirectory({
        title: "选择 Grok 注册结果存储目录",
        defaultPath: String(data.defaultPath || ""),
        buttonLabel: "选择此目录",
      });
      reply(api, {
        channel: "grok-register:storage",
        siteId,
        sessionId,
        payload: {
          requestId,
          ok: true,
          canceled: Boolean(picked && picked.canceled),
          path: picked && picked.path ? String(picked.path) : "",
        },
      });
      return;
    }

    if (channel === "grok-register:start-device-oauth") {
      const session = await startDeviceCode(api, (m) => api.log(`[oauth] ${m}`));
      const key = session.device_code;
      deviceSessions.set(key, {
        ...session,
        email: String(data.email || ""),
        sso: String(data.sso || ""),
        startedAt: Date.now(),
      });
      reply(api, {
        channel: "grok-register:device-oauth",
        siteId,
        sessionId,
        payload: {
          requestId,
          ok: true,
          device_code: session.device_code,
          user_code: session.user_code,
          verification_uri: session.verification_uri,
          verification_uri_complete: session.verification_uri_complete,
          expires_in: session.expires_in,
          interval: session.interval,
        },
      });
      return;
    }

    if (channel === "grok-register:poll-device-oauth") {
      const deviceCode = String(data.device_code || "").trim();
      if (!deviceCode) throw new Error("poll-device-oauth missing device_code");
      const known = deviceSessions.get(deviceCode) || {};
      const token = await pollDeviceToken(api, {
        deviceCode,
        interval: Number(data.interval || known.interval || 5),
        expiresIn: Number(data.expires_in || known.expires_in || 1800),
        timeoutMs: Number(data.timeoutMs || 120000),
      }, (m) => api.log(`[oauth] ${m}`));
      deviceSessions.set(deviceCode, { ...known, token, finishedAt: Date.now() });
      reply(api, {
        channel: "grok-register:device-oauth-token",
        siteId,
        sessionId,
        payload: {
          requestId,
          ok: true,
          token,
        },
      });
      return;
    }

    if (channel === "grok-register:get-sso" || channel === "grok-register:get-session-cookies") {
      const session = await readSessionCookies(api, {
        ...data,
        siteId: data.siteId || siteId,
        sessionId: data.sessionId || sessionId,
      });
      reply(api, {
        channel: "grok-register:session-cookies",
        siteId,
        sessionId,
        payload: {
          requestId,
          ok: true,
          sso: session.sso,
          userId: session.userId,
          cfClearance: session.cfClearance,
          cloudflareCookies: session.cloudflareCookies,
          cookies: session.cookies,
        },
      });
      return;
    }

    if (channel === "grok-register:result") {
      const saved = await saveRegistrationBundle(api, {
        ...data,
        siteId: data.siteId || siteId,
        sessionId: data.sessionId || sessionId,
      });
      api.log(`[mail] result saved ok=${Boolean(data.ok)} email=${data.email || ""} files=${(saved.files || []).length}`);
      reply(api, {
        channel: "grok-register:result-ack",
        siteId,
        sessionId,
        payload: {
          requestId,
          ok: true,
          path: saved.path,
          storagePath: saved.storagePath,
          files: saved.files,
          oauth: saved.oauth || null,
          nsfw: saved.nsfw || null,
        },
      });
      return;
    }

    if (channel === "grok-register:log") {
      api.log(`[page] ${String(data.message || "")}`);
      return;
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    api.log(`[mail] error channel=${channel}: ${message}`);
    reply(api, {
      channel: "grok-register:error",
      siteId,
      sessionId,
      payload: { requestId, ok: false, error: message, forChannel: channel },
    });
  }
};

exports.deactivate = async function deactivate(api) {
  api.log("[mail] deactivate");
  apiRef = null;
};

function publicConfig() {
  return {
    mailBase: config.mailBase,
    domains: config.domains.slice(),
    createPath: config.createPath,
    messagesPath: config.messagesPath,
  };
}

function normalizeData(data) {
  if (!data || typeof data !== "object") return {};
  return data;
}

function reply(api, input) {
  api.sendBrowserTabMessage({
    channel: input.channel,
    payload: input.payload,
    siteId: input.siteId,
    sessionId: input.sessionId,
  });
}

function defaultPanelConfig() {
  return {
    password: "",
    storagePath: "",
    accountSeparator: "|",
    enableNsfw: false,
    targets: { cpa: false, grok2api: false, sso: false },
  };
}

function normalizePanelConfig(raw) {
  const base = defaultPanelConfig();
  const src = raw && typeof raw === "object" ? raw : {};
  const targets = src.targets && typeof src.targets === "object" ? src.targets : {};
  return {
    password: String(src.password || ""),
    storagePath: String(src.storagePath || "").trim(),
    accountSeparator: String(src.accountSeparator || "|") || "|",
    enableNsfw: Boolean(src.enableNsfw),
    targets: {
      cpa: Boolean(targets.cpa),
      grok2api: Boolean(targets.grok2api),
      sso: Boolean(targets.sso),
    },
  };
}

async function loadPanelConfig(api) {
  try {
    const raw = await api.readText("panel-config.json");
    return normalizePanelConfig(JSON.parse(raw));
  } catch (_e) {
    return defaultPanelConfig();
  }
}

async function savePanelConfig(api, panel) {
  const normalized = normalizePanelConfig(panel);
  await api.writeText("panel-config.json", JSON.stringify(normalized, null, 2));
  return normalized;
}

async function loadMailConfig(api) {
  const merged = { ...DEFAULT_CONFIG, domains: DEFAULT_CONFIG.domains.slice() };
  try {
    const raw = await api.readText("config.json");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.mailBase === "string" && parsed.mailBase.trim()) {
        merged.mailBase = parsed.mailBase.trim().replace(/\/+$/, "");
      }
      if (typeof parsed.adminPassword === "string" && parsed.adminPassword) {
        merged.adminPassword = parsed.adminPassword;
      }
      if (typeof parsed.authMode === "string" && parsed.authMode.trim()) {
        merged.authMode = parsed.authMode.trim().toLowerCase();
      }
      if (typeof parsed.customAuth === "string") merged.customAuth = parsed.customAuth;
      if (typeof parsed.createPath === "string" && parsed.createPath.trim()) {
        merged.createPath = normalizePath(parsed.createPath, "/admin/new_address");
      }
      if (typeof parsed.messagesPath === "string" && parsed.messagesPath.trim()) {
        merged.messagesPath = normalizePath(parsed.messagesPath, "/api/mails");
      }
      if (typeof parsed.detailPath === "string" && parsed.detailPath.trim()) {
        merged.detailPath = normalizePath(parsed.detailPath, "/api/mail");
      }
      if (typeof parsed.pollIntervalMs === "number" && parsed.pollIntervalMs > 200) {
        merged.pollIntervalMs = parsed.pollIntervalMs;
      }
      if (typeof parsed.codeTimeoutMs === "number" && parsed.codeTimeoutMs > 1000) {
        merged.codeTimeoutMs = parsed.codeTimeoutMs;
      }
      if (typeof parsed.domains === "string" && parsed.domains.trim()) {
        merged.domains = parsed.domains.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      } else if (Array.isArray(parsed.domains)) {
        merged.domains = parsed.domains.map((x) => String(x).trim()).filter(Boolean);
      }
    }
  } catch (_error) {}
  if (!merged.domains.length) merged.domains = ["icmk.top"];
  return merged;
}

function normalizePath(path, fallback) {
  const raw = String(path || fallback || "").trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function authHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  const key = config.adminPassword || "";
  const mode = (config.authMode || "x-admin-auth").toLowerCase();
  if (key) {
    if (mode === "x-api-key") headers["X-API-Key"] = key;
    else if (mode === "bearer") headers.Authorization = `Bearer ${key}`;
    else if (mode !== "none") headers["x-admin-auth"] = key;
  }
  if (config.customAuth) headers["x-custom-auth"] = config.customAuth;
  return headers;
}

function randomName(length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function createMailbox(api) {
  const domain = config.domains[Math.floor(Math.random() * config.domains.length)];
  const name = randomName(10);
  const url = `${config.mailBase}${config.createPath}`;
  const data = await api.request(url, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name, enablePrefix: true, domain }),
  });
  if (typeof data === "string") throw new Error(`create mailbox non-json: ${data.slice(0, 200)}`);
  const email = String((data && data.address) || "").trim();
  const jwt = String((data && data.jwt) || "").trim();
  if (!email || !jwt) throw new Error(`create mailbox missing address/jwt: ${JSON.stringify(data).slice(0, 240)}`);
  return { email, jwt };
}

async function persistMailbox(api, box) {
  try {
    let list = [];
    try {
      list = JSON.parse(await api.readText("mailboxes.json"));
      if (!Array.isArray(list)) list = [];
    } catch (_e) { list = []; }
    list.unshift({ email: box.email, jwt: box.jwt, createdAt: new Date().toISOString() });
    await api.writeText("mailboxes.json", JSON.stringify(list.slice(0, 50), null, 2));
  } catch (error) {
    api.log(`[mail] persist mailbox failed: ${error && error.message ? error.message : error}`);
  }
}

function pickListPayload(data) {
  if (Array.isArray(data)) return data.filter((x) => x && typeof x === "object");
  if (!data || typeof data !== "object") return [];
  for (const key of ["results", "hydra:member", "data", "messages", "list", "rows", "records"]) {
    const items = data[key];
    if (Array.isArray(items)) return items.filter((x) => x && typeof x === "object");
    if (items && typeof items === "object" && Array.isArray(items.messages)) {
      return items.messages.filter((x) => x && typeof x === "object");
    }
  }
  return [];
}

function extractVerificationCode(text, subject) {
  const subjectText = String(subject || "");
  const body = String(text || "");
  let match = subjectText.match(/^([A-Z0-9]{3}-[A-Z0-9]{3})\s+xAI/i);
  if (match) return match[1].toUpperCase();
  match = subjectText.match(/\b([A-Z0-9]{3}-[A-Z0-9]{3})\b/i);
  if (match) return match[1].toUpperCase();
  match = body.match(/\b([A-Z0-9]{3}-[A-Z0-9]{3})\b/i);
  if (match) return match[1].toUpperCase();
  for (const pattern of [/verification\s+code[:\s]+(\d{4,8})/i, /your\s+code[:\s]+(\d{4,8})/i, /confirm(?:ation)?\s+code[:\s]+(\d{4,8})/i]) {
    match = body.match(pattern);
    if (match) return match[1];
  }
  match = body.match(/\b([A-Z0-9]{6})\b/i);
  if (match) return match[1].toUpperCase();
  return "";
}

function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, " ");
}

async function listEmails(api, email) {
  let jwt = mailboxTokens.get(String(email || "").toLowerCase());
  if (!jwt) {
    try {
      const list = JSON.parse(await api.readText("mailboxes.json"));
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && String(item.email || "").toLowerCase() === String(email).toLowerCase() && item.jwt) {
            mailboxTokens.set(String(email).toLowerCase(), String(item.jwt));
            jwt = String(item.jwt);
            break;
          }
        }
      }
    } catch (_e) {}
  }
  if (!jwt) throw new Error(`missing jwt for ${email}`);
  const url = `${config.mailBase}${config.messagesPath}?limit=20&offset=0`;
  const data = await api.request(url, {
    method: "GET",
    headers: authHeaders({ Authorization: `Bearer ${jwt}` }),
  });
  if (typeof data === "string") throw new Error(`list mails non-json: ${data.slice(0, 200)}`);
  return pickListPayload(data);
}

async function getMessageDetail(api, email, messageId) {
  const token = mailboxTokens.get(String(email || "").toLowerCase());
  if (!token) return {};
  const candidates = [
    `${config.mailBase}${config.detailPath}/${messageId}`,
    `${config.mailBase}/api/mail/${messageId}`,
    `${config.mailBase}/api/mails/${messageId}`,
    `${config.mailBase}${config.messagesPath}/${messageId}`,
  ];
  const headers = authHeaders({ Authorization: `Bearer ${token}` });
  for (const url of candidates) {
    try {
      const data = await api.request(url, { method: "GET", headers });
      if (typeof data === "string") continue;
      if (data && typeof data === "object" && data.data && typeof data.data === "object") return data.data;
      if (data && typeof data === "object") return data;
    } catch (_e) {}
  }
  return {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitVerificationCode(api, email, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const seen = new Map();
  while (Date.now() < deadline) {
    let messages = [];
    try {
      messages = await listEmails(api, email);
      api.log(`[mail] mail count=${messages.length}`);
    } catch (error) {
      api.log(`[mail] poll failed: ${error && error.message ? error.message : error}`);
      await sleep(config.pollIntervalMs);
      continue;
    }
    for (const msg of messages) {
      const msgId = String(msg.id || msg.msgid || msg.mail_id || msg.messageId || "");
      if (!msgId) continue;
      const attempt = Number(seen.get(msgId) || 0);
      if (attempt >= 5) continue;
      seen.set(msgId, attempt + 1);
      const recipients = Array.isArray(msg.to)
        ? msg.to.filter((t) => t && typeof t === "object").map((t) => String(t.address || "").toLowerCase())
        : [];
      const msgAddr = String(msg.address || "").toLowerCase();
      if (recipients.length && !recipients.includes(email.toLowerCase())) continue;
      if (msgAddr && msgAddr !== email.toLowerCase()) continue;
      const parts = [];
      for (const field of ["text", "raw", "content", "intro", "body", "snippet"]) {
        if (typeof msg[field] === "string" && msg[field].trim()) parts.push(msg[field]);
      }
      if (typeof msg.html === "string") parts.push(stripHtml(msg.html));
      else if (Array.isArray(msg.html)) for (const h of msg.html) if (typeof h === "string") parts.push(stripHtml(h));
      let subject = String(msg.subject || "");
      let combined = parts.join("\n");
      const detail = await getMessageDetail(api, email, msgId);
      if (detail && typeof detail === "object") {
        for (const field of ["text", "raw", "content", "intro", "body", "snippet"]) {
          if (typeof detail[field] === "string" && detail[field].trim()) combined += `\n${detail[field]}`;
        }
        if (typeof detail.html === "string") combined += `\n${stripHtml(detail.html)}`;
        else if (Array.isArray(detail.html)) for (const h of detail.html) if (typeof h === "string") combined += `\n${stripHtml(h)}`;
        if (!subject) subject = String(detail.subject || "");
      }
      const code = extractVerificationCode(combined, subject);
      if (code) return code;
      api.log(`[mail] mail parsed no code id=${msgId} attempt=${seen.get(msgId)}`);
    }
    await sleep(config.pollIntervalMs);
  }
  throw new Error(`no verification code within ${Math.round(timeoutMs / 1000)}s for ${email}`);
}

function assertDialogApi(api) {
  if (typeof api.chooseDirectory !== "function") {
    throw new Error("当前 Jarvis 运行时不支持 api.chooseDirectory（请重启加载新主进程）");
  }
}
function assertFsApi(api) {
  if (typeof api.writeFile !== "function" || typeof api.readFile !== "function" || typeof api.appendFile !== "function") {
    throw new Error("当前 Jarvis 运行时不支持绝对路径 fs API（请重启加载新主进程）");
  }
}

function joinPath(base, name) {
  const root = String(base || "").replace(/[\\/]+$/, "");
  const leaf = String(name || "").replace(/^[\\/]+/, "");
  if (!root) return leaf;
  return root.includes("\\") ? `${root}\\${leaf}` : `${root}/${leaf}`;
}

function safeEmailFilename(email) {
  return String(email || "unknown").replace(/[\\/:*?"<>|]+/g, "_").trim() || "unknown";
}

async function readSessionCookies(api, data) {
  const result = {
    sso: String((data && data.sso) || "").trim(),
    userId: String((data && data.userId) || "").trim(),
    cfClearance: "",
    cloudflareCookies: "",
    cookies: [],
  };

  if (typeof api.getCookies !== "function") {
    api.log("[session] getCookies API unavailable");
    return result;
  }

  const siteId = String((data && data.siteId) || lastRequestContext.siteId || "").trim() || undefined;
  const sessionId = String((data && data.sessionId) || lastRequestContext.sessionId || "").trim() || undefined;
  const scope = { siteId, sessionId };

  const bags = [];
  const filters = [
    { url: "https://grok.com/" },
    { url: "https://www.grok.com/" },
    { url: "https://accounts.x.ai/" },
    { url: "https://auth.x.ai/" },
    { domain: "grok.com" },
    { domain: ".grok.com" },
    { domain: "x.ai" },
    { domain: ".x.ai" },
    {}, // full jar for this partition as last resort
  ];
  for (const filter of filters) {
    try {
      const cookies = await api.getCookies({ ...filter, ...scope });
      if (Array.isArray(cookies) && cookies.length) bags.push(...cookies);
    } catch (error) {
      api.log(`[session] getCookies failed filter=${JSON.stringify(filter)} err=${error && error.message ? error.message : error}`);
    }
  }

  // de-dupe by name@domain@path
  const map = new Map();
  for (const cookie of bags) {
    if (!cookie || !cookie.name) continue;
    const key = `${cookie.name}|${cookie.domain || ""}|${cookie.path || ""}`;
    if (!map.has(key) && cookie.value != null) map.set(key, cookie);
  }
  const all = [...map.values()];
  result.cookies = all.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain || "",
    path: c.path || "",
    httpOnly: Boolean(c.httpOnly),
  }));

  const byName = (name, preferDomainRe) => {
    const matches = all.filter((c) => String(c.name || "").toLowerCase() === String(name).toLowerCase() && String(c.value || "").trim());
    if (!matches.length) return "";
    if (preferDomainRe) {
      const preferred = matches.find((c) => preferDomainRe.test(String(c.domain || "")));
      if (preferred) return String(preferred.value).trim();
    }
    // Prefer grok.com for account cookies, then any.
    const grok = matches.find((c) => /grok\.com/i.test(String(c.domain || "")));
    if (grok) return String(grok.value).trim();
    return String(matches[0].value).trim();
  };

  if (!result.sso) result.sso = byName("sso", /grok\.com/i) || byName("sso-rw", /grok\.com/i) || byName("sso") || byName("sso-rw");
  if (!result.userId) {
    result.userId = byName("x-userid", /grok\.com/i)
      || byName("x_userid", /grok\.com/i)
      || byName("userid", /grok\.com/i)
      || byName("user_id", /grok\.com/i)
      || byName("x-userid")
      || byName("x_userid")
      || byName("userid")
      || byName("user_id");
  }
  result.cfClearance = byName("cf_clearance", /grok\.com/i) || byName("cf_clearance");

  // Prefer grok.com cloudflare cookies for web account export.
  const cfNames = ["cf_clearance", "__cf_bm", "cf_chl_2", "cf_chl_rc_i", "cf_chl_rc_ni", "cf_chl_rc_m"];
  const pairs = [];
  for (const name of cfNames) {
    const preferred = all.find((c) => String(c.name) === name && /grok\.com/i.test(String(c.domain || "")))
      || all.find((c) => String(c.name) === name);
    if (preferred && preferred.value) pairs.push(`${name}=${preferred.value}`);
  }
  result.cloudflareCookies = pairs.join("; ");

  api.log(
    `[session] cookies total=${all.length} sso=${result.sso ? "yes" : "no"} userId=${result.userId || "-"} cf=${result.cfClearance ? "yes" : "no"} site=${siteId || "-"} session=${sessionId || "-"} names=${all.map((c) => c.name).slice(0, 20).join(",")}`,
  );
  return result;
}

async function readSsoCookie(api, data) {
  const session = await readSessionCookies(api, data);
  return session.sso || "";
}

function b64url(bytes) {
  let binary = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function randomB64Url(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}
async function sha256B64Url(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return b64url(digest);
}
async function genPkce() {
  const verifier = randomB64Url(32);
  return {
    verifier,
    challenge: await sha256B64Url(verifier),
    state: randomB64Url(16),
    nonce: randomB64Url(16),
  };
}
function decodeJwtPayload(token) {
  try {
    const seg = String(token || "").split(".")[1] || "";
    const padded = seg + "=".repeat((4 - (seg.length % 4)) % 4);
    return JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
  } catch (_e) {
    return {};
  }
}
function parseConsentCode(body) {
  for (const line of String(body || "").split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    try {
      const data = JSON.parse(line.slice(start));
      if (data && typeof data === "object" && data.code) {
        if (data.success === false) return "";
        return String(data.code || "");
      }
    } catch (_e) {}
  }
  return "";
}
function extractNextActionId(html) {
  const text = String(html || "");
  const patterns = [
    /next-action["']?\s*[:=]\s*["']([a-f0-9]{20,})["']/i,
    /"actionId"\s*:\s*"([a-f0-9]{20,})"/i,
    /\$ACTION_ID_([a-f0-9]{20,})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1];
  }
  return DEFAULT_NEXT_ACTION_ID;
}
function isoUtcFromUnix(ts) {
  try { return new Date(Number(ts) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"); }
  catch (_e) { return ""; }
}
function nowIsoZ() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function nowIsoNsFromExp(exp) {
  try {
    const d = new Date(Number(exp) * 1000);
    return `${d.toISOString().replace(/\.\d{3}Z$/, "")}.000000000Z`;
  } catch (_e) {
    return `${new Date().toISOString().replace(/\.\d{3}Z$/, "")}.000000000Z`;
  }
}

async function startDeviceCode(api, logFn) {
  const log = logFn || (() => {});
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: SCOPES,
  }).toString();
  const resp = await api.request(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": GROK_TOKEN_UA,
    },
    body,
  });
  const payload = typeof resp === "string" ? JSON.parse(resp) : (resp || {});
  const deviceCode = String(payload.device_code || "").trim();
  const userCode = String(payload.user_code || "").trim();
  if (!deviceCode || !userCode) {
    throw new Error(`device code incomplete: ${JSON.stringify(payload).slice(0, 240)}`);
  }
  const verificationUri = String(payload.verification_uri || DEVICE_UI_BASE).trim() || DEVICE_UI_BASE;
  const verificationUriComplete = String(
    payload.verification_uri_complete || `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
  ).trim();
  const session = {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    expires_in: Number(payload.expires_in || 1800) || 1800,
    interval: Math.max(Number(payload.interval || 5) || 5, 1),
  };
  log(`device code ready user_code=${userCode}`);
  return session;
}

async function pollDeviceToken(api, input, logFn) {
  const log = logFn || (() => {});
  const deviceCode = String(input.deviceCode || "").trim();
  if (!deviceCode) throw new Error("device_code required");
  let intervalMs = Math.max(Number(input.interval || 5) || 5, 1) * 1000;
  const timeoutMs = Math.max(Number(input.timeoutMs || 120000) || 120000, 5000);
  const expiresBudgetMs = Math.max(Number(input.expiresIn || 1800) || 1800, 5) * 1000;
  const deadline = Date.now() + Math.min(timeoutMs, expiresBudgetMs);
  let first = true;
  while (Date.now() < deadline) {
    if (!first) await sleep(intervalMs);
    first = false;
    const body = new URLSearchParams({
      grant_type: DEVICE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: CLIENT_ID,
    }).toString();
    let resp;
    try {
      resp = await api.request(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          "user-agent": GROK_TOKEN_UA,
        },
        body,
      });
    } catch (error) {
      log(`poll network: ${error && error.message ? error.message : error}`);
      continue;
    }
    const payload = typeof resp === "string"
      ? (() => { try { return JSON.parse(resp); } catch (_e) { return { raw: resp }; } })()
      : (resp || {});
    if (payload && payload.access_token) {
      if (!payload.expires_in) payload.expires_in = 21600;
      if (!payload.token_type) payload.token_type = "Bearer";
      const ref = decodeJwtPayload(payload.access_token).referrer;
      log(`device token ok referrer=${ref || "-"}`);
      return payload;
    }
    const err = String(payload.error || "");
    if (err === "authorization_pending") {
      continue;
    }
    if (err === "slow_down") {
      intervalMs = Math.min(intervalMs + 5000, 30000);
      continue;
    }
    if (err === "expired_token" || err === "access_denied" || err === "invalid_grant") {
      throw new Error(`device auth failed: ${err}${payload.error_description ? `: ${payload.error_description}` : ""}（若刚点允许仍失败，通常是账号未真正授权成功或 device_code 已失效，请重跑 OAuth）`);
    }
    if (err) {
      throw new Error(`device token error: ${err}${payload.error_description ? `: ${payload.error_description}` : ""}`);
    }
    // keep waiting on empty/soft responses
  }
  throw new Error("device auth timed out waiting for approval");
}

/**
 * Preferred OAuth path: device-code grant.
 * Browser UI must approve user_code on accounts.x.ai/oauth2/device.
 * Optional SSO cookie is only used for protocol-side verify/approve fallback.
 */
async function exchangeSsoForToken(api, sso, logFn) {
  const log = logFn || (() => {});
  const session = await startDeviceCode(api, log);
  // Best-effort protocol approve with SSO cookie (no browser). If it fails, caller should use browser path.
  if (sso) {
    try {
      await protocolApproveDevice(api, sso, session.user_code, log);
      log("protocol approve attempted");
    } catch (error) {
      log(`protocol approve skipped: ${error && error.message ? error.message : error}`);
      const err = new Error(`需要浏览器完成设备授权: ${session.verification_uri_complete}`);
      err.deviceSession = session;
      throw err;
    }
  } else {
    const err = new Error(`需要浏览器完成设备授权: ${session.verification_uri_complete}`);
    err.deviceSession = session;
    throw err;
  }
  return pollDeviceToken(api, {
    deviceCode: session.device_code,
    interval: session.interval,
    expiresIn: Math.min(session.expires_in, 180),
    timeoutMs: 120000,
  }, log);
}

async function protocolApproveDevice(api, sso, userCode, logFn) {
  const log = logFn || (() => {});
  const cookie = `sso=${sso}; sso-rw=${sso}`;
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const common = {
    cookie,
    "user-agent": ua,
    accept: "text/html,application/xhtml+xml,application/json",
    origin: "https://accounts.x.ai",
  };
  // open verification page
  await api.request(`${DEVICE_UI_BASE}?user_code=${encodeURIComponent(userCode)}`, {
    method: "GET",
    headers: { ...common, referer: "https://accounts.x.ai/" },
  });
  // verify
  const verifyBody = new URLSearchParams({ user_code: userCode }).toString();
  const verifyResp = await api.request(DEVICE_VERIFY_URL, {
    method: "POST",
    headers: {
      ...common,
      "content-type": "application/x-www-form-urlencoded",
      referer: `${DEVICE_UI_BASE}?user_code=${encodeURIComponent(userCode)}`,
    },
    body: verifyBody,
  });
  const verifyText = typeof verifyResp === "string" ? verifyResp : JSON.stringify(verifyResp || {});
  if (/sign-in|sign-up|rate_limited/i.test(verifyText) && !/consent|authorize|授权/i.test(verifyText)) {
    throw new Error(`device verify unexpected: ${verifyText.slice(0, 180)}`);
  }
  // approve
  const approveBody = new URLSearchParams({
    user_code: userCode,
    action: "allow",
    principal_type: "User",
    principal_id: "",
  }).toString();
  // Consent page is the real referer; empty action was the browser-path Invalid action root cause.
  const approveResp = await api.request(DEVICE_APPROVE_URL, {
    method: "POST",
    headers: {
      ...common,
      "content-type": "application/x-www-form-urlencoded",
      referer: `${DEVICE_UI_BASE}/consent?user_code=${encodeURIComponent(userCode)}`,
    },
    body: approveBody,
  });
  const approveText = typeof approveResp === "string" ? approveResp : JSON.stringify(approveResp || {});
  if (!/done|authorized|已授权|device authorized/i.test(approveText) && !/done/i.test(String(approveResp && approveResp.url || ""))) {
    // soft pass: some responses are empty redirects
    log(`approve response soft: ${approveText.slice(0, 120)}`);
  }
}

function tokenToCpaRecord(token, email, sso) {
  const access = token.access_token || "";
  const payload = decodeJwtPayload(access);
  const idPayload = token.id_token ? decodeJwtPayload(token.id_token) : {};
  const finalEmail = email || idPayload.email || payload.email || "";
  let expired = payload.exp ? isoUtcFromUnix(payload.exp) : "";
  if (!expired && token.expires_in != null) expired = isoUtcFromUnix(Math.floor(Date.now() / 1000) + Number(token.expires_in));
  return {
    type: "xai",
    auth_kind: "oauth",
    email: finalEmail,
    sub: payload.sub || idPayload.sub || "",
    access_token: access,
    refresh_token: token.refresh_token || "",
    id_token: token.id_token || "",
    token_type: token.token_type || "Bearer",
    expires_in: token.expires_in ?? null,
    expired,
    last_refresh: nowIsoZ(),
    redirect_uri: REDIRECT_URI,
    token_endpoint: CPA_TOKEN_ENDPOINT,
    base_url: CPA_GROK_BASE_URL,
    disabled: false,
    headers: { ...CPA_GROK_HEADERS },
    ...(sso ? { sso } : {}),
  };
}

function tokenToGrok2BuildRecord(token, email) {
  const access = token.access_token || "";
  const payload = decodeJwtPayload(access);
  const finalEmail = email || payload.email || "";
  return {
    provider: "grok_build",
    name: finalEmail,
    client_id: CLIENT_ID,
    access_token: access,
    refresh_token: token.refresh_token || "",
    id_token: token.id_token || "",
    token_type: token.token_type || "Bearer",
    scope: payload.scope || "",
    expires_at: payload.exp ? nowIsoNsFromExp(payload.exp) : nowIsoNsFromExp(Math.floor(Date.now() / 1000) + Number(token.expires_in || 21600)),
    expires_in: Number(token.expires_in || 0),
    email: finalEmail,
    sub: payload.sub || "",
    user_id: payload.sub || payload.principal_id || "",
    principal_id: payload.principal_id || payload.sub || "",
    team_id: payload.team_id || "",
  };
}

async function saveRegistrationBundle(api, data) {
  assertFsApi(api);
  const storagePath = String(data.storagePath || "").trim();
  if (!storagePath) throw new Error("缺少 storagePath");
  const email = String(data.email || "").trim();
  const password = String(data.password || "");
  const separator = String(data.accountSeparator || "|") || "|";
  const targets = (data.targets && typeof data.targets === "object") ? data.targets : {};
  const enableNsfw = Boolean(data.enableNsfw);
  let sso = String(data.sso || "").trim();
  let cloudflareCookies = String(data.cloudflareCookies || "");
  let userId = String(data.userId || "");
  // Always re-read from Electron session as source of truth for grok.com cookies.
  try {
    const session = await readSessionCookies(api, { sso, userId });
    if (session.sso) sso = session.sso;
    if (session.userId) userId = session.userId;
    if (session.cloudflareCookies) cloudflareCookies = session.cloudflareCookies;
    if (!cloudflareCookies && session.cfClearance) cloudflareCookies = `cf_clearance=${session.cfClearance}`;
    api.log(`[session] sso=${sso ? "yes" : "no"} userId=${userId || "-"} cf=${session.cfClearance ? "yes" : "no"}`);
  } catch (error) {
    api.log(`[session] read cookies failed: ${error && error.message ? error.message : error}`);
  }
  const nsfwMeta = data.nsfw || null;
  const files = [];
  const fname = safeEmailFilename(email);

  // always write meta under storage root
  const result = {
    at: new Date().toISOString(),
    storagePath,
    ok: Boolean(data.ok),
    email,
    password,
    sso,
    userId,
    cloudflareCookies,
    targets,
    enableNsfw,
    nsfw: nsfwMeta,
    url: data.url || "",
    given: data.given || "",
    family: data.family || "",
    code: data.code || "",
    error: data.error || "",
  };
  const metaPath = joinPath(storagePath, "last-result.json");
  await api.writeFile(metaPath, JSON.stringify(result, null, 2));
  files.push(metaPath);
  try { await api.writeText("last-result.json", JSON.stringify(result, null, 2)); } catch (_e) {}

  let oauthToken = (data.oauthToken && data.oauthToken.access_token) ? data.oauthToken : null;
  let oauthError = String(data.oauthError || "");
  let deviceSession = data.deviceSession || null;
  const needOauth = Boolean(data.ok && email && (targets.cpa || targets.grok2api));
  if (needOauth && !oauthToken) {
    // OAuth is expected to be completed via browser device-code flow in content script.
    // Keep a protocol fallback for environments that already have SSO + can approve without UI.
    if (!sso) {
      oauthError = oauthError || "缺少 SSO，无法完成 OAuth";
      api.log(`[oauth] ${oauthError}`);
    } else {
      try {
        oauthToken = await exchangeSsoForToken(api, sso, (m) => api.log(`[oauth] ${m}`));
      } catch (error) {
        oauthError = error && error.message ? error.message : String(error);
        if (error && error.deviceSession) deviceSession = error.deviceSession;
        api.log(`[oauth] failed: ${oauthError}`);
      }
    }
  }

  // 1) account always on success
  if (data.ok && email) {
    const accountDir = joinPath(storagePath, "account");
    const accountPath = joinPath(accountDir, `${fname}.text`);
    const line = [email, password, sso].join(separator);
    await api.writeFile(accountPath, `${line}\n`);
    files.push(accountPath);
  }

  // 2) CPA
  if (data.ok && targets.cpa && email) {
    const cpaDir = joinPath(storagePath, "cpa");
    const cpaPath = joinPath(cpaDir, `${fname}.json`);
    if (oauthToken) {
      const record = tokenToCpaRecord(oauthToken, email, sso);
      await api.writeFile(cpaPath, JSON.stringify(record, null, 2));
      files.push(cpaPath);
    } else {
      await api.writeFile(cpaPath, JSON.stringify({
        error: oauthError || "oauth failed",
        email,
        type: "xai",
        auth_kind: "oauth",
      }, null, 2));
      files.push(cpaPath);
    }
  }

  // 3) Grok2API
  if (data.ok && targets.grok2api && email) {
    const g2Dir = joinPath(storagePath, "grok2api");
    const buildPath = joinPath(g2Dir, `${fname}.build.json`);
    const webPath = joinPath(g2Dir, `${fname}.web.json`);
    if (oauthToken) {
      await api.writeFile(buildPath, JSON.stringify(tokenToGrok2BuildRecord(oauthToken, email), null, 2));
      files.push(buildPath);
    } else {
      await api.writeFile(buildPath, JSON.stringify({
        provider: "grok_build",
        name: email,
        email,
        error: oauthError || "oauth failed",
      }, null, 2));
      files.push(buildPath);
    }
    const webRecord = {
      name: email,
      email,
      user_id: userId || (oauthToken ? (decodeJwtPayload(oauthToken.access_token).sub || "") : ""),
      sso_token: sso,
      token: "",
      tier: "base",
      cloudflare_cookies: cloudflareCookies || "",
      nsfw_enabled_at: nsfwMeta && nsfwMeta.ok ? (nsfwMeta.at || nowIsoZ()) : "",
      birth_date_set_at: nsfwMeta && nsfwMeta.birthAt ? nsfwMeta.birthAt : "",
    };
    await api.writeFile(webPath, JSON.stringify(webRecord, null, 2));
    files.push(webPath);
  }

  // 4) SSO
  if (data.ok && targets.sso && email && sso) {
    const ssoDir = joinPath(storagePath, "sso");
    const ssoPath = joinPath(ssoDir, `${fname}.text`);
    await api.writeFile(ssoPath, `${sso}\n`);
    files.push(ssoPath);
  }

  return {
    storagePath,
    path: metaPath,
    files,
    oauth: oauthToken
      ? { ok: true }
      : (needOauth ? { ok: false, error: oauthError, deviceSession } : null),
    deviceSession,
    nsfw: nsfwMeta,
  };
}
