import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { apiRequest } from "../lib/apiClient";

export interface CurrentUser {
  userId: string;
  email: string;
  rtRole: string;
  displayName: string | null;
}

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  // On first load, the only source of truth for "am I logged in" is
  // whether the HttpOnly session cookie (already set by the browser,
  // if any) still resolves to a valid session server-side - this
  // deliberately never reads or writes localStorage/sessionStorage
  // for auth state, since the cookie is the only thing the server
  // actually trusts.
  useEffect(() => {
    apiRequest<CurrentUser>("GET", "/api/auth/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const loggedInUser = await apiRequest<CurrentUser>("POST", "/api/auth/login", {
      email,
      password,
    });
    setUser(loggedInUser);
  }, []);

  const logout = useCallback(async () => {
    await apiRequest("POST", "/api/auth/logout");
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
