import { homedir } from "node:os";
import { isIP } from "node:net";
import { join, resolve } from "node:path";

export type GatewayAuthMode = "local" | "gateway";

export interface TrustedProxyCidr {
  readonly address: string;
  readonly prefix: number;
}

export interface GatewayConfig {
  readonly authMode: GatewayAuthMode;
  readonly host: string;
  readonly port: number;
  readonly publicOrigin: URL;
  readonly appUrl: URL;
  readonly allowedHosts: ReadonlySet<string>;
  readonly trustedProxies: readonly TrustedProxyCidr[];
  readonly tlsCertificatePath?: string;
  readonly tlsKeyPath?: string;
  readonly stateDir: string;
  readonly databasePath: string;
  readonly secretFilePath: string;
  readonly sessionIdleMs: number;
  readonly sessionAbsoluteMs: number;
  readonly rpId: string;
  readonly rpName: string;
  readonly username: string;
  readonly displayName: string;
  readonly maxJsonBodyBytes: number;
  readonly maxRequestBodyBytes: number;
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly upstreamTimeoutMs: number;
  readonly proxyRequestLimit: number;
  readonly proxyRequestWindowMs: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseUrl(value: string | undefined, name: string): URL {
  if (!value?.trim()) throw new Error(`${name} is required in gateway mode`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain credentials, a query, or a fragment`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(`${name} must not contain a path`);
  }
  return parsed;
}

function normalizeHostname(value: string): string {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return unbracketed.toLowerCase().replace(/\.$/, "");
}

function parseAllowedHosts(origin: URL, extra: string | undefined): Set<string> {
  const hosts = new Set<string>([normalizeHostname(origin.hostname)]);
  for (const value of extra?.split(",") ?? []) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    let hostname: string;
    try {
      hostname = normalizeHostname(new URL(`http://${trimmed}`).hostname);
    } catch {
      throw new Error(`Invalid PI_WEB_ALLOWED_HOSTS entry: ${trimmed}`);
    }
    hosts.add(hostname);
  }
  return hosts;
}

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((result, part) => (result * 256) + Number(part), 0);
}

function parseTrustedProxy(value: string): TrustedProxyCidr {
  const [address, prefixText] = value.split("/", 2);
  const family = isIP(address);
  if (!family) throw new Error(`Invalid trusted proxy address: ${value}`);

  const maximumPrefix = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? maximumPrefix : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximumPrefix) {
    throw new Error(`Invalid trusted proxy CIDR prefix: ${value}`);
  }
  if (prefix === 0) {
    throw new Error("Trusted proxy CIDRs must not cover the entire address space");
  }
  return { address: normalizeHostname(address), prefix };
}

function parseTrustedProxies(value: string | undefined): TrustedProxyCidr[] {
  return (value?.split(",") ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseTrustedProxy);
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHostname(host));
}

function canonicalOrigin(origin: URL): string {
  return origin.origin;
}

function defaultStateDir(env: NodeJS.ProcessEnv): string {
  return resolve(env.PI_WEB_GATEWAY_STATE_DIR ?? join(env.HOME || homedir(), ".pi-web-gateway"));
}

export function isGatewayAuthMode(value: string | undefined): value is "gateway" {
  return value?.trim().toLowerCase() === "gateway";
}

export function isLoopbackHostname(host: string): boolean {
  return isLoopbackHost(host);
}

