#!/usr/bin/env python3
"""Headless Grok / xAI email registration over pure protocol.

Does not open the website UI or Jarvis Browser.

Mailbox:
  Default auto-creates email + pulls OTP via CF temp-mail
  (mailapi.icmk.top / x-admin-auth / /admin/new_address).

Cloudflare Turnstile is optional:
  1) try create-user without token
  2) only if server requires Turnstile:
       - provided --turnstile-token
       - CAPSOLVER_API_KEY / YESCAPTCHA_API_KEY
       - local Chrome (Playwright/CDP) only for Turnstile
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import secrets
import string
import struct
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin

try:
    from curl_cffi import requests as cffi_requests
except ImportError as exc:  # pragma: no cover
    raise SystemExit("需要 curl_cffi：pip install curl_cffi") from exc

try:
    import requests as std_requests
except ImportError:  # pragma: no cover
    std_requests = None


# local import (same directory as this script)
try:
    from cfmail import CFMail
except ImportError:  # pragma: no cover
    _here = Path(__file__).resolve().parent
    if str(_here) not in sys.path:
        sys.path.insert(0, str(_here))
    from cfmail import CFMail

try:
    from browser_turnstile import solve_turnstile_browser, stop_shared_browser
except ImportError:  # pragma: no cover
    _here = Path(__file__).resolve().parent
    if str(_here) not in sys.path:
        sys.path.insert(0, str(_here))
    from browser_turnstile import solve_turnstile_browser, stop_shared_browser


ACCOUNTS_BASE = "https://accounts.x.ai"
SIGNUP_URL = f"{ACCOUNTS_BASE}/sign-up?redirect=grok-com"
GRPC_BASE = f"{ACCOUNTS_BASE}/auth_mgmt.AuthManagement"
TURNSTILE_SITEKEY_DEFAULT = "0x4AAAAAAAhr9JGVDZbrZOo0"
FALLBACK_NEXT_ACTION = "7f7332944c24eefea8c64a1c6feefd079beb39dca5"


# ----------------------------- protobuf / grpc-web -----------------------------

def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            break
    return bytes(out)


def _key(field: int, wire: int) -> bytes:
    return _varint((field << 3) | wire)


def pb_str(field: int, value: str) -> bytes:
    data = (value or "").encode("utf-8")
    return _key(field, 2) + _varint(len(data)) + data


def pb_bool(field: int, value: bool) -> bytes:
    return _key(field, 0) + _varint(1 if value else 0)


def grpc_frame(msg: bytes) -> bytes:
    return b"\x00" + struct.pack(">I", len(msg)) + msg


def parse_grpc_web(body: bytes) -> tuple[bytes, dict[str, str]]:
    data = b""
    trailers: dict[str, str] = {}
    i = 0
    while i + 5 <= len(body):
        flag = body[i]
        length = int.from_bytes(body[i + 1 : i + 5], "big")
        part = body[i + 5 : i + 5 + length]
        i += 5 + length
        if flag == 0:
            data = part
        elif flag == 0x80:
            for line in part.decode("utf-8", "replace").split("\r\n"):
                if ":" in line:
                    k, v = line.split(":", 1)
                    trailers[k.strip().lower()] = v.strip()
    # some gateways put status only in headers; caller merges them
    return data, trailers


# ----------------------------- helpers -----------------------------

def log(msg: str) -> None:
    print(msg, flush=True)


def build_profile(given: str = "", family: str = "", password: str = "") -> tuple[str, str, str]:
    g = given or "".join(random.choices(string.ascii_lowercase, k=random.randint(4, 7))).capitalize()
    f = family or "".join(random.choices(string.ascii_lowercase, k=random.randint(4, 7))).capitalize()
    p = password or ("N" + secrets.token_hex(4) + "!a7#" + secrets.token_urlsafe(6))
    return g, f, p


def extract_verification_code(text: str, subject: str = "") -> str:
    blob = f"{subject}\n{text}"
    if subject:
        m = re.search(r"^([A-Z0-9]{3}-[A-Z0-9]{3})\s+xAI", subject, re.I)
        if m:
            return m.group(1).upper()
    m = re.search(r"\b([A-Z0-9]{3}-[A-Z0-9]{3})\b", blob, re.I)
    if m:
        return m.group(1).upper()
    m = re.search(
        r"(?:verification\s+code|your\s+code|confirm(?:ation)?\s+code)[:\s]+([A-Z0-9]{4,8})",
        blob,
        re.I,
    )
    if m:
        return m.group(1).upper()
    m = re.search(r"\b([A-Z0-9]{6})\b", blob, re.I)
    if m:
        return m.group(1).upper()
    return ""


def extract_next_action(text: str) -> str:
    """Extract Next.js server action id from HTML/JS/flight text.

    createServerReference("...") usually lives in a client chunk, not the HTML shell.
    Prefer ids that appear near signup payload markers.
    """
    body = text or ""
    candidates: list[tuple[int, str]] = []
    for m in re.finditer(r'createServerReference\)?\("([0-9a-f]{20,})"', body):
        action = m.group(1)
        # score by nearby signup markers
        window = body[max(0, m.start() - 2500) : m.end() + 2500]
        score = 0
        if "emailValidationCode" in window or "createUserAndSessionRequest" in window:
            score += 100
        if "turnstileToken" in window or "tosAcceptedVersion" in window:
            score += 40
        if "sign-up" in window or "signUp" in window or "sign_up" in window:
            score += 10
        # prefer longer / newer looking hashes slightly by keeping order as tie-break via index
        candidates.append((score, action))
    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        best_score, best = candidates[0]
        if best_score > 0 or len(candidates) == 1:
            return best
        # multiple unscoped refs: return first createServerReference still
        return candidates[0][1]
    for pat in (
        r'"next-action"\s*:\s*"([0-9a-f]{20,})"',
    ):
        m = re.search(pat, body)
        if m:
            return m.group(1)
    return ""


def extract_script_urls(html: str, base: str = ACCOUNTS_BASE) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    for raw in re.findall(r'(?:src|href)="([^"]+/_next/static/[^"]+\.js[^"]*)"', html or ""):
        src = raw
        if src.startswith("//"):
            src = "https:" + src
        elif src.startswith("/"):
            src = urljoin(base + "/", src.lstrip("/"))
        elif not src.startswith("http"):
            src = urljoin(base + "/", src)
        if src not in seen:
            seen.add(src)
            urls.append(src)
    # flight payloads may list chunk paths without quotes tags
    for raw in re.findall(r'(/_next/static/chunks/[^"\'\s]+\.js)', html or ""):
        src = urljoin(base + "/", raw.lstrip("/"))
        if src not in seen:
            seen.add(src)
            urls.append(src)
    return urls


def looks_like_cf_edge_block(status: int, body: str, headers: dict | None = None) -> bool:
    """True for Cloudflare *edge* interstitials / hard blocks (not application Turnstile)."""
    headers = headers or {}
    text = body or ""
    low = text.lower()
    server = str(headers.get("server") or headers.get("Server") or "").lower()
    if status in (403, 503) and ("cloudflare" in server or "cf-ray" in {k.lower() for k in headers}):
        if any(x in low for x in ("cf-browser-verification", "just a moment", "attention required", "cf-challenge", "turnstile")):
            return True
        if "cloudflare" in low and ("blocked" in low or "captcha" in low or "challenge" in low):
            return True
    if "cf-browser-verification" in low or ("just a moment" in low and "cloudflare" in low):
        return True
    return False


def extract_cookie_setter_url(text: str) -> str:
    if not text:
        return ""
    for m in re.finditer(r"\d+:T([0-9a-fA-F]+),", text):
        n = int(m.group(1), 16)
        payload = text[m.end() : m.end() + n]
        if payload.startswith("https://") and "set-cookie" in payload:
            return payload.strip()
    t = text.strip().strip('"')
    if t.startswith("https://") and "set-cookie" in t:
        return t.split()[0].strip('"')
    m = re.search(r"https://auth\.[a-zA-Z0-9.-]+/set-cookie\?q=[A-Za-z0-9_\-\.%=]+", text)
    if m:
        return m.group(0)
    m = re.search(r"https://[a-zA-Z0-9.-]+/set-cookie\?q=[A-Za-z0-9_\-\.%=]+", text)
    return m.group(0) if m else ""


def parse_action_error(body: str) -> str:
    if not body:
        return ""
    # flight stream: 1:{"error":"..."}
    for line in body.splitlines():
        start = line.find("{")
        if start < 0:
            continue
        try:
            data = json.loads(line[start:])
        except Exception:
            continue
        if isinstance(data, dict) and data.get("error"):
            return str(data["error"])
    m = re.search(r'"error"\s*:\s*"([^"]+)"', body)
    return m.group(1) if m else ""


def is_turnstile_required(error: str) -> bool:
    """Application-level Turnstile requirement (server action), not edge 403."""
    low = (error or "").lower()
    if "turnstile" in low:
        return True
    # e.g. "Failed to verify Cloudflare turnstile token" / "cloudflare token"
    if "cloudflare" in low and "token" in low:
        return True
    return False


# ----------------------------- captcha APIs (optional) -----------------------------

def solve_turnstile_api(
    sitekey: str,
    page_url: str,
    timeout_s: float = 120,
) -> str:
    cap = os.getenv("CAPSOLVER_API_KEY", "").strip()
    yes = os.getenv("YESCAPTCHA_API_KEY", "").strip()
    if cap:
        tok = _capsolver_turnstile(cap, sitekey, page_url, timeout_s)
        if tok:
            return tok
    if yes:
        tok = _yescaptcha_turnstile(yes, sitekey, page_url, timeout_s)
        if tok:
            return tok
    return ""


def _capsolver_turnstile(api_key: str, sitekey: str, page_url: str, timeout_s: float) -> str:
    import urllib.request

    def post(path: str, body: dict) -> dict:
        req = urllib.request.Request(
            f"https://api.capsolver.com/{path}",
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode() or "{}")

    try:
        created = post(
            "createTask",
            {
                "clientKey": api_key,
                "task": {
                    "type": "AntiTurnstileTaskProxyLess",
                    "websiteURL": page_url,
                    "websiteKey": sitekey,
                },
            },
        )
    except Exception as e:
        log(f"[turnstile-api] capsolver create failed: {e}")
        return ""
    if created.get("errorId"):
        log(f"[turnstile-api] capsolver create error: {created}")
        return ""
    task_id = created.get("taskId") or ""
    if not task_id:
        return ""
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        time.sleep(2)
        try:
            res = post("getTaskResult", {"clientKey": api_key, "taskId": task_id})
        except Exception as e:
            log(f"[turnstile-api] capsolver poll failed: {e}")
            continue
        if res.get("status") == "ready":
            tok = ((res.get("solution") or {}).get("token") or "").strip()
            if tok:
                log(f"[turnstile-api] capsolver ok len={len(tok)}")
                return tok
            return ""
        if res.get("errorId"):
            log(f"[turnstile-api] capsolver result error: {res}")
            return ""
    log("[turnstile-api] capsolver timeout")
    return ""


def _yescaptcha_turnstile(api_key: str, sitekey: str, page_url: str, timeout_s: float) -> str:
    import urllib.request

    base = os.getenv("YESCAPTCHA_BASE", "https://api.yescaptcha.com").rstrip("/")

    def post(url: str, body: dict) -> dict:
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode() or "{}")

    try:
        created = post(
            f"{base}/createTask",
            {
                "clientKey": api_key,
                "task": {
                    "type": "TurnstileTaskProxyless",
                    "websiteURL": page_url,
                    "websiteKey": sitekey,
                },
            },
        )
    except Exception as e:
        log(f"[turnstile-api] yescaptcha create failed: {e}")
        return ""
    if created.get("errorId"):
        log(f"[turnstile-api] yescaptcha create error: {created}")
        return ""
    task_id = created.get("taskId") or ""
    if not task_id:
        return ""
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        time.sleep(2)
        try:
            res = post(f"{base}/getTaskResult", {"clientKey": api_key, "taskId": task_id})
        except Exception as e:
            log(f"[turnstile-api] yescaptcha poll failed: {e}")
            continue
        if res.get("status") == "ready":
            tok = ((res.get("solution") or {}).get("token") or "").strip()
            if tok:
                log(f"[turnstile-api] yescaptcha ok len={len(tok)}")
                return tok
            return ""
        if res.get("errorId"):
            log(f"[turnstile-api] yescaptcha result error: {res}")
            return ""
    log("[turnstile-api] yescaptcha timeout")
    return ""


# ----------------------------- mail provider -----------------------------

class CloudMail:
    def __init__(self, base_url: str, admin_email: str, admin_password: str, domains: list[str]) -> None:
        if std_requests is None:
            raise RuntimeError("CloudMail 需要 requests：pip install requests")
        self.base_url = base_url.rstrip("/")
        self.admin_email = admin_email
        self.admin_password = admin_password
        self.domains = domains
        self.public_token = ""
        self._account_ids: dict[str, Any] = {}
        self._session = std_requests.Session()
        self._session.headers.update({"Content-Type": "application/json"})

    def _data(self, resp: Any, action: str) -> Any:
        resp.raise_for_status()
        payload = resp.json()
        if not isinstance(payload, dict) or payload.get("code") != 200:
            detail = payload.get("message", str(payload)) if isinstance(payload, dict) else str(payload)
            raise RuntimeError(f"CloudMail {action} failed: {detail}")
        return payload.get("data")

    def gen_token(self, force_refresh: bool = False) -> str:
        if self.public_token and not force_refresh:
            return self.public_token
        resp = self._session.post(
            f"{self.base_url}/api/public/genToken",
            json={"email": self.admin_email, "password": self.admin_password},
            timeout=30,
        )
        data = self._data(resp, "genToken")
        token = data.get("token") if isinstance(data, dict) else None
        if not token:
            raise RuntimeError("CloudMail genToken missing token")
        self.public_token = token
        return token

    def create_mailbox(self) -> tuple[str, str]:
        domain = random.choice(self.domains)
        local = "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
        address = f"{local}@{domain}"
        login = self._session.post(
            f"{self.base_url}/api/login",
            json={"email": self.admin_email, "password": self.admin_password},
            timeout=30,
        )
        jwt = self._data(login, "login").get("token")
        if not jwt:
            raise RuntimeError("CloudMail login missing token")
        resp = self._session.post(
            f"{self.base_url}/api/account/add",
            json={"email": address, "token": ""},
            headers={"Authorization": jwt},
            timeout=30,
        )
        data = self._data(resp, "add account")
        if isinstance(data, dict):
            account_id = data.get("accountId") or data.get("id")
            if account_id is not None:
                self._account_ids[address] = account_id
        return address, secrets.token_urlsafe(10)

    def list_emails(self, to_email: str, size: int = 20) -> list[dict]:
        token = self.gen_token()
        payload = {"size": size, "toEmail": to_email}
        resp = self._session.post(
            f"{self.base_url}/api/public/emailList",
            json=payload,
            headers={"Authorization": token},
            timeout=30,
        )
        try:
            data = self._data(resp, "emailList")
        except RuntimeError as exc:
            if "token" in str(exc).lower() or "401" in str(exc):
                token = self.gen_token(force_refresh=True)
                resp = self._session.post(
                    f"{self.base_url}/api/public/emailList",
                    json=payload,
                    headers={"Authorization": token},
                    timeout=30,
                )
                data = self._data(resp, "emailList")
            else:
                raise
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
        if isinstance(data, dict):
            for key in ("list", "rows", "emails", "records"):
                items = data.get(key)
                if isinstance(items, list):
                    return [x for x in items if isinstance(x, dict)]
        return []

    def wait_verification_code(
        self,
        email: str,
        timeout: float = 180,
        poll_interval: float = 2.0,
        on_log: Callable[[str], None] | None = None,
    ) -> str:
        deadline = time.time() + timeout
        self.gen_token()
        while time.time() < deadline:
            try:
                messages = self.list_emails(email)
            except Exception as exc:
                if on_log:
                    on_log(f"mail poll failed: {exc}")
                time.sleep(poll_interval)
                continue
            if on_log:
                on_log(f"mail count={len(messages)}")
            for msg in messages:
                subject = str(msg.get("subject") or "")
                content = "\n".join(
                    str(msg.get(k) or "")
                    for k in ("content", "text", "textContent", "body", "snippet", "html")
                )
                code = extract_verification_code(content, subject)
                if code:
                    return code
            time.sleep(poll_interval)
        raise TimeoutError(f"timeout waiting verification code for {email}")


# ----------------------------- xAI protocol client -----------------------------

@dataclass
class RegisterResult:
    ok: bool
    email: str = ""
    password: str = ""
    sso: str = ""
    cookie_setter_url: str = ""
    error: str = ""
    turnstile_used: bool = False
    next_action: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "email": self.email,
            "password": self.password,
            "sso": self.sso,
            "cookieSetterUrl": self.cookie_setter_url,
            "error": self.error,
            "turnstileUsed": self.turnstile_used,
            "nextAction": self.next_action,
        }


class XaiEmailRegister:
    def __init__(
        self,
        proxy: str = "",
        next_action: str = "",
        turnstile_sitekey: str = TURNSTILE_SITEKEY_DEFAULT,
        impersonate: str = "chrome120",
    ) -> None:
        self.s = cffi_requests.Session()
        if proxy:
            self.s.proxies = {"http": proxy, "https": proxy}
        self.proxy = proxy
        self.next_action = (next_action or os.getenv("GROK_NEXT_ACTION") or "").strip()
        self.turnstile_sitekey = turnstile_sitekey or TURNSTILE_SITEKEY_DEFAULT
        self.impersonate = impersonate
        self._warmed = False
        self._page_html = ""

    def warm(self, force: bool = False) -> None:
        if self._warmed and not force:
            return
        r = self.s.get(SIGNUP_URL, impersonate=self.impersonate, timeout=30)
        body = r.text or ""
        if looks_like_cf_edge_block(r.status_code, body, dict(r.headers)):
            raise RuntimeError(
                f"warmup blocked by Cloudflare edge (HTTP {r.status_code}). "
                "Use a residential/proxy IP or different fingerprint; this is not Turnstile."
            )
        if r.status_code >= 400:
            raise RuntimeError(f"warmup failed HTTP {r.status_code}: {body[:180]}")
        self._page_html = body

        # sitekey may appear in HTML or later chunks
        m = re.search(r'"sitekey"\s*:\s*"(0x[0-9A-Za-z_-]+)"', self._page_html)
        if m:
            self.turnstile_sitekey = m.group(1)
        m2 = re.search(r'(0x4[0-9A-Za-z_-]{10,})', self._page_html)
        if m2 and not m:
            self.turnstile_sitekey = m2.group(1)

        if not self.next_action:
            found = extract_next_action(self._page_html)
            sk = ""
            # Always scan live chunks; HTML almost never embeds the action id.
            disc_action, disc_sk = self._discover_from_chunks(self._page_html)
            if disc_action:
                found = disc_action
            if disc_sk:
                sk = disc_sk
            if sk:
                self.turnstile_sitekey = sk
            self.next_action = found or FALLBACK_NEXT_ACTION
            if found:
                log(f"[warm] next-action={found}")
            else:
                log(f"[warm] next-action fallback={self.next_action}")
        self._warmed = True

    def _discover_from_chunks(self, html: str) -> tuple[str, str]:
        """Scan signup JS chunks for server-action id + turnstile sitekey.

        Important: do not stop on the first createServerReference. Other actions
        (e.g. getSession) also use createServerReference and will 404/no-op if used
        for create-user.
        """
        urls = extract_script_urls(html)
        if not urls:
            return "", ""

        def score(u: str) -> tuple[int, int]:
            name = u.rsplit("/", 1)[-1]
            prefer = 0
            if "sign" in name or "auth" in name:
                prefer -= 10
            if "turbopack" in name or "polyfill" in name:
                prefer += 50
            return (prefer, len(name))

        urls = sorted(urls, key=score)
        best_action = ""
        best_score = -1
        found_sitekey = ""
        # Scan enough chunks; signup payload usually lives in a medium app chunk.
        for url in urls[:40]:
            try:
                cr = self.s.get(url, impersonate=self.impersonate, timeout=20)
            except Exception as exc:
                log(f"[warm] chunk fetch failed {url.rsplit('/',1)[-1]}: {exc}")
                continue
            if cr.status_code >= 400:
                continue
            body = cr.text or ""
            if not found_sitekey:
                m = re.search(r'"sitekey"\s*:\s*"(0x[0-9A-Za-z_-]+)"', body)
                if m:
                    found_sitekey = m.group(1)
                else:
                    m = re.search(r'(0x4[0-9A-Za-z_-]{10,})', body)
                    if m:
                        found_sitekey = m.group(1)

            # File-level signals are more reliable than a tight char window:
            # action id and payload fields can be far apart in minified chunks.
            file_score = 0
            if "createUserAndSessionRequest" in body:
                file_score += 120
            if "clearTextPassword" in body:
                file_score += 40
            if "turnstileToken" in body and "emailValidationCode" in body:
                file_score += 40
            elif "emailValidationCode" in body:
                file_score += 20
            if "tosAcceptedVersion" in body:
                file_score += 20

            local_best = ""
            local_score = -1
            for m in re.finditer(r'createServerReference\)?\("([0-9a-f]{20,})"', body):
                action = m.group(1)
                window = body[max(0, m.start() - 4000) : m.end() + 4000]
                sc = file_score
                # tiny local boosts
                if "emailValidationCode" in window or "createUserAndSessionRequest" in window:
                    sc += 30
                if '"default"' in body[m.start(): m.end() + 80]:
                    sc += 5
                # de-prioritize known non-signup action names if present nearby
                nearby = body[m.start(): m.end() + 120]
                if "getSession" in nearby:
                    sc -= 50
                if sc > local_score:
                    local_score = sc
                    local_best = action
            if not local_best:
                continue
            if local_score > best_score:
                best_score = local_score
                best_action = local_best
                if best_score >= 100:
                    log(f"[warm] discovered signup action from {url.rsplit('/',1)[-1]}")
                    # good enough; keep scanning only if we still need sitekey
                    if found_sitekey:
                        break
        if best_action and best_score < 100:
            log(f"[warm] best action score={best_score} (may not be signup-scoped)")
        return best_action, found_sitekey

    def _grpc(self, method: str, msg: bytes) -> bytes:
        self.warm()
        r = self.s.post(
            f"{GRPC_BASE}/{method}",
            data=grpc_frame(msg),
            headers={
                "content-type": "application/grpc-web+proto",
                "x-grpc-web": "1",
                "x-user-agent": "connect-es/2.1.1",
                "origin": ACCOUNTS_BASE,
                "referer": SIGNUP_URL,
            },
            impersonate=self.impersonate,
            timeout=30,
        )
        data, trailers = parse_grpc_web(r.content or b"")
        # merge header trailers
        for k in ("grpc-status", "grpc-message"):
            if r.headers.get(k) and k not in trailers:
                trailers[k] = r.headers.get(k) or ""
        status = trailers.get("grpc-status", "0" if r.status_code < 400 else "2")
        if r.status_code >= 400 or (status not in ("", "0")):
            from urllib.parse import unquote

            message = unquote(trailers.get("grpc-message", "") or "")
            raise RuntimeError(f"{method} http={r.status_code} grpc={status} {message}".strip())
        return data

    def create_email_code(self, email: str, castle_request_token: str = "") -> None:
        # CreateEmailValidationCodeRequest { email=1, castle_request_token=3 optional }
        msg = pb_str(1, email)
        if castle_request_token:
            msg += pb_str(3, castle_request_token)
        self._grpc("CreateEmailValidationCode", msg)

    def verify_email_code(self, email: str, code: str) -> None:
        clean = str(code or "").replace("-", "").strip()
        # VerifyEmailValidationCodeRequest { email=1, email_validation_code=2 }
        self._grpc("VerifyEmailValidationCode", pb_str(1, email) + pb_str(2, clean))

    def create_user(
        self,
        email: str,
        code: str,
        given: str,
        family: str,
        password: str,
        turnstile_token: str = "",
        castle_request_token: str = "",
    ) -> tuple[str, str]:
        """Returns (cookie_setter_url, raw_body). cookie_setter_url may be empty if SSO already set."""
        self.warm()
        if not self.next_action:
            self.next_action = FALLBACK_NEXT_ACTION
        payload = [
            {
                "emailValidationCode": str(code or "").replace("-", "").strip(),
                "createUserAndSessionRequest": {
                    "email": email,
                    "givenName": given,
                    "familyName": family,
                    "clearTextPassword": password,
                    "tosAcceptedVersion": 1,
                },
                "turnstileToken": turnstile_token or "",
                "conversionId": str(uuid.uuid4()),
                "castleRequestToken": castle_request_token or "",
            }
        ]
        r = self.s.post(
            SIGNUP_URL,
            data=json.dumps(payload, separators=(",", ":")),
            headers={
                "content-type": "text/plain;charset=UTF-8",
                "accept": "text/x-component",
                "next-action": self.next_action,
                "origin": ACCOUNTS_BASE,
                "referer": SIGNUP_URL,
            },
            impersonate=self.impersonate,
            timeout=45,
            allow_redirects=False,
        )
        body = r.text or ""
        if looks_like_cf_edge_block(r.status_code, body, dict(r.headers)):
            raise RuntimeError(
                f"createUser blocked by Cloudflare edge (HTTP {r.status_code}). "
                "This is edge protection, not application Turnstile."
            )

        def _action_not_found(status: int, headers: dict, text_body: str) -> bool:
            low = (text_body or "").lower()
            if str(headers.get("x-nextjs-action-not-found") or "").lower() in {"1", "true"}:
                return True
            if "unrecognized action" in low or "action not found" in low or "server action not found" in low:
                return True
            # Next may return plain 404 body: "Server action not found."
            if status == 404 and "action" in low:
                return True
            return False

        # next-action may rotate; rediscover once and retry
        if _action_not_found(r.status_code, dict(r.headers), body):
            old = self.next_action
            log(f"[createUser] next-action not found ({old[:16]}...); rediscovering...")
            self.next_action = ""
            self.warm(force=True)
            if not self.next_action or self.next_action == old:
                raise RuntimeError(
                    f"createUser next-action unrecognized: {old or '(empty)'}. "
                    f"HTTP {r.status_code}: {body[:180]}"
                )
            log(f"[createUser] next-action rotated {old[:16]}... -> {self.next_action[:16]}...")
            r = self.s.post(
                SIGNUP_URL,
                data=json.dumps(payload, separators=(",", ":")),
                headers={
                    "content-type": "text/plain;charset=UTF-8",
                    "accept": "text/x-component",
                    "next-action": self.next_action,
                    "origin": ACCOUNTS_BASE,
                    "referer": SIGNUP_URL,
                },
                impersonate=self.impersonate,
                timeout=45,
                allow_redirects=False,
            )
            body = r.text or ""
            if looks_like_cf_edge_block(r.status_code, body, dict(r.headers)):
                raise RuntimeError(
                    f"createUser blocked by Cloudflare edge (HTTP {r.status_code}). "
                    "This is edge protection, not application Turnstile."
                )
            if _action_not_found(r.status_code, dict(r.headers), body):
                raise RuntimeError(
                    f"createUser still next-action not found after rediscover: {self.next_action}. "
                    f"HTTP {r.status_code}: {body[:180]}"
                )

        if r.status_code >= 400:
            raise RuntimeError(f"createUser HTTP {r.status_code}: {body[:240]}")
        err = parse_action_error(body)
        if err:
            raise RuntimeError(err)
        return extract_cookie_setter_url(body), body

    def follow_cookies(self, cookie_url: str) -> str:
        if cookie_url:
            url = cookie_url.strip()
            for _ in range(16):
                r = self.s.get(url, impersonate=self.impersonate, timeout=25, allow_redirects=False)
                sso = self.get_sso()
                if sso:
                    loc = r.headers.get("location") or r.headers.get("Location") or ""
                    if loc:
                        nxt = urljoin(url, loc) if loc.startswith("/") else loc
                        if "accounts.x.ai" in nxt and "set-cookie" not in nxt:
                            try:
                                self.s.get(nxt, impersonate=self.impersonate, timeout=20, allow_redirects=True)
                            except Exception:
                                pass
                    return sso
                loc = r.headers.get("location") or r.headers.get("Location") or ""
                if not loc:
                    break
                url = urljoin(url, loc) if loc.startswith("/") else loc
        return self.get_sso()

    def get_sso(self) -> str:
        jar = getattr(self.s.cookies, "jar", None)
        cookies = list(jar) if jar is not None else []
        for c in cookies:
            name = getattr(c, "name", "")
            value = str(getattr(c, "value", "") or "")
            domain = str(getattr(c, "domain", "") or "").lstrip(".")
            if name == "sso" and value.startswith("eyJ") and (domain == "x.ai" or domain.endswith(".x.ai")):
                return value
        for c in cookies:
            name = getattr(c, "name", "")
            value = str(getattr(c, "value", "") or "")
            if name == "sso" and value.startswith("eyJ"):
                return value
        try:
            return self.s.cookies.get("sso") or ""
        except Exception:
            return ""

    def resolve_turnstile_if_needed(
        self,
        prefer_token: str = "",
        allow_api: bool = False,
        allow_browser: bool = True,
        browser_proxy: str = "",
        cdp: str = "",
        no_browser: bool = False,
        force_new_chrome: bool = False,
        timeout_s: float = 180,
        harvest_email: str = "",
        harvest_code: str = "",
        fetch_code=None,
        given: str = "",
        family: str = "",
        password: str = "",
        interactive: bool = True,
    ) -> str:
        if prefer_token.strip():
            return prefer_token.strip()

        # Self-solve first: local Chrome (optionally with protocol gRPC bridge).
        # Captcha platforms are opt-in only when allow_api=True AND key is set.
        if allow_browser and not no_browser:
            try:
                if not harvest_email:
                    log(
                        "[turnstile] browser path needs a harvest mailbox "
                        "(full UI to credentials). Missing harvest_email."
                    )
                else:
                    log(
                        f"[turnstile] self-solve via local Chrome harvest={harvest_email}"
                    )

                def bridge_fetch(url: str, method: str, headers: dict, body: bytes):
                    """Replay browser gRPC with curl_cffi so CF edge won't 403."""
                    try:
                        self.warm()
                    except Exception:
                        pass
                    # Forward browser headers that matter for grpc-web / RSC / next-action
                    out_h = {}
                    for k, v in (headers or {}).items():
                        lk = str(k).lower()
                        if lk in ("host", "content-length", "connection", "keep-alive"):
                            continue
                        out_h[k] = v
                    out_h.setdefault("origin", ACCOUNTS_BASE)
                    out_h.setdefault("referer", SIGNUP_URL)
                    if "auth_mgmt.AuthManagement" in (url or ""):
                        out_h["content-type"] = (
                            headers.get("content-type")
                            or headers.get("Content-Type")
                            or "application/grpc-web+proto"
                        )
                        out_h["x-grpc-web"] = headers.get("x-grpc-web") or "1"
                        out_h.setdefault("x-user-agent", "connect-es/2.1.1")
                        out_h.setdefault("accept", "*/*")
                    # Prefer browser-sent content-type for grpc-web framing compatibility
                    try:
                        r = self.s.request(
                            method or "POST",
                            url,
                            data=body or b"",
                            headers=out_h,
                            impersonate=self.impersonate,
                            timeout=45,
                        )
                    except Exception as e:
                        log(f"[bridge] curl_cffi err: {e}; retry once")
                        # recreate session once
                        self.s = cffi_requests.Session()
                        if self.proxy:
                            self.s.proxies = {"http": self.proxy, "https": self.proxy}
                        self.warm()
                        r = self.s.request(
                            method or "POST",
                            url,
                            data=body or b"",
                            headers=out_h,
                            impersonate=self.impersonate,
                            timeout=45,
                        )
                    return int(r.status_code), dict(r.headers), r.content or b""

                tok = solve_turnstile_browser(
                    cdp=cdp or os.getenv("GROK_CDP_URL", "http://127.0.0.1:9333"),
                    browser_proxy=browser_proxy or "",
                    force_new_chrome=force_new_chrome,
                    timeout_s=timeout_s,
                    email=harvest_email,
                    code=harvest_code,
                    fetch_code=fetch_code,
                    bridge_fetch=bridge_fetch,
                    given=given or "Ada",
                    family=family or "Lovelace",
                    password=password or "",
                    interactive=interactive,
                    try_inject=True,
                    log=log,
                )
                if tok:
                    log(f"[turnstile] browser token len={len(tok)}")
                    return tok
                log("[turnstile] browser returned empty token")
            except Exception as exc:
                log(f"[turnstile] browser solve failed: {exc}")
        return ""

    def register(
        self,
        email: str,
        code: str,
        *,
        given: str = "",
        family: str = "",
        password: str = "",
        turnstile_token: str = "",
        force_turnstile: bool = False,
        allow_browser: bool = True,
        browser_proxy: str = "",
        cdp: str = "",
        no_browser: bool = False,
        force_new_chrome: bool = False,
        harvest_email: str = "",
        harvest_code: str = "",
        fetch_code=None,
        interactive: bool = True,
        turnstile_timeout_s: float = 120,
    ) -> RegisterResult:
        given, family, password = build_profile(given, family, password)
        result = RegisterResult(ok=False, email=email, password=password)
        try:
            self.warm()
            result.next_action = self.next_action
            # verify is idempotent-ish; always verify before create
            self.verify_email_code(email, code)

            token = turnstile_token.strip()
            # Default: do NOT assume Turnstile is present.
            # force_turnstile is opt-in for environments that always require it.
            if force_turnstile and not token:
                log("[turnstile] force mode: solving before create-user")
                token = self.resolve_turnstile_if_needed(
                    allow_api=bool(os.getenv("CAPSOLVER_API_KEY") or os.getenv("YESCAPTCHA_API_KEY") or os.getenv("GROK_ALLOW_CAPTCHA_API")),
                    allow_browser=allow_browser,
                    browser_proxy=browser_proxy,
                    cdp=cdp,
                    no_browser=no_browser,
                    force_new_chrome=force_new_chrome,
                    timeout_s=turnstile_timeout_s,
                    harvest_email=harvest_email,
                    harvest_code=harvest_code,
                    fetch_code=fetch_code,
                    given=given,
                    family=family,
                    password=password,
                    interactive=interactive,
                )
                result.turnstile_used = bool(token)
                if not token:
                    raise RuntimeError(
                        "--force-turnstile set, but no token / captcha key / browser solver success"
                    )

            # Attempt 1: empty token (or user-provided token). Works when CF is off.
            if token:
                log("[createUser] submitting with provided/forced turnstile token")
            else:
                log("[createUser] submitting without turnstile token (CF-optional path)")
            try:
                cookie_url, _ = self.create_user(email, code, given, family, password, token)
            except RuntimeError as exc:
                err = str(exc)
                if is_turnstile_required(err) and not token:
                    log("[turnstile] server required token; resolving only because create-user asked for it...")
                    token = self.resolve_turnstile_if_needed(
                        prefer_token=turnstile_token,
                        allow_api=bool(os.getenv("CAPSOLVER_API_KEY") or os.getenv("YESCAPTCHA_API_KEY") or os.getenv("GROK_ALLOW_CAPTCHA_API")),
                        allow_browser=allow_browser,
                        browser_proxy=browser_proxy,
                        cdp=cdp,
                        no_browser=no_browser,
                        force_new_chrome=force_new_chrome,
                        timeout_s=turnstile_timeout_s,
                        harvest_email=harvest_email,
                        harvest_code=harvest_code,
                        fetch_code=fetch_code,
                        given=given,
                        family=family,
                        password=password,
                        interactive=interactive,
                    )
                    if not token:
                        raise RuntimeError(
                            "服务端要求 Cloudflare Turnstile，但未能取得 token。\n"
                            "当前策略：自己过验证（本机 Chrome + 协议 gRPC 桥），不走打码平台。\n"
                            "可尝试：\n"
                            "  1) 再跑一次 ./run.sh ，在弹出的 Chrome 里完成/点击 Turnstile\n"
                            "  2) --browser-proxy 住宅代理后重试\n"
                            "  3) 用日常 Chrome 开 remote debugging 后 --cdp http://127.0.0.1:9222\n"
                            "  4) 手动 --turnstile-token '...'\n"
                            "说明：若日志出现 browser-cf-403，表示浏览器直连 gRPC 被拦；"
                            "已用 curl_cffi 桥接时应能继续。若仍 Checking，需要更干净的浏览器指纹/出口。"
                        ) from exc
                    result.turnstile_used = True
                    cookie_url, _ = self.create_user(email, code, given, family, password, token)
                elif is_turnstile_required(err) and token:
                    # token present but rejected: one optional re-solve if API available
                    log("[turnstile] token rejected; trying one fresh solve if API available...")
                    fresh = self.resolve_turnstile_if_needed(
                        allow_api=bool(os.getenv("CAPSOLVER_API_KEY") or os.getenv("YESCAPTCHA_API_KEY") or os.getenv("GROK_ALLOW_CAPTCHA_API")),
                        allow_browser=allow_browser,
                        browser_proxy=browser_proxy,
                        cdp=cdp,
                        no_browser=no_browser,
                        force_new_chrome=force_new_chrome,
                        timeout_s=turnstile_timeout_s,
                        harvest_email=harvest_email,
                        harvest_code=harvest_code,
                        fetch_code=fetch_code,
                        given=given,
                        family=family,
                        password=password,
                        interactive=interactive,
                    )
                    if not fresh or fresh == token:
                        raise
                    result.turnstile_used = True
                    cookie_url, _ = self.create_user(email, code, given, family, password, fresh)
                else:
                    raise

            result.cookie_setter_url = cookie_url
            sso = self.follow_cookies(cookie_url)
            if not sso:
                try:
                    self.s.get(f"{ACCOUNTS_BASE}/", impersonate=self.impersonate, timeout=20, allow_redirects=True)
                except Exception:
                    pass
                sso = self.get_sso()
            if not sso or not sso.startswith("eyJ"):
                raise RuntimeError("建号后未拿到 sso cookie（可能 next-action 过期或 turnstile 无效）")
            result.sso = sso
            result.ok = True
            return result
        except Exception as exc:
            result.error = str(exc)
            return result


