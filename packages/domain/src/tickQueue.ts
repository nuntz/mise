import { z } from "zod";
import { LocalDate } from "./weeks";

/**
 * A change to a Grocery List made on this device and not yet known to have reached the household:
 * a Have Tick set to a value as of a time, or a line added by hand under a key of its own.
 */
export const QueuedChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tick"), line: z.number().int().positive(), have: z.boolean(), at: z.iso.datetime() }),
  z.object({ kind: z.literal("add"), key: z.string(), date: LocalDate, text: z.string(), at: z.iso.datetime() }),
  /** A Have Tick on a line added under `key` that isn't added yet; it becomes a "tick" once it is. */
  z.object({ kind: z.literal("tickAdded"), key: z.string(), have: z.boolean(), at: z.iso.datetime() }),
]);
export type QueuedChange = z.infer<typeof QueuedChange>;

/** Where the queue keeps its changes, so they survive the page closing while offline. */
export type QueueStorage = {
  load(): QueuedChange[];
  save(changes: QueuedChange[]): void;
};

/**
 * How the queue reaches the household. A refusal (`ok: false`) is final: retrying can't change it.
 * A throw means it wasn't reached, or no answer came back, so the change is sent again later.
 */
export type TickTransport = {
  setHaveTick(input: { line: number; have: boolean; at: string }): Promise<{ ok: true } | { ok: false }>;
  addGroceryLine(input: {
    date: LocalDate;
    text: string;
    key: string;
  }): Promise<{ ok: true; line: number } | { ok: false }>;
};

export type TickQueue = {
  /** Sets a line's Have Tick as of now; sent with the next flush. */
  tick(line: number, have: boolean): void;
  /** Adds a line by hand to the Grocery List of the Week of `date`; returns the key it is added under. */
  add(date: LocalDate, text: string): string;
  /** Sets the Have Tick of a line added under `key` and not added yet. */
  tickAdded(key: string, have: boolean): void;
  /** The changes not yet sent, oldest first. */
  pending(): readonly QueuedChange[];
  /** The changes the household refused since last dismissed, such as a tick on a line a rebuild removed. */
  refused(): readonly QueuedChange[];
  dismissRefused(): void;
  /** Calls `listener` whenever what is pending or refused changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Sends the pending changes in order, stopping at the first that doesn't get through. */
  flush(): Promise<void>;
};

export function createTickQueue(options: {
  storage: QueueStorage;
  transport: TickTransport;
  now?: () => Date;
  newKey?: () => string;
}): TickQueue {
  const { storage, transport } = options;
  const now = options.now ?? (() => new Date());
  const newKey = options.newKey ?? (() => crypto.randomUUID());
  let changes = storage.load();
  let refused: QueuedChange[] = [];
  const listeners = new Set<() => void>();
  // The flush under way, if any: a second one waits for it rather than sending the same change again.
  let flushing: Promise<void> | null = null;

  const save = (next: QueuedChange[]) => {
    changes = next;
    storage.save(changes);
    for (const listener of listeners) listener();
  };

  return {
    tick(line, have) {
      save([...changes, { kind: "tick", line, have, at: now().toISOString() }]);
    },

    add(date, text) {
      const key = newKey();
      save([...changes, { kind: "add", key, date, text, at: now().toISOString() }]);
      return key;
    },

    tickAdded(key, have) {
      save([...changes, { kind: "tickAdded", key, have, at: now().toISOString() }]);
    },

    pending: () => changes,

    refused: () => refused,

    dismissRefused() {
      refused = [];
      for (const listener of listeners) listener();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    flush() {
      flushing ??= send().finally(() => {
        flushing = null;
      });
      return flushing;
    },
  };

  async function send(): Promise<void> {
    while (changes.length > 0) {
      const [change] = changes as [QueuedChange];
      let outcome: { ok: true; line?: number } | { ok: false };
      try {
        if (change.kind === "tick") {
          outcome = await transport.setHaveTick({ line: change.line, have: change.have, at: change.at });
        } else if (change.kind === "add") {
          // Sent again under the same key, it is the same line, so a lost answer adds nothing twice.
          outcome = await transport.addGroceryLine({ date: change.date, text: change.text, key: change.key });
        } else {
          // A tick on a line whose add is no longer queued; a refused add takes its ticks with it.
          outcome = { ok: false };
        }
      } catch {
        return;
      }
      // Changes made while it was being sent stay queued.
      const rest = changes.filter((later) => later !== change);
      if (!outcome.ok) {
        refused = [...refused, change];
        // Ticks on a line that was never added go with it.
        save(change.kind === "add" ? rest.filter((later) => !follows(later, change.key)) : rest);
      } else if (change.kind === "add" && outcome.line !== undefined) {
        const line = outcome.line;
        save(
          rest.map((later) =>
            follows(later, change.key) ? { kind: "tick", line, have: later.have, at: later.at } : later,
          ),
        );
      } else {
        save(rest);
      }
    }
  }
}

/** Whether `change` is a tick on the line added under `key`. */
function follows(change: QueuedChange, key: string): change is Extract<QueuedChange, { kind: "tickAdded" }> {
  return change.kind === "tickAdded" && change.key === key;
}