export function parseGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const authMode = env.PI_WEB_AUTH_MODE?.trim().toLowerCase() || "local";
  if (authMode !== "local" && authMode !== "gateway") {
    throw new Error("PI_WEB_AUTH_MODE must be local or gateway");
  }

  const publicOrigin = parseUrl(env.PI_WEB_PUBLIC_ORIGIN, "PI_WEB_PUBLIC_ORIGIN");
  const appUrl = parseUrl(env.PI_WEB_APP_URL ?? "http://127.0.0.1:30141", "PI_WEB_APP_URL");
  const host = env.PI_WEB_GATEWAY_HOST?.trim() || "127.0.0.1";
  const port = parseInteger(env.PI_WEB_GATEWAY_PORT, 30142, "PI_WEB_GATEWAY_PORT", 1, 65535);
  const tlsCertificatePath = env.PI_WEB_TLS_CERT?.trim() || undefined;
  const tlsKeyPath = env.PI_WEB_TLS_KEY?.trim() || undefined;
  const trustedProxies = parseTrustedProxies(env.PI_WEB_TRUSTED_PROXIES);

  if (Boolean(tlsCertificatePath) !== Boolean(tlsKeyPath)) {
    throw new Error("PI_WEB_TLS_CERT and PI_WEB_TLS_KEY must be configured together");
  }

  if (!isLoopbackHost(host) && !tlsCertificatePath) {
    throw new Error(
      "Refusing to listen on a non-loopback address without PI_WEB_TLS_CERT and PI_WEB_TLS_KEY",
    );
  }

  if (
    publicOrigin.protocol !== "https:"
    && !isLoopbackHost(host)
    && !isLoopbackHost(publicOrigin.hostname)
  ) {
    throw new Error("Gateway mode requires HTTPS for non-loopback access");
  }

  if (
    publicOrigin.protocol === "https:"
    && !tlsCertificatePath
    && trustedProxies.length === 0
  ) {
    throw new Error(
      "An HTTPS public origin without local TLS requires PI_WEB_TRUSTED_PROXIES",
    );
  }

  const stateDir = defaultStateDir(env);
  const rpId = normalizeHostname(env.PI_WEB_RP_ID?.trim() || publicOrigin.hostname);
  const originHostname = normalizeHostname(publicOrigin.hostname);
  if (isIP(originHostname)) {
    throw new Error(
      "PI_WEB_PUBLIC_ORIGIN must use localhost or a domain name for WebAuthn",
    );
  }
  if (!rpId || isIP(rpId)) {
    throw new Error("PI_WEB_RP_ID must be a domain name");
  }
  if (!rpId.includes(".") && !isLoopbackHost(originHostname)) {
    throw new Error("PI_WEB_RP_ID must include a registrable domain suffix");
  }
  if (
    !isLoopbackHost(originHostname)
    && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(rpId)
  ) {
    throw new Error("PI_WEB_RP_ID contains invalid domain characters");
  }
  if (rpId !== originHostname && !originHostname.endsWith(`.${rpId}`)) {
    throw new Error("PI_WEB_RP_ID must equal the public hostname or one of its parent domains");
  }
  return {
    authMode,
    host,
    port,
    publicOrigin,
    appUrl,
    allowedHosts: parseAllowedHosts(publicOrigin, env.PI_WEB_ALLOWED_HOSTS),
    trustedProxies,
    tlsCertificatePath,
    tlsKeyPath,
    stateDir,
    databasePath: resolve(
      env.PI_WEB_GATEWAY_DB?.trim() || join(stateDir, "auth.db"),
    ),
    secretFilePath: resolve(
      env.PI_WEB_GATEWAY_SECRET_FILE?.trim() || join(stateDir, "secrets.json"),
    ),
    sessionIdleMs: parseInteger(
      env.PI_WEB_SESSION_IDLE_SECONDS,
      30 * 60,
      "PI_WEB_SESSION_IDLE_SECONDS",
      60,
      24 * 60 * 60,
    ) * 1000,
    sessionAbsoluteMs: parseInteger(
      env.PI_WEB_SESSION_ABSOLUTE_SECONDS,
      7 * 24 * 60 * 60,
      "PI_WEB_SESSION_ABSOLUTE_SECONDS",
      300,
      30 * 24 * 60 * 60,
    ) * 1000,
    rpId,
    rpName: env.PI_WEB_RP_NAME?.trim() || "Pi Web",
    username: env.PI_WEB_AUTH_USERNAME?.trim() || "pi",
    displayName: env.PI_WEB_AUTH_DISPLAY_NAME?.trim() || "Pi Web Operator",
    maxJsonBodyBytes: parseInteger(
      env.PI_WEB_GATEWAY_MAX_JSON_BODY_BYTES,
      64 * 1024,
      "PI_WEB_GATEWAY_MAX_JSON_BODY_BYTES",
      1024,
      1024 * 1024,
    ),
    maxRequestBodyBytes: parseInteger(
      env.PI_WEB_GATEWAY_MAX_BODY_BYTES,
      50 * 1024 * 1024,
      "PI_WEB_GATEWAY_MAX_BODY_BYTES",
      1024,
      1024 * 1024 * 1024,
    ),
    headersTimeoutMs: parseInteger(
      env.PI_WEB_GATEWAY_HEADERS_TIMEOUT_MS,
      20_000,
      "PI_WEB_GATEWAY_HEADERS_TIMEOUT_MS",
      1_000,
      120_000,
    ),
    requestTimeoutMs: parseInteger(
      env.PI_WEB_GATEWAY_REQUEST_TIMEOUT_MS,
      120_000,
      "PI_WEB_GATEWAY_REQUEST_TIMEOUT_MS",
      5_000,
      600_000,
    ),
    upstreamTimeoutMs: parseInteger(
      env.PI_WEB_GATEWAY_UPSTREAM_TIMEOUT_MS,
      120_000,
      "PI_WEB_GATEWAY_UPSTREAM_TIMEOUT_MS",
      1_000,
      600_000,
    ),
    proxyRequestLimit: parseInteger(
      env.PI_WEB_GATEWAY_PROXY_REQUEST_LIMIT,
      600,
      "PI_WEB_GATEWAY_PROXY_REQUEST_LIMIT",
      10,
      100_000,
    ),
    proxyRequestWindowMs: parseInteger(
      env.PI_WEB_GATEWAY_PROXY_REQUEST_WINDOW_MS,
      60_000,
      "PI_WEB_GATEWAY_PROXY_REQUEST_WINDOW_MS",
      1_000,
      3_600_000,
    ),
  };
}

