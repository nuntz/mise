import { z } from "zod";
import { Member } from "./members";

/** The signed-in person a tool call is made for, as Cloudflare Access identified them. */
export const Caller = z.object({
  email: z.email(),
});
export type Caller = z.infer<typeof Caller>;

/** A Caller and the Member whose email they signed in with, if any. */
export const ResolvedCaller = Caller.extend({
  member: Member.nullable(),
});
export type ResolvedCaller = z.infer<typeof ResolvedCaller>;
