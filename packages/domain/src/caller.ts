import { z } from "zod";

/** The signed-in person a tool call is made for, as Cloudflare Access identified them. */
export const Caller = z.object({
  email: z.email(),
});
export type Caller = z.infer<typeof Caller>;