export function getPublicOrigin(config: GatewayConfig): string {
  return canonicalOrigin(config.publicOrigin);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  return normalized === "::1"
    || normalized === "127.0.0.1"
    || normalized.startsWith("127.");
}

function ipv6ToBigInt(address: string): bigint {
  const [headText, tailText = ""] = address.split("::", 2);
  const head = headText ? headText.split(":").filter(Boolean) : [];
  const tail = tailText ? tailText.split(":").filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  const parts = [
    ...head,
    ...Array.from({ length: missing }, () => "0"),
    ...tail,
  ];
  if (parts.length !== 8) throw new Error("Invalid IPv6 address");
  return parts.reduce((result, part) => {
    const value = Number.parseInt(part || "0", 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error("Invalid IPv6 address");
    }
    return (result << 16n) | BigInt(value);
  }, 0n);
}

export function addressMatchesCidr(address: string, cidr: TrustedProxyCidr): boolean {
  const family = isIP(address);
  const cidrFamily = isIP(cidr.address);
  if (!family || family !== cidrFamily) return false;

  if (family === 4) {
    const mask = cidr.prefix === 0
      ? 0
      : (0xffffffff << (32 - cidr.prefix)) >>> 0;
    return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(cidr.address) & mask);
  }

  const normalizedAddress = address.startsWith("::ffff:")
    ? address.slice(7)
    : address;
  const normalizedCidr = cidr.address.startsWith("::ffff:")
    ? cidr.address.slice(7)
    : cidr.address;
  if (isIP(normalizedAddress) === 4 && isIP(normalizedCidr) === 4) {
    const mask = cidr.prefix === 0
      ? 0
      : (0xffffffff << (32 - Math.max(0, cidr.prefix - 96))) >>> 0;
    return (ipv4ToNumber(normalizedAddress) & mask)
      === (ipv4ToNumber(normalizedCidr) & mask);
  }

  const mask = cidr.prefix === 0
    ? 0n
    : ((1n << BigInt(cidr.prefix)) - 1n) << BigInt(128 - cidr.prefix);
  return (ipv6ToBigInt(address) & mask) === (ipv6ToBigInt(cidr.address) & mask);
}

export function isTrustedProxy(address: string | undefined, config: GatewayConfig): boolean {
  if (!address) return false;
  return config.trustedProxies.some(
    (cidr) => addressMatchesCidr(address, cidr),
  );
}
