import test from "node:test";
import assert from "node:assert/strict";
import { assertWithinRateLimit } from "./rate-limit";
import { validateEmailOtpRequestInput, validateEmailOtpVerifyInput, validateOAuthInput } from "./validation";

test("otp request and oauth validation normalize input", () => {
  const otpRequest = validateEmailOtpRequestInput({
    email: "User@Example.com"
  });

  const oauth = validateOAuthInput({
    provider: "google",
    providerUserId: "google-123",
    email: "OAuth@Example.com"
  });

  assert.equal(otpRequest.email, "user@example.com");
  assert.equal(oauth.email, "oauth@example.com");
});

test("otp verify validation enforces challenge id and code format", () => {
  const valid = validateEmailOtpVerifyInput({
    challengeId: "3b7a944f-451f-40d5-95d7-11f26beec4cb",
    email: "test@example.com",
    code: "123456"
  });

  assert.equal(valid.code, "123456");

  assert.throws(() =>
    validateEmailOtpVerifyInput({
      challengeId: "invalid-id",
      email: "test@example.com",
      code: "12"
    })
  );
});

test("rate limiter blocks excessive requests for same key", () => {
  const key = `auth-test-key-${Date.now()}`;
  for (let i = 0; i < 20; i += 1) {
    assert.doesNotThrow(() => assertWithinRateLimit(key));
  }
  assert.throws(() => assertWithinRateLimit(key));
});
