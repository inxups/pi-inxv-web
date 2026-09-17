# Pi Web

[English](./README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

[pi 编程智能体](https://github.com/earendil-works/pi)的本地浏览器界面。Pi Web 与 pi 共用本机配置和会话文件，可在浏览器中查找和继续对话、运行智能体、配置模型与资源，并查看项目文件。

中文微信群：请查看 [GitHub Discussions 帖子](https://github.com/agegr/pi-web/discussions/271)。

![Pi Web 展示包含结构化 Markdown、工具调用和项目导航的 pi 会话](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## 功能

- **会话工作区**：按项目查找、继续、重命名、导出和删除对话，并查看运行状态、上下文占用、花费和压缩信息。
- **两种分支方式**：**新会话**会从较早的消息创建独立会话文件；**从此处编辑**会在当前会话内创建分支。
- **项目文件工具**：浏览和上传文件、查看 Git Diff，并预览源码、Markdown、图片、音频、PDF 和 DOCX；文件变化后会自动刷新。
- **Git worktree**：从侧边栏切换 checkout，同时把同一仓库不同 worktree 的会话归在一起。
- **网页配置**：无需离开 Pi Web，即可管理 Provider 登录和 API Key、模型、模型测试、插件包及技能。
- **英文、简体中文和繁体中文界面**：Pi Web 首次打开时跟随浏览器语言，也可从顶部栏切换语言。

## 快速开始

Pi Web 要求 Node.js 22.19.0 或更高版本。先用 `node --version` 检查版本，然后运行：

```bash
npx @agegr/pi-web@latest
```

服务就绪后，命令行会尝试自动打开浏览器。如果没有打开，请访问 [http://127.0.0.1:30141](http://127.0.0.1:30141)。Pi Web 默认仅监听 `127.0.0.1`。

如果尚未配置模型 Provider，请打开**模型（Models）**面板登录或添加 API Key。

如需全局安装 `pi-web` 命令：

```bash
npm install -g @agegr/pi-web@latest
pi-web
```

更新前先用 `Ctrl+C` 停止正在运行的进程，再次执行同一条安装命令。卸载时运行 `npm uninstall -g @agegr/pi-web`。

## 生产部署

服务器或公网部署应使用 `pi-web-gateway`，不要直接暴露 Agent。Gateway
使用独立系统用户运行，认证、TLS、Session 和审计数据都放在应用发布目录
之外。完整的 Debian/Ubuntu 安装、Caddy、防火墙、备份、恢复和更新步骤见
[数据中心部署](./docs/deployment.zh-CN.md)。

前置条件：带 systemd 的 Linux、Git、Node.js 22.19.0 或更高版本、
`sudo`，以及可签发 HTTPS 证书的 DNS 域名。WebAuthn 不接受 IP 地址，
`PI_WEB_PUBLIC_ORIGIN` 必须使用域名。Node 应系统级安装到 `/usr/bin/node`；
示例 systemd unit 使用这个路径。

### 首次安装

创建服务用户和可更新的发布目录：

```bash
sudo useradd --system --create-home --home-dir /var/lib/pi-web --shell /usr/sbin/nologin piweb
sudo useradd --system --create-home --home-dir /var/lib/pi-web-gateway --shell /usr/sbin/nologin piweb-gateway
sudo install -d -o piweb -g piweb -m 0700 /var/lib/pi-web /srv/pi-web
sudo install -d -o piweb-gateway -g piweb-gateway -m 0700 /var/lib/pi-web-gateway
sudo install -d -o root -g piweb -m 0750 /etc/pi-web
sudo install -d -o root -g piweb -m 0755 /opt/pi-web /opt/pi-web/releases
```

在与生产环境相同的 OS 和 CPU 架构上构建一个不可变发布目录。更新时把
`PI_WEB_REVISION` 改成已经验证过的发布 tag 或 commit：

```bash
export PI_WEB_REPO=https://github.com/inxups/pi-inxv-web.git
export PI_WEB_REVISION=origin/main
build_root="$(mktemp -d)"
git clone "$PI_WEB_REPO" "$build_root/src"
cd "$build_root/src"
git fetch --tags --prune
git checkout --detach "$PI_WEB_REVISION"
npm ci
npm run build
release_id="$(node -p "require('./package.json').version")-$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
release_dir="/opt/pi-web/releases/$release_id"
sudo install -d -o root -g piweb -m 0755 "$release_dir"
sudo cp -a .next bin deploy gateway public next.config.ts package.json package-lock.json node_modules "$release_dir/"
sudo chown -R root:piweb "$release_dir"
sudo chmod -R u=rwX,go=rX "$release_dir"
sudo chmod 0755 "$release_dir"
sudo ln -sfn "$release_dir" /opt/pi-web/current
```

生成 Gateway 密钥并安装配置示例：

```bash
sudo -u piweb-gateway env HOME=/var/lib/pi-web-gateway \
  PI_WEB_AUTH_MODE=gateway \
  PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
  PI_WEB_GATEWAY_STATE_DIR=/var/lib/pi-web-gateway \
  /usr/bin/node /opt/pi-web/current/bin/pi-web-gateway.js init

sudo install -m 0644 /opt/pi-web/current/deploy/pi-web.env.example /etc/pi-web/pi-web.env
sudo install -m 0644 /opt/pi-web/current/deploy/pi-web-gateway.env.example /etc/pi-web/pi-web-gateway.env
sudo editor /etc/pi-web/pi-web.env /etc/pi-web/pi-web-gateway.env
```

两个文件中的 `PI_WEB_GATEWAY_ATTESTATION_SECRET` 必须完全一致，并把
`pi.example.com` 换成你的实际域名。然后安装并启动服务：

```bash
sudo chown root:piweb /etc/pi-web/pi-web.env
sudo chown root:piweb-gateway /etc/pi-web/pi-web-gateway.env
sudo chmod 0640 /etc/pi-web/pi-web.env /etc/pi-web/pi-web-gateway.env
sudo install -m 0644 /opt/pi-web/current/deploy/pi-web.service /etc/systemd/system/pi-web.service
sudo install -m 0644 /opt/pi-web/current/deploy/pi-web-gateway.service /etc/systemd/system/pi-web-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-web pi-web-gateway
```

使用 Caddy 或其他反向代理终止 HTTPS，并且只转发到 Gateway。推荐的 Caddy
配置如下：

```text
pi.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:30142
}
```

不要把 `30141` 或 `30142` 暴露到公网。完整的 Caddy 和防火墙配置见部署
文档。

生成一次性初始化代码，然后打开 `https://<你的域名>/auth/setup`：

```bash
sudo -u piweb-gateway env HOME=/var/lib/pi-web-gateway \
  PI_WEB_AUTH_MODE=gateway \
  PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
  PI_WEB_GATEWAY_STATE_DIR=/var/lib/pi-web-gateway \
  PI_WEB_GATEWAY_ATTESTATION_SECRET="$(sudo cat /var/lib/pi-web-gateway/attestation.env | cut -d= -f2-)" \
  /usr/bin/node /opt/pi-web/current/bin/pi-web-gateway.js bootstrap
```

### 更新

应用更新只替换 `/opt/pi-web/releases/<release-id>` 并切换
`/opt/pi-web/current` 符号链接。`/etc/pi-web` 配置、`/var/lib/pi-web`
Agent 数据、`/var/lib/pi-web-gateway` Gateway 数据和 `/srv/pi-web` 项目
不会被覆盖。

更新前先备份数据目录并记录当前发布目录。使用上面的构建命令生成新发布
目录，然后短时停服并切换：

```bash
sudo systemctl stop pi-web-gateway pi-web
sudo install -m 0644 /opt/pi-web/releases/<new-release-id>/deploy/pi-web.service /etc/systemd/system/pi-web.service
sudo install -m 0644 /opt/pi-web/releases/<new-release-id>/deploy/pi-web-gateway.service /etc/systemd/system/pi-web-gateway.service
sudo systemctl daemon-reload
sudo ln -sfn /opt/pi-web/releases/<new-release-id> /opt/pi-web/current
sudo systemctl start pi-web pi-web-gateway
```

新版本验证完成前保留旧发布目录。不要用示例文件覆盖现有的环境文件；新增
变量应手动合并。如果新版本升级了 Gateway 数据库 schema，回滚应用前必须
恢复发布前的 Gateway 数据备份。完整步骤见
[数据中心部署](./docs/deployment.zh-CN.md)。

## 配置

端口和主机名以命令行参数为准，优先于对应的环境变量。`--no-open` 与 `PI_WEB_NO_OPEN=1` 中任意一个都会关闭自动打开浏览器。运行 `pi-web --help`（或 `-h`）可打印启动选项并以退出码 0 结束，不会启动服务；未知参数会报错并以退出码 1 结束。

| 参数或环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `--help`、`-h` | 打印启动选项并退出 | — |
| `--port <端口>`、`-p <端口>` 或 `PORT` | 服务端口 | `30141` |
| `--hostname <主机>`、`-H <主机>` 或 `PI_WEB_HOSTNAME` | 监听主机名 | `127.0.0.1` |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `PI_WEB_ALLOWED_HOSTS` | 额外允许的代理或自定义主机名，多个值用逗号分隔，必须精确匹配 | 未设置 |
| `PI_WEB_AUTH_MODE` | 认证模式：`local` 使用旧密码模式，`gateway` 只接受独立 Gateway 的内部断言 | `local` |
| `PI_WEB_PASSWORD` | 仅用于 `local` 模式的浏览器密码登录和 Basic Auth | 不启用认证 |

例如：

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### 远程访问

公网或跨网络访问应使用 `pi-web-gateway`。它使用独立系统用户运行，负责
HTTPS、Passkey、密码加 TOTP、服务端 Session、限流和审计；Agent 仍只监听
`127.0.0.1`，不会收到登录 Cookie 或 API Token。

```bash
PI_WEB_AUTH_MODE=gateway \
PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
PI_WEB_GATEWAY_HOST=127.0.0.1 \
PI_WEB_GATEWAY_PORT=30142 \
pi-web-gateway serve
```

首次使用需要先执行 `pi-web-gateway init` 生成密钥，再执行
`pi-web-gateway bootstrap` 生成一次性初始化代码。完整步骤见
[数据中心部署](./docs/deployment.zh-CN.md)。

Gateway API Token 默认是 `agent:read` 和 30 天有效期，写操作需显式选择
`agent:write`；Token 不能管理 Gateway 账号或 Session。登录、Token 和
Session 事件可用 `pi-web-gateway audit list` 查看。

`PI_WEB_PASSWORD` 模式不适合作为公网入口：它没有 MFA、没有服务端撤销，
而且密码校验代码与 Agent 扩展在同一进程内。若只在可信局域网临时使用，
仍应设置足够长的随机密码，并通过 HTTPS 或 VPN 访问。

生产环境部署、systemd 和 Caddy 示例见
[数据中心部署](./docs/deployment.zh-CN.md)。

### HTTP 代理

服务端的模型和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。

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

## 注意事项

- **智能体数据**：Pi Web 默认读取 `~/.pi/agent` 下的 pi 数据，包括 `sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl` 中的会话文件。可通过 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **文件系统访问**：Pi Web 必须能读取智能体数据目录及会话记录中的工作目录。与现有 pi 会话共用数据时，请让 Pi Web 运行在与 pi 相同的文件系统环境中。
- **共享配置**：模型面板使用 pi 的模型、设置和凭据存储，因此两种界面都能看到相关更改。
- **文件访问边界**：文件浏览器仅能访问在 Pi Web 中选择过的工作目录，以及它已识别的项目或会话根目录；它不是通用的文件系统浏览器。
- **Git worktree**：切换器何时显示、如何创建 worktree，以及删除会产生什么影响，见 [Pi Web 里的 Worktree](./docs/worktrees.zh-CN.md)。

## 开发

```bash
npm install
npm run dev
```

开发服务器运行在 [http://127.0.0.1:30141](http://127.0.0.1:30141)。常用检查命令：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
npm run test:e2e:gateway
```

日常开发时不要运行 `next build` 或 `npm run build`。它们会写入 `.next/`，可能干扰开发服务器；仅在发布流程中执行构建。

贡献者文档：[国际化](./docs/i18n.md)和[发布流程](./docs/release.md)。

## 仓库结构

```text
app/             Next.js 界面和 API 路由
components/      React 界面组件
hooks/           客户端状态和交互 hooks
lib/             会话、智能体、模型、文件、Git 和安全逻辑
public/          静态资源和 PWA 文件
bin/             npm CLI 入口及启动参数解析
docs/            面向用户和贡献者的专题文档
```

架构说明和详细文件地图见 [AGENTS.md](./AGENTS.md)。

## 许可证

[MIT](./LICENSE)
