import { describe, expect, it, vi } from "vitest";
import { localEndpoint, workerIdentity } from "./host";

describe("daemon identity", () => {
  it("distinguishes workers under a persistent supervisor", async () => {
    const lookup = vi.fn(async (pid: number) => ({ parent: 100, started: pid === 200 ? "Mon Oct 19 10:00:00 2026" : "Tue Oct 20 10:00:00 2026" }));
    expect(await workerIdentity(200, 100, lookup)).not.toBe(await workerIdentity(201, 100, lookup));
  });
  it("does not change identity when only a plugin child is replaced", async () => {
    const lookup = async (pid: number) => ({ parent: pid === 200 ? 100 : 200, started: `start-${pid}` });
    expect(await workerIdentity(301, 100, lookup)).toBe(await workerIdentity(302, 100, lookup));
  });
  it("does not confuse a reused PID with the old worker", async () => {
    expect(await workerIdentity(200, 100, async () => ({ parent: 100, started: "first" }))).not.toBe(await workerIdentity(200, 100, async () => ({ parent: 100, started: "second" })));
  });
  it("rejects a home owned by an unrelated process", async () => {
    await expect(workerIdentity(200, 999, async () => ({ parent: 1, started: "start" }))).rejects.toThrow(/another daemon/);
  });
  it.each(["localhost:6767", "127.0.0.1:6767", "[::1]:6767", "0.0.0.0:6767", "[::]:6767"])("allows loopback %s", (listen) => {
    expect(localEndpoint(listen).url).toMatch(/^ws:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):6767\/ws$/);
  });
  it.each(["example.com:6767", "user:password@127.0.0.1:6767", "127.0.0.1:6767/elsewhere", "127.0.0.1:6767?token=value", "unix://", "unix://relative"])("rejects nonlocal or modified target %s", (listen) => {
    expect(() => localEndpoint(listen)).toThrow();
  });
  it("supports a local Unix socket", () => { expect(localEndpoint("unix:///tmp/test-paseo.sock")).toEqual({ url: "ws://localhost/ws", socketPath: "/tmp/test-paseo.sock" }); });
});
