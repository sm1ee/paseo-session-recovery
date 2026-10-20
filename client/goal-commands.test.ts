import type { PluginClientContext, PluginClientSlashCommandContribution, PluginCommandCenterItemContribution } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import { contributeGoalCommands } from "./goal-commands";

function fixture() {
  const commands: PluginClientSlashCommandContribution[] = [], items: PluginCommandCenterItemContribution[] = [];
  const remove = vi.fn(), openScreen = vi.fn(), send = vi.fn(async () => {}), ref = vi.fn(() => ({ send }));
  const rpc = vi.fn(async () => ({ supported: true }));
  const paseo = { agents: { ref } };
  const client = { addSlashCommand: (command: PluginClientSlashCommandContribution) => { commands.push(command); return remove; },
    addCommandCenterItem: (item: PluginCommandCenterItemContribution) => { items.push(item); return remove; } } as unknown as PluginClientContext;
  const stop = contributeGoalCommands(client);
  async function submit(name: string, args = "") {
    const command = commands.find((entry) => entry.name === name)!;
    if (command.context !== "agent") throw new Error("Requires a session");
    await command.onSubmit({ agent: { id: "fixture" }, args, paseo, openScreen, rpc } as unknown as Parameters<typeof command.onSubmit>[0]);
  }
  return { stop, commands, items, submit, ref, send, openScreen, remove, rpc };
}
describe("Goal 조회와 편집 명령", () => {
  it.each([["goal", ""], ["goal", "edit"], ["goal-edit", ""]])("/%s %s는 대화를 실행하지 않고 편집기를 연다", async (name, args) => {
    const f = fixture(); await f.submit(name, args);
    expect(f.openScreen).toHaveBeenCalledExactlyOnceWith({ screenId: "goal", params: { agentId: "fixture" } });
    expect(f.send).not.toHaveBeenCalled(); expect(f.ref).not.toHaveBeenCalled();
  });
  it.each(["pause", "resume", "clear", "Finish the fixture\nKeep existing evidence", "status"])("네이티브 /goal %s를 원래 대화로 한 번 전달한다", async (args) => {
    const f = fixture(); await f.submit("goal", args);
    expect(f.ref).toHaveBeenCalledExactlyOnceWith("fixture");
    expect(f.send).toHaveBeenCalledExactlyOnceWith(`/goal ${args}`); expect(f.openScreen).not.toHaveBeenCalled();
  });
  it("실패한 네이티브 명령을 자동 재전송하지 않는다", async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(f.submit("goal", "pause")).rejects.toThrow("Connection lost");
    expect(f.send).toHaveBeenCalledOnce(); f.stop(); expect(f.remove).toHaveBeenCalledTimes(3);
  });
  it.each(["", "edit"])("지원하지 않는 제공자의 /goal %s도 원래 처리로 넘긴다", async (args) => {
    const f = fixture(); f.rpc.mockResolvedValueOnce({ supported: false }); await f.submit("goal", args);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(args ? `/goal ${args}` : "/goal"); expect(f.openScreen).not.toHaveBeenCalled();
  });
});
