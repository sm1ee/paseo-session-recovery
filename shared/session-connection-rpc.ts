import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const sessionConnectionRpc = defineRpc({
  name: "recovery.session.connection.v1", input: z.unknown(),
  output: z.object({ protocol: z.literal(1), available: z.boolean() }),
});
