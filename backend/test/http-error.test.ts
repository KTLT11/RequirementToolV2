import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../src/http/errors.js";

test("HttpError maps each code to the expected HTTP status", () => {
  assert.equal(new HttpError("VALIDATION_ERROR", "x").status, 400);
  assert.equal(new HttpError("UNAUTHENTICATED", "x").status, 401);
  assert.equal(new HttpError("FORBIDDEN", "x").status, 403);
  assert.equal(new HttpError("NOT_FOUND", "x").status, 404);
  assert.equal(new HttpError("CONFLICT", "x").status, 409);
  assert.equal(new HttpError("INTERNAL_ERROR", "x").status, 500);
});

test("HttpError preserves the code and message", () => {
  const err = new HttpError("CONFLICT", "case_code already exists");
  assert.equal(err.code, "CONFLICT");
  assert.equal(err.message, "case_code already exists");
});
