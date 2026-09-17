export const API_TOKEN_SCOPES = ["agent:read", "agent:write"] as const;

export type ApiTokenScope = typeof API_TOKEN_SCOPES[number];

const API_TOKEN_SCOPE_SET = new Set<string>(API_TOKEN_SCOPES);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function normalizeApiTokenScopes(
  value: unknown,
  fallback: ApiTokenScope = "agent:read",
): ApiTokenScope[] {
  const values = value === undefined
    ? [fallback]
    : Array.isArray(value)
      ? value
      : [value];
  const scopes: ApiTokenScope[] = [];
  for (const item of values) {
    if (typeof item !== "string" || !API_TOKEN_SCOPE_SET.has(item)) {
      throw new Error(`API token scope must be one of: ${API_TOKEN_SCOPES.join(", ")}`);
    }
    const scope = item as ApiTokenScope;
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  if (scopes.length === 0) {
    throw new Error(`API token scope must be one of: ${API_TOKEN_SCOPES.join(", ")}`);
  }
  return scopes;
}

export function storedApiTokenScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["full"];
  const scopes = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return scopes.length > 0 ? Array.from(new Set(scopes)) : ["full"];
}

export function apiTokenAllowsMethod(
  scopes: readonly string[],
  method: string,
): boolean {
  if (scopes.includes("full") || scopes.includes("agent:write")) return true;
  return scopes.includes("agent:read") && SAFE_METHODS.has(method.toUpperCase());
}

export function apiTokenScopeLabel(scope: string): string {
  if (scope === "agent:read") return "Agent 只读";
  if (scope === "agent:write") return "Agent 读写";
  if (scope === "full") return "兼容完整权限";
  return scope;
}
