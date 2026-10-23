import { expect, it, vi } from "vitest";
import contribute from "../index.server";

const { observe } = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock("./service", () => ({ RecoveryService: class {
  observe = observe;
  configure = vi.fn();
  invalidSettings = vi.fn();
  stop = vi.fn();
} }));

const capacityMessage = "Selected model is at capacity. Please try a different model.";
it.each([
  ["codex", undefined, capacityMessage, "server_overloaded"],
  ["codex", "server_overloaded", capacityMessage, "server_overloaded"],
  ["codex", "authentication_failed", capacityMessage, "authentication_failed"],
  ["codex", "usage_limit_reached", capacityMessage, "usage_limit_reached"],
  ["codex", "", capacityMessage, ""],
  ["claude", undefined, capacityMessage, undefined],
  ["codex-profile", undefined, capacityMessage, undefined],
  ["codex", undefined, "The model is at capacity.", undefined],
  ["codex", undefined, `Quoted error: ${capacityMessage}`, undefined],
  ["codex", undefined, `${capacityMessage}\n`, undefined],
  ["codex", undefined, "You've hit your usage limit.", undefined],
] as const)("normalizes only exact code-less Codex capacity failures (%s, %s, %s)", async (provider, code, message, expectedCode) => {
  observe.mockClear();
  const callbacks = new Map<string, (event: unknown) => unknown>();
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values: {} }), subscribe: () => () => {} }),
    on: (name: string, callback: (event: unknown) => unknown) => { callbacks.set(name, callback); },
    handle: vi.fn(),
  };
  const cleanup = contribute(server as unknown as Parameters<typeof contribute>[0]);
  const event = { agent: { id: "session", provider }, turnId: "turn-1", outcome: {
    kind: "failed", error: { code, message },
  } };
  await callbacks.get("agent.turn_ended")!(event);
  expect(observe).toHaveBeenCalledExactlyOnceWith({ kind: "end", ...event, outcome: { kind: "failed", error: { code: expectedCode } } });
  await cleanup();
});
