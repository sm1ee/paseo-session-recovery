import { describe, expect, it } from "vitest";
import { daemonCompatibilityError } from "./compatibility";

describe("daemon compatibility", () => {
  it.each(["0.11.4", "0.11.99", "0.12.0", "0.12.25", "0.13.0", "0.13.8", "0.14.0", "1.0.0"])("accepts stable version %s with the required capabilities", (version) => {
    expect(daemonCompatibilityError(version, true)).toBeNull();
  });
  it("accepts 0.11 without the background workspace capability", () => {
    expect(daemonCompatibilityError("0.11.4", false)).toBeNull();
  });
  it.each([undefined, null, "", "0.11.3", "0.10.9", "0.13.0-beta.1", "0.12.0-beta.1", "0.12.00", "01.0.0", "0.012.0", "9007199254740992.0.0", "0.9007199254740992.0", "0.12.999999999999999999999"])("rejects older, prerelease, or malformed version %s", (version) => {
    expect(daemonCompatibilityError(version, true)).toMatch(/not supported/);
  });
  it.each(["0.12.0", "0.13.0", "0.14.0", "1.0.0"])("blocks missing capabilities on %s before any recovery", (version) => {
    expect(daemonCompatibilityError(version, false)).toMatch(/background workspace/);
  });
});
