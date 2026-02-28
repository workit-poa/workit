import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "./password";
import { assertWithinRateLimit } from "./rate-limit";
import { createAccessToken, hashRefreshToken, newRefreshTokenValue, verifyAccessToken } from "./token";
import { validateEmailLoginInput, validateEmailRegistrationInput, validateOAuthInput } from "./validation";

test("registration validation normalizes email and enforces strong passwords", () => {
  const valid = validateEmailRegistrationInput({
    email: "User@Example.com",
    password: "StrongPass1!"
  });

  assert.equal(valid.email, "user@example.com");
  assert.throws(() =>
    validateEmailRegistrationInput({
      email: "user@example.com",
      password: "weak"
    })
  );
});

test("login and oauth validation accept valid payloads", () => {
  const login = validateEmailLoginInput({
    email: "USER@example.com",
    password: "anything"
  });
  const oauth = validateOAuthInput({
    provider: "google",
    providerUserId: "google-123",
    email: "OAuth@Example.com"
  });

  assert.equal(login.email, "user@example.com");
  assert.equal(oauth.email, "oauth@example.com");
});

test("password hashing verifies correctly", async () => {
  const plain = "StrongPass1!";
  const hashed = await hashPassword(plain);

  assert.notEqual(hashed, plain);
  assert.equal(await verifyPassword(plain, hashed), true);
  assert.equal(await verifyPassword("WrongPass1!", hashed), false);
});

test("jwt access tokens are created and verified", async () => {
  const token = await createAccessToken({
    id: "user-1",
    email: "user@example.com"
  });
  const payload = await verifyAccessToken(token);

  assert.equal(payload.sub, "user-1");
  assert.equal(payload.email, "user@example.com");
  assert.equal(payload.type, "access");
});

test("refresh token generation and hashing are deterministic", () => {
  const refreshToken = newRefreshTokenValue();
  const hashA = hashRefreshToken(refreshToken);
  const hashB = hashRefreshToken(refreshToken);

  assert.ok(refreshToken.length > 20);
  assert.equal(hashA, hashB);
});

test("rate limiter blocks excessive requests for same key", () => {
  const key = `auth-test-key-${Date.now()}`;
  for (let i = 0; i < 20; i += 1) {
    assert.doesNotThrow(() => assertWithinRateLimit(key));
  }
  assert.throws(() => assertWithinRateLimit(key));
});
