import assert from "node:assert/strict";
import test from "node:test";
import { nextAuthOptions } from "./next-auth-options";

test("signIn allows credentials (otp) flow without requiring email", async () => {
  const signIn = nextAuthOptions.callbacks?.signIn;
  assert.ok(signIn, "Expected signIn callback to be defined");

  const result = await signIn({
    account: { type: "credentials", provider: "otp" } as never,
    user: { id: "user_1" } as never
  });

  assert.equal(result, true);
});

test("jwt handles credentials (otp) flow and does not enter oauth provider switch", async () => {
  const jwt = nextAuthOptions.callbacks?.jwt;
  assert.ok(jwt, "Expected jwt callback to be defined");

  const result = await jwt({
    token: {},
    account: { type: "credentials", provider: "otp" } as never,
    user: {
      id: "user_1",
      email: "user@example.com",
      hederaAccountId: "0.0.12345",
      createdAt: "2026-03-01T00:00:00.000Z"
    } as never
  });

  assert.equal(result.sub, "user_1");
  assert.deepEqual(result.workitUser, {
    id: "user_1",
    email: "user@example.com",
    hederaAccountId: "0.0.12345",
    evmAddress: null,
    createdAt: "2026-03-01T00:00:00.000Z"
  });
});

test("jwt rejects unsupported oauth providers", async () => {
  const jwt = nextAuthOptions.callbacks?.jwt;
  assert.ok(jwt, "Expected jwt callback to be defined");

  await assert.rejects(
    async () =>
      await jwt({
        token: {},
        account: { type: "oauth", provider: "otp", providerAccountId: "external-1" } as never,
        user: { email: "user@example.com" } as never
      }),
    /Unsupported OAuth provider/
  );
});
