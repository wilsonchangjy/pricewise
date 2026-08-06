import { test } from "node:test";
import assert from "node:assert/strict";

// The webhook is a Deno Edge Function and can't be imported here, so these
// reproduce its four decision rules as pure functions and pin the behaviour.
// Every one of them is a bug that actually reached the user on 2026-08-06:
// two searches acknowledged and then never heard from again, and a
// "looking for Uniqlo" message deleted an hour later by an unrelated question.

const SEARCH_DEADLINE_MS = 50_000;
const SUPERSEDE_WINDOW_MS = 3 * 60_000;

// ── 1. a search never ends in silence ───────────────────────────────────────
// The original handed the work to EdgeRuntime.waitUntil and caught failures into
// console.error. Once the webhook returns 200 the isolate is reclaimed, so the
// work simply stopped — and the catch meant nobody was told.
async function runWithDeadline(work, deadlineMs) {
  const TIMED_OUT = Symbol("deadline");
  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(() => r(TIMED_OUT), deadlineMs); });
  const outcome = await Promise.race([
    work.then(() => "done", (e) => e ?? new Error("search failed")),
    deadline,
  ]);
  clearTimeout(timer);
  if (outcome === TIMED_OUT) return "slow";
  return outcome === "done" ? "done" : "failed";
}

test("a search that succeeds reports success", async () => {
  assert.equal(await runWithDeadline(Promise.resolve(), SEARCH_DEADLINE_MS), "done");
});

test("a search that THROWS tells the user instead of logging into the void", async () => {
  const boom = Promise.reject(new Error("adapter exploded"));
  assert.equal(await runWithDeadline(boom, SEARCH_DEADLINE_MS), "failed",
    "the exact shape of the live bug: an error the user never heard about");
});

test("a search that overruns says so rather than going quiet", async () => {
  const forever = new Promise(() => {});
  assert.equal(await runWithDeadline(forever, 30), "slow");
});

test("the deadline stays inside Telegram's ~60s retry window", () => {
  assert.ok(SEARCH_DEADLINE_MS < 60_000,
    "overrun means Telegram re-delivers the update and the whole search runs twice");
  // Measured live: Uniqlo 14.5s, Jacquemus 26.8s, Castlery 36s.
  assert.ok(SEARCH_DEADLINE_MS > 40_000, "a typical search must fit comfortably");
});

// ── 2. superseding is for corrections, not for anything that follows ────────
function shouldSupersede(previous, now) {
  return Boolean(previous?.ackMessageId) &&
    Boolean(previous?.startedAt) &&
    now - previous.startedAt < SUPERSEDE_WINDOW_MS;
}

test("a typo corrected seconds later supersedes the first search", () => {
  const t = 1_000_000;
  assert.equal(shouldSupersede({ ackMessageId: 5, startedAt: t }, t + 4_000), true);
});

test("an unrelated question an hour later does NOT delete the older message", () => {
  const t = 1_000_000;
  assert.equal(shouldSupersede({ ackMessageId: 5, startedAt: t }, t + 60 * 60_000), false,
    "the live bug: 'looking for Uniqlo' vanished when Jacquemus was asked an hour on");
});

test("a marker left behind by a search that died can't delete anything either", () => {
  // A search killed mid-flight never clears its marker, so it looks in-flight
  // forever. Time-bounding is what stops that stale marker doing damage.
  assert.equal(shouldSupersede({ ackMessageId: 5 }, Date.now()), false, "no startedAt: too old to trust");
});

// ── 3. the supersede check fails OPEN ───────────────────────────────────────
function stillCurrent({ error, storedToken }, token) {
  if (error) return true;
  const current = storedToken ?? null;
  return current === null || current === token;
}

test("only a DIFFERENT token supersedes; anything else reports", () => {
  assert.equal(stillCurrent({ storedToken: "A" }, "A"), true, "mine — report");
  assert.equal(stillCurrent({ storedToken: "B" }, "A"), false, "genuinely superseded — stay quiet");
  assert.equal(stillCurrent({ storedToken: null }, "A"), true, "no marker: can't tell, so report");
  assert.equal(stillCurrent({ error: true }, "A"), true, "read failed: a duplicate beats a lost answer");
});

// ── 4. an outcome exists for every path ─────────────────────────────────────
test("every branch of a search produces a message", async () => {
  const sent = [];
  const finish = async (work) => {
    const outcome = await runWithDeadline(work, 30);
    if (outcome === "slow") sent.push("still-looking");
    else if (outcome === "failed") sent.push("went-wrong");
    else sent.push("results");   // runSearch itself sends these
  };
  await finish(Promise.resolve());
  await finish(Promise.reject(new Error("x")));
  await finish(new Promise(() => {}));
  assert.deepEqual(sent, ["results", "went-wrong", "still-looking"],
    "three outcomes, three messages — silence is not one of them");
});
