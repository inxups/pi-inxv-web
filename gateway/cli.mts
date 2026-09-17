import { stdin, stdout, stderr } from "node:process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseGatewayConfig } from "./config.mts";
import { loadOrCreateGatewaySecrets } from "./secrets.mts";
import { GatewayDatabase } from "./db.mts";
import { AuthError, GatewayAuthService } from "./auth-service.mts";
import { startGatewayServer } from "./server.mts";

function helpText(): string {
  return `Usage: pi-web-gateway <command> [options]

Commands:
  init                        Create gateway encryption and assertion secrets
  serve                       Start the TLS/authentication gateway
  bootstrap                   Create a one-time setup code for the first administrator
  password                    Read a password from stdin and store an Argon2id hash
  totp-reset                  Replace the TOTP secret and revoke all browser sessions
  recovery regenerate         Replace all recovery codes and print them once
  token create [--name NAME] [--expires-days DAYS]
                              Create a revocable API token
  token list                  List active API token ids
  token revoke <id>           Revoke an API token
  sessions revoke-all         Revoke every browser session
  help                        Show this message

Required environment:
  PI_WEB_PUBLIC_ORIGIN        Public HTTPS origin, for example https://pi.example.com
  PI_WEB_GATEWAY_STATE_DIR    Gateway state directory
  PI_WEB_GATEWAY_ATTESTATION_SECRET
                              Shared with the Pi Web app for internal assertions
  PI_WEB_TLS_CERT, PI_WEB_TLS_KEY
                              Required when listening on a non-loopback address

See docs/deployment.zh-CN.md for the systemd and proxy setup.`;
}

function gatewayEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_WEB_AUTH_MODE: process.env.PI_WEB_AUTH_MODE || "gateway",
  };
}

async function withService<T>(
  callback: (service: GatewayAuthService, config: ReturnType<typeof parseGatewayConfig>) => Promise<T> | T,
): Promise<T> {
  const config = parseGatewayConfig(gatewayEnvironment());
  if (config.authMode !== "gateway") {
    throw new Error("PI_WEB_AUTH_MODE must be gateway when running pi-web-gateway");
  }
  const externalSecret = process.env.PI_WEB_GATEWAY_ATTESTATION_SECRET;
  const secrets = await loadOrCreateGatewaySecrets(config.secretFilePath);
  if (externalSecret && secrets.attestationSecret !== externalSecret) {
    throw new Error(
      "PI_WEB_GATEWAY_ATTESTATION_SECRET does not match the gateway secret file",
    );
  }
  const database = new GatewayDatabase(config.databasePath);
  const service = new GatewayAuthService(database, secrets, config);
  try {
    return await callback(service, config);
  } finally {
    service.close();
  }
}

function readPasswordFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => { value += chunk; });
    stdin.on("error", reject);
    stdin.on("end", () => resolve(value.replace(/\r?\n$/, "")));
  });
}