# ----------------------------- CLI -----------------------------

def cmd_send_code(args: argparse.Namespace) -> int:
    client = XaiEmailRegister(proxy=args.proxy, next_action=args.next_action)
    client.create_email_code(args.email, castle_request_token=args.castle_token or "")
    print(json.dumps({"ok": True, "email": args.email, "step": "createEmailValidationCode"}, ensure_ascii=False))
    return 0


def cmd_verify_code(args: argparse.Namespace) -> int:
    client = XaiEmailRegister(proxy=args.proxy, next_action=args.next_action)
    client.verify_email_code(args.email, args.code)
    print(json.dumps({"ok": True, "email": args.email, "step": "verifyEmailValidationCode"}, ensure_ascii=False))
    return 0


def _build_cfmail(args: argparse.Namespace) -> CFMail:
    domains = args.mail_domain or args.mail_domains or "icmk.top"
    return CFMail(
        base_url=args.mail_base or args.mail_url or "https://mailapi.icmk.top",
        admin_password=args.mail_password or "",
        domains=domains,
        auth_mode=getattr(args, "mail_auth_mode", None) or "x-admin-auth",
        custom_auth=getattr(args, "mail_custom_auth", None) or "",
        create_path=getattr(args, "mail_create_path", None) or "/admin/new_address",
        messages_path=getattr(args, "mail_messages_path", None) or "/api/mails",
    )


