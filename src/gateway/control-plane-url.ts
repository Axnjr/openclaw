const DEFAULT_CONTROL_PLANE_ORIGIN = "https://www.gwal.ai";

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_CONTROL_PLANE_ORIGIN;
  }
  const noTrailingSlash = trimmed.replace(/\/+$/g, "");
  return noTrailingSlash.replace(/\/api$/i, "");
}

export function resolveControlPlaneOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.OPENCLAW_CONTROL_PLANE_URL ?? env.LAZZY_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_ORIGIN;
  return normalizeBaseUrl(raw);
}

export function buildControlPlaneApiUrl(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const origin = resolveControlPlaneOrigin(env);
  return normalizedPath.startsWith("/api/")
    ? `${origin}${normalizedPath}`
    : `${origin}/api${normalizedPath}`;
}
