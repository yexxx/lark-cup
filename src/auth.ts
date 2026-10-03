import { api, send } from "./api";
import { sessionIdentity, updateSession } from "./session";
export interface User {
  id: string;
  name: string;
  role: "user" | "admin";
  status: "active" | "disabled";
}
async function enter(path: string, body: unknown): Promise<{ user: User }> {
  updateSession(sessionIdentity(), true);
  const result = await send(path, body);
  updateSession(result.user.id, true);
  return result;
}
/** Local credentials and future SSO providers share the same user and session contract. */
export const authAdapter = {
  currentUser: () => api<{ user: User | null }>("/auth/me"),
  login: (username: string, password: string) =>
    enter("/auth/login", { username, password }),
  register: (username: string, name: string, password: string) =>
    enter("/auth/register", { username, name, password }),
  logout: async () => {
    await send("/auth/logout");
    updateSession(null, true);
  },
  changePassword: async (currentPassword: string, newPassword: string) => {
    await send("/auth/password", { currentPassword, newPassword });
    updateSession(null, true);
  },
};
