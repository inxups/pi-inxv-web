# 数据中心部署

本文描述 Pi Web 的单用户生产部署方式。公网只连接 `pi-web-gateway`，
Gateway 独立负责 TLS、Passkey/TOTP、Session、限流和审计。Pi Web Agent
只监听 `127.0.0.1:30141`，不会收到浏览器的登录 Cookie、API Token 或
Gateway 的加密密钥。

不要继续把旧的 `PI_WEB_PASSWORD` 模式直接暴露到公网。旧模式只保留给
本机开发和可信私网；需要随时从公网访问时使用下面的 Gateway 模式。

## 目录和用户

```text
/opt/pi-web                        应用构建产物
/etc/pi-web/pi-web.env             Agent 环境变量
/etc/pi-web/pi-web-gateway.env     Gateway 环境变量
/var/lib/pi-web                    Agent 会话、模型凭据和插件数据
/var/lib/pi-web-gateway            Gateway 数据库和密钥
/srv/pi-web                        项目工作区
```

在 Debian 或 Ubuntu 上执行：

```bash
sudo useradd --system --create-home --home-dir /var/lib/pi-web --shell /usr/sbin/nologin piweb
sudo useradd --system --create-home --home-dir /var/lib/pi-web-gateway --shell /usr/sbin/nologin piweb-gateway
sudo install -d -o piweb -g piweb -m 0700 /var/lib/pi-web /srv/pi-web
sudo install -d -o piweb-gateway -g piweb-gateway -m 0700 /var/lib/pi-web-gateway
sudo install -d -o root -g piweb -m 0750 /etc/pi-web /opt/pi-web
```

安装 Node.js 22.19.0 或更高版本。两个服务都使用同一个构建目录，但使用不同
系统用户和不同的可写数据目录。

## 构建

在构建机或服务器上执行：

```bash
cd /opt/pi-web
npm ci
npm run build
sudo chown -R root:piweb /opt/pi-web
sudo find /opt/pi-web -type d -exec chmod 0755 {} \;
sudo find /opt/pi-web -type f -exec chmod 0644 {} \;
sudo chmod 0755 /opt/pi-web/bin/pi-web.js /opt/pi-web/bin/pi-web-gateway.js
```

生产环境不要直接复制开发目录的 `.next`。升级时建议先在临时目录执行
`npm ci` 和 `npm run build`，验证后再替换发布目录。

## 生成 Gateway 密钥

先创建 Gateway 配置，至少设置：

```bash
sudo install -d -o piweb-gateway -g piweb-gateway -m 0700 /var/lib/pi-web-gateway
sudo -u piweb-gateway env \
  HOME=/var/lib/pi-web-gateway \
  PI_WEB_AUTH_MODE=gateway \
  PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
  PI_WEB_GATEWAY_HOST=127.0.0.1 \
  PI_WEB_GATEWAY_PORT=30142 \
  PI_WEB_GATEWAY_STATE_DIR=/var/lib/pi-web-gateway \
  /usr/bin/node /opt/pi-web/bin/pi-web-gateway.js init
```

命令会在 `/var/lib/pi-web-gateway` 下生成 `secrets.json` 和
`attestation.env`，并输出 `PI_WEB_GATEWAY_ATTESTATION_SECRET`。把这个值
放进两个环境文件；不要把值写进项目、脚本或日志。

## 配置服务

复制并修改示例文件：

```bash
sudo install -m 0644 /opt/pi-web/deploy/pi-web.env.example /etc/pi-web/pi-web.env
sudo install -m 0644 /opt/pi-web/deploy/pi-web-gateway.env.example /etc/pi-web/pi-web-gateway.env
sudo editor /etc/pi-web/pi-web.env /etc/pi-web/pi-web-gateway.env
```

两个文件必须使用完全相同的
`PI_WEB_GATEWAY_ATTESTATION_SECRET`。Agent 环境必须包含：

```text
PI_WEB_AUTH_MODE=gateway
PI_WEB_HOSTNAME=127.0.0.1
PI_WEB_ALLOWED_HOSTS=pi.example.com
PI_WEB_GATEWAY_ATTESTATION_SECRET=...
```

