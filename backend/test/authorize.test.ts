import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { HttpError } from "../src/http/errors.js";
import { requireRole } from "../src/auth/authorize.js";
import type { AppUser } from "../src/auth/users.js";

function fakeUser(rtRole: string): AppUser {
  return {
    userId: "00000000-0000-0000-0000-000000000001",
    email: "test@example.com",
    passwordHash: "unused",
    rtRole,
    displayName: null,
    isActive: true,
  };
}

test("requireRole calls next() with no error when the role matches", () => {
  const req = { user: fakeUser("BA") } as unknown as Request;
  let calledWith: unknown = "not-called";
  const next = (err?: unknown) => {
    calledWith = err;
  };

  requireRole("BA")(req, {} as Response, next);

  assert.equal(calledWith, undefined);
});

test("requireRole calls next(FORBIDDEN) when the role does not match", () => {
  const req = { user: fakeUser("QC") } as unknown as Request;
  let calledWith: unknown;
  const next = (err?: unknown) => {
    calledWith = err;
  };

  requireRole("BA")(req, {} as Response, next);

  assert.ok(calledWith instanceof HttpError);
  assert.equal((calledWith as HttpError).code, "FORBIDDEN");
});

test("requireRole calls next(UNAUTHENTICATED) when req.user is missing", () => {
  const req = {} as Request;
  let calledWith: unknown;
  const next = (err?: unknown) => {
    calledWith = err;
  };

  requireRole("BA")(req, {} as Response, next);

  assert.ok(calledWith instanceof HttpError);
  assert.equal((calledWith as HttpError).code, "UNAUTHENTICATED");
});
