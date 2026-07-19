import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnreachable } from "../supabase/functions/_shared/telegram.mjs";

test("a blocked bot / dead account is permanent — stop retrying", () => {
  assert.equal(isUnreachable({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }), true);
  assert.equal(isUnreachable({ ok: false, error_code: 403, description: "Forbidden: user is deactivated" }), true);
  assert.equal(isUnreachable({ ok: false, error_code: 400, description: "Bad Request: chat not found" }), true);
});

test("transient failures are NOT permanent — they must retry next tick", () => {
  assert.equal(isUnreachable({ ok: false, error_code: 429, description: "Too Many Requests" }), false);
  assert.equal(isUnreachable({ ok: false, error_code: 500, description: "Internal Server Error" }), false);
  assert.equal(isUnreachable({ ok: false }), false, "a thrown/unknown failure is transient until proven otherwise");
  assert.equal(isUnreachable({ ok: false, error_code: 400, description: "Bad Request: message is too long" }), false);
});

test("a successful send is never treated as unreachable", () => {
  assert.equal(isUnreachable({ ok: true, result: {} }), false);
  assert.equal(isUnreachable(undefined), false);
});
