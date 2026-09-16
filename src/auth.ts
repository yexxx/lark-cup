import { api, send } from "./api";
export interface User {
  id: string;
  name: string;
  role: "user" | "admin";
  status: "active" | "disabled";
}
/** Only this adapter and server/auth.ts need replacement when integrating real authentication. */
export const authAdapter = {
  currentUser: () => api<{ user: User | null }>("/auth/me"),
  login: (id: string, name: string) => send("/auth/login", { id, name }),
  logout: () => send("/auth/logout"),
};