收紧权限：

```bash
sudo chown root:piweb /etc/pi-web/pi-web.env
sudo chown root:piweb-gateway /etc/pi-web/pi-web-gateway.env
sudo chmod 0640 /etc/pi-web/pi-web.env /etc/pi-web/pi-web-gateway.env
```

如果 Gateway 和 Agent 使用不同的 `PI_WEB_AUTH_USERNAME`，初始化后不要
随意修改，否则现有用户将无法登录。

## 启动服务

安装 unit 文件：

```bash
sudo install -m 0644 /opt/pi-web/deploy/pi-web-gateway.service /etc/systemd/system/pi-web-gateway.service
sudo install -m 0644 /opt/pi-web/deploy/pi-web.service /etc/systemd/system/pi-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-web-gateway pi-web
sudo systemctl status pi-web-gateway pi-web
```

查看 Gateway 日志：

```bash
sudo journalctl -u pi-web-gateway -f
```

此时 Gateway 的 `/healthz` 返回 200，但访问首页会跳转到 `/auth/login`。
Agent 的 `30141` 端口不应从外部访问。

## 初始化 Passkey 和验证器

在 Gateway 所在主机上生成一次性初始化代码：

```bash
sudo -u piweb-gateway env \
  HOME=/var/lib/pi-web-gateway \
  PI_WEB_AUTH_MODE=gateway \
  PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
  PI_WEB_GATEWAY_HOST=127.0.0.1 \
  PI_WEB_GATEWAY_PORT=30142 \
  PI_WEB_GATEWAY_STATE_DIR=/var/lib/pi-web-gateway \
  PI_WEB_GATEWAY_ATTESTATION_SECRET="$(sudo cat /var/lib/pi-web-gateway/attestation.env | cut -d= -f2-)" \
  /usr/bin/node /opt/pi-web/bin/pi-web-gateway.js bootstrap
```

然后从浏览器访问 `https://pi.example.com/auth/setup`，输入代码：

1. 扫描或复制 TOTP 密钥到验证器。
2. 注册一个 Passkey。
3. 设置至少 16 位的登录密码，并输入验证器代码。
4. 将页面上显示的一次性恢复码离线保存。

初始化完成后，Gateway 不再接受初始化代码。初始终端输出中的代码应立即
作废。Passkey 是首选登录方式；兼容登录必须同时提交密码和验证器代码，
不接受单独的密码或单独的 TOTP 代码。

## HTTPS 入口

### 方式一：Caddy 只负责 TLS

这是推荐的低风险部署。Caddy 只提供 HTTPS，不配置自己的认证：

```text
pi.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:30142
}
```

Gateway 配置保持：

```text
PI_WEB_GATEWAY_HOST=127.0.0.1
PI_WEB_GATEWAY_PORT=30142
PI_WEB_PUBLIC_ORIGIN=https://pi.example.com
PI_WEB_TRUSTED_PROXIES=127.0.0.1/32
PI_WEB_GATEWAY_UPSTREAM_TIMEOUT_MS=120000
PI_WEB_GATEWAY_PROXY_REQUEST_LIMIT=600
PI_WEB_GATEWAY_PROXY_REQUEST_WINDOW_MS=60000
```

`PI_WEB_TRUSTED_PROXIES` 只允许回环代理提供 `X-Forwarded-Proto` 和客户端
地址。`X-Forwarded-For` 会从右向左跳过显式配置的可信代理，只采用第一个
不可信地址；不要把代理 CIDR 放得过宽。

Gateway 为代理页面补发 nonce CSP，并为每个已认证 Session 配置请求预算。
`PI_WEB_GATEWAY_UPSTREAM_TIMEOUT_MS` 是 Agent 在收到数据前的空闲超时，
默认 120 秒。SSE 和终端流每 30 秒有心跳，不会因为正常空闲被提前断开。

### 方式二：Gateway 直接终止 TLS

如果需要 Gateway 直接监听公网：

```text
PI_WEB_GATEWAY_HOST=0.0.0.0
PI_WEB_GATEWAY_PORT=443
PI_WEB_TLS_CERT=/etc/pi-web/tls/fullchain.pem
PI_WEB_TLS_KEY=/etc/pi-web/tls/privkey.pem
```

