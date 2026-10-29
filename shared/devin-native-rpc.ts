import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Unpatched daemons fail closed instead of spawning a second Devin process.
export const devinNativeRpc = defineRpc({ name: "recovery.devin.native.v1", input: z.unknown(),
  output: z.object({ protocol: z.literal(1), available: z.boolean() }) });
