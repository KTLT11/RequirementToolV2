import { Router } from "express";
import { HttpError } from "../http/errors.js";
import { authenticate } from "./authenticate.js";
import { clearSessionCookie, readSessionCookie, setSessionCookie } from "./cookies.js";
import { verifyPassword } from "./password.js";
import { createSession, revokeSession } from "./sessions.js";
import { findUserByEmail } from "./users.js";

export const authRouter = Router();

interface LoginRequestBody {
  email?: unknown;
  password?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// POST /api/auth/login
authRouter.post("/login", async (req, res, next) => {
  try {
    const body = req.body as LoginRequestBody;

    if (!isNonEmptyString(body.email) || !isNonEmptyString(body.password)) {
      throw new HttpError("VALIDATION_ERROR", "email and password are required");
    }

    const email = body.email.trim();
    const user = await findUserByEmail(email);

    // Same response whether the email doesn't exist or the password
    // is wrong - and verifyPassword always runs an argon2 comparison
    // even against a placeholder hash when the user isn't found, so
    // this path doesn't take a measurably different amount of time
    // and can't be used to enumerate which emails exist.
    const passwordHash =
      user?.passwordHash ??
      "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const passwordOk = await verifyPassword(passwordHash, body.password);

    if (!user || !user.isActive || !passwordOk) {
      throw new HttpError("UNAUTHENTICATED", "Invalid email or password");
    }

    const session = await createSession(user.userId);
    setSessionCookie(res, session.sessionId, session.expiresAt);

    res.status(200).json({
      data: {
        userId: user.userId,
        email: user.email,
        rtRole: user.rtRole,
        displayName: user.displayName,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
authRouter.get("/me", authenticate, (req, res) => {
  const user = req.user!;
  res.status(200).json({
    data: {
      userId: user.userId,
      email: user.email,
      rtRole: user.rtRole,
      displayName: user.displayName,
    },
  });
});

// POST /api/auth/logout
// Deliberately does not require authenticate() - logging out an
// already-invalid or missing session must still succeed (same
// idempotency reasoning as revokeSession itself), rather than forcing
// the client to handle a 401 just to clear its own cookie.
authRouter.post("/logout", async (req, res, next) => {
  try {
    const sessionId = readSessionCookie(req);
    if (sessionId) {
      await revokeSession(sessionId);
    }
    clearSessionCookie(res);
    res.status(200).json({ data: { loggedOut: true } });
  } catch (err) {
    next(err);
  }
});