证书和私钥应只对 root 和 `piweb-gateway` 可读：

```bash
sudo install -d -o root -g piweb-gateway -m 0750 /etc/pi-web/tls
sudo install -o root -g piweb-gateway -m 0640 fullchain.pem /etc/pi-web/tls/fullchain.pem
sudo install -o root -g piweb-gateway -m 0640 privkey.pem /etc/pi-web/tls/privkey.pem
```

非回环监听且没有 TLS 证书时 Gateway 会拒绝启动。

## 防火墙和验证

至少限制：

```text
允许 443/tcp 访问 pi-web-gateway
禁止公网访问 30141/tcp
禁止公网访问 30142/tcp，除非端口只监听回环
```

检查 Gateway 没有把认证 Cookie 传给 Agent：

```bash
curl -I http://127.0.0.1:30141/
```

Agent 直连应返回 401 或 403，而不是页面。检查 Gateway：

```bash
curl -I https://pi.example.com/
curl -i https://pi.example.com/api/auth/status
```

首页应跳转到 `/auth/login`，状态接口应显示 `setupRequired:false`。登录后
检查 Pi Web 设置页的退出功能，确认退出后现有浏览器 Session 立即失效。

## 会话、Token 和运维命令

创建可撤销的 API Token。默认是 `agent:read` 和 30 天有效期；需要写操作时
显式选择 `agent:write`。API Token 只能访问 Agent API，不能管理 Gateway
账号、Session、Passkey 或其他 Token：

```bash
sudo -u piweb-gateway env \
  HOME=/var/lib/pi-web-gateway \
  PI_WEB_AUTH_MODE=gateway \
  PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
  PI_WEB_GATEWAY_HOST=127.0.0.1 \
  PI_WEB_GATEWAY_STATE_DIR=/var/lib/pi-web-gateway \
  PI_WEB_GATEWAY_ATTESTATION_SECRET="$(sudo cat /var/lib/pi-web-gateway/attestation.env | cut -d= -f2-)" \
  /usr/bin/node /opt/pi-web/bin/pi-web-gateway.js token create \
    --name laptop-cli --scope agent:read --expires-days 30
```

需要长期运行的自动化必须显式使用 `--no-expiry`；不建议为一般客户端使用
永不过期的 Token。下面的命令沿用同样的 Gateway 环境变量。查看和撤销：

```bash
/usr/bin/node /opt/pi-web/bin/pi-web-gateway.js token list
/usr/bin/node /opt/pi-web/bin/pi-web-gateway.js token revoke <token-id>
```

查看最近的登录、Token、Session 和 Passkey 审计事件：

```bash
sudo -u piweb-gateway env \
  HOME=/var/lib/pi-web-gateway \
  PI_WEB_AUTH_MODE=gateway \
  PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
  PI_WEB_GATEWAY_HOST=127.0.0.1 \
  PI_WEB_GATEWAY_STATE_DIR=/var/lib/pi-web-gateway \
  PI_WEB_GATEWAY_ATTESTATION_SECRET="$(sudo cat /var/lib/pi-web-gateway/attestation.env | cut -d= -f2-)" \
  /usr/bin/node /opt/pi-web/bin/pi-web-gateway.js audit list --limit 100
```

撤销全部浏览器 Session：

```bash
sudo -u piweb-gateway env \
  HOME=/var/lib/pi-web-gateway \
  PI_WEB_AUTH_MODE=gateway \
  PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
  PI_WEB_GATEWAY_HOST=127.0.0.1 \
  PI_WEB_GATEWAY_STATE_DIR=/var/lib/pi-web-gateway \
  PI_WEB_GATEWAY_ATTESTATION_SECRET="$(sudo cat /var/lib/pi-web-gateway/attestation.env | cut -d= -f2-)" \
  /usr/bin/node /opt/pi-web/bin/pi-web-gateway.js sessions revoke-all
```

如果验证器设备丢失，可在确认本机权限后轮换 TOTP 密钥；这会同时撤销所有
浏览器 Session：

