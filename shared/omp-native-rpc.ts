import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Older, unpatched daemons return unavailable instead of forwarding a request
// to a second OMP process. The companion handles this on the owning daemon.
export const ompNativeRpc = defineRpc({
  name: "recovery.omp.native.v1", input: z.unknown(),
  output: z.object({ protocol: z.literal(1), available: z.boolean() }),
});
