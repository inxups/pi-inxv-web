const WEB_AUTH_SECRET_NAMES = [
  "PI_WEB_PASSWORD",
  "PI_WEB_GATEWAY_ATTESTATION_SECRET",
  "PI_WEB_GATEWAY_SECRET_FILE",
  "PI_WEB_GATEWAY_STATE_DIR",
] as const;

function comparableEnvironmentName(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

/**
 * Remove Pi Web authentication secrets before starting child processes.
 * Project commands, terminals, package tools, and extensions must not inherit
 * the password that protects the browser/API surface.
 */
export function stripWebAuthSecrets(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  const secretNames = new Set(
    WEB_AUTH_SECRET_NAMES.map((name) => comparableEnvironmentName(name, platform)),
  );

  for (const name of Object.keys(sanitized)) {
    if (secretNames.has(comparableEnvironmentName(name, platform))) {
      delete sanitized[name];
    }
  }
  return sanitized;
}
