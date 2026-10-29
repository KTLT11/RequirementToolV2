import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext";

/**
 * Redirects to /login whenever there is no valid session, per the
 * AuthContext's one source of truth (GET /api/auth/me). Shows
 * nothing meaningful while that initial check is still in flight,
 * rather than flashing the login page then immediately redirecting
 * away from it once the real session turns out to be valid.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <p>Loading…</p>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