def _auto_mailbox_and_code(
    client: XaiEmailRegister,
    args: argparse.Namespace,
    email: str,
    code: str,
) -> tuple[str, str, str]:
    """Create mailbox + fetch OTP when missing.

    Prefer CFMail (mailapi.icmk.top style). CloudMail kept as legacy opt-in.
    Returns (email, code, mailbox_secret).
    """
    mailbox_secret = ""

    # Legacy CloudMail path
    if args.cloudmail:
        domains = [d.strip() for d in re.split(r"[,，\s]+", args.mail_domains or "") if d.strip()]
        if not args.mail_url or not args.mail_admin_email or not args.mail_password or not domains:
            raise SystemExit("CloudMail 需要 --mail-url / --mail-admin-email / --mail-password / --mail-domains")
        mail = CloudMail(args.mail_url, args.mail_admin_email, args.mail_password, domains)
        mail.gen_token()
        if not email:
            email, mailbox_secret = mail.create_mailbox()
            log(f"[mail/cloudmail] created {email}")
        if not code:
            client.create_email_code(email, castle_request_token=args.castle_token or "")
            log(f"[mail/cloudmail] code requested for {email}")
            code = mail.wait_verification_code(
                email,
                timeout=args.mail_timeout,
                on_log=lambda m: log(f"[mail] {m}"),
            )
            log(f"[mail/cloudmail] code={code}")
        return email, code, mailbox_secret

    # Default: CF temp-mail auto when email/code missing
    need_auto = (not email) or (not code)
    if not need_auto:
        return email, code, mailbox_secret

    if not args.mail_password and not os.getenv("CFMAIL_ADMIN_PASSWORD") and not os.getenv("CLOUDFLARE_API_KEY"):
        # still allow defaults from CLI defaults
        pass

    mail = _build_cfmail(args)
    log(
        f"[mail] cf temp-mail {mail.base_url} domains={','.join(mail.domains)} "
        f"auth={mail.auth_mode} create={mail.create_path}"
    )
    if not email:
        email, mailbox_secret = mail.create_mailbox()
        log(f"[mail] created {email}")
    if not code:
        client.create_email_code(email, castle_request_token=args.castle_token or "")
        log(f"[mail] code requested for {email}")
        code = mail.wait_verification_code(
            email,
            timeout=args.mail_timeout,
            log=lambda m: log(f"[mail] {m}"),
        )
        log(f"[mail] code={code}")
    return email, code, mailbox_secret


