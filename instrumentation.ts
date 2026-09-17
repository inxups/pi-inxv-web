export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertAppAuthConfiguration } = await import("@/lib/auth-mode");
  assertAppAuthConfiguration();

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();
}
