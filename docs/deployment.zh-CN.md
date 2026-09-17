# Debian 单用户部署

本文描述 Pi Web 的单用户生产部署方式。公网只连接 `pi-web-gateway`，
Gateway 独立负责认证、Passkey/TOTP、Session、限流和审计；TLS 可以由
Caddy 终止，也可以由 Gateway 直接终止。Pi Web Agent 只监听
`127.0.0.1:30141`，不会收到浏览器的登录 Cookie、API Token 或 Gateway
的加密密钥。

不要继续把旧的 `PI_WEB_PASSWORD` 模式直接暴露到公网。旧模式只保留给
本机开发和可信私网；需要随时从公网访问时使用下面的 Gateway 模式。

本方案默认不创建新用户，直接使用 Debian 上已有的非 root 登录账号运行
两个服务。先设置：

```bash
export PI_WEB_USER="$(id -un)"
export PI_WEB_GROUP="$(id -gn)"
```

不要使用 `root` 运行 Agent。单用户模式减少了系统用户隔离，Gateway
和 Agent 共享同一个账号；如果 Agent 扩展或终端被攻破，攻击面会更大。
仅供个人使用，建议只在受控主机和 HTTPS 入口下使用。

## 目录

```text
/opt/pi-web/releases/<release-id>  不可变的应用构建产物
/opt/pi-web/current                指向当前发布目录的符号链接
/etc/pi-web/pi-web.env             Agent 环境变量
/etc/pi-web/pi-web-gateway.env     Gateway 环境变量
/var/lib/pi-web                    Agent 会话、模型凭据和插件数据
/var/lib/pi-web-gateway            Gateway 数据库和密钥
/srv/pi-web                        项目工作区
```

在 Debian 上执行：

```bash
sudo install -d -o "$PI_WEB_USER" -g "$PI_WEB_GROUP" -m 0700 /var/lib/pi-web /var/lib/pi-web-gateway /srv/pi-web
sudo install -d -o root -g root -m 0750 /etc/pi-web
sudo install -d -o root -g root -m 0755 /opt/pi-web /opt/pi-web/releases
```

安装 Node.js 22.19.0 或更高版本，并确保服务使用系统级
`/usr/bin/node`。两个服务共享发布目录和同一个账号，但数据目录分开。
环境文件、会话数据和 Gateway 状态都放在发布目录之外，升级应用时不会被
覆盖。

## 构建发布目录

在构建机或服务器上为每个版本构建一个独立目录。`PI_WEB_REVISION` 应使用
已经验证过的发布 tag 或 commit；下面的 `origin/main` 只适合首次安装或
受控的开发部署。构建机应与生产服务器使用相同的 OS 和 CPU 架构；否则
`node-pty` 等原生依赖可能无法运行。

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
sudo install -d -o root -g root -m 0755 "$release_dir"
sudo cp -a .next bin deploy gateway public next.config.ts package.json package-lock.json node_modules "$release_dir/"
sudo chown -R root:root "$release_dir"
sudo chmod -R u=rwX,go=rX "$release_dir"
sudo chmod 0755 "$release_dir"
sudo ln -sfn "$release_dir" /opt/pi-web/current
```

生产环境不要直接在 `/opt/pi-web` 里执行 `npm ci` 或 `npm run build`。每次
更新都生成新的 `release-id`，完成构建和权限检查后再切换
`/opt/pi-web/current`。旧发布目录可以保留到新版本验证完成，用于快速回滚。

## 生成 Gateway 密钥

在当前 shell 定义一个 Gateway 命令，后续初始化、Token 和审计操作都复用它：

```bash
pi_gateway() {
  sudo -u "$PI_WEB_USER" env \
    HOME=/var/lib/pi-web-gateway \
    PI_WEB_AUTH_MODE=gateway \
    PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
    PI_WEB_GATEWAY_HOST=127.0.0.1 \
    PI_WEB_GATEWAY_PORT=30142 \
    PI_WEB_GATEWAY_STATE_DIR=/var/lib/pi-web-gateway \
    PI_WEB_TRUSTED_PROXIES=127.0.0.1/32 \
    /usr/bin/node /opt/pi-web/current/bin/pi-web-gateway.js "$@"
}
pi_gateway init
```

命令会在 `/var/lib/pi-web-gateway` 下生成 `secrets.json` 和
`attestation.env`，并输出 `PI_WEB_GATEWAY_ATTESTATION_SECRET`。把这个值
放进两个环境文件；不要把值写进项目、脚本或日志。

## 配置服务

复制并修改示例文件：

```bash
sudo install -m 0644 /opt/pi-web/current/deploy/pi-web.env.example /etc/pi-web/pi-web.env
sudo install -m 0644 /opt/pi-web/current/deploy/pi-web-gateway.env.example /etc/pi-web/pi-web-gateway.env
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
sudo chown root:root /etc/pi-web/pi-web.env /etc/pi-web/pi-web-gateway.env
sudo chmod 0600 /etc/pi-web/pi-web.env /etc/pi-web/pi-web-gateway.env
```

如果 Gateway 和 Agent 使用不同的 `PI_WEB_AUTH_USERNAME`，初始化后不要
随意修改，否则现有用户将无法登录。

## 启动服务

安装 unit 文件：

```bash
sudo install -m 0644 /opt/pi-web/current/deploy/pi-web-gateway@.service /etc/systemd/system/pi-web-gateway@.service
sudo install -m 0644 /opt/pi-web/current/deploy/pi-web@.service /etc/systemd/system/pi-web@.service
sudo systemctl daemon-reload
sudo systemctl enable --now "pi-web-gateway@$PI_WEB_USER" "pi-web@$PI_WEB_USER"
sudo systemctl status "pi-web-gateway@$PI_WEB_USER" "pi-web@$PI_WEB_USER"
```

查看 Gateway 日志：

```bash
sudo journalctl -u "pi-web-gateway@$PI_WEB_USER" -f
```

此时 Gateway 的 `/healthz` 返回 200，但访问首页会跳转到 `/auth/login`。
Agent 的 `30141` 端口不应从外部访问。

## 初始化 Passkey 和验证器

在 Gateway 所在主机上生成一次性初始化代码：

```bash
pi_gateway bootstrap
```

然后从浏览器访问 `https://pi.example.com/auth/setup`，输入代码：

