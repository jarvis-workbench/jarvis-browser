# Grok 邮箱注册 · Jarvis Script

在 **Jarvis Browser** 真实页面里走 xAI「使用邮箱注册」：

1. Worker 调 CF temp-mail 建箱
2. Content script 点「Sign up with email」并填邮箱
3. Worker 拉 xAI 验证码
4. Content script 填码 → 资料页 → 等 Turnstile（本机真实浏览器指纹，不走打码平台）
5. 点 Complete sign up，输出账号密码

Python 协议脚本（`../register.py`）只作链路验证；**本脚本才是当前推荐的注册方式**。

## 1.4.6
- 设备授权 consent 页：hidden `action` 默认为空，必须先写成 `action=allow` 再提交
- 不再盲点任意 submit（会点到「拒绝」/ cookie 横幅，落到 `Invalid action`）
- 按页面模式走 verify → consent → done，Invalid action 自动重开 verification URI

## 1.4.5
- 全流程顺序固定（仅勾选 CPA 或 Grok2Api 时进入 OAuth）：
  1. 注册 UI 完成
  2. 等重定向/登录拿到 grok.com `sso`（以及 cf / x-userid）
  3. 可选 NSFW
  4. 设备码 OAuth：device/code → `/oauth2/device?user_code=` → 继续/允许 → 轮询 token
  5. 写 account / cpa / grok2api / sso
- 未勾选 CPA/Grok2Api 时跳过 OAuth，只保存 account/SSO（若勾选）

## 1.4.4
- OAuth 改为设备码流程（对齐 grok2api / CLIProxyAPI）：
  1. POST `auth.x.ai/oauth2/device/code` 取 `device_code` / `user_code`
  2. 同会话打开 `accounts.x.ai/oauth2/device?user_code=...`
  3. UI 点「继续 / 允许 / 授权」
  4. 轮询 `oauth2/token` 拿 access/refresh
- 需要在**已登录**的 Grok 会话里跑后处理；未登录会跳 sign-in
- 脚本重装/刷新 1.4.4 即可（纯 jarvis-script 变更）

## 1.4.3
- 修复：主进程补齐 `session:get-cookies` → `handleGetCookies`，后置真正能读到 HttpOnly 的 `sso` / `cf_clearance` / `x-userid`
- worker 读 cookie 时绑定当前 BrowserView 的 site/session partition，并写回 last-result
- **需要重启 Jarvis**（改了 main process），再重装/刷新脚本 1.4.3

## 安装

1. 打开 Jarvis Browser
2. 建/打开一个 xAI / Grok 站点会话（建议新会话）
3. 打开该站点的 **Jarvis Script** 面板
4. 安装目录：

```text
/Users/yifu/development/jarvis-broswer/tools/grok-email-register/jarvis-script
```

5. 确认脚本已启用
6. 在该会话地址栏打开：

```text
https://accounts.x.ai/sign-up?redirect=grok-com
```

右下角会出现 **Grok 邮箱注册** 面板。

- 仅在 **sign-up** URL 会自动开始；**登录页不会自动跑**
- 若落到登录页，会自动点「注册」切到注册流
- 面板有 **注册密码（必填）** 输入框：不填不能开始；不会自动生成密码
- 面板有 **存储目录（必选）**：点「选择」弹出 **Electron 系统目录选择器**，注册结果由主进程写入该绝对路径
- 面板：**开始注册 / 停止 / 重置**（停止会立刻打断等待与填表）
- Turnstile 会在登录页或资料页等不同位置出现，脚本按当前页智能等待/点选

## 邮箱配置

脚本内已带你提供的默认值：

| 项 | 默认 |
|----|------|
| API | `https://mailapi.icmk.top` |
| 管理员密钥 | `2434981942a@A`（`x-admin-auth`） |
| 域名 | `icmk.top` |

运行时覆盖：把 `config.example.json` 内容写入该脚本的 **data 目录** `config.json`  
（安装后由 Jarvis 管理的 script data dir，不是源码目录）。

Worker 会把创建过的邮箱记到 data 目录 `mailboxes.json`，最终结果记到 `last-result.json`。

## 目录结构

```text
jarvis-script/
  jarvis-script.json      # 清单
  content/register.js     # 页面填表 + Turnstile 等待
  worker/mail-worker.js   # 建箱 / 收码
  config.example.json
  README.md
```

## 消息协议（content ↔ worker）

| 方向 | channel | 作用 |
|------|---------|------|
| C→W | `grok-register:ping` | 探测 worker |
| C→W | `grok-register:create-mailbox` | 建临时邮箱 |
| C→W | `grok-register:wait-code` | 轮询验证码 |
| C→W | `grok-register:result` | 落盘结果 |
| W→C | `grok-register:mailbox` / `code` / `error` | 回包 |

Content 通过 `jarvis.send`；Worker 通过 `api.sendBrowserTabMessage`。

## 权限

- `http`：访问 mail API
- `browser-tab:message`：回写页面

## 注意

- **不要**再依赖打码平台；Turnstile 在真实 Jarvis `BrowserView` 里等/点。
- 若 IP 信誉差，仍可能一直 `Checking your Browser…`，这时需要更干净出口或手动点选。
- 页面刷新后，脚本会尽量用 `sessionStorage` 续跑（邮箱/验证码/密码）。
- 点面板「重置」清空续跑状态。


## 存储目录

点面板「选择」→ Electron `showOpenDialog` 选任意本地目录。

注册成功后主进程写入：

```text
<你选的目录>/
  last-result.json
  accounts.jsonl
  index.json
```

权限：`dialog`（选目录）+ `fs`（任意绝对路径读写）。需要带这些 RPC 的 Jarvis 主进程运行时。



## 落盘结构（存储目录示例 `/grok`）

```text
/grok/
  last-result.json
  account/<email>.text          # 邮箱|密码|SSO（分隔符可配置）
  cpa/<email>.json              # CLIProxyAPI xai oauth 记录
  grok2api/<email>.build.json   # grok_build oauth
  grok2api/<email>.web.json     # grok_web sso
  sso/<email>.text              # 纯 SSO
```

OAuth：SSO cookie → Authorization Code + PKCE（`referrer=grok-build`）→ `access_token` / `refresh_token`。  
NSFW：面板勾选「开启 NSFW」后在页面上下文设置 birth-date + `UpdateUserFeatureControls`。

面板配置（密码/目录/勾选/分隔符/NSFW）持久化在 **脚本 data 目录** `panel-config.json`，不是站点 sessionStorage 独占。
