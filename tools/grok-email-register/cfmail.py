#!/usr/bin/env python3
"""Cloudflare temp-mail client for register_grok_protocol.py.

Tested against:
  base: https://mailapi.icmk.top
  auth: x-admin-auth
  path: /admin/new_address
  mails: /api/mails
"""
from __future__ import annotations

import re
import secrets
import string
import time
from typing import Any, Callable

import requests


def _extract_verification_code(text: str, subject: str = "") -> str:
    if subject:
        match = re.search(r"^([A-Z0-9]{3}-[A-Z0-9]{3})\s+xAI", subject, re.IGNORECASE)
        if match:
            return match.group(1)
        match = re.search(r"\b([A-Z0-9]{3}-[A-Z0-9]{3})\b", subject, re.IGNORECASE)
        if match:
            return match.group(1).upper()
    match = re.search(r"\b([A-Z0-9]{3}-[A-Z0-9]{3})\b", text, re.IGNORECASE)
    if match:
        return match.group(1).upper()
    for pattern in (
        r"verification\s+code[:\s]+(\d{4,8})",
        r"your\s+code[:\s]+(\d{4,8})",
        r"confirm(?:ation)?\s+code[:\s]+(\d{4,8})",
    ):
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1)
    match = re.search(r"\b([A-Z0-9]{6})\b", text, re.IGNORECASE)
    if match:
        return match.group(1).upper()
    return ""


def _pick_list_payload(data: Any) -> list[dict]:
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in ("results", "hydra:member", "data", "messages", "list", "rows", "records"):
            items = data.get(key)
            if isinstance(items, list):
                return [x for x in items if isinstance(x, dict)]
            if isinstance(items, dict):
                nested = items.get("messages")
                if isinstance(nested, list):
                    return [x for x in nested if isinstance(x, dict)]
    return []