async function serve(): Promise<void> {
  if (!process.env.PI_WEB_GATEWAY_ATTESTATION_SECRET) {
    console.warn(
      "[pi-web-gateway] PI_WEB_GATEWAY_ATTESTATION_SECRET is unset; use the value from `pi-web-gateway init` in both service environment files.",
    );
  }
  await withService(async (service, config) => {
    const server = await startGatewayServer(config, service);
    const address = server.address();
    const display = typeof address === "object" && address
      ? `${address.address}:${address.port}`
      : `${config.host}:${config.port}`;
    console.log(`[pi-web-gateway] listening on ${display}; public origin ${config.publicOrigin.origin}`);
    const pruneTimer = setInterval(() => service.db.pruneExpired(Date.now()), 60_000);
    pruneTimer.unref();
    service.db.pruneExpired(Date.now());

    await new Promise<void>((resolve) => {
      const stop = () => {
        clearInterval(pruneTimer);
        server.close(() => resolve());
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift() || "serve";
  if (command === "help" || command === "--help" || command === "-h") {
    stdout.write(`${helpText()}\n`);
    return;
  }
  if (command === "serve") {
    await serve();
    return;
  }
  if (command === "init") {
    const config = parseGatewayConfig(gatewayEnvironment());
    if (config.authMode !== "gateway") {
      throw new Error("PI_WEB_AUTH_MODE must be gateway when running pi-web-gateway");
    }
    const secrets = await loadOrCreateGatewaySecrets(config.secretFilePath);
    const environmentPath = join(config.stateDir, "attestation.env");
    await writeFile(
      environmentPath,
      `PI_WEB_GATEWAY_ATTESTATION_SECRET=${secrets.attestationSecret}\n`,
      { mode: 0o600 },
    );
    await chmod(environmentPath, 0o600);
    stdout.write(`Gateway secrets: ${config.secretFilePath}\n`);
    stdout.write(`App attestation environment: ${environmentPath}\n`);
    stdout.write(`PI_WEB_GATEWAY_ATTESTATION_SECRET=${secrets.attestationSecret}\n`);
    stdout.write("把最后一行放入两个服务的 EnvironmentFile，并删除当前终端输出。\n");
    return;
  }
  if (command === "bootstrap") {
    await withService((service, config) => {
      const code = service.createBootstrapCode();
      stdout.write(`初始化代码（15 分钟内有效，只显示一次）：\n${code}\n`);
      stdout.write(`请在 ${config.publicOrigin.origin}/auth/setup 使用。\n`);
    });
    return;
  }
  if (command === "password") {
    const password = await readPasswordFromStdin();
    await withService(async (service) => {
      await service.setPassword(password);
      stdout.write("密码已更新。\n");
    });
    return;
  }
  if (command === "totp-reset") {
    await withService((service) => {
      const result = service.rotateTotpSecret();
      stdout.write("新的 TOTP 密钥（只显示一次）：\n");
      stdout.write(`${result.secret}\n`);
      stdout.write(`${result.uri}\n`);
      stdout.write("所有浏览器 Session 已撤销，请重新登录。\n");
    });
    return;
  }
  if (command === "recovery" && args[0] === "regenerate") {
    await withService(async (service) => {
      const codes = await service.regenerateRecoveryCodes();
      stdout.write("新的恢复码（只显示一次）：\n");
      for (const code of codes) stdout.write(`${code}\n`);
    });
    return;
  }
  if (command === "token") {
    const action = args.shift();
    if (action === "create") {
      let name = "API token";
      let expiresAt: number | null = null;
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--name" && args[index + 1]) {
          name = args[index + 1];
          index += 1;
        } else if (args[index] === "--expires-days" && args[index + 1]) {
          const days = Number(args[index + 1]);
          if (!Number.isFinite(days) || days <= 0) {
            throw new Error("--expires-days must be a positive number");
          }
          expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
          index += 1;
        } else {
          throw new Error(`Unknown token option: ${args[index]}`);
        }
      }
      await withService((service) => {
        const result = service.issueApiToken(name, expiresAt);
        stdout.write(`Token id: ${result.id}\nToken (只显示一次):\n${result.token}\n`);
      });
      return;
    }
    if (action === "list") {
      await withService((service) => {
        const tokens = service.listApiTokens();
        if (tokens.length === 0) {
          stdout.write("没有有效的 API Token。\n");
          return;
        }
        for (const token of tokens) {
          stdout.write(`${token.id}\t${token.name}\tcreated=${new Date(token.createdAt).toISOString()}\n`);
        }
      });
      return;
    }
    if (action === "revoke" && args[0]) {
      await withService((service) => {
        const revoked = service.revokeApiToken(args[0]);
        if (!revoked) throw new Error("API Token not found");
        stdout.write("API Token 已撤销。\n");
      });
      return;
    }
  }
  if (command === "sessions" && args[0] === "revoke-all") {
    await withService((service) => {
      const user = service.getUser();
      if (!user) throw new Error("Gateway setup is not complete");
      const count = service.revokeAllSessions(user.id);
      stdout.write(`已撤销 ${count} 个浏览器会话。\n`);
    });
    return;
  }
  stderr.write(`Unknown command: ${command}\n\n${helpText()}\n`);
  process.exitCode = 1;
}

void main().catch((error) => {
  if (error instanceof AuthError) {
    stderr.write(`${error.message}\n`);
  } else {
    stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
