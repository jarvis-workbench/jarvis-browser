/**
 * xAI OAuth (authorization code + PKCE) and optional NSFW enable.
 * Ported from local grokRegister-cpa sso_to_auth_json / nsfw helpers.
 * Requires worker host to expose crypto / btoa / atob.
 */

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const OIDC_ISSUER = "https://auth.x.ai";
const REDIRECT_URI = "http://127.0.0.1:56121/callback";
const GROK_REFERRER = "grok-build";
const GROK_PLAN = "generic";
const GROK_VERSION = "0.2.93";
const GROK_TOKEN_UA = `grok-pager/${GROK_VERSION} grok-shell/${GROK_VERSION} (linux; x86_64)`;
const NEXT_ACTION_ID = "4005315a1d7e426de592990bb54bb37471f39dd6d2";
const SCOPES = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const CPA_TOKEN_ENDPOINT = `${OIDC_ISSUER}/oauth2/token`;
const CPA_GROK_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const CPA_GROK_HEADERS = {
  "User-Agent": GROK_TOKEN_UA,
  "X-XAI-Token-Auth": "xai-grok-cli",
  "x-authenticateresponse": "authenticate-response",
  "x-grok-client-identifier": "grok-pager",
  "x-grok-client-version": GROK_VERSION,
};