```bash
sudo -u piweb-gateway env \
  HOME=/var/lib/pi-web-gateway \
  PI_WEB_AUTH_MODE=gateway \
  PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
  PI_WEB_GATEWAY_HOST=127.0.0.1 \
  PI_WEB_GATEWAY_STATE_DIR=/var/lib/pi-web-gateway \
  PI_WEB_GATEWAY_ATTESTATION_SECRET="$(sudo cat /var/lib/pi-web-gateway/attestation.env | cut -d= -f2-)" \
  /usr/bin/node /opt/pi-web/bin/pi-web-gateway.js totp-reset
```

恢复码泄漏或数量不足时，可一次性重新生成全部恢复码：

```bash
sudo -u piweb-gateway env \
  HOME=/var/lib/pi-web-gateway \
  PI_WEB_AUTH_MODE=gateway \
  PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
  PI_WEB_GATEWAY_HOST=127.0.0.1 \
  PI_WEB_GATEWAY_STATE_DIR=/var/lib/pi-web-gateway \
  PI_WEB_GATEWAY_ATTESTATION_SECRET="$(sudo cat /var/lib/pi-web-gateway/attestation.env | cut -d= -f2-)" \
  /usr/bin/node /opt/pi-web/bin/pi-web-gateway.js recovery regenerate
```

恢复码丢失时，可在本机通过验证器和恢复码登录后重新注册设备；如果所有
认证因素都丢失，需要从备份恢复 Gateway 数据，或重新执行初始化。

## 备份

备份时停止两个服务，或至少确保 Gateway 数据库和 Agent 数据的一致性：

```bash
sudo systemctl stop pi-web-gateway pi-web
sudo tar -C /var/lib -czf pi-web-backup.tgz pi-web pi-web-gateway
sudo tar -C /srv -czf pi-web-projects.tgz pi-web
sudo systemctl start pi-web-gateway pi-web
```

必须单独保护：

```text
/var/lib/pi-web-gateway/secrets.json
/var/lib/pi-web-gateway/attestation.env
/var/lib/pi-web-gateway/auth.db
/var/lib/pi-web/.pi/agent
```

Gateway 数据库不含原始 Session Token 或 API Token；但它包含 Passkey
公钥、TOTP 密文、审计记录和加密所需元数据。备份仍应按敏感数据保护。
数据库使用 `PRAGMA user_version` 记录 schema 版本；Gateway 拒绝打开比当前
程序更新的数据库，避免旧版本静默破坏新数据。

## 恢复和回滚

先准备完整备份，再按下面的顺序恢复：

1. 停止 `pi-web-gateway` 和 `pi-web`。
2. 解压基础数据备份，至少恢复 `pi-web-gateway/auth.db`、
   `pi-web-gateway/secrets.json`、`pi-web-gateway/attestation.env` 和
   `pi-web/.pi/agent`。
3. 恢复对应版本的 `/opt/pi-web` 构建产物和 systemd unit。
4. 启动两个服务，访问 `/healthz` 和 `/api/auth/status`，再用已有 Passkey
   或恢复码完成一次登录。
5. 检查 `journalctl -u pi-web-gateway` 中没有 schema、TLS 或 Secret
   不匹配错误。

回滚应用版本时，先恢复旧版本构建，再恢复与新版本发布前一致的 Gateway
数据库。不要只回滚程序而保留新 schema 数据库；这会被 schema 版本检查拒绝。
每次发布都应记录 build 版本、数据库 schema 版本和备份文件校验值。

## 本机开发

不需要远程访问时，可以不设置 `PI_WEB_AUTH_MODE`，使用原来的
`127.0.0.1` 加 `PI_WEB_PASSWORD` 模式。该模式不应监听 `0.0.0.0`，
也不应放在公网入口。

本地单独测试 Gateway 时，`PI_WEB_PUBLIC_ORIGIN` 必须使用
`http://localhost:<port>`，不能使用 `http://127.0.0.1:<port>`；WebAuthn
的 RP ID 不接受 IP 地址。Agent 后端仍可继续监听 `127.0.0.1`。
