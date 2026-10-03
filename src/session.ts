let identity: string | null = null;
let version = 0;
const requests = new Set<AbortController>();
export const sessionIdentity = () => identity;
export const sessionVersion = () => version;
export function updateSession(id: string | null, force = false) {
  if (!force && id === identity) return;
  identity = id;
  version++;
  for (const request of requests) request.abort();
}
export function trackSession(controller: AbortController) {
  requests.add(controller);
  return () => requests.delete(controller);
}
export function reportSessionError(status: number, code?: string) {
  if (typeof window === "undefined") return;
  if (status === 401) window.dispatchEvent(new Event("lark:auth-expired"));
  if (code === "AUTH_CHANGED")
    window.dispatchEvent(new Event("lark:auth-changed"));
}