def cmd_register(args: argparse.Namespace) -> int:
    client = XaiEmailRegister(proxy=args.proxy, next_action=args.next_action)
    email = (args.email or "").strip()
    code = (args.code or "").strip()
    mailbox_password = ""

    email, code, mailbox_password = _auto_mailbox_and_code(client, args, email, code)

    if not email or not code:
        raise SystemExit(
            "需要 --email/--code；或不传则自动走 CFMail 建邮箱+收码 "
            "(默认 https://mailapi.icmk.top / icmk.top)"
        )

    harvest_email = ""
    harvest_code = ""
    fetch_code = None
    mail_for_harvest = None
    if not args.no_browser and not (args.turnstile_token or "").strip():
        try:
            mail_for_harvest = _build_cfmail(args)
        except Exception as exc:
            log(f"[turnstile] harvest mail client unavailable: {exc}")

    def _browser_prep() -> None:
        nonlocal harvest_email, fetch_code
        if harvest_email or mail_for_harvest is None:
            return
        he, _jwt = mail_for_harvest.create_mailbox()
        harvest_email = he
        log(f"[turnstile] harvest mailbox {harvest_email}")

        def _fetch(em: str) -> str:
            return mail_for_harvest.wait_verification_code(
                em,
                timeout=args.mail_timeout,
                log=lambda m: log(f"[mail/harvest] {m}"),
            )

        fetch_code = _fetch

    _orig_resolve = client.resolve_turnstile_if_needed

    def _resolve_wrapped(*a, **kw):
        if not kw.get("harvest_email") and not args.no_browser:
            _browser_prep()
            kw["harvest_email"] = harvest_email
            kw["fetch_code"] = fetch_code
            kw.setdefault("interactive", not getattr(args, "no_interactive", False))
            kw.setdefault("timeout_s", float(getattr(args, "turnstile_timeout", 120)))
        return _orig_resolve(*a, **kw)

    client.resolve_turnstile_if_needed = _resolve_wrapped  # type: ignore

    result = client.register(
        email,
        code,
        given=args.given,
        family=args.family,
        password=args.password,
        turnstile_token=args.turnstile_token,
        force_turnstile=args.force_turnstile,
        allow_browser=not args.no_browser,
        browser_proxy=args.browser_proxy,
        cdp=args.cdp,
        no_browser=args.no_browser,
        force_new_chrome=args.force_new_chrome,
        harvest_email=harvest_email,
        harvest_code=harvest_code,
        fetch_code=fetch_code,
        interactive=not getattr(args, "no_interactive", False),
        turnstile_timeout_s=float(getattr(args, "turnstile_timeout", 120)),
    )
    payload = result.as_dict()
    if mailbox_password:
        # CFMail returns jwt here; CloudMail returns random password
        payload["mailboxSecret"] = mailbox_password
        payload["mailboxPassword"] = mailbox_password
    print(json.dumps(payload, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0 if result.ok else 2


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Headless Grok email registration (protocol-only)")
    p.add_argument("--proxy", default=os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY") or "", help="HTTP(S) proxy")
    p.add_argument("--next-action", default=os.getenv("GROK_NEXT_ACTION", ""), help="Next.js server action id")
    p.add_argument("--pretty", action="store_true")

    sub = p.add_subparsers(dest="cmd")

    # default register via parent args too
    p.add_argument("--email", default="")
    p.add_argument("--code", default="")
    p.add_argument("--password", default="")
    p.add_argument("--given", default="")
    p.add_argument("--family", default="")
    p.add_argument("--turnstile-token", default=os.getenv("GROK_TURNSTILE_TOKEN", ""))
    p.add_argument(
        "--force-turnstile",
        action="store_true",
        help="强制先解 Turnstile（默认：先空 token 提交，失败后再解）",
    )
    p.add_argument(
        "--no-browser",
        action="store_true",
        help="禁止本机 Chrome 解 Turnstile（仅 token/打码）",
    )
    p.add_argument(
        "--browser-proxy",
        default=os.getenv("GROK_BROWSER_PROXY", ""),
        help="仅给 Chrome 解 Turnstile 用的代理",
    )
    p.add_argument(
        "--cdp",
        default=os.getenv("GROK_CDP_URL", "http://127.0.0.1:9333"),
        help="Chrome CDP 地址，默认 http://127.0.0.1:9333",
    )
    p.add_argument(
        "--force-new-chrome",
        action="store_true",
        help="强制新起 Chrome，不复用已有 CDP",
    )
    p.add_argument(
        "--no-interactive",
        action="store_true",
        help="Turnstile 卡住时不等待人工在 Chrome 窗口点击",
    )
    p.add_argument(
        "--turnstile-timeout",
        type=float,
        default=float(os.getenv("GROK_TURNSTILE_TIMEOUT", "180")),
        help="浏览器解 Turnstile 超时秒数（默认 120，交互模式可再延长）",
    )
    p.add_argument("--castle-token", default="")
    # ---- CF temp-mail (mailapi.icmk.top) defaults; override via env/flags ----
    p.add_argument(
        "--mail-base",
        default=os.getenv("CFMAIL_BASE", os.getenv("CLOUDFLARE_API_BASE", "https://mailapi.icmk.top")),
        help="CF temp-mail API base，默认 https://mailapi.icmk.top",
    )
    p.add_argument(
        "--mail-password",
        default=os.getenv(
            "CFMAIL_ADMIN_PASSWORD",
            os.getenv("CLOUDFLARE_API_KEY", os.getenv("CLOUDMAIL_PASSWORD", "2434981942a@A")),
        ),
        help="CF temp-mail 管理员密钥（x-admin-auth）",
    )
    p.add_argument(
        "--mail-domain",
        default=os.getenv(
            "CFMAIL_DOMAINS",
            os.getenv("CLOUDFLARE_DOMAINS", os.getenv("CLOUDFLARE_DOMAIN", "icmk.top")),
        ),
        help="收信域名，默认 icmk.top（逗号分隔可轮换）",
    )
    p.add_argument("--mail-auth-mode", default=os.getenv("CFMAIL_AUTH_MODE", "x-admin-auth"))
    p.add_argument("--mail-custom-auth", default=os.getenv("CFMAIL_CUSTOM_AUTH", ""))
    p.add_argument("--mail-create-path", default=os.getenv("CFMAIL_CREATE_PATH", "/admin/new_address"))
    p.add_argument("--mail-messages-path", default=os.getenv("CFMAIL_MESSAGES_PATH", "/api/mails"))
    p.add_argument("--mail-timeout", type=float, default=float(os.getenv("CFMAIL_TIMEOUT", "180")))
    # legacy CloudMail
    p.add_argument("--cloudmail", action="store_true", help="改用旧 CloudMail API（非默认）")
    p.add_argument("--mail-url", default=os.getenv("CLOUDMAIL_URL", ""), help="兼容旧参数；CFMail 请用 --mail-base")
    p.add_argument("--mail-admin-email", default=os.getenv("CLOUDMAIL_ADMIN_EMAIL", ""))
    p.add_argument("--mail-domains", default=os.getenv("CLOUDMAIL_DOMAINS", ""), help="兼容旧参数；CFMail 请用 --mail-domain")

    s = sub.add_parser("send-code", help="仅发送邮箱验证码")
    s.add_argument("--email", required=True)
    s.add_argument("--castle-token", default="")
    s.set_defaults(func=cmd_send_code)

    v = sub.add_parser("verify-code", help="仅校验邮箱验证码")
    v.add_argument("--email", required=True)
    v.add_argument("--code", required=True)
    v.set_defaults(func=cmd_verify_code)

    r = sub.add_parser("register", help="完成注册（默认）")
    r.set_defaults(func=cmd_register)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    if func is None:
        # default to register with top-level flags
        args.cmd = "register"
        return cmd_register(args)
    return func(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