1. 扫描或复制 TOTP 密钥到验证器。
2. 注册一个 Passkey。
3. 设置至少 16 位的登录密码，并输入验证器代码。
4. 将页面上显示的一次性恢复码离线保存。

初始化完成后，Gateway 不再接受初始化代码。初始终端输出中的代码应立即
作废。Passkey 是首选登录方式；兼容登录必须同时提交密码和验证器代码，
不接受单独的密码或单独的 TOTP 代码。

初始化代码有效期为 15 分钟，而且只能使用一次。代码在成功开始初始化时
即被消耗；如果后续的 TOTP、Passkey 或密码步骤失败，旧代码也不能再次
使用。初始化挑战本身只有 10 分钟，应在一个新浏览器标签页中一次完成。

### 初始化故障排查

`Invalid or expired setup code` 表示代码不存在、已经使用或已经过期。
重新运行 `pi_gateway bootstrap`，复制完整的新代码后，从一个新的无痕
窗口重新访问 `/auth/setup`。不要继续提交旧代码。

`Too many authentication requests` 表示初始化请求预算已经用尽。可以等待
响应中的 `Retry-After`，或者在确认是本机维护操作后重启 Gateway 清空
进程内的限流计数：

```bash
sudo systemctl restart "pi-web-gateway@$PI_WEB_USER"
curl -fsS https://pi.example.com/api/auth/status
```

确认状态仍为 `setupRequired:true` 后，再运行 `pi_gateway bootstrap` 生成
新代码。只提交一次代码，不要反复点击、刷新或重复打开初始化页面。如果
状态已经显示 `setupRequired:false`，说明初始化已经完成，应直接前往登录
页，不要再生成初始化代码。

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

证书和私钥应只对 root 和运行 Gateway 的账号可读：

```bash
sudo install -d -o root -g "$PI_WEB_GROUP" -m 0750 /etc/pi-web/tls
sudo install -o root -g "$PI_WEB_GROUP" -m 0640 fullchain.pem /etc/pi-web/tls/fullchain.pem
sudo install -o root -g "$PI_WEB_GROUP" -m 0640 privkey.pem /etc/pi-web/tls/privkey.pem
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
pi_gateway token create --name laptop-cli --scope agent:read --expires-days 30
```

需要长期运行的自动化必须显式使用 `--no-expiry`；不建议为一般客户端使用
永不过期的 Token。下面的命令沿用同样的 Gateway 环境变量。查看和撤销：

```bash
pi_gateway token list
pi_gateway token revoke <token-id>
```

查看最近的登录、Token、Session 和 Passkey 审计事件：

```bash
pi_gateway audit list --limit 100
```

撤销全部浏览器 Session：

```bash
pi_gateway sessions revoke-all
```

如果验证器设备丢失，可在确认本机权限后轮换 TOTP 密钥；这会同时撤销所有
浏览器 Session：

```bash
pi_gateway totp-reset
```

恢复码泄漏或数量不足时，可一次性重新生成全部恢复码：

```bash
pi_gateway recovery regenerate
```

恢复码丢失时，可在本机通过验证器和恢复码登录后重新注册设备；如果所有
认证因素都丢失，需要从备份恢复 Gateway 数据，或重新执行初始化。

## 更新发布

