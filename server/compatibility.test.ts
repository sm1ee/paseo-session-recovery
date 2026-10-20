import { describe, expect, it } from "vitest";
import { daemonCompatibilityError } from "./compatibility";

describe("daemon compatibility", () => {
  it.each(["0.11.4", "0.11.99", "0.12.0", "0.12.25"])("accepts supported stable version %s", (version) => {
    expect(daemonCompatibilityError(version, true)).toBeNull();
  });
  it("accepts 0.11 without the background workspace capability", () => {
    expect(daemonCompatibilityError("0.11.4", false)).toBeNull();
  });
  it.each([undefined, null, "", "0.11.3", "0.10.9", "0.13.0", "1.0.0", "0.12.0-beta.1", "0.12.00", "0.12.999999999999999999999"])("rejects unverified version %s", (version) => {
    expect(daemonCompatibilityError(version, true)).toMatch(/not supported/);
  });
  it("blocks incomplete 0.12 capabilities before any recovery", () => {
    expect(daemonCompatibilityError("0.12.0", false)).toMatch(/background workspace/);
  });
});
