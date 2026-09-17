# Pi Web

[pi 编程智能体](https://github.com/earendil-works/pi)的浏览器界面。Pi Web
与 pi 共用本机配置和会话文件，可以在浏览器中查找和继续对话、运行智能体、
配置模型与资源，并查看项目文件。

中文讨论请查看 [GitHub Discussions](https://github.com/inxups/pi-inxv-web/discussions)。

![Pi Web 展示包含结构化 Markdown、工具调用和项目导航的 pi 会话](./docs/screenshot2.png)

## 功能

- **会话工作区**：按项目查找、继续、重命名、导出和删除对话，并查看运行
  状态、上下文占用、花费和压缩信息。
- **两种分支方式**：**新会话**会从较早的消息创建独立会话文件；**从此处
  编辑**会在当前会话内创建分支。
- **项目文件工具**：浏览和上传文件、查看 Git Diff，并预览源码、Markdown、
  图片、音频、PDF 和 DOCX；文件变化后会自动刷新。
- **Git worktree**：从侧边栏切换 checkout，同时把同一仓库不同 worktree
  的会话归在一起。
- **网页配置**：管理 Provider 登录和 API Key、模型、模型测试、插件包及
  技能，无需离开 Pi Web。
- **多语言界面**：界面支持英文、简体中文和繁体中文，首次打开时跟随浏览器
  语言，也可从顶部栏切换。
- **独立认证 Gateway**：公网访问时由 `pi-web-gateway` 提供 Passkey、TOTP、
  服务端 Session、限流和审计，Agent 不接收浏览器登录凭据。

## 环境要求

- Node.js 22.19.0 或更高版本。
- 本机模式默认只监听 `127.0.0.1`，无需额外认证。
- 生产部署需要域名和 HTTPS。系统服务应使用 `/usr/bin/node`，不要把服务
  指向用户目录中的 nvm 安装。

## 快速开始

```bash
git clone https://github.com/inxups/pi-inxv-web.git
cd pi-inxv-web
npm ci
npm run build
npm start
```

## 两种运行方式

### 本机模式

仅在本机或可信开发环境使用时，直接运行 `pi-web`。默认地址为
`http://127.0.0.1:30141`，不需要密码。

需要临时放宽监听地址时，可以运行：

```bash
pi-web -p 8080 -H 0.0.0.0 --no-open
```

这会暴露未认证的 Agent。不要把 `0.0.0.0` 或 `PI_WEB_PASSWORD` 模式直接
暴露到公网。

### 公网或跨网络模式

公网访问必须使用 `pi-web-gateway`。推荐链路：

```text
浏览器 -> Caddy :443 -> Gateway 127.0.0.1:30142 -> Agent 127.0.0.1:30141
```

Gateway 负责认证、代理、Passkey、密码加 TOTP、服务端 Session、限流和审计。
HTTPS 可以由 Caddy 终止，也可以由 Gateway 直接终止。Agent 仍只监听
`127.0.0.1:30141`，不会收到浏览器登录 Cookie 或 API Token。

生产部署直接使用现有非 root 登录账号即可，不需要创建 `piweb` 或
`piweb-gateway` 系统用户。`30141` 和 `30142` 不得对公网开放。

## Debian 生产部署

当前推荐方式是在 Debian 上使用单用户、多发布目录部署。完整命令、systemd
配置、Caddy 示例、更新、备份和恢复流程见
[Debian 单用户部署](./docs/deployment.zh-CN.md)。

部署前准备：

1. 安装 Node.js 22.19+，确保 `/usr/bin/node` 和 `/usr/bin/npm` 可用。
2. 安装 `git`、构建工具和 Caddy。
3. 将真实域名解析到服务器，并开放 `80/tcp` 和 `443/tcp`。
4. 使用现有非 root 账号运行两个服务，不创建新用户。

首次部署的核心流程：

1. 构建应用并安装到 `/opt/pi-web/releases/<release-id>`。
2. 初始化 Gateway 密钥并配置 `/etc/pi-web/pi-web.env` 与
   `/etc/pi-web/pi-web-gateway.env`。
3. 启动 `pi-web@<用户>` 和 `pi-web-gateway@<用户>`。
4. 按部署文档定义 `pi_gateway`，运行 `pi_gateway bootstrap`，访问
   `https://<域名>/auth/setup`，保存 Passkey、TOTP、密码和恢复码。

如果使用 Cloudflare 代理，Caddy 的自动证书签发可能受到代理影响。最简单
的方式是在证书签发和续期期间保持该记录为 `DNS only`。如果必须保留代理，
应使用 Cloudflare Origin Certificate，并把 SSL/TLS 模式设置为
`Full (strict)`。

主要目录：

```text
/opt/pi-web/releases/<release-id>  不可变的应用构建产物
/opt/pi-web/current                当前版本符号链接
/etc/pi-web                       两个服务的环境文件
/var/lib/pi-web                    Agent 数据、模型凭据和插件数据
/var/lib/pi-web-gateway            Gateway 数据库和密钥
/srv/pi-web                        项目工作区
```

以后更新时只新增发布目录并切换 `/opt/pi-web/current`。配置、数据和项目
不会被覆盖；旧发布目录保留到新版本验证完成，可用于回滚。

部署后至少检查：

```bash
curl -I http://127.0.0.1:30141/
curl -I https://pi.example.com/
curl -sS https://pi.example.com/api/auth/status
sudo ss -ltnp | grep -E ':(30141|30142|443)'
```

Agent 直连应返回 `401` 或 `403`；Gateway 首页应跳转到登录页；`30141` 和
`30142` 应只监听 `127.0.0.1`。

## Gateway 认证

Gateway 提供以下认证能力：

- Passkey 是首选登录方式。
- 兼容登录必须同时提交密码和 TOTP 验证码。
- 服务端 Session 可以立即撤销。
- 恢复码只显示一次，应离线保存。
- 登录、Token 和 Session 事件会写入审计记录。

初始化代码有效期为 15 分钟且只能使用一次。代码在开始初始化时即被消耗，
初始化挑战本身只有 10 分钟。如果看到 `Invalid or expired setup code`，
需要重新生成代码；如果看到 `Too many authentication requests`，应等待
`Retry-After` 或重启 Gateway 清空进程内限流计数。详细处理见
[初始化故障排查](./docs/deployment.zh-CN.md#初始化故障排查)。

生产部署后，可以使用部署文档中定义的 `pi_gateway` 命令管理 Token 和审计：

```bash
pi_gateway token create --name laptop-cli --scope agent:read --expires-days 30
pi_gateway token list
pi_gateway audit list --limit 100
pi_gateway sessions revoke-all
```

API Token 默认是 `agent:read` 和 30 天有效期。需要写操作时必须显式选择
`agent:write`。API Token 不能管理 Gateway 账号、Session、Passkey 或其他
Token。

`PI_WEB_PASSWORD` 只保留给本机开发和可信私网。它没有 MFA、没有服务端
撤销，而且认证代码与 Agent 扩展在同一进程内，不适合作为公网入口。

## 配置

端口和主机名以命令行参数为准，优先于对应的环境变量。`--no-open` 与
`PI_WEB_NO_OPEN=1` 中任意一个都会关闭自动打开浏览器。运行
`pi-web --help`（或 `-h`）可打印启动选项并退出。

| 参数或环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `--help`、`-h` | 打印启动选项并退出 | 无 |
| `--port <端口>`、`-p <端口>` 或 `PORT` | 服务端口 | `30141` |
| `--hostname <主机>`、`-H <主机>` 或 `PI_WEB_HOSTNAME` | 监听主机名 | `127.0.0.1` |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `PI_WEB_SKIP_VERSION_CHECK=1` | 关闭版本更新检查 | 未设置 |
| `PI_WEB_ALLOWED_HOSTS` | 额外允许的代理或自定义主机名，多个值用逗号分隔，必须精确匹配 | 未设置 |
| `PI_WEB_AUTH_MODE` | 认证模式：`local` 使用旧密码模式，`gateway` 只接受 Gateway 内部断言 | `local` |
| `PI_WEB_PASSWORD` | 仅用于 `local` 模式的浏览器密码登录和 Basic Auth | 不启用认证 |
| `PI_WEB_IDLE_TIMEOUT_MS` | Session 空闲超时毫秒数，`0` 表示禁用空闲关闭 | `600000`（10 分钟） |

示例：

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### HTTP 代理

服务端的模型和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和
`NO_PROXY` 环境变量。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## 数据与文件边界

- **智能体数据**：Pi Web 默认读取 `~/.pi/agent`，包括
  `sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl`。可通过
  `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **文件系统访问**：Pi Web 必须能读取智能体数据目录及会话记录中的工作
  目录。与现有 pi 会话共用数据时，应让两者运行在相同的文件系统环境中。
- **共享配置**：模型面板使用 pi 的模型、设置和凭据存储，因此两种界面
  都能看到相关更改。
- **文件访问边界**：文件浏览器仅能访问在 Pi Web 中选择过的工作目录，
  以及它已识别的项目或会话根目录，不是通用文件系统浏览器。
- **Git worktree**：切换器何时显示、如何创建 worktree，以及删除会产生
  什么影响，见 [Pi Web 里的 Worktree](./docs/worktrees.zh-CN.md)。

## 扩展与下游集成

### Session 行右键菜单

Electron 封装器和其他下游集成可以监听可取消的
`pi-web:session-row-contextmenu` 浏览器事件，在不修改 `SessionSidebar`
的情况下提供自己的 Session 菜单。需要接管菜单时，同步调用
`preventDefault()`：

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

事件详情包含 `id`、`path`、`cwd`、可选的 `name`、指针坐标，以及用于刷新
Session 列表的 `refresh()`。如果没有监听器取消该事件，Pi Web 会保留浏览器
原生右键菜单。该接口位于浏览器端，与 pi Agent 扩展相互独立。

### 扩展 Session 存活状态

带有分离任务的服务端 Pi 扩展可以通过版本化全局注册表阻止自动空闲驱逐：

```js
const liveness = globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")];
const release = liveness?.version === 1
  ? liveness.register({
      name: "my-extension",
      sessionId,
      sessionFile: sessionFile || undefined,
      isActive: () => detachedJobs.size > 0,
    })
  : () => {};
```

每个活跃的扩展 Session 注册一次，并在 Session 关闭、替换或重新加载时调用
返回的幂等 `release`。`isActive` 必须同步、轻量，并只判断传入的精确
Session ID 或文件。Provider 错误会安全地保留该 Session。该租约只影响自动
空闲驱逐，显式关闭和 Stop 回退清理仍然优先。

## 开发

```bash
npm install
npm run dev
```

开发服务器运行在
[http://127.0.0.1:30141](http://127.0.0.1:30141)。常用检查命令：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
npm run test:e2e:gateway
```

日常开发时不要运行 `next build` 或 `npm run build`。它们会写入 `.next/`，
可能干扰开发服务器；仅在发布流程中执行构建。

贡献者文档：[国际化](./docs/i18n.md)、[发布流程](./docs/release.md)。

## 仓库结构

```text
app/             Next.js 界面和 API 路由
components/      React 界面组件
hooks/           客户端状态和交互 hooks
lib/             会话、智能体、模型、文件、Git 和安全逻辑
gateway/         独立认证、代理和审计服务
public/          静态资源和 PWA 文件
bin/             npm CLI 入口及启动参数解析
deploy/          systemd unit 和示例环境文件
docs/            面向用户和贡献者的专题文档
```

架构说明和详细文件地图见 [AGENTS.md](./AGENTS.md)。

## 许可证

[MIT](./LICENSE)
