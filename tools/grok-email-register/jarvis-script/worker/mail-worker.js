/**
 * Grok email-register worker
 * - create mailbox via CF temp-mail admin API
 * - poll OTP for xAI verification emails
 * - reply to content script through browser-tab:message
 */
/* global exports, module, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, TextDecoder, TextEncoder */

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

/** @type {Map<string, string>} */
const mailboxTokens = new Map();
/** @type {any} */
let apiRef = null;
/** @type {typeof DEFAULT_CONFIG} */
let config = { ...DEFAULT_CONFIG };

exports.activate = async function activate(api) {
  apiRef = api;
  config = await loadConfig(api);
  api.log(
    `[mail] ready base=${config.mailBase} domains=${config.domains.join(",")} create=${config.createPath}`,
  );
};

exports.onMonitorEvent = async function onMonitorEvent(event, api) {
  if (!event || event.name !== "dom:message") {
    return;
  }

  const payload = event.payload || {};
  const channel = String(payload.channel || "");
  if (!channel.startsWith("grok-register:")) {
    return;
  }

  const data = normalizeData(payload.data);
  const requestId = String(data.requestId || "");
  const siteId = event.context && event.context.siteId;
  const sessionId = event.context && event.context.sessionId;

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

    if (channel === "grok-register:create-mailbox") {
      const box = await createMailbox(api);
      mailboxTokens.set(box.email.toLowerCase(), box.jwt);
      await persistMailbox(api, box);
      api.log(`[mail] created ${box.email}`);
      reply(api, {
        channel: "grok-register:mailbox",
        siteId,
        sessionId,
        payload: {
          requestId,
          ok: true,
          email: box.email,
          jwt: box.jwt,
        },
      });
      return;
    }

    if (channel === "grok-register:wait-code") {
      const email = String(data.email || "").trim();
      if (!email) {
        throw new Error("wait-code missing email");
      }
      const timeoutMs = Number(data.timeoutMs || config.codeTimeoutMs) || config.codeTimeoutMs;
      api.log(`[mail] waiting code for ${email} timeout=${timeoutMs}ms`);
      const code = await waitVerificationCode(api, email, timeoutMs);
      api.log(`[mail] got code=${code} for ${email}`);
      reply(api, {
        channel: "grok-register:code",
        siteId,
        sessionId,
        payload: {
          requestId,
          ok: true,
          email,
          code,
        },
      });
      return;
    }

    if (channel === "grok-register:result") {
      const result = {
        at: new Date().toISOString(),
        ...data,
      };
      await api.writeText("last-result.json", JSON.stringify(result, null, 2));
      api.log(`[mail] result saved ok=${Boolean(data.ok)} email=${data.email || ""}`);
      reply(api, {
        channel: "grok-register:result-ack",
        siteId,
        sessionId,
        payload: { requestId, ok: true },
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
      payload: {
        requestId,
        ok: false,
        error: message,
        forChannel: channel,
      },
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

async function loadConfig(api) {
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
      if (typeof parsed.customAuth === "string") {
        merged.customAuth = parsed.customAuth;
      }
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
  } catch (_error) {
    // optional data-dir config
  }
  if (!merged.domains.length) {
    merged.domains = ["icmk.top"];
  }
  return merged;
}

function normalizePath(path, fallback) {
  const raw = String(path || fallback || "").trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeData(data) {
  if (!data || typeof data !== "object") {
    return {};
  }
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

function authHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  const key = config.adminPassword || "";
  const mode = (config.authMode || "x-admin-auth").toLowerCase();
  if (key) {
    if (mode === "x-api-key") {
      headers["X-API-Key"] = key;
    } else if (mode === "bearer") {
      headers.Authorization = `Bearer ${key}`;
    } else if (mode === "none") {
      // no admin header
    } else {
      headers["x-admin-auth"] = key;
    }
  }
  if (config.customAuth) {
    headers["x-custom-auth"] = config.customAuth;
  }
  return headers;
}

function randomName(length) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

async function createMailbox(api) {
  const domain = config.domains[Math.floor(Math.random() * config.domains.length)];
  const name = randomName(10);
  const url = `${config.mailBase}${config.createPath}`;
  const body = JSON.stringify({
    name,
    enablePrefix: true,
    domain,
  });
  const data = await api.request(url, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body,
  });
  if (typeof data === "string") {
    throw new Error(`create mailbox non-json: ${data.slice(0, 200)}`);
  }
  const email = String((data && data.address) || "").trim();
  const jwt = String((data && data.jwt) || "").trim();
  if (!email || !jwt) {
    throw new Error(`create mailbox missing address/jwt: ${JSON.stringify(data).slice(0, 240)}`);
  }
  return { email, jwt };
}

async function persistMailbox(api, box) {
  try {
    let list = [];
    try {
      list = JSON.parse(await api.readText("mailboxes.json"));
      if (!Array.isArray(list)) list = [];
    } catch (_e) {
      list = [];
    }
    list.unshift({
      email: box.email,
      jwt: box.jwt,
      createdAt: new Date().toISOString(),
    });
    await api.writeText("mailboxes.json", JSON.stringify(list.slice(0, 50), null, 2));
  } catch (error) {
    api.log(`[mail] persist mailbox failed: ${error && error.message ? error.message : error}`);
  }
}

function pickListPayload(data) {
  if (Array.isArray(data)) {
    return data.filter((x) => x && typeof x === "object");
  }
  if (!data || typeof data !== "object") {
    return [];
  }
  const keys = ["results", "hydra:member", "data", "messages", "list", "rows", "records"];
  for (const key of keys) {
    const items = data[key];
    if (Array.isArray(items)) {
      return items.filter((x) => x && typeof x === "object");
    }
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
  const patterns = [
    /verification\s+code[:\s]+(\d{4,8})/i,
    /your\s+code[:\s]+(\d{4,8})/i,
    /confirm(?:ation)?\s+code[:\s]+(\d{4,8})/i,
  ];
  for (const pattern of patterns) {
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
  const jwt = mailboxTokens.get(String(email || "").toLowerCase());
  if (!jwt) {
    // try restore from mailboxes.json
    try {
      const list = JSON.parse(await api.readText("mailboxes.json"));
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && String(item.email || "").toLowerCase() === String(email).toLowerCase() && item.jwt) {
            mailboxTokens.set(String(email).toLowerCase(), String(item.jwt));
            break;
          }
        }
      }
    } catch (_e) {
      // ignore
    }
  }
  const token = mailboxTokens.get(String(email || "").toLowerCase());
  if (!token) {
    throw new Error(`missing jwt for ${email}`);
  }
  const url = `${config.mailBase}${config.messagesPath}?limit=20&offset=0`;
  const data = await api.request(url, {
    method: "GET",
    headers: authHeaders({ Authorization: `Bearer ${token}` }),
  });
  if (typeof data === "string") {
    throw new Error(`list mails non-json: ${data.slice(0, 200)}`);
  }
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
      if (data && typeof data === "object" && data.data && typeof data.data === "object") {
        return data.data;
      }
      if (data && typeof data === "object") {
        return data;
      }
    } catch (_e) {
      // try next
    }
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
        ? msg.to
            .filter((t) => t && typeof t === "object")
            .map((t) => String(t.address || "").toLowerCase())
        : [];
      const msgAddr = String(msg.address || "").toLowerCase();
      if (recipients.length && !recipients.includes(email.toLowerCase())) continue;
      if (msgAddr && msgAddr !== email.toLowerCase()) continue;

      const parts = [];
      for (const field of ["text", "raw", "content", "intro", "body", "snippet"]) {
        if (typeof msg[field] === "string" && msg[field].trim()) {
          parts.push(msg[field]);
        }
      }
      if (typeof msg.html === "string") {
        parts.push(stripHtml(msg.html));
      } else if (Array.isArray(msg.html)) {
        for (const h of msg.html) {
          if (typeof h === "string") parts.push(stripHtml(h));
        }
      }
      let subject = String(msg.subject || "");
      let combined = parts.join("\n");

      const detail = await getMessageDetail(api, email, msgId);
      if (detail && typeof detail === "object") {
        for (const field of ["text", "raw", "content", "intro", "body", "snippet"]) {
          if (typeof detail[field] === "string" && detail[field].trim()) {
            combined += `\n${detail[field]}`;
          }
        }
        if (typeof detail.html === "string") {
          combined += `\n${stripHtml(detail.html)}`;
        } else if (Array.isArray(detail.html)) {
          for (const h of detail.html) {
            if (typeof h === "string") combined += `\n${stripHtml(h)}`;
          }
        }
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