function b64url(bytes) {
  let binary = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomB64Url(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

async function sha256B64Url(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return b64url(digest);
}

async function genPkce() {
  const verifier = randomB64Url(32);
  const challenge = await sha256B64Url(verifier);
  const state = randomB64Url(16);
  const nonce = randomB64Url(16);
  return { verifier, challenge, state, nonce };
}

function decodeJwtPayload(token) {
  try {
    const seg = String(token || "").split(".")[1] || "";
    const padded = seg + "=".repeat((4 - (seg.length % 4)) % 4);
    const json = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch (_e) {
    return {};
  }
}

function parseConsentCode(body) {
  const text = String(body || "");
  for (const line of text.split("\n")) {
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

function isoUtcFromUnix(ts) {
  try {
    return new Date(Number(ts) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch (_e) {
    return "";
  }
}

function nowIsoZ() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function nowIsoNs() {
  // second precision + 9 zero nanos, matching sample style
  const d = new Date();
  const base = d.toISOString().replace(/\.\d{3}Z$/, "");
  return `${base}.000000000Z`;
}

function requestCookieHeader(init) {
  const headers = init && init.headers ? init.headers : {};
  return headers.cookie || headers.Cookie || "";
}

/**
 * Exchange SSO cookie for OAuth tokens via authorization code + PKCE.
 * Uses api.request (Electron session). Cookie header is set explicitly.
 */
async function exchangeSsoForToken(api, sso, log) {
  const cookie = `sso=${sso}; sso-rw=${sso}`;
  const logFn = typeof log === "function" ? log : () => {};

  // validate SSO
  const home = await api.request("https://accounts.x.ai/", {
    method: "GET",
    headers: {
      cookie,
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });
  const homeText = typeof home === "string" ? home : JSON.stringify(home || {});
  if (/sign-in|sign-up|使用您的邮箱登录|Sign in/i.test(homeText) && /password|登录|Sign in/i.test(homeText) && homeText.length < 50000) {
    // soft check only; pages can still include those words
  }
  logFn("sso cookie attached for oauth");

  const pkce = await genPkce();
  const authorizeParams = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    nonce: pkce.nonce,
    plan: GROK_PLAN,
    redirect_uri: REDIRECT_URI,
    referrer: GROK_REFERRER,
    response_type: "code",
    scope: SCOPES,
    state: pkce.state,
  });

  // Electron session fetch follows redirects; we still POST consent URL.
  // First GET authorize to establish session cookies / land on consent.
  const authorizeUrl = `${OIDC_ISSUER}/oauth2/authorize?${authorizeParams.toString()}`;
  const authorizeHtml = await api.request(authorizeUrl, {
    method: "GET",
    headers: {
      cookie,
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });
  const authorizeText = typeof authorizeHtml === "string" ? authorizeHtml : "";
  // Try discover consent URL from HTML; fallback known path with query.
  let consentUrl = "";
  const m = authorizeText.match(/https:\/\/accounts\.x\.ai\/oauth2\/consent[^"'\s]*/i);
  if (m) consentUrl = m[0];
  if (!consentUrl) {
    // Often final URL is consent with same query; reconstruct.
    consentUrl = `https://accounts.x.ai/oauth2/consent?${authorizeParams.toString()}`;
  }
  logFn(`consent url ready`);

  const consentPayload = JSON.stringify([{
    action: "allow",
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope: SCOPES,
    state: pkce.state,
    codeChallenge: pkce.challenge,
    codeChallengeMethod: "S256",
    nonce: pkce.nonce,
    principalType: "User",
    principalId: "",
    referrer: GROK_REFERRER,
  }]);

  const consentResp = await api.request(consentUrl, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "text/plain;charset=UTF-8",
      accept: "text/x-component",
      origin: "https://accounts.x.ai",
      referer: consentUrl,
      "next-action": NEXT_ACTION_ID,
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    body: consentPayload,
  });
  const consentText = typeof consentResp === "string" ? consentResp : JSON.stringify(consentResp || {});
  const code = parseConsentCode(consentText);
  if (!code) {
    throw new Error(`consent 未返回 code: ${consentText.slice(0, 240)}`);
  }
  logFn("authorization code ok");

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: pkce.verifier,
  }).toString();

  const tokenResp = await api.request(CPA_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": GROK_TOKEN_UA,
      "x-grok-client-version": GROK_VERSION,
      accept: "*/*",
    },
    body: tokenBody,
  });
  const token = typeof tokenResp === "string" ? JSON.parse(tokenResp) : tokenResp;
  if (!token || !token.access_token) {
    throw new Error(`token 缺少 access_token: ${JSON.stringify(token).slice(0, 240)}`);
  }
  if (!token.expires_in) token.expires_in = 21600;
  if (!token.token_type) token.token_type = "Bearer";

  const ap = decodeJwtPayload(token.access_token);
  const ref = ap.referrer;
  if (ref !== GROK_REFERRER && ref !== "grok-build" && ref !== "cli-proxy-api") {
    logFn(`warn access_token referrer=${ref}`);
  } else {
    logFn(`access_token referrer=${ref}`);
  }
  return token;
}

function tokenToCpaRecord(token, email, sso) {
  const access = token.access_token || "";
  const refresh = token.refresh_token || "";
  const idToken = token.id_token || "";
  const payload = decodeJwtPayload(access);
  const idPayload = idToken ? decodeJwtPayload(idToken) : {};
  const finalEmail = email || idPayload.email || payload.email || "";
  const sub = payload.sub || idPayload.sub || "";
  let expired = "";
  if (payload.exp) expired = isoUtcFromUnix(payload.exp);
  else if (token.expires_in != null) expired = isoUtcFromUnix(Math.floor(Date.now() / 1000) + Number(token.expires_in));

  return {
    type: "xai",
    auth_kind: "oauth",
    email: finalEmail,
    sub,
    access_token: access,
    refresh_token: refresh,
    id_token: idToken,
    token_type: token.token_type || "Bearer",
    expires_in: token.expires_in ?? null,
    expired,
    last_refresh: nowIsoZ(),
    redirect_uri: REDIRECT_URI,
    token_endpoint: CPA_TOKEN_ENDPOINT,
    base_url: CPA_GROK_BASE_URL,
    disabled: false,
    headers: { ...CPA_GROK_HEADERS },
    sso: sso || undefined,
  };
}

function tokenToGrok2BuildRecord(token, email) {
  const access = token.access_token || "";
  const refresh = token.refresh_token || "";
  const payload = decodeJwtPayload(access);
  const finalEmail = email || payload.email || "";
  let expiresAt = "";
  if (payload.exp) {
    const d = new Date(Number(payload.exp) * 1000);
    expiresAt = `${d.toISOString().replace("Z", "")}000Z`.replace(/(\.\d{3})\d*Z?$/, (m) => m.includes(".") ? `${m.replace(/Z.*/, "")}000Z` : m);
    // simpler:
    expiresAt = nowIsoNsFromExp(payload.exp);
  } else {
    expiresAt = nowIsoNs();
  }
  return {
    provider: "grok_build",
    name: finalEmail,
    client_id: CLIENT_ID,
    access_token: access,
    refresh_token: refresh,
    id_token: token.id_token || "",
    token_type: token.token_type || "Bearer",
    scope: payload.scope || "",
    expires_at: expiresAt,
    expires_in: Number(token.expires_in || 0),
    email: finalEmail,
    sub: payload.sub || "",
    user_id: payload.sub || payload.principal_id || "",
    principal_id: payload.principal_id || payload.sub || "",
    team_id: payload.team_id || "",
  };
}

function nowIsoNsFromExp(exp) {
  try {
    const d = new Date(Number(exp) * 1000);
    const base = d.toISOString().replace(/\.\d{3}Z$/, "");
    return `${base}.000000000Z`;
  } catch (_e) {
    return nowIsoNs();
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function encodeGrpcWebFrame(payloadBytes) {
  const len = payloadBytes.length;
  const out = new Uint8Array(5 + len);
  out[0] = 0;
  out[1] = (len >>> 24) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 8) & 0xff;
  out[4] = len & 0xff;
  out.set(payloadBytes, 5);
  return out;
}

function encodeNsfwPayload() {
  // field1 { field2 = 1 } ; field2 { string always_show_nsfw_content }
  const field1Content = new Uint8Array([0x10, 0x01]);
  const field1 = new Uint8Array(2 + field1Content.length);
  field1[0] = 0x0a;
  field1[1] = field1Content.length;
  field1.set(field1Content, 2);

  const nsfwString = new TextEncoder().encode("always_show_nsfw_content");
  const field2Inner = new Uint8Array(2 + nsfwString.length);
  field2Inner[0] = 0x0a;
  field2Inner[1] = nsfwString.length;
  field2Inner.set(nsfwString, 2);
  const field2 = new Uint8Array(2 + field2Inner.length);
  field2[0] = 0x12;
  field2[1] = field2Inner.length;
  field2.set(field2Inner, 2);

  const payload = new Uint8Array(field1.length + field2.length);
  payload.set(field1, 0);
  payload.set(field2, field1.length);
  return encodeGrpcWebFrame(payload);
}

function encodeTosPayload() {
  // field 2 varint 1
  const payload = new Uint8Array([0x10, 0x01]);
  return encodeGrpcWebFrame(payload);
}

function randomBirthDate() {
  const age = 22 + Math.floor(Math.random() * 18);
  const year = new Date().getUTCFullYear() - age;
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, "0");
  return `${year}-${month}-${day}T16:00:00.000Z`;
}

/**
 * Enable NSFW using SSO in browser page context is preferred.
 * Worker can only try HTTP with cookie; CF may block.
 */
async function enableNsfwViaHttp(api, sso, log) {
  const logFn = typeof log === "function" ? log : () => {};
  const cookie = `sso=${sso}; sso-rw=${sso}`;
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // TOS
  try {
    const tosBytes = encodeTosPayload();
    await api.request("https://accounts.x.ai/auth_mgmt.AuthManagement/SetTosAcceptedVersion", {
      method: "POST",
      headers: {
        cookie,
        "user-agent": ua,
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "x-user-agent": "connect-es/2.1.1",
        origin: "https://accounts.x.ai",
        referer: "https://accounts.x.ai/accept-tos",
      },
      // session.fetch body only supports string in current runtime
      body: bytesToBase64(tosBytes),
    });
  } catch (e) {
    logFn(`tos warn: ${e && e.message ? e.message : e}`);
  }

  // birth date
  try {
    await api.request("https://grok.com/rest/auth/set-birth-date", {
      method: "POST",
      headers: {
        cookie,
        "user-agent": ua,
        "content-type": "application/json",
        origin: "https://grok.com",
        referer: "https://grok.com/",
      },
      body: JSON.stringify({ birthDate: randomBirthDate() }),
    });
  } catch (e) {
    logFn(`birth warn: ${e && e.message ? e.message : e}`);
  }

  // NSFW feature — body is binary; runtime only serializes string bodies.
  // Prefer page-side enable via content script when possible.
  logFn("http nsfw best-effort (binary grpc may need page context)");
  return { ok: false, note: "prefer-page-nsfw" };
}

module.exports = {
  CLIENT_ID,
  exchangeSsoForToken,
  tokenToCpaRecord,
  tokenToGrok2BuildRecord,
  enableNsfwViaHttp,
  decodeJwtPayload,
  nowIsoZ,
  nowIsoNs,
};
