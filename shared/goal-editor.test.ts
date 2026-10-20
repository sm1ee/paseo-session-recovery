import { describe, expect, it } from "vitest";
import { goalLengthLimit, goalObjectiveError } from "./goal-editor";
describe("네이티브 Goal 본문의 제한", () => {
  it("제공자별 실제 본문 한도를 적용한다", () => {
    expect(goalLengthLimit("codex")).toBe(16000);
    for (const source of ["claude", "opencode"] as const) {
      expect(goalLengthLimit(source)).toBe(4000); expect(goalObjectiveError("x".repeat(4001), source)).not.toBeNull();
    }
  });
  it("제어 명령을 제공자별로 구분한다", () => {
    expect(goalObjectiveError("pause", "codex")).not.toBeNull(); expect(goalObjectiveError("pause", "claude")).toBeNull();
    expect(goalObjectiveError("stop", "claude")).not.toBeNull(); expect(goalObjectiveError("clear", "opencode")).toBeNull();
    expect(goalObjectiveError('"Quoted objective"\nKeep the evidence.', "opencode")).toBeNull();
  });
});