class CFMail:
    """Drop-in mailbox backend used by register_one()."""

    def __init__(
        self,
        base_url: str,
        admin_password: str,
        domains: str | list[str],
        *,
        auth_mode: str = "x-admin-auth",
        custom_auth: str = "",
        create_path: str = "/admin/new_address",
        messages_path: str = "/api/mails",
        detail_path: str = "/api/mail",
    ) -> None:
        self.base_url = (base_url or "").strip().rstrip("/")
        self.admin_password = admin_password or ""
        self.auth_mode = (auth_mode or "x-admin-auth").strip().lower()
        self.custom_auth = (custom_auth or "").strip()
        self.create_path = self._norm_path(create_path, "/admin/new_address")
        self.messages_path = self._norm_path(messages_path, "/api/mails")
        self.detail_path = self._norm_path(detail_path, "/api/mail")
        if isinstance(domains, str):
            self.domains = [d.strip() for d in re.split(r"[,，\s]+", domains) if d.strip()]
        else:
            self.domains = [str(d).strip() for d in (domains or []) if str(d).strip()]
        if not self.base_url:
            raise ValueError("CFMail base_url is empty")
        if not self.admin_password:
            raise ValueError("CFMail admin password is empty")
        if not self.domains:
            raise ValueError("CFMail domains are empty")
        self._domain_index = 0
        self._tokens: dict[str, str] = {}
        self._session = requests.Session()

    @staticmethod
    def _norm_path(path: str, default: str) -> str:
        raw = (path or default).strip() or default
        return raw if raw.startswith("/") else f"/{raw}"

    def _next_domain(self) -> str:
        domain = self.domains[self._domain_index % len(self.domains)]
        self._domain_index += 1
        return domain

    def _auth_headers(self, *, content_type: bool = False, bearer: str = "") -> dict[str, str]:
        headers: dict[str, str] = {}
        if content_type:
            headers["Content-Type"] = "application/json"
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        key = self.admin_password
        mode = self.auth_mode
        if key:
            if mode == "x-api-key":
                headers["X-API-Key"] = key
            elif mode == "bearer":
                headers["Authorization"] = f"Bearer {key}"
            elif mode == "none":
                pass
            else:
                # default / x-admin-auth
                headers["x-admin-auth"] = key
        if self.custom_auth:
            headers["x-custom-auth"] = self.custom_auth
        return headers

    def gen_token(self) -> str:
        # Compatibility hook for old CloudMail flow. CF uses per-mailbox JWT.
        return "cfmail"

    def create_mailbox(self) -> tuple[str, str]:
        domain = self._next_domain()
        name = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(10))
        is_admin = self.create_path.rstrip("/").lower() == "/admin/new_address"
        if is_admin:
            payload = {"name": name, "enablePrefix": True, "domain": domain}
            headers = self._auth_headers(content_type=True)
        else:
            payload = {"domain": domain}
            headers = self._auth_headers(content_type=True)
            # anonymous new_address usually only needs custom-auth, not admin auth
            if self.auth_mode == "x-admin-auth" and "x-admin-auth" in headers and not self.custom_auth:
                # still keep admin header if site requires it for non-admin path
                pass
        resp = self._session.post(
            f"{self.base_url}{self.create_path}",
            json=payload,
            headers=headers,
            timeout=30,
        )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"CFMail create failed HTTP {resp.status_code}: {(resp.text or '')[:300]}"
            )
        try:
            data = resp.json()
        except Exception as exc:
            raise RuntimeError(f"CFMail create returned non-JSON: {(resp.text or '')[:300]}") from exc
        address = str((data or {}).get("address") or "").strip()
        jwt = str((data or {}).get("jwt") or "").strip()
        if not address or not jwt:
            raise RuntimeError(f"CFMail create missing address/jwt: {data}")
        self._tokens[address.lower()] = jwt
        # keep second value for protocol script compatibility
        return address, jwt

    def list_emails(self, email: str = "", size: int = 20) -> list[dict]:
        jwt = self._tokens.get((email or "").lower(), "")
        if not jwt:
            raise RuntimeError(f"CFMail missing jwt for {email}")
        resp = self._session.get(
            f"{self.base_url}{self.messages_path}",
            params={"limit": size, "offset": 0},
            headers=self._auth_headers(bearer=jwt),
            timeout=30,
        )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"CFMail list failed HTTP {resp.status_code}: {(resp.text or '')[:300]}"
            )
        try:
            data = resp.json()
        except Exception as exc:
            raise RuntimeError(f"CFMail list returned non-JSON: {(resp.text or '')[:300]}") from exc
        return _pick_list_payload(data)

    def get_message_detail(self, email: str, message_id: str) -> dict:
        jwt = self._tokens.get((email or "").lower(), "")
        if not jwt:
            return {}
        candidates = [
            f"{self.base_url}{self.detail_path}/{message_id}",
            f"{self.base_url}/api/mail/{message_id}",
            f"{self.base_url}/api/mails/{message_id}",
            f"{self.base_url}{self.messages_path}/{message_id}",
        ]
        headers = self._auth_headers(bearer=jwt)
        for url in candidates:
            try:
                resp = self._session.get(url, headers=headers, timeout=20)
                if resp.status_code >= 400:
                    continue
                data = resp.json()
                if isinstance(data, dict) and isinstance(data.get("data"), dict):
                    return data["data"]
                if isinstance(data, dict):
                    return data
            except Exception:
                continue
        return {}

    def wait_verification_code(
        self,
        email: str,
        timeout: float = 180,
        poll_interval: float = 2.0,
        log: Callable[[str], None] | None = None,
        on_log: Callable[[str], None] | None = None,
    ) -> str:
        log_fn = log or on_log
        deadline = time.time() + timeout
        seen: dict[str, int] = {}
        while time.time() < deadline:
            try:
                messages = self.list_emails(email=email, size=20)
            except Exception as exc:
                if log_fn:
                    log_fn(f"mail poll failed: {exc}")
                time.sleep(poll_interval)
                continue
            if log_fn:
                log_fn(f"mail count={len(messages)}")
            for msg in messages:
                msg_id = str(msg.get("id") or msg.get("msgid") or msg.get("mail_id") or msg.get("messageId") or "")
                if not msg_id:
                    continue
                attempt = int(seen.get(msg_id, 0))
                if attempt >= 5:
                    continue
                seen[msg_id] = attempt + 1

                # Prefer target-address match when available.
                recipients = [
                    str(t.get("address", "")).lower()
                    for t in (msg.get("to") or [])
                    if isinstance(t, dict)
                ]
                msg_addr = str(msg.get("address", "") or "").lower()
                if recipients and email.lower() not in recipients:
                    continue
                if msg_addr and msg_addr != email.lower():
                    continue

                parts: list[str] = []
                for field in ("text", "raw", "content", "intro", "body", "snippet"):
                    value = msg.get(field)
                    if isinstance(value, str) and value.strip():
                        parts.append(value)
                html_val = msg.get("html")
                if isinstance(html_val, str):
                    html_val = [html_val]
                if isinstance(html_val, list):
                    parts.extend(re.sub(r"<[^>]+>", " ", h) for h in html_val if isinstance(h, str))
                subject = str(msg.get("subject", "") or "")
                combined = "\n".join(parts)

                detail = self.get_message_detail(email, msg_id)
                if detail:
                    for field in ("text", "raw", "content", "intro", "body", "snippet"):
                        value = detail.get(field)
                        if isinstance(value, str) and value.strip():
                            combined += "\n" + value
                    html2 = detail.get("html")
                    if isinstance(html2, str):
                        html2 = [html2]
                    if isinstance(html2, list):
                        for h in html2:
                            if isinstance(h, str):
                                combined += "\n" + re.sub(r"<[^>]+>", " ", h)
                    if not subject:
                        subject = str(detail.get("subject", "") or "")

                code = _extract_verification_code(combined, subject)
                if code:
                    if log:
                        log(f"got code={code}")
                    return code
                if log_fn:
                    log_fn(f"mail parsed no code id={msg_id} attempt={seen[msg_id]}")
            time.sleep(poll_interval)
        raise TimeoutError(f"CFMail no verification code within {timeout}s for {email}")
