import { describe, expect, it } from "vitest";
import { authFailureOf } from "./errors";

describe("authFailureOf", () => {
  it("tells Auth's rate limit apart from a wrong password or code", () => {
    expect(authFailureOf({ status: 429 })).toBe("rate_limited");
    expect(authFailureOf({ code: "over_request_rate_limit" })).toBe("rate_limited");
    expect(authFailureOf({ status: 400, code: "over_email_send_rate_limit" })).toBe("rate_limited");
  });

  it("reports a failing service as unavailable", () => {
    expect(authFailureOf({ status: 500 })).toBe("unavailable");
    expect(authFailureOf({ status: 503 })).toBe("unavailable");
  });

  it("treats everything else as the credentials or code being refused", () => {
    expect(authFailureOf({ status: 400, code: "invalid_credentials" })).toBe("rejected");
    expect(authFailureOf({ status: 422, code: "mfa_verification_failed" })).toBe("rejected");
    expect(authFailureOf({})).toBe("rejected");
  });
});