更新只切换应用发布目录；`/etc/pi-web`、`/var/lib/pi-web`、
`/var/lib/pi-web-gateway` 和 `/srv/pi-web` 都应该保留。部署前先记录当前
发布和系统状态：

```bash
readlink -f /opt/pi-web/current
systemctl is-active "pi-web@$PI_WEB_USER" "pi-web-gateway@$PI_WEB_USER"
```

按“构建发布目录”一节构建新的 `release_id`，不要把新版本直接覆盖到旧
目录。确认新目录可以由 `$PI_WEB_USER` 读取，并且 Gateway 数据库备份已经
完成，然后执行短时停机切换：

```bash
sudo systemctl stop "pi-web-gateway@$PI_WEB_USER" "pi-web@$PI_WEB_USER"
sudo install -m 0644 /opt/pi-web/releases/<new-release-id>/deploy/pi-web@.service /etc/systemd/system/pi-web@.service
sudo install -m 0644 /opt/pi-web/releases/<new-release-id>/deploy/pi-web-gateway@.service /etc/systemd/system/pi-web-gateway@.service
sudo systemctl daemon-reload
sudo ln -sfn /opt/pi-web/releases/<new-release-id> /opt/pi-web/current
sudo systemctl start "pi-web@$PI_WEB_USER" "pi-web-gateway@$PI_WEB_USER"
```

新版本可能增加环境变量。不要用示例文件覆盖现有的
`/etc/pi-web/pi-web.env` 或 `/etc/pi-web/pi-web-gateway.env`；应先对比
`/opt/pi-web/current/deploy/*.env.example`，再手动合并变化。

启动后验证：

```bash
sudo systemctl is-active "pi-web@$PI_WEB_USER" "pi-web-gateway@$PI_WEB_USER"
sudo journalctl -u "pi-web-gateway@$PI_WEB_USER" -n 50 --no-pager
curl -fsS https://pi.example.com/healthz
curl -i https://pi.example.com/api/auth/status
```

保留至少一个可用的旧 `releases/<release-id>`。如果新版本有问题，先停止
服务并切回旧目录，再重新安装该目录中的 systemd unit。若新版本升级了
Gateway 数据库 schema，旧版本不能直接读取新数据库；这种情况下必须恢复
发布前的 Gateway 数据备份后再回滚。详细恢复顺序见下一节。

## 备份

备份时停止两个服务，或至少确保 Gateway 数据库和 Agent 数据的一致性：

```bash
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -o root -g root -m 0700 /var/backups/pi-web
sudo systemctl stop "pi-web-gateway@$PI_WEB_USER" "pi-web@$PI_WEB_USER"
sudo tar -C /var/lib -czf "/var/backups/pi-web/data-$backup_stamp.tgz" pi-web pi-web-gateway
sudo tar -C /srv -czf "/var/backups/pi-web/projects-$backup_stamp.tgz" pi-web
sudo chmod 0600 "/var/backups/pi-web/data-$backup_stamp.tgz" "/var/backups/pi-web/projects-$backup_stamp.tgz"
sudo systemctl start "pi-web-gateway@$PI_WEB_USER" "pi-web@$PI_WEB_USER"
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

1. 停止 `pi-web-gateway@$PI_WEB_USER` 和 `pi-web@$PI_WEB_USER`。
2. 解压基础数据备份，至少恢复 `pi-web-gateway/auth.db`、
   `pi-web-gateway/secrets.json`、`pi-web-gateway/attestation.env` 和
   `pi-web/.pi/agent`。
3. 将对应版本的构建产物放回 `/opt/pi-web/releases/<release-id>`，并
   将 `/opt/pi-web/current` 切换回该目录；同时恢复该目录中的 systemd
   unit 文件。
4. 启动两个服务，访问 `/healthz` 和 `/api/auth/status`，再用已有 Passkey
   或恢复码完成一次登录。
5. 检查 `journalctl -u "pi-web-gateway@$PI_WEB_USER"` 中没有 schema、TLS 或 Secret
   不匹配错误。

回滚应用版本时，先停止服务，再恢复旧版本构建和 systemd unit，最后恢复与
新版本发布前一致的 Gateway 数据库。不要只回滚程序而保留新 schema
数据库；这会被 schema 版本检查拒绝。每次发布都应记录 release-id、数据库
schema 版本、备份文件路径和校验值。

## 本机开发

不需要远程访问时，可以不设置 `PI_WEB_AUTH_MODE`，使用原来的
`127.0.0.1` 加 `PI_WEB_PASSWORD` 模式。该模式不应监听 `0.0.0.0`，
也不应放在公网入口。

本地单独测试 Gateway 时，`PI_WEB_PUBLIC_ORIGIN` 必须使用
`http://localhost:<port>`，不能使用 `http://127.0.0.1:<port>`；WebAuthn
的 RP ID 不接受 IP 地址。Agent 后端仍可继续监听 `127.0.0.1`。
