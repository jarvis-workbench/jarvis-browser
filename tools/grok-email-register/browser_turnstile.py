#!/usr/bin/env python3
"""Local Chrome helper: obtain Cloudflare Turnstile token for accounts.x.ai.

Registration itself stays protocol-only. When the server requires Turnstile,
this module briefly drives a real headed Chrome session just far enough to
mount the widget and read cf-turnstile-response.

Important (live recon 2026-07-24):
- Turnstile only mounts on the *credentials* step ("Complete your sign up").
- Reaching that step requires: cookie banner → Sign up with email → email
  → Sign up → email code → Confirm email → name/password form.
- Under Playwright/CDP automation the widget often stays on
  "Checking your Browser…". Clicking during Checking worsens it (failure_retry).
- Dummy-email-only pages never mount the widget (returns no-token).
"""
from __future__ import annotations

import os
import queue
import random
import re
import secrets
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

ACCOUNTS_BASE = "https://accounts.x.ai"
SIGNUP_URL = f"{ACCOUNTS_BASE}/sign-up?redirect=grok-com"
DEFAULT_CDP = os.getenv("GROK_CDP_URL", "http://127.0.0.1:9333")
TURNSTILE_SITEKEY = os.getenv("GROK_TURNSTILE_SITEKEY", "0x4AAAAAAAhr9JGVDZbrZOo0")
CHROME_PROFILE = Path(
    os.getenv(
        "GROK_CHROME_PROFILE",
        str(Path(__file__).resolve().parent / "chrome-profile"),
    )
)
LOG_DIR = Path(os.getenv("GROK_LOG_DIR", str(Path(__file__).resolve().parent / "logs")))
# Keep stealth minimal. Heavy fingerprint spoofing made Checking permanent here.
STEALTH_JS = "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"


FetchCodeFn = Callable[[str], str]
LogFn = Callable[[str], None]
# (url, method, headers, body) -> (status, response_headers, body_bytes)
BridgeFetchFn = Callable[[str, str, dict, bytes], tuple[int, dict, bytes]]


def _log(msg: str, log: LogFn | None = None) -> None:
    if log:
        log(msg)
    else:
        print(msg, flush=True)


def _cdp_port(cdp_url: str) -> int:
    u = urlparse(cdp_url)
    if u.port:
        return int(u.port)
    return 9222


def _normalize_proxy(proxy: str) -> str:
    p = (proxy or "").strip()
    if not p:
        return ""
    if "://" not in p:
        p = "http://" + p
    return p


def _find_chrome_bin() -> str:
    chrome_bin = (os.getenv("GROK_CHROME_BIN") or os.getenv("CHROME_PATH") or "").strip()
    if chrome_bin:
        return chrome_bin
    import shutil

    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
    ]
    for c in candidates:
        if "/" in c and Path(c).exists():
            return c
        found = shutil.which(c)
        if found:
            return found
    return "google-chrome"


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off", "")


