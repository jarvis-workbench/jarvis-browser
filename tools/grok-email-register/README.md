# Grok Email Register (Headless)

纯协议实现 Grok / xAI「使用邮箱注册」：

- **不打开站点 / 不用浏览器**
- **默认自动建邮箱 + 自动拉验证码**（CF temp-mail）
- **Turnstile 可选**：先空 token，被要求再解

## 默认邮箱 API（你已提供）

| 项 | 默认值 |
|----|--------|
| API | `https://mailapi.icmk.top` |
| 管理员密钥 | `x-admin-auth`（env/参数可覆盖） |
| 域名 | `icmk.top` |
| 建箱 | `POST /admin/new_address` |
| 收信 | `GET /api/mails`（邮箱 JWT） |

实现参考 ban 项目的 `cfmail.py`。

## 一键注册

```bash
cd /Users/yifu/development/jarvis-broswer
pip install curl_cffi requests

# 不传 email/code：自动建箱 → 发码 → 收码 → 注册
python3 tools/grok-email-register/register.py --pretty
```

可选环境变量（也可用命令行参数）：

```bash
export CFMAIL_BASE='https://mailapi.icmk.top'
export CFMAIL_ADMIN_PASSWORD='你的管理员密钥'
export CFMAIL_DOMAINS='icmk.top'
```

命令行等价：

```bash
python3 tools/grok-email-register/register.py \
  --mail-base 'https://mailapi.icmk.top' \
  --mail-password '你的管理员密钥' \
  --mail-domain 'icmk.top' \
  --pretty
```

## 流程

1. CFMail 创建 `xxxx@icmk.top`，拿到 jwt  
2. gRPC-Web `CreateEmailValidationCode`  
3. 轮询 `/api/mails` 解析 xAI 验证码（如 `YBE-AYU`）  
4. gRPC-Web `VerifyEmailValidationCode`  
5. Next server action 建号（空 turnstile，必要时再解）  
6. 跟随 set-cookie，输出 `sso`

## Turnstile（自己过验证，不走打码平台）

默认策略：先空 token 提交；服务端要求时再解。

### 当前方案

1. **协议**负责：建邮箱、发码、收码、验码、createUser  
2. **本机 Chrome**只负责：走到 credentials 页拿 Turnstile token  
3. 浏览器里被 CF **HTTP 403** 的 gRPC，用 **curl_cffi 协议桥**转发（不是打码平台）  
4. **绝不代理** `/cdn-cgi/` / Turnstile 资源（否则会卡在 Checking）

### 实机结论

| 步骤 | 结果 |
|------|------|
| 协议 CreateEmail / Verify | OK |
| 浏览器直连 CreateEmail | 常 403 |
| 协议桥 + 浏览器 UI | 可到 **Complete your sign up** |
| Turnstile | 常卡 Checking；需本机窗口点一下或更干净出口 |

### 使用

```bash
cd /Users/yifu/development/jarvis-broswer/tools/grok-email-register
./run.sh
# 弹出 Chrome 后，如出现人机勾选请手动点一下
```

可选：

```bash
# 更长等待人工点选
GROK_TURNSTILE_INTERACTIVE_WAIT=300 ./run.sh --turnstile-timeout 300

# 浏览器走代理
./run.sh --browser-proxy 'http://127.0.0.1:7890'

# 接已有日常 Chrome（先手动开 remote debugging）
./run.sh --cdp http://127.0.0.1:9222
```

> 默认不使用 CAPSOLVER / YESCAPTCHA。只有你显式设置了这些 key 才会走打码。


## 当前实机结论（2026-07-24）

| 步骤 | 协议 curl_cffi | 自动化 Chrome |
|------|----------------|---------------|
| 页面 HTML / warm | OK | OK |
| CreateEmailValidationCode | OK | **常 HTTP 403（CF 边缘）** |
| 收信验证码 | OK（mailapi） | — |
| createUser 空 token | 业务错误：要求 turnstile | — |
| Turnstile checkbox | — | 能加载，但常卡在 Checking |

也就是说：**不是邮箱链路坏了**，而是 **createUser 要 Turnstile token**，而自动化浏览器在本机 IP 上被 CF 拦了。

### 解法优先级

1. `CAPSOLVER_API_KEY` / `YESCAPTCHA_API_KEY`（最稳，推荐）
2. `--turnstile-token` 人工灌入
3. 本机 Chrome（默认开启）：inject widget + 尝试完整 UI；403/Checking 时会明确报错
4. `--browser-proxy` 住宅代理 / 更干净出口

```bash
# 推荐：打码
export CAPSOLVER_API_KEY='***'
./run.sh

# 或外部 token
./run.sh --turnstile-token '0.xxxxx'

# 禁止浏览器，只走打码/外部 token
./run.sh --no-browser
```

首次浏览器路径需：

```bash
.venv/bin/pip install -r requirements.txt
# rebrowser-playwright 已优先；channel=chrome 用本机 Google Chrome
```

## 其它用法

```bash
# 手动邮箱+验证码
python3 tools/grok-email-register/register.py --email a@b.com --code 123456 --pretty

# 只发码 / 只验码
python3 tools/grok-email-register/register.py send-code --email a@b.com
python3 tools/grok-email-register/register.py verify-code --email a@b.com --code 123456

# 代理
python3 tools/grok-email-register/register.py --proxy 'http://127.0.0.1:7890' --pretty
```

## 成功输出

```json
{
  "ok": true,
  "email": "xxxx@icmk.top",
  "password": "...",
  "sso": "eyJ...",
  "turnstileUsed": false,
  "mailboxSecret": "<mailbox jwt>"
}
```

## 文件

- `register.py`：协议注册主脚本  
- `cfmail.py`：CF temp-mail 建箱/收信  
