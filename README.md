# Pi Web

[中文文档](./README.zh-CN.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

Local browser UI for the [pi coding agent](https://github.com/earendil-works/pi). Pi Web uses the same local configuration and session files as pi, so you can browse and resume conversations, run agent turns, configure models and resources, and inspect project files from a browser.

![Pi Web displaying a pi session with structured Markdown, tool calls, and project navigation](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## Features

- **Session workspace**: browse, resume, rename, export, and delete conversations grouped by project, with running state, context usage, cost, and compaction details.
- **Two ways to branch**: **New session** creates an independent session file from an earlier message; **Edit from here** creates a branch inside the current session.
- **Project file tools**: browse and upload files, inspect Git diffs, and preview source, Markdown, images, audio, PDFs, and DOCX files with automatic refresh.
- **Git worktrees**: switch checkouts from the sidebar while keeping sessions from the same repository grouped together.
- **Web-based configuration**: manage provider login and API keys, models, model tests, plugin packages, and skills without leaving Pi Web.
- **English, Simplified Chinese, and Traditional Chinese UI**: Pi Web follows the browser language initially and provides a language switcher in the top bar.

## Quick Start

Pi Web requires Node.js 22.19.0 or newer. Check your version with `node --version`, then run:

```bash
npx @agegr/pi-web@latest
```

The CLI opens a browser after the server is ready. If it does not, open [http://127.0.0.1:30141](http://127.0.0.1:30141). Pi Web listens only on `127.0.0.1` by default.

If no model provider is configured yet, open the **Models** panel to sign in or add an API key.

To install the `pi-web` command globally:

```bash
npm install -g @agegr/pi-web@latest
pi-web
```

To update, stop the running process with `Ctrl+C` and run the same install command again. To uninstall, run `npm uninstall -g @agegr/pi-web`.

## Production Installation

For a server or public deployment, use `pi-web-gateway` rather than exposing the Agent directly. The Gateway runs as a separate system user and keeps authentication, TLS, sessions, and audit data outside the application release. The complete Debian/Ubuntu checklist, including Caddy, firewall rules, backup, recovery, and the detailed update procedure, is in [Data center deployment](./docs/deployment.zh-CN.md).

Prerequisites: Linux with systemd, Git, Node.js 22.19.0 or newer, `sudo`, and a DNS hostname with HTTPS. Install Node system-wide at `/usr/bin/node`; the sample systemd units use that path. WebAuthn requires a hostname; do not use an IP address as `PI_WEB_PUBLIC_ORIGIN`.

### First Install

Create the service accounts and release layout:

```bash
sudo useradd --system --create-home --home-dir /var/lib/pi-web --shell /usr/sbin/nologin piweb
sudo useradd --system --create-home --home-dir /var/lib/pi-web-gateway --shell /usr/sbin/nologin piweb-gateway
sudo install -d -o piweb -g piweb -m 0700 /var/lib/pi-web /srv/pi-web
sudo install -d -o piweb-gateway -g piweb-gateway -m 0700 /var/lib/pi-web-gateway
sudo install -d -o root -g piweb -m 0750 /etc/pi-web
sudo install -d -o root -g piweb -m 0755 /opt/pi-web /opt/pi-web/releases
```

Build an immutable release on the same OS and CPU architecture as production. Use a release tag or a tested commit for `PI_WEB_REVISION` when updating:

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

Initialize the Gateway secret and install the configuration examples:

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

Set the same `PI_WEB_GATEWAY_ATTESTATION_SECRET` in both files and replace `pi.example.com` with your hostname. Then install the services and start them:

```bash
sudo chown root:piweb /etc/pi-web/pi-web.env
sudo chown root:piweb-gateway /etc/pi-web/pi-web-gateway.env
sudo chmod 0640 /etc/pi-web/pi-web.env /etc/pi-web/pi-web-gateway.env
sudo install -m 0644 /opt/pi-web/current/deploy/pi-web.service /etc/systemd/system/pi-web.service
sudo install -m 0644 /opt/pi-web/current/deploy/pi-web-gateway.service /etc/systemd/system/pi-web-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-web pi-web-gateway
```

Terminate HTTPS with Caddy or another reverse proxy and forward to the Gateway only. The recommended Caddy configuration is:

```text
pi.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:30142
}
```

Do not expose `30141` or `30142` to the public network. The complete Caddy and firewall setup is in the detailed deployment guide.

Generate the one-time setup code and open `https://<your-hostname>/auth/setup`:

```bash
sudo -u piweb-gateway env HOME=/var/lib/pi-web-gateway \
  PI_WEB_AUTH_MODE=gateway \
  PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
  PI_WEB_GATEWAY_STATE_DIR=/var/lib/pi-web-gateway \
  PI_WEB_GATEWAY_ATTESTATION_SECRET="$(sudo cat /var/lib/pi-web-gateway/attestation.env | cut -d= -f2-)" \
  /usr/bin/node /opt/pi-web/current/bin/pi-web-gateway.js bootstrap
```

### Updating

Application updates only replace `/opt/pi-web/releases/<release-id>` and switch
the `/opt/pi-web/current` symlink. Configuration in `/etc/pi-web`, Agent data in
`/var/lib/pi-web`, Gateway state in `/var/lib/pi-web-gateway`, and projects in
`/srv/pi-web` stay in place.

Before updating, back up the data directories and note the current release. Build the new release with the same commands above, then switch it with a short service restart:

```bash
sudo systemctl stop pi-web-gateway pi-web
sudo install -m 0644 /opt/pi-web/releases/<new-release-id>/deploy/pi-web.service /etc/systemd/system/pi-web.service
sudo install -m 0644 /opt/pi-web/releases/<new-release-id>/deploy/pi-web-gateway.service /etc/systemd/system/pi-web-gateway.service
sudo systemctl daemon-reload
sudo ln -sfn /opt/pi-web/releases/<new-release-id> /opt/pi-web/current
sudo systemctl start pi-web pi-web-gateway
```

Keep the previous release until the new one has been verified. Do not overwrite the environment files from the examples; merge new variables manually. If a release changed the Gateway database schema, restore the pre-update Gateway backup before rolling the application back. See [Data center deployment](./docs/deployment.zh-CN.md) for the full update and rollback procedure.

## Configuration

For port and hostname, command-line options override the corresponding environment variables. Either `--no-open` or `PI_WEB_NO_OPEN=1` disables automatic browser opening. Run `pi-web --help` (or `-h`) to print startup options and exit without starting the server. Unknown options exit with an error.

| Option or environment variable | Purpose | Default |
| --- | --- | --- |
| `--help`, `-h` | Print startup options and exit | — |
| `--port <port>`, `-p <port>`, or `PORT` | Server port | `30141` |
| `--hostname <host>`, `-H <host>`, or `PI_WEB_HOSTNAME` | Bind hostname | `127.0.0.1` |
| `--no-open` or `PI_WEB_NO_OPEN=1` | Do not open a browser automatically | Browser opens |
| `PI_WEB_SKIP_VERSION_CHECK=1` | Disable Pi Web update checks | Unset |
| `PI_WEB_ALLOWED_HOSTS` | Additional exact proxy or custom hostnames, comma-separated | Unset |
| `PI_WEB_AUTH_MODE` | Authentication mode: `local` for the legacy password mode, `gateway` for the separate authenticated gateway | `local` |
| `PI_WEB_PASSWORD` | Enable local browser password login and Basic Auth in `local` mode only | Authentication disabled |
| `PI_WEB_IDLE_TIMEOUT_MS` | Session idle timeout in milliseconds, up to `2147483647`; `0` disables idle shutdown; invalid or out-of-range values use the default | `600000` (10 min) |

For example:

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### Remote Access

Use `pi-web-gateway` for public or cross-network access. It runs as a separate OS user and owns HTTPS, Passkeys, password-plus-TOTP, server-side sessions, rate limiting, and audit history. The Agent stays on `127.0.0.1` and never receives browser login cookies or API tokens.

```bash
PI_WEB_AUTH_MODE=gateway \
PI_WEB_PUBLIC_ORIGIN=https://pi.example.com \
PI_WEB_GATEWAY_HOST=127.0.0.1 \
PI_WEB_GATEWAY_PORT=30142 \
pi-web-gateway serve
```

Run `pi-web-gateway init` once to create the gateway secrets, then `pi-web-gateway bootstrap` to create a one-time setup code. See [Data center deployment](./docs/deployment.zh-CN.md) for the complete systemd and Caddy workflow.

Gateway API tokens default to `agent:read` with a 30-day expiry; write access requires an explicit `agent:write` scope, and API tokens cannot manage Gateway accounts or sessions. Use `pi-web-gateway audit list` to inspect login, token, and session events.

The old `PI_WEB_PASSWORD` mode is not suitable as an internet-facing entry point: it has no MFA, no server-side revocation, and its authentication code shares a process with Agent extensions. It remains available for trusted local development.

### HTTP Proxy

Server-side model and API requests honor the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables.

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## Notes

- **Agent data**: Pi Web reads pi data from `~/.pi/agent` by default, including session files under `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Set `PI_CODING_AGENT_DIR` to use another pi agent directory.
- **Filesystem access**: Pi Web must be able to read the agent data directory and the working directories recorded by its sessions. Run Pi Web in the same filesystem environment as pi when sharing existing sessions.
- **Shared configuration**: the Models panel uses pi's model, settings, and credential storage, so changes are visible to both interfaces.
- **File access boundary**: the file browser is limited to working directories selected in Pi Web and project or session roots it already knows about; it is not a general filesystem browser.
- **Git worktrees**: see [Worktrees in Pi Web](./docs/worktrees.md) for switcher visibility, worktree creation, and removal behavior.

### Downstream Session Context Menu

Electron wrappers and other downstream integrations can provide a session-row
context menu without patching `SessionSidebar`. Listen for the cancelable
`pi-web:session-row-contextmenu` browser event and call `preventDefault()`
synchronously when the integration will handle it:

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

The detail object contains `id`, `path`, `cwd`, optional `name`, pointer
coordinates, and a `refresh()` callback for actions that change the session
list. If no listener cancels the extension event, Pi Web preserves the
browser's native context menu. This hook is browser-side and independent of
Pi agent extensions.

### Extension Session Liveness

Server-side Pi extensions with detached work can prevent automatic idle
session eviction through the versioned global registry:

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

Register once per active extension session and call the returned idempotent
`release` function on session shutdown, replacement, or reload. `isActive`
must be synchronous, cheap, and scoped to the supplied exact session id or
file. Provider errors fail safe by preserving that session. This lease only
affects automatic idle eviction; explicit shutdown and Stop fallback cleanup
still take precedence.

## Development

```bash
npm install
npm run dev
```

The development server runs at [http://127.0.0.1:30141](http://127.0.0.1:30141). Run the common checks with:

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
npm run test:e2e:gateway
```

Do not run `next build` or `npm run build` during normal development. It writes to `.next/` and can interfere with the development server; leave builds for release work.

Contributor guides: [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md).

## Repository Layout

```text
app/             Next.js UI and API routes
components/      React UI components
hooks/           Client state and interaction hooks
lib/             Session, agent, model, file, Git, and security logic
public/          Static assets and PWA files
bin/             npm CLI entrypoint and launch option parsing
docs/            Focused user and contributor guides
```

See [AGENTS.md](./AGENTS.md) for the architecture notes and detailed file map.

## License

[MIT](./LICENSE)
