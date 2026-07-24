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

## Turnstile

当前环境若返回 `Failed to verify Cloudflare turnstile token`：

```bash
export CAPSOLVER_API_KEY='***'
# 或 YESCAPTCHA_API_KEY / --turnstile-token
python3 tools/grok-email-register/register.py --pretty
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