class TurnstileBrowser:
    """One shared Chrome + one Playwright worker thread for Turnstile only."""

    def __init__(
        self,
        cdp_url: str = DEFAULT_CDP,
        *,
        browser_proxy: str = "",
        force_new_chrome: bool = False,
        use_cdp: bool | None = None,
        log: LogFn | None = None,
    ) -> None:
        self.cdp_url = cdp_url or DEFAULT_CDP
        self.browser_proxy = _normalize_proxy(browser_proxy)
        self.force_new_chrome = force_new_chrome or bool(self.browser_proxy)
        # CDP remote-debugging is more bot-like; default to channel=chrome launch.
        if use_cdp is None:
            use_cdp = _env_bool("GROK_TURNSTILE_USE_CDP", False)
        self.use_cdp = bool(use_cdp)
        self._log_fn = log
        self._chrome: subprocess.Popen | None = None
        self._owned = False
        self._pw = None
        self._browser = None
        self._context = None  # persistent / launch context when not CDP
        self._q: queue.Queue = queue.Queue()
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._start_err: BaseException | None = None
        self._stopping = False
        self._chrome_log = None

    def _say(self, msg: str) -> None:
        _log(msg, self._log_fn)

    def _alive(self) -> bool:
        if not self.use_cdp:
            return self._browser is not None or self._context is not None
        import urllib.request

        urls = [self.cdp_url.rstrip("/") + "/json/version"]
        if "127.0.0.1" in self.cdp_url:
            urls.append(self.cdp_url.replace("127.0.0.1", "localhost").rstrip("/") + "/json/version")
            urls.append(self.cdp_url.replace("127.0.0.1", "[::1]").rstrip("/") + "/json/version")
        for url in urls:
            try:
                with urllib.request.urlopen(url, timeout=2) as r:
                    if r.read():
                        return True
            except Exception:
                continue
        return False

    def _chrome_cmd(self) -> list[str]:
        port = _cdp_port(self.cdp_url)
        profile = (
            Path("/tmp/grok-email-register-chrome-proxy")
            if self.browser_proxy
            else CHROME_PROFILE
        )
        if self.browser_proxy:
            import shutil

            try:
                if profile.exists():
                    shutil.rmtree(profile, ignore_errors=True)
            except Exception:
                pass
        profile.mkdir(parents=True, exist_ok=True)
        chrome_bin = _find_chrome_bin()
        cmd = [
            chrome_bin,
            f"--remote-debugging-port={port}",
            f"--user-data-dir={str(profile)}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-dev-shm-usage",
            "--window-size=1400,900",
            "--disable-blink-features=AutomationControlled",
            "--lang=en-US",
            "--remote-allow-origins=*",
            "--remote-debugging-address=127.0.0.1",
        ]
        if self.browser_proxy:
            u = urlparse(self.browser_proxy)
            hostport = u.hostname or ""
            if u.port:
                hostport = f"{hostport}:{u.port}"
            if hostport:
                scheme = u.scheme or "http"
                if scheme in ("socks5", "socks"):
                    scheme = "socks5"
                cmd.append(f"--proxy-server={scheme}://{hostport}")
                self._say(f"[browser] chrome proxy {scheme}://{hostport}")
        cmd.append("about:blank")
        return cmd

    def _kill_cdp_chrome(self) -> None:
        port = _cdp_port(self.cdp_url)
        try:
            subprocess.run(
                ["bash", "-lc", f"pkill -f 'remote-debugging-port={port}' || true"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass
        for _ in range(20):
            if not self._alive():
                break
            time.sleep(0.2)

    def _ensure_chrome_cdp(self) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        CHROME_PROFILE.mkdir(parents=True, exist_ok=True)
        must_own = bool(self.browser_proxy) or self.force_new_chrome
        if self._alive() and not must_own:
            self._say(f"[browser] reuse CDP {self.cdp_url}")
            return
        if self._alive() and must_own:
            self._say(f"[browser] restart Chrome on {self.cdp_url}")
            self._kill_cdp_chrome()
        if self._chrome_log is None or getattr(self._chrome_log, "closed", True):
            self._chrome_log = open(LOG_DIR / "chrome.log", "ab")
        self._chrome = subprocess.Popen(
            self._chrome_cmd(),
            stdout=self._chrome_log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self._owned = True
        for _ in range(80):
            if self._alive():
                self._say(f"[browser] started Chrome CDP {self.cdp_url}")
                return
            if self._chrome is not None and self._chrome.poll() is not None:
                raise RuntimeError(f"Chrome CDP exited code={self._chrome.returncode}")
            time.sleep(0.35)
        raise RuntimeError("Chrome CDP start timeout")

    def _detach_playwright(self) -> None:
        try:
            if self._context is not None:
                self._context.close()
        except Exception:
            pass
        self._context = None
        try:
            if self._browser is not None and not self.use_cdp:
                self._browser.close()
        except Exception:
            pass
        try:
            if self._pw is not None:
                self._pw.stop()
        except Exception:
            pass
        self._pw = None
        self._browser = None

    def _kill_owned_chrome(self) -> None:
        if self._chrome is not None:
            try:
                self._chrome.terminate()
            except Exception:
                pass
            try:
                self._chrome.wait(timeout=3)
            except Exception:
                try:
                    self._chrome.kill()
                except Exception:
                    pass
            self._chrome = None
        self._owned = False
        if self.use_cdp:
            self._kill_cdp_chrome()

    def _connect_playwright(self) -> None:
        # Prefer rebrowser-playwright: patches CDP Runtime.Enable leak that CF uses.
        try:
            from rebrowser_playwright.sync_api import sync_playwright
            self._say("[browser] using rebrowser-playwright")
        except ImportError:
            from playwright.sync_api import sync_playwright
            self._say("[browser] using stock playwright (install rebrowser-playwright for CF)")

        if self._pw is None:
            self._pw = sync_playwright().start()

        if self.use_cdp:
            try:
                self._browser = self._pw.chromium.connect_over_cdp(self.cdp_url)
            except Exception:
                try:
                    self._pw.stop()
                except Exception:
                    pass
                self._pw = sync_playwright().start()
                self._browser = self._pw.chromium.connect_over_cdp(self.cdp_url)
            return

        # Preferred: launch real Chrome without remote-debugging CDP ownership.
        # This is still automatable, but less "CDP bot-shaped" than forced debug port.
        CHROME_PROFILE.mkdir(parents=True, exist_ok=True)
        launch_args = [
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=1400,900",
            "--lang=en-US",
        ]
        proxy = None
        if self.browser_proxy:
            u = urlparse(self.browser_proxy)
            hostport = u.hostname or ""
            if u.port:
                hostport = f"{hostport}:{u.port}"
            scheme = u.scheme or "http"
            if scheme in ("socks5", "socks"):
                scheme = "socks5"
            server = f"{scheme}://{hostport}"
            proxy = {"server": server}
            if u.username:
                proxy["username"] = u.username
            if u.password:
                proxy["password"] = u.password
            self._say(f"[browser] launch proxy {server}")

        # Fresh subdir per process reduces sticky CF failure_retry state.
        profile = CHROME_PROFILE / f"run-{os.getpid()}-{secrets.token_hex(2)}"
        profile.mkdir(parents=True, exist_ok=True)
        try:
            self._context = self._pw.chromium.launch_persistent_context(
                user_data_dir=str(profile),
                channel="chrome",
                headless=False,
                viewport={"width": 1400, "height": 900},
                locale="en-US",
                args=launch_args,
                proxy=proxy,
                ignore_default_args=["--enable-automation"],
            )
            self._browser = self._context.browser
            self._owned = True
            self._say("[browser] launched Chrome channel=chrome (non-CDP)")
        except Exception as exc:
            self._say(f"[browser] channel=chrome failed ({exc}); falling back to CDP")
            self.use_cdp = True
            self._ensure_chrome_cdp()
            self._browser = self._pw.chromium.connect_over_cdp(self.cdp_url)

    def _worker(self) -> None:
        try:
            if self.use_cdp:
                self._ensure_chrome_cdp()
            self._connect_playwright()
            self._say("[browser] Playwright ready")
            self._ready.set()
        except BaseException as e:
            self._start_err = e
            self._ready.set()
            return

        while not self._stopping:
            try:
                item = self._q.get(timeout=0.5)
            except queue.Empty:
                continue
            if item is None:
                break
            payload, reply = item
            try:
                tok = self._solve_on_thread(payload)
                reply.put(("ok", tok))
            except BaseException as e:
                reply.put(("err", RuntimeError(str(e).strip() or type(e).__name__)))
            finally:
                try:
                    self._q.task_done()
                except Exception:
                    pass

        self._detach_playwright()
        if self._owned and self.use_cdp:
            self._kill_owned_chrome()
        self._say("[browser] released")

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            if not self._ready.wait(timeout=60):
                raise RuntimeError("browser start timeout")
            if self._start_err is not None:
                raise RuntimeError(f"browser start failed: {self._start_err}")
            return
        self._stopping = False
        self._start_err = None
        self._ready.clear()
        try:
            while True:
                self._q.get_nowait()
        except queue.Empty:
            pass
        self._thread = threading.Thread(target=self._worker, name="turnstile-browser", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=90):
            raise RuntimeError("browser start timeout")
        if self._start_err is not None:
            raise RuntimeError(f"browser start failed: {self._start_err}")

    def stop(self) -> None:
        self._stopping = True
        try:
            self._q.put(None)
        except Exception:
            pass
        if self._thread is not None:
            self._thread.join(timeout=20)
            self._thread = None
        self._detach_playwright()
        if self._owned and self.use_cdp:
            self._kill_owned_chrome()
        if self._chrome_log is not None:
            try:
                self._chrome_log.close()
            except Exception:
                pass
            self._chrome_log = None

    def turnstile_token(self, payload: dict, timeout_s: float = 90) -> str:
        if self._thread is None or not self._thread.is_alive():
            self.start()
        reply: queue.Queue = queue.Queue(maxsize=1)
        job = dict(payload or {})
        job["timeout_s"] = float(timeout_s)
        self._q.put((job, reply))
        wait_s = max(180.0, float(timeout_s) * 3 + 60.0)
        try:
            status, result = reply.get(timeout=wait_s)
        except queue.Empty as e:
            raise TimeoutError(f"turnstile queue timeout {wait_s:.0f}s") from e
        if status == "err":
            raise RuntimeError(str(result))
        return result or ""

    def _new_page(self):
        assert self._browser is not None or self._context is not None
        if self._context is not None:
            page = self._context.new_page()
        else:
            if not self._browser.contexts:
                self._browser.new_context(
                    viewport={"width": 1400, "height": 900},
                    locale="en-US",
                )
            ctx = self._browser.contexts[0]
            page = ctx.new_page()
        try:
            page.add_init_script(STEALTH_JS)
        except Exception:
            pass
        return page

    def _solve_on_thread(self, payload: dict) -> str:
        timeout_s = float(payload.get("timeout_s") or 90)
        attempts = max(1, int(os.getenv("GROK_TURNSTILE_ATTEMPTS", "2")))
        last_note = ""
        for i in range(attempts):
            page = None
            try:
                if (self._browser is None and self._context is None) or (
                    self.use_cdp and not self._alive()
                ):
                    if self.use_cdp:
                        self._ensure_chrome_cdp()
                    self._connect_playwright()
                page = self._new_page()
                tok, note = self._solve(page, payload, timeout_s)
                last_note = note or last_note
                if tok:
                    if i:
                        self._say(f"[browser] turnstile ok attempt {i + 1}/{attempts}")
                    return tok
                self._say(
                    f"[browser] turnstile empty attempt {i + 1}/{attempts}"
                    + (f" ({note})" if note else "")
                )
            except BaseException as e:
                last_note = str(e).strip() or type(e).__name__
                self._say(f"[browser] turnstile attempt {i + 1}/{attempts} err: {last_note}")
            finally:
                if page is not None:
                    try:
                        page.close()
                    except Exception:
                        pass
            time.sleep(0.4 + random.random() * 0.5)
        if last_note:
            self._say(f"[browser] turnstile failed: {last_note}")
        return ""

    @staticmethod
    def _read_token(page) -> str:
        try:
            return (
                page.evaluate(
                    """() => {
                      const el = document.querySelector('input[name="cf-turnstile-response"]');
                      if (el && el.value) return el.value;
                      try {
                        if (window.turnstile && turnstile.getResponse)
                          return String(turnstile.getResponse() || '');
                      } catch (e) {}
                      for (const n of document.querySelectorAll('input[type="hidden"]')) {
                        if ((n.name || '').includes('turnstile') && n.value) return n.value;
                        if ((n.name || '') === 'cf-turnstile-response' && n.value) return n.value;
                      }
                      return '';
                    }"""
                )
                or ""
            )
        except Exception:
            return ""

    @staticmethod
    def _frame_title(fr) -> str:
        try:
            return fr.evaluate("() => document.title || ''") or ""
        except Exception:
            return ""

    def _turnstile_state(self, page) -> dict:
        frames = []
        for fr in page.frames:
            u = fr.url or ""
            if "challenges.cloudflare" in u or "turnstile" in u:
                frames.append({"url": u, "title": self._frame_title(fr)})
        return {
            "token": self._read_token(page),
            "frames": frames,
            "page_text": "",
        }

    def _click_turnstile_checkbox(self, page) -> bool:
        """Click only when the widget is NOT stuck in Checking."""
        for fr in page.frames:
            u = fr.url or ""
            if "challenges.cloudflare" not in u and "turnstile" not in u:
                continue
            title = self._frame_title(fr)
            if title and "Checking" in title:
                continue
            if "failure" in u:
                continue
            try:
                box = fr.frame_element().bounding_box()
            except Exception:
                box = None
            if not box:
                continue
            # Checkbox is usually on the left of the flexible widget.
            cx = box["x"] + min(28.0, max(18.0, box["width"] * 0.08))
            cy = box["y"] + box["height"] / 2
            try:
                page.mouse.move(cx, cy, steps=random.randint(8, 16))
                page.mouse.click(cx, cy)
                return True
            except Exception:
                continue
        return False

    def _dismiss_banners(self, page) -> None:
        # OneTrust cookie banner is always first on accounts.x.ai
        for sel in (
            "#onetrust-accept-btn-handler",
            "button#onetrust-accept-btn-handler",
        ):
            try:
                page.locator(sel).click(timeout=1500)
                page.wait_for_timeout(400)
                return
            except Exception:
                pass
        for label in ("Accept All", "Allow All", "Accept", "Agree", "I agree", "同意", "接受"):
            try:
                page.get_by_role("button", name=label).first.click(timeout=600)
                return
            except Exception:
                pass

    def _click_label(self, page, labels: tuple[str, ...], *, role: str = "button", timeout: float = 2500) -> bool:
        for label in labels:
            try:
                page.get_by_role(role, name=re.compile(label, re.I)).first.click(timeout=timeout)
                return True
            except Exception:
                pass
            try:
                page.get_by_text(re.compile(label, re.I)).first.click(timeout=timeout)
                return True
            except Exception:
                pass
        return False

    def _page_text(self, page) -> str:
        try:
            return page.evaluate("() => (document.body && document.body.innerText || '').slice(0, 2500)") or ""
        except Exception:
            return ""

    def _attach_cf403_watch(self, page) -> dict:
        """Watch accounts.x.ai responses for CF edge 403s (common under automation)."""
        state = {"create_email_403": False, "any_403": 0, "urls": []}

        def on_response(resp):
            try:
                u = resp.url or ""
                st = resp.status
            except Exception:
                return
            if "accounts.x.ai" not in u:
                return
            if st == 403:
                state["any_403"] += 1
                if len(state["urls"]) < 8:
                    state["urls"].append(u[:160])
                if "CreateEmailValidationCode" in u:
                    state["create_email_403"] = True
                    self._say("[browser] CF edge HTTP 403 on CreateEmailValidationCode")

        try:
            page.on("response", on_response)
        except Exception:
            pass
        return state

    def _fill_first(self, page, selectors: list[str], value: str) -> bool:
        """Fill React-controlled inputs reliably (fill-only often leaves UI empty)."""
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                if loc.count() == 0:
                    continue
                if not loc.is_visible(timeout=1200):
                    continue
                loc.click(timeout=1200)
                # clear existing
                try:
                    loc.fill("")
                except Exception:
                    pass
                try:
                    loc.press("Meta+a")
                    loc.press("Backspace")
                except Exception:
                    try:
                        loc.press("Control+a")
                        loc.press("Backspace")
                    except Exception:
                        pass
                # prefer human-like typing for React onChange
                try:
                    loc.type(value, delay=random.randint(35, 70))
                except Exception:
                    loc.fill(value)
                # verify DOM value; if empty, force native setter + input/change events
                current = ""
                try:
                    current = loc.input_value(timeout=800) or ""
                except Exception:
                    current = ""
                if current != value:
                    try:
                        page.evaluate(
                            """({sel, value}) => {
                              const el = document.querySelector(sel);
                              if (!el) return false;
                              const proto = window.HTMLInputElement.prototype;
                              const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                              if (desc && desc.set) desc.set.call(el, value);
                              else el.value = value;
                              el.dispatchEvent(new Event('input', { bubbles: true }));
                              el.dispatchEvent(new Event('change', { bubbles: true }));
                              return el.value === value;
                            }""",
                            {"sel": sel, "value": value},
                        )
                        current = loc.input_value(timeout=800) or ""
                    except Exception:
                        pass
                if current == value or (value and value in current):
                    return True
            except Exception:
                continue
        return False

    def _try_inject_widget(self, page, timeout_s: float) -> tuple[str, str]:
        """Fast path: inject managed widget on accounts.x.ai origin."""
        try:
            page.goto(SIGNUP_URL, wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            return "", f"inject goto: {e}"
        page.wait_for_timeout(800)
        self._dismiss_banners(page)
        sitekey = TURNSTILE_SITEKEY
        try:
            page.evaluate(
                """(sitekey) => {
                  return new Promise((resolve) => {
                    const host = document.createElement('div');
                    host.id = 'grok-ts-host';
                    host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:999999;background:#fff;padding:8px;border:1px solid #ccc';
                    document.body.appendChild(host);
                    const go = () => {
                      try {
                        window.turnstile.render(host, {
                          sitekey,
                          callback: (t) => { window.__grokTs = t; },
                          'error-callback': () => { window.__grokTsErr = true; },
                        });
                        resolve('rendered');
                      } catch (e) {
                        resolve('render-err:' + e);
                      }
                    };
                    if (window.turnstile && window.turnstile.render) { go(); return; }
                    const s = document.createElement('script');
                    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
                    s.async = true;
                    s.onload = go;
                    s.onerror = () => resolve('script-fail');
                    document.head.appendChild(s);
                  });
                }""",
                sitekey,
            )
        except Exception as e:
            return "", f"inject eval: {e}"

        t0 = time.time()
        last = "inject-waiting"
        while time.time() - t0 < min(22.0, timeout_s):
            try:
                tok = page.evaluate("() => window.__grokTs || ''") or ""
            except Exception:
                tok = ""
            if not tok:
                tok = self._read_token(page)
            if tok and len(tok) > 20:
                return tok, "inject-ok"
            st = self._turnstile_state(page)
            if st["frames"]:
                last = st["frames"][0].get("title") or last
            page.wait_for_timeout(1000)
        return "", last

    def _wait_token(self, page, deadline: float, *, interactive: bool, label: str) -> tuple[str, str]:
        last_note = ""
        warned = False
        clicked = False
        while time.time() < deadline:
            tok = self._read_token(page)
            if tok and len(tok) > 20:
                return tok, f"{label}-ok"
            title = ""
            frame_url = ""
            try:
                for fr in page.frames:
                    u = fr.url or ""
                    if "turnstile" in u or "challenges.cloudflare" in u:
                        title = self._frame_title(fr) or title
                        frame_url = u
            except Exception:
                pass
            if title:
                last_note = title
            elif frame_url:
                last_note = "frame:" + frame_url[:60]
            else:
                last_note = "no-turnstile-frame"

            # Never click while Checking — that produced failure_retry in recon.
            if title and "Checking" not in title and "failure" not in (frame_url or ""):
                if not clicked:
                    if self._click_turnstile_checkbox(page):
                        clicked = True
                        self._say("[browser] clicked turnstile checkbox")

            if "Checking" in (title or "") and not warned:
                warned = True
                self._say(
                    "[browser] Turnstile 仍在 Checking your Browser…（自己过验证模式）。"
                    "请看弹出的 Chrome 窗口：若出现勾选框请点一下；"
                    "若一直 Checking，可稍等或刷新后重试。不用打码平台。"
                )
            page.wait_for_timeout(1500 if not interactive else 2000)
        return "", last_note or f"{label}-timeout"


    def _install_protocol_bridge(self, page, bridge_fetch: BridgeFetchFn | None) -> None:
        """Forward CF-blocked browser calls through curl_cffi (protocol TLS fingerprint).

        Live finding: automated Chrome gets HTTP 403 on
        /auth_mgmt.AuthManagement/* and some RSC navigations, while curl_cffi works.
        Bridging lets the real signup UI advance so Turnstile can mount; no captcha API.
        """
        if bridge_fetch is None:
            return

        patterns = (
            "**/auth_mgmt.AuthManagement/**",
            "https://accounts.x.ai/**",
        )

        def _should_bridge(url: str, resource_type: str = "") -> bool:
            u = url or ""
            if "accounts.x.ai" not in u and "auth_mgmt.AuthManagement" not in u:
                return False
            # CRITICAL: never bridge Cloudflare browser integrity / Turnstile.
            # Proxying /cdn-cgi/challenge-platform breaks CF and leaves Turnstile on Checking.
            if any(
                x in u
                for x in (
                    "challenges.cloudflare.com",
                    "/cdn-cgi/",
                    "challenge-platform",
                    "turnstile",
                    "cf-turnstile",
                )
            ):
                return False
            # static assets stay in browser
            if any(
                x in u
                for x in (
                    "/_next/static/",
                    ".woff",
                    ".woff2",
                    ".png",
                    ".jpg",
                    ".jpeg",
                    ".gif",
                    ".svg",
                    ".ico",
                    ".map",
                    ".css",
                )
            ):
                return False
            if u.endswith(".js") and "/_next/" in u:
                return False
            # Always bridge gRPC auth endpoints (browser is CF-403'd here)
            if "auth_mgmt.AuthManagement" in u:
                return True
            # RSC / next navigations that CF sometimes 403s for automation
            if "_rsc=" in u:
                return True
            if resource_type in ("fetch", "xhr") and any(
                x in u for x in ("/sign-up", "/sign-in", "/auth", "next-action", "mp/track")
            ):
                return True
            return False

        def handler(route):
            request = route.request
            url = request.url or ""
            rtype = ""
            try:
                rtype = request.resource_type or ""
            except Exception:
                rtype = ""
            if not _should_bridge(url, rtype):
                try:
                    route.continue_()
                except Exception:
                    pass
                return
            try:
                headers = dict(request.headers or {})
                body = b""
                try:
                    body = request.post_data_buffer or b""
                except Exception:
                    raw = request.post_data
                    if raw is None:
                        body = b""
                    elif isinstance(raw, bytes):
                        body = raw
                    else:
                        body = str(raw).encode("utf-8", errors="ignore")
                method = (request.method or "POST").upper()
                path = url.split("accounts.x.ai")[-1][:100] if "accounts.x.ai" in url else url[:100]
                self._say(f"[bridge] {method} {path} body={len(body)}B type={rtype}")
                status, resp_headers, resp_body = bridge_fetch(url, method, headers, body)
                resp_body = resp_body or b""
                # Playwright fulfill is picky about hop-by-hop headers
                out_headers = {}
                for k, v in (resp_headers or {}).items():
                    lk = str(k).lower()
                    if lk in (
                        "content-encoding",
                        "transfer-encoding",
                        "content-length",
                        "connection",
                        "keep-alive",
                        "alt-svc",
                        "strict-transport-security",
                        "set-cookie",  # set via browser cookie jar separately if needed
                    ):
                        continue
                    out_headers[k] = v
                # ensure grpc-web content-type
                if not any(k.lower() == "content-type" for k in out_headers):
                    out_headers["content-type"] = "application/grpc-web+proto"
                # expose grpc status for frontend if only in trailers body
                gs = ""
                try:
                    # trailer frame often ascii contains grpc-status
                    tail = resp_body[-80:].decode("utf-8", errors="ignore")
                    if "grpc-status" in tail:
                        gs = tail.replace("\r", " ").replace("\n", " ")[:60]
                except Exception:
                    pass
                self._say(
                    f"[bridge] <- HTTP {status} len={len(resp_body)}"
                    + (f" {gs}" if gs else "")
                )
                route.fulfill(status=int(status or 502), headers=out_headers, body=resp_body)
            except Exception as e:
                self._say(f"[bridge] fail: {e}")
                try:
                    route.abort()
                except Exception:
                    pass

        for pat in patterns:
            try:
                page.route(pat, handler)
            except Exception as e:
                self._say(f"[bridge] route {pat} err: {e}")
        self._say("[bridge] protocol gRPC bridge installed (curl_cffi)")

    def _solve_full_signup(
        self,
        page,
        *,
        email: str,
        fetch_code: FetchCodeFn | None,
        code: str,
        given: str,
        family: str,
        password: str,
        timeout_s: float,
        interactive: bool,
        bridge_fetch: BridgeFetchFn | None = None,
    ) -> tuple[str, str]:
        if not email:
            return "", "missing-harvest-email"
        deadline = time.time() + max(40.0, float(timeout_s))

        try:
            page.goto(SIGNUP_URL, wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            return "", f"goto: {e}"
        cf403 = self._attach_cf403_watch(page)
        self._install_protocol_bridge(page, bridge_fetch)
        page.wait_for_timeout(1000)
        self._dismiss_banners(page)
        page.wait_for_timeout(400)

        # Landing has provider buttons; email field appears only after this click.
        opened = self._click_label(
            page,
            ("Sign up with email", "使用邮箱注册", "Continue with email"),
            timeout=4000,
        )
        if not opened:
            # fallback: any button containing both sign/up and email
            try:
                page.locator("button", has_text=re.compile(r"sign up with email", re.I)).first.click(timeout=3000)
                opened = True
            except Exception:
                pass
        page.wait_for_timeout(900)
        if page.locator('input[type="email"]').count() == 0:
            try:
                LOG_DIR.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(LOG_DIR / "no_email_input.png"), full_page=True)
                self._say(f"[browser] no email input; text0={self._page_text(page).splitlines()[:6]!r}")
            except Exception:
                pass
            return "", "email-form-not-opened"

        if not self._fill_first(
            page,
            ['input[type="email"]', 'input[name="email"]', 'input[autocomplete="email"]'],
            email,
        ):
            return "", "email-input-missing"
        page.wait_for_timeout(500)
        try:
            shown = page.locator('input[type="email"]').first.input_value(timeout=1000)
            self._say(f"[browser] email field value={shown!r}")
        except Exception as e:
            self._say(f"[browser] email field read fail: {e}")
        # blur to trigger validation
        try:
            page.locator('input[type="email"]').first.press("Tab")
        except Exception:
            pass
        page.wait_for_timeout(400)

        def _reached_verify() -> bool:
            try:
                if page.locator('input[name="code"]').count() > 0:
                    return True
            except Exception:
                pass
            text = self._page_text(page)
            return any(
                x in text
                for x in (
                    "Verify your email",
                    "security code",
                    "We've emailed",
                    "one time",
                    "Confirm email",
                    "Please enter it below",
                )
            )

        submitted = False
        for strategy in ("role-sign-up", "submit", "enter", "text", "force-js"):
            nav_ish = False
            try:
                if strategy == "role-sign-up":
                    btn = page.get_by_role("button", name=re.compile(r"^Sign up$", re.I)).first
                    try:
                        disabled = btn.is_disabled()
                        self._say(f"[browser] Sign up disabled={disabled}")
                    except Exception:
                        pass
                    # wait for network after click; signup triggers gRPC + RSC
                    with page.expect_response(
                        lambda r: any(
                            x in (r.url or "")
                            for x in (
                                "CreateEmailValidationCode",
                                "sign-up",
                                "auth_mgmt",
                            )
                        ),
                        timeout=8000,
                    ):
                        btn.click(timeout=3000)
                elif strategy == "submit":
                    page.locator('button[type="submit"]').first.click(timeout=2500)
                elif strategy == "enter":
                    page.locator('input[type="email"]').first.press("Enter")
                elif strategy == "force-js":
                    page.evaluate(
                        """() => {
                          const btn = Array.from(document.querySelectorAll('button')).find(
                            b => /^(sign up)$/i.test((b.innerText||'').trim())
                          );
                          if (btn) { btn.disabled = false; btn.click(); return 'btn'; }
                          const form = document.querySelector('form');
                          if (form) {
                            if (form.requestSubmit) form.requestSubmit();
                            else form.submit();
                            return 'form';
                          }
                          return 'none';
                        }"""
                    )
                else:
                    page.locator('button:has-text("Sign up")').last.click(timeout=2500)
            except Exception as e:
                msg = str(e)
                # navigation destroys context; often means submit actually started
                if any(
                    x in msg.lower()
                    for x in (
                        "execution context was destroyed",
                        "navigation",
                        "target closed",
                        "timeout",
                    )
                ):
                    nav_ish = True
                    self._say(f"[browser] email-submit {strategy} nav/timeout: {e}")
                else:
                    self._say(f"[browser] email-submit {strategy} fail: {e}")
                    continue

            # allow SPA transition
            for _ in range(8):
                page.wait_for_timeout(700)
                if _reached_verify():
                    submitted = True
                    self._say(f"[browser] email submitted via {strategy}")
                    break
            if submitted:
                break
            text = self._page_text(page)
            # capture subtle errors beyond first lines
            err_bits = [ln for ln in text.splitlines() if any(k in ln.lower() for k in ("error", "invalid", "try again", "failed", "limit"))]
            self._say(
                f"[browser] after {strategy} text0={text.splitlines()[:5]!r}"
                + (f" errs={err_bits[:3]!r}" if err_bits else "")
                + (f" nav_ish={nav_ish}" if nav_ish else "")
            )
        if not submitted:
            try:
                LOG_DIR.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(LOG_DIR / "email_submit_fail.png"), full_page=True)
            except Exception:
                pass
            if cf403.get("create_email_403") or cf403.get("any_403", 0) >= 1:
                return (
                    "",
                    "browser-cf-403: CreateEmailValidationCode blocked by Cloudflare edge "
                    "(HTTP 403). Use protocol gRPC bridge (default) or a cleaner browser/IP. "
                    "No captcha platform required.",
                )
            return "", "email-submit-did-not-reach-verify"

        otp = (code or "").strip()
        if not otp:
            if fetch_code is None:
                return "", "missing-code-and-fetcher"
            self._say(f"[browser] waiting mailbox code for {email}")
            otp = (fetch_code(email) or "").strip()
        if not otp:
            return "", "empty-otp"
        clean = re.sub(r"[^A-Za-z0-9]", "", otp)
        self._say(f"[browser] typing code={clean}")

        def _on_credentials() -> bool:
            try:
                if page.locator('input[type="password"]').count() > 0:
                    return True
                if page.locator(
                    'input[name="givenName"], input[name="familyName"], input[name="password"]'
                ).count() > 0:
                    return True
            except Exception:
                pass
            text = self._page_text(page)
            return any(
                x in text
                for x in (
                    "Complete your sign up",
                    "First name",
                    "Last name",
                    "Password",
                    "givenName",
                )
            )

        try:
            ok = self._fill_first(
                page,
                ['input[name="code"]', 'input[autocomplete="one-time-code"]', 'input[inputmode="text"]'],
                clean,
            )
            if not ok:
                page.locator('input[name="code"]').first.click(timeout=2000)
                page.locator('input[name="code"]').first.type(clean, delay=60)
        except Exception as e:
            self._say(f"[browser] code fill interrupted (often OK): {e}")

        confirmed = False
        for i in range(12):
            if _on_credentials():
                confirmed = True
                self._say(f"[browser] credentials ready t={i}")
                break
            page.wait_for_timeout(500)

        if not confirmed:
            for strategy in ("button", "enter", "submit", "force-js"):
                if _on_credentials():
                    confirmed = True
                    break
                try:
                    if strategy == "button":
                        self._click_label(page, (r"Confirm email", "确认", "Verify"), timeout=2500)
                    elif strategy == "enter":
                        page.locator('input[name="code"]').first.press("Enter")
                    elif strategy == "force-js":
                        page.evaluate(
                            """() => {
                              const btn = Array.from(document.querySelectorAll('button')).find(b =>
                                /confirm email|verify/i.test((b.innerText||'').trim())
                              );
                              if (btn) { btn.click(); return 'btn'; }
                              const form = document.querySelector('form');
                              if (form) { (form.requestSubmit||form.submit).call(form); return 'form'; }
                              return 'none';
                            }"""
                        )
                    else:
                        page.locator('button[type="submit"]').first.click(timeout=2000)
                except Exception as e:
                    self._say(f"[browser] confirm {strategy} err: {e}")
                for j in range(10):
                    page.wait_for_timeout(600)
                    if _on_credentials():
                        confirmed = True
                        self._say(f"[browser] credentials via confirm={strategy} t={j}")
                        break
                if confirmed:
                    break
                self._say(
                    f"[browser] after confirm {strategy} text0={self._page_text(page).splitlines()[:5]!r}"
                )

        if not confirmed:
            text = self._page_text(page)
            try:
                LOG_DIR.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(LOG_DIR / "stuck_before_credentials.png"), full_page=True)
            except Exception:
                pass
            return "", f"stuck-before-credentials: {text[:180]!r}"

        self._say("[browser] on credentials page; Turnstile should mount here (self-solve, no captcha API)")
        self._fill_first(
            page,
            [
                'input[name="givenName"]',
                'input[autocomplete="given-name"]',
                'input[data-testid="givenName"]',
            ],
            given or "Ada",
        )
        self._fill_first(
            page,
            [
                'input[name="familyName"]',
                'input[autocomplete="family-name"]',
                'input[data-testid="familyName"]',
            ],
            family or "Lovelace",
        )
        self._fill_first(
            page,
            [
                'input[name="password"]',
                'input[type="password"]',
                'input[autocomplete="new-password"]',
            ],
            password or f"N{secrets.token_hex(4)}!a7#{secrets.token_hex(3)}",
        )
        page.wait_for_timeout(1200)

        # Wait for widget; do not submit "Complete sign up" — we only need the token.
        remain = max(15.0, deadline - time.time())
        if interactive:
            remain = max(remain, float(os.getenv("GROK_TURNSTILE_INTERACTIVE_WAIT", "240")))
            self._say(
                f"[browser] 自己过验证：请看弹出的 Chrome，完成 Turnstile（最多 {remain:.0f}s）。"
                "若一直 Checking，等勾选框出现后点一下；不要关窗口。"
            )
        return self._wait_token(page, time.time() + remain, interactive=interactive, label="full-ui")

    def _solve(self, page, payload: dict, timeout_s: float) -> tuple[str, str]:
        interactive = bool(payload.get("interactive", _env_bool("GROK_TURNSTILE_INTERACTIVE", True)))
        email = (payload.get("email") or "").strip()
        code = (payload.get("code") or "").strip()
        fetch_code = payload.get("fetch_code")
        bridge_fetch = payload.get("bridge_fetch")
        given = (payload.get("given") or "Ada").strip() or "Ada"
        family = (payload.get("family") or "Lovelace").strip() or "Lovelace"
        password = (payload.get("password") or "").strip() or (
            f"N{secrets.token_hex(4)}!a7#{secrets.token_hex(3)}"
        )
        try_inject = bool(payload.get("try_inject", _env_bool("GROK_TURNSTILE_TRY_INJECT", True)))

        last_note = ""
        # Prefer full signup UI when we can harvest (with protocol bridge if provided).
        # Turnstile only mounts on credentials step. Inject is fallback only.
        if email and (code or callable(fetch_code)):
            self._say(f"[browser] full signup UI harvest email={email} bridge={'yes' if callable(bridge_fetch) else 'no'}")
            tok, note = self._solve_full_signup(
                page,
                email=email,
                fetch_code=fetch_code if callable(fetch_code) else None,
                code=code,
                given=given,
                family=family,
                password=password,
                timeout_s=timeout_s,
                interactive=interactive,
                bridge_fetch=bridge_fetch if callable(bridge_fetch) else None,
            )
            if tok:
                return tok, note
            last_note = note or last_note
            self._say(f"[browser] full UI harvest ended: {last_note or 'empty'}")

        if try_inject:
            self._say("[browser] fallback: inject turnstile widget (self, no captcha API)")
            tok, note = self._try_inject_widget(page, min(40.0 if interactive else 25.0, timeout_s))
            last_note = note or last_note
            if tok:
                self._say(f"[browser] inject token len={len(tok)}")
                return tok, note

        return "", last_note or "no-turnstile-token"


_SHARED: TurnstileBrowser | None = None
_SHARED_LOCK = threading.Lock()


def solve_turnstile_browser(
    *,
    cdp: str = "",
    browser_proxy: str = "",
    force_new_chrome: bool = False,
    timeout_s: float = 90,
    email: str = "",
    code: str = "",
    fetch_code: FetchCodeFn | None = None,
    bridge_fetch: BridgeFetchFn | None = None,
    given: str = "Ada",
    family: str = "Lovelace",
    password: str = "",
    interactive: bool | None = None,
    try_inject: bool | None = None,
    use_cdp: bool | None = None,
    log: LogFn | None = None,
) -> str:
    """Public helper used by register.py."""
    global _SHARED
    cdp_url = (cdp or DEFAULT_CDP).strip() or DEFAULT_CDP
    proxy = _normalize_proxy(browser_proxy)
    if interactive is None:
        interactive = _env_bool("GROK_TURNSTILE_INTERACTIVE", True)
    if try_inject is None:
        try_inject = _env_bool("GROK_TURNSTILE_TRY_INJECT", True)

    with _SHARED_LOCK:
        if _SHARED is not None:
            changed = (
                _SHARED.cdp_url != cdp_url
                or _SHARED.browser_proxy != proxy
                or (force_new_chrome and not _SHARED.force_new_chrome)
            )
            if use_cdp is not None and bool(use_cdp) != bool(_SHARED.use_cdp):
                changed = True
            if changed:
                try:
                    _SHARED.stop()
                except Exception:
                    pass
                _SHARED = None
        if _SHARED is None:
            _SHARED = TurnstileBrowser(
                cdp_url=cdp_url,
                browser_proxy=proxy,
                force_new_chrome=force_new_chrome,
                use_cdp=use_cdp,
                log=log,
            )
            _SHARED.start()
        browser = _SHARED

    payload = {
        "email": email,
        "code": code,
        "fetch_code": fetch_code,
        "bridge_fetch": bridge_fetch,
        "given": given,
        "family": family,
        "password": password,
        "interactive": interactive,
        "try_inject": try_inject,
    }
    return browser.turnstile_token(payload, timeout_s=timeout_s)


def stop_shared_browser() -> None:
    global _SHARED
    with _SHARED_LOCK:
        if _SHARED is not None:
            try:
                _SHARED.stop()
            except Exception:
                pass
            _SHARED = None
