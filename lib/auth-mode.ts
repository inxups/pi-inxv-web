export type WebAuthMode = "local" | "gateway";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function webAuthMode(
  environment: NodeJS.ProcessEnv = process.env,
): WebAuthMode {
  const value = environment.PI_WEB_AUTH_MODE?.trim().toLowerCase();
  if (!value || value === "local") return "local";
  if (value === "gateway") return "gateway";
  throw new Error("PI_WEB_AUTH_MODE must be local or gateway");
}

export function isGatewayAuthMode(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return webAuthMode(environment) === "gateway";
}

export function gatewayAttestationSecret(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.PI_WEB_GATEWAY_ATTESTATION_SECRET ?? "";
}

export function assertAppAuthConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const mode = webAuthMode(environment);
  if (mode !== "gateway") return;

  if (gatewayAttestationSecret(environment).length < 32) {
    throw new Error(
      "PI_WEB_GATEWAY_ATTESTATION_SECRET must be at least 32 characters in gateway mode",
    );
  }
  if (environment.PI_WEB_PASSWORD) {
    throw new Error(
      "PI_WEB_PASSWORD must be unset in gateway mode; authentication belongs to pi-web-gateway",
    );
  }

  const hostname = environment.PI_WEB_HOSTNAME?.trim() || "127.0.0.1";
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    throw new Error(
      "Pi Web must listen on a loopback address in gateway mode; expose only the gateway",
    );
  }
}
