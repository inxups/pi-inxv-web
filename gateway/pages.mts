import { randomBase64Url } from "./base64url.mts";

export interface RenderedPage {
  readonly html: string;
  readonly contentSecurityPolicy: string;
}

function pageShell(title: string, body: string, script: string): RenderedPage {
  const nonce = randomBase64Url(18);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(100% - 32px, 460px); padding: 28px 0; }
    h1 { margin: 0 0 8px; font-size: 26px; letter-spacing: 0; }
    h2 { margin: 24px 0 10px; font-size: 16px; }
    p { margin: 0 0 16px; color: color-mix(in srgb, CanvasText 72%, Canvas); line-height: 1.5; }
    form, section { margin: 18px 0; }
    label { display: block; margin: 0 0 6px; font-size: 13px; font-weight: 600; }
    input, select, button { width: 100%; min-height: 44px; border-radius: 6px; font: inherit; }
    input, select { border: 1px solid color-mix(in srgb, CanvasText 24%, Canvas); background: Canvas; color: CanvasText; padding: 10px 12px; }
    button { border: 0; background: #1d4ed8; color: white; cursor: pointer; padding: 10px 14px; font-weight: 650; }
    button.secondary { background: color-mix(in srgb, CanvasText 12%, Canvas); color: CanvasText; }
    button.danger { background: #b91c1c; }
    button:disabled { opacity: .55; cursor: wait; }
    .row { display: flex; gap: 10px; align-items: center; }
    .row > * { flex: 1; }
    #token-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    #token-form button { grid-column: 1 / -1; }
    @media (max-width: 420px) { #token-form { grid-template-columns: 1fr; } }
    .status { min-height: 22px; margin: 10px 0; color: #b91c1c; white-space: pre-wrap; }
    .status.ok { color: #15803d; }
    code { overflow-wrap: anywhere; }
    pre { overflow: auto; padding: 14px; border-radius: 6px; background: color-mix(in srgb, CanvasText 8%, Canvas); user-select: all; }
    ul { padding-left: 20px; }
    .muted { color: color-mix(in srgb, CanvasText 62%, Canvas); font-size: 13px; }
    .hidden { display: none; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <main>${body}</main>
  <script nonce="${nonce}">
${script}
  </script>
</body>
</html>`;
  return {
    html,
    contentSecurityPolicy: [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
}

const CLIENT_HELPERS = String.raw`
const $ = (selector) => document.querySelector(selector);
const status = (element, message, ok = false) => {
  element.textContent = message || "";
  element.classList.toggle("ok", ok);
};
async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "请求失败 (" + response.status + ")");
    error.code = data.code;
    error.retryAfterMs = data.retryAfterMs;
    throw error;
  }
  return data;
}
function safeNext() {
  const value = new URLSearchParams(location.search).get("next");
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}
function toBase64Url(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function creationOptions(options) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) {
    return PublicKeyCredential.parseCreationOptionsFromJSON(options);
  }
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    user: { ...options.user, id: fromBase64Url(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((credential) => ({
      ...credential,
      id: fromBase64Url(credential.id),
    })),
  };
}
function requestOptions(options) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) {
    return PublicKeyCredential.parseRequestOptionsFromJSON(options);
  }
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((credential) => ({
      ...credential,
      id: fromBase64Url(credential.id),
    })),
  };
}
function credentialJson(credential) {
  if (typeof credential.toJSON === "function") return credential.toJSON();
  const response = credential.response;
  const common = {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
  if ("attestationObject" in response) {
    return {
      ...common,
      response: {
        clientDataJSON: toBase64Url(response.clientDataJSON),
        attestationObject: toBase64Url(response.attestationObject),
        transports: response.getTransports ? response.getTransports() : [],
      },
    };
  }
  return {
    ...common,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : undefined,
    },
  };
}
async function ensureStatus() {
  const methods = await request("/api/auth/status");
  if (methods.setupRequired && location.pathname !== "/auth/setup") {
    location.replace("/auth/setup");
    throw new Error("需要先完成初始化");
  }
  return methods;
}
`;

const LOGIN_SCRIPT = `${CLIENT_HELPERS}
const message = $("#message");
let methods;
async function loginWithPasskey() {
  try {
    status(message, "正在调用 Passkey...");
    const started = await request("/api/auth/passkey/options", { method: "POST", body: "{}" });
    const credential = await navigator.credentials.get({ publicKey: requestOptions(started.options) });
    if (!credential) throw new Error("未选择 Passkey");
    await request("/api/auth/passkey/verify", {
      method: "POST",
      body: JSON.stringify({ challengeId: started.challengeId, response: credentialJson(credential) }),
    });
    location.replace(safeNext());
  } catch (error) {
    status(message, error.message);
  }
}
$("#passkey").addEventListener("click", loginWithPasskey);
$("#totp-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await request("/api/auth/totp", {
      method: "POST",
      body: JSON.stringify({
        password: $("#totp-password").value,
        code: $("#totp-code").value,
      }),
    });
    location.replace(safeNext());
  } catch (error) {
    status(message, error.message);
  }
});
$("#recovery-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await request("/api/auth/recovery", {
      method: "POST",
      body: JSON.stringify({ code: $("#recovery-code").value }),
    });
    location.replace(safeNext());
  } catch (error) {
    status(message, error.message);
  }
});
ensureStatus().then((value) => {
  methods = value;
  $("#passkey").classList.toggle("hidden", !methods.passkeys || !window.PublicKeyCredential);
  $("#totp-section").classList.toggle("hidden", !methods.totp);
  $("#recovery-section").classList.toggle("hidden", !methods.recoveryCodes);
}).catch((error) => status(message, error.message));
`;

const SETUP_SCRIPT = `${CLIENT_HELPERS}
const message = $("#message");
const setup = $("#setup");
const finish = $("#finish");
let challengeId = "";
let credential = null;
let passkeyOptions = null;
$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    status(message, "正在创建初始化挑战...");
    const result = await request("/api/setup/start", {
      method: "POST",
      body: JSON.stringify({ code: $("#setup-code").value }),
    });
    challengeId = result.challengeId;
    passkeyOptions = result.passkeyOptions;
    $("#totp-secret").textContent = result.totpSecret;
    $("#totp-uri").href = result.totpUri;
    setup.classList.add("hidden");
    finish.classList.remove("hidden");
    status(message, "请把密钥加入验证器并设置登录密码；建议同时注册 Passkey。", true);
  } catch (error) {
    status(message, error.message);
  }
});
$("#register-passkey").addEventListener("click", async () => {
  try {
    if (!challengeId) throw new Error("请先输入初始化代码");
    if (!window.PublicKeyCredential) throw new Error("当前浏览器不支持 Passkey");
    status(message, "正在注册 Passkey...");
    if (!passkeyOptions) throw new Error("初始化挑战不包含 Passkey 参数");
    const created = await navigator.credentials.create({
      publicKey: creationOptions(passkeyOptions),
    });
    if (!created) throw new Error("Passkey 注册已取消");
    credential = credentialJson(created);
    status(message, "Passkey 已获取，请输入验证器代码完成初始化。", true);
  } catch (error) {
    status(message, error.message);
  }
});
$("#finish-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await request("/api/setup/finish", {
      method: "POST",
      body: JSON.stringify({
        challengeId,
        credential,
        password: $("#finish-password").value,
        totpCode: $("#finish-code").value,
        deviceName: $("#device-name").value,
      }),
    });
    finish.classList.add("hidden");
    const recovery = $("#recovery");
    $("#recovery-codes").textContent = result.recoveryCodes.join("\\n");
    recovery.classList.remove("hidden");
    status(message, "初始化完成。恢复码只显示一次。", true);
  } catch (error) {
    status(message, error.message);
  }
});
ensureStatus().then((methods) => {
  if (!methods.setupRequired) location.replace("/");
}).catch((error) => status(message, error.message));
`;

const ACCOUNT_SCRIPT = `${CLIENT_HELPERS}
const message = $("#message");
function listItem(title, detail, actionLabel, action) {
  const item = document.createElement("li");
  const text = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("div");
  small.className = "muted";
  small.textContent = detail;
  text.append(strong, small);
  const button = document.createElement("button");
  button.className = "danger";
  button.textContent = actionLabel;
  button.addEventListener("click", action);
  item.append(text, button);
  return item;
}
function auditItem(entry) {
  const item = document.createElement("li");
  const strong = document.createElement("strong");
  strong.textContent = entry.event;
  const small = document.createElement("div");
  small.className = "muted";
  small.textContent = new Date(entry.timestamp).toLocaleString() + " · " + (entry.ip || "unknown IP");
  item.append(strong, small);
  return item;
}
function scopeLabel(scope) {
  return scope === "agent:read"
    ? "Agent 只读"
    : scope === "agent:write"
      ? "Agent 读写"
      : scope === "full"
        ? "兼容完整权限"
        : scope;
}
async function loadAccount() {
  const data = await request("/api/auth/account");
  $("#username").textContent = data.user.username;
  const sessions = $("#sessions");
  sessions.replaceChildren();
  for (const session of data.sessions) {
    sessions.append(listItem(
      session.current ? "当前会话" : "浏览器会话",
      new Date(session.lastSeenAt).toLocaleString(),
      session.current ? "退出全部其他会话" : "撤销",
      async () => {
        await request(session.current ? "/api/auth/sessions" : "/api/auth/sessions/" + encodeURIComponent(session.id), {
          method: "DELETE",
        });
        await loadAccount();
      },
    ));
  }
  const credentials = $("#credentials");
  credentials.replaceChildren();
  for (const item of data.credentials) {
    credentials.append(listItem(
      item.name,
      new Date(item.createdAt).toLocaleString(),
      "删除 Passkey",
      async () => {
        if (!confirm("确定删除这个 Passkey？")) return;
        await request("/api/auth/credentials/" + encodeURIComponent(item.id), { method: "DELETE" });
        await loadAccount();
      },
    ));
  }
  const tokens = $("#tokens");
  tokens.replaceChildren();
  for (const token of data.apiTokens) {
    const scopes = (token.scopes || []).map(scopeLabel).join(" + ");
    const expiry = token.expiresAt === null
      ? "永不过期"
      : "到期 " + new Date(token.expiresAt).toLocaleString();
    tokens.append(listItem(
      token.name,
      scopes + " · " + expiry + " · 创建于 " + new Date(token.createdAt).toLocaleString(),
      "撤销 Token",
      async () => {
        if (!confirm("确定撤销这个 API Token？")) return;
        await request("/api/auth/api-tokens/" + encodeURIComponent(token.id), { method: "DELETE" });
        await loadAccount();
      },
    ));
  }
  const audit = $("#audit");
  audit.replaceChildren();
  for (const entry of data.audit || []) {
    audit.append(auditItem(entry));
  }
}
$("#register-passkey").addEventListener("click", async () => {
  try {
    const started = await request("/api/auth/passkey/register/options", {
      method: "POST",
      body: JSON.stringify({ deviceName: $("#device-name").value }),
    });
    const created = await navigator.credentials.create({ publicKey: creationOptions(started.options) });
    if (!created) throw new Error("Passkey 注册已取消");
    await request("/api/auth/passkey/register/verify", {
      method: "POST",
      body: JSON.stringify({
        challengeId: started.challengeId,
        response: credentialJson(created),
        deviceName: $("#device-name").value,
      }),
    });
    status(message, "Passkey 已添加", true);
    await loadAccount();
  } catch (error) {
    status(message, error.message);
  }
});
$("#token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await request("/api/auth/api-tokens", {
      method: "POST",
      body: JSON.stringify({
        name: $("#token-name").value,
        scopes: [$("#token-scope").value],
        expiresAt: Number($("#token-expiry").value) > 0
          ? Date.now() + Number($("#token-expiry").value) * 24 * 60 * 60 * 1000
          : null,
      }),
    });
    $("#new-token").textContent = result.token;
    $("#new-token-wrap").classList.remove("hidden");
    await loadAccount();
  } catch (error) {
    status(message, error.message);
  }
});
$("#logout").addEventListener("click", async () => {
  await request("/api/auth/logout", { method: "POST", body: "{}" });
  location.replace("/auth/login");
});
loadAccount().catch((error) => status(message, error.message));
`;

export function renderLoginPage(): RenderedPage {
  return pageShell("Pi Web 登录", `
    <h1>Pi Web</h1>
    <p>此入口由 Pi Web Gateway 独立验证。Agent 进程不会收到登录 Cookie 或 API Token。</p>
    <p id="message" class="status" role="alert" aria-live="polite"></p>
    <button id="passkey" type="button">使用 Passkey 登录</button>
    <section id="totp-section">
      <h2>密码 + 验证器</h2>
      <form id="totp-form">
        <label for="totp-password">密码</label>
        <input id="totp-password" type="password" autocomplete="current-password" placeholder="密码" required>
        <label for="totp-code">验证器代码</label>
        <input id="totp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位代码" required>
        <button type="submit">登录</button>
      </form>
    </section>
    <section id="recovery-section">
      <h2>恢复码</h2>
      <form id="recovery-form" class="row">
        <label class="hidden" for="recovery-code">恢复码</label>
        <input id="recovery-code" autocomplete="off" placeholder="一次性恢复码" required>
        <button type="submit" class="secondary">恢复</button>
      </form>
    </section>
  `, LOGIN_SCRIPT);
}

export function renderSetupPage(): RenderedPage {
  return pageShell("Pi Web 初始化", `
    <h1>初始化 Pi Web Gateway</h1>
    <p>初始化代码由服务器命令行生成，只使用一次。完成前不要开放公网端口。</p>
    <p id="message" class="status" role="alert" aria-live="polite"></p>
    <section id="setup">
      <form id="setup-form">
        <label for="setup-code">初始化代码</label>
        <div class="row">
          <input id="setup-code" autocomplete="off" required>
          <button type="submit">继续</button>
        </div>
      </form>
    </section>
    <section id="finish" class="hidden">
      <h2>验证器</h2>
      <p>密码密钥：<code id="totp-secret"></code></p>
      <p><a id="totp-uri" href="#">在验证器中打开</a></p>
      <h2>Passkey</h2>
      <label for="device-name">设备名称</label>
      <input id="device-name" value="Primary passkey" autocomplete="off">
      <p><button id="register-passkey" type="button" class="secondary">注册 Passkey</button></p>
      <form id="finish-form">
        <h2>完成初始化</h2>
        <label for="finish-password">登录密码（至少 16 位）</label>
        <input id="finish-password" type="password" minlength="16" autocomplete="new-password" required>
        <label for="finish-code">验证器代码</label>
        <input id="finish-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
        <p><button type="submit">完成并生成恢复码</button></p>
      </form>
    </section>
    <section id="recovery" class="hidden">
      <h2>恢复码</h2>
      <p>请离线保存。每个恢复码只能使用一次。</p>
      <pre id="recovery-codes"></pre>
      <p><a href="/">进入 Pi Web</a></p>
    </section>
  `, SETUP_SCRIPT);
}

export function renderAccountPage(): RenderedPage {
  return pageShell("Pi Web 安全设置", `
    <h1>安全设置</h1>
    <p>当前用户：<strong id="username"></strong></p>
    <p id="message" class="status" role="alert" aria-live="polite"></p>
    <section>
      <h2>Passkey</h2>
      <label for="device-name">新设备名称</label>
      <input id="device-name" value="Additional passkey" autocomplete="off">
      <p><button id="register-passkey" type="button">添加 Passkey</button></p>
      <ul id="credentials"></ul>
    </section>
    <section>
      <h2>会话</h2>
      <ul id="sessions"></ul>
    </section>
    <section>
      <h2>API Token</h2>
      <form id="token-form">
        <label class="hidden" for="token-name">Token 名称</label>
        <input id="token-name" placeholder="例如：laptop-cli" required>
        <label class="hidden" for="token-scope">权限</label>
        <select id="token-scope">
          <option value="agent:read">Agent 只读</option>
          <option value="agent:write">Agent 读写</option>
        </select>
        <label class="hidden" for="token-expiry">有效期</label>
        <select id="token-expiry">
          <option value="7">7 天</option>
          <option value="30" selected>30 天</option>
          <option value="90">90 天</option>
          <option value="365">365 天</option>
          <option value="0">永不过期</option>
        </select>
        <button type="submit">创建</button>
      </form>
      <div id="new-token-wrap" class="hidden">
        <p>Token 只显示一次：</p>
        <pre id="new-token"></pre>
      </div>
      <ul id="tokens"></ul>
    </section>
    <section>
      <h2>安全记录</h2>
      <ul id="audit"></ul>
    </section>
    <p><button id="logout" type="button" class="secondary">退出当前会话</button></p>
  `, ACCOUNT_SCRIPT);
}
