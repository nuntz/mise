import { describe, expect, test } from "bun:test";
import { createTickQueue, type QueuedChange, type QueueStorage, type TickTransport } from "./tickQueue";

const WEEK = "2026-10-26";

/**
 * A Grocery List server as the Worker keeps one: a Have Tick set later wins (ADR 0015), and a line
 * added again under the same key is the same line. Unreachable while `online` is false.
 */
function fakeServer() {
  const lines = new Map<number, { have: boolean; haveAt: string | null; text?: string }>([
    [1, { have: false, haveAt: null }],
    [2, { have: false, haveAt: null }],
  ]);
  const keys = new Map<string, number>();
  const server = { online: true, lines, loseNextAnswer: false };

  const reach = () => {
    if (!server.online) throw new Error("No connection");
  };
  /** The change is made, but the connection drops before its answer arrives. */
  const answer = <T>(value: T): T => {
    if (!server.loseNextAnswer) return value;
    server.loseNextAnswer = false;
    throw new Error("Connection closed");
  };

  /** A transport for one client. */
  const transport = (): TickTransport => ({
    async setHaveTick({ line, have, at }) {
      reach();
      const current = lines.get(line);
      if (!current) return { ok: false };
      if (current.haveAt === null || Date.parse(current.haveAt) <= Date.parse(at)) {
        lines.set(line, { ...current, have, haveAt: at });
      }
      return answer({ ok: true });
    },
    async addGroceryLine({ text, key }) {
      reach();
      const existing = keys.get(key);
      if (existing !== undefined) return { ok: true, line: existing };
      const id = lines.size + 1;
      lines.set(id, { have: false, haveAt: null, text });
      keys.set(key, id);
      return answer({ ok: true as const, line: id });
    },
  });

  return { server, transport };
}

/** A clock a test moves by hand, one minute at a time. */
function clock(start = "2026-10-24T10:00:00.000Z") {
  let now = Date.parse(start);
  return {
    now: () => new Date(now),
    tick: () => {
      now += 60_000;
    },
  };
}

function memoryStorage(): QueueStorage & { saved: QueuedChange[] } {
  const storage = {
    saved: [] as QueuedChange[],
    load: () => storage.saved,
    save: (changes: QueuedChange[]) => {
      storage.saved = changes;
    },
  };
  return storage;
}

let keyCount = 0;
const newKey = () => `key-${++keyCount}`;

describe("tick queue", () => {
  test("a tick made offline waits, and is replayed once the connection is back", async () => {
    const { server, transport } = fakeServer();
    const time = clock();
    const queue = createTickQueue({ storage: memoryStorage(), transport: transport(), now: time.now, newKey });

    server.online = false;
    queue.tick(1, true);
    await queue.flush();
    expect(server.lines.get(1)?.have).toBe(false);
    expect(queue.pending()).toHaveLength(1);

    server.online = true;
    await queue.flush();
    expect(server.lines.get(1)).toEqual({ have: true, haveAt: "2026-10-24T10:00:00.000Z" });
    expect(queue.pending()).toEqual([]);
  });

  test("two shoppers' offline ticks reconcile per line: the one made last wins, whoever syncs last", async () => {
    const { server, transport } = fakeServer();
    const time = clock();
    const alex = createTickQueue({ storage: memoryStorage(), transport: transport(), now: time.now, newKey });
    const sam = createTickQueue({ storage: memoryStorage(), transport: transport(), now: time.now, newKey });

    server.online = false;
    alex.tick(1, true);
    sam.tick(2, true);
    time.tick();
    sam.tick(1, false);
    time.tick();
    alex.tick(2, false);

    server.online = true;
    await sam.flush();
    await alex.flush();
    // Line 1: Sam's untick came after Alex's tick, so it stands though Alex synced last.
    expect(server.lines.get(1)).toEqual({ have: false, haveAt: "2026-10-24T10:01:00.000Z" });
    // Line 2: Alex's untick came last.
    expect(server.lines.get(2)).toEqual({ have: false, haveAt: "2026-10-24T10:02:00.000Z" });
  });

  test("a line added offline is added once, though its answer was lost and it is sent again", async () => {
    const { server, transport } = fakeServer();
    const queue = createTickQueue({ storage: memoryStorage(), transport: transport(), now: clock().now, newKey });

    server.online = false;
    queue.add(WEEK, "2 lemons");
    expect(queue.pending()).toMatchObject([{ kind: "add", date: WEEK, text: "2 lemons" }]);

    server.online = true;
    server.loseNextAnswer = true;
    await queue.flush();
    expect(queue.pending()).toHaveLength(1);
    await queue.flush();
    expect([...server.lines.values()].filter((line) => line.text === "2 lemons")).toHaveLength(1);
    expect(queue.pending()).toEqual([]);
  });

  test("a tick on a line added offline lands on that line once it is added", async () => {
    const { server, transport } = fakeServer();
    const time = clock();
    const queue = createTickQueue({ storage: memoryStorage(), transport: transport(), now: time.now, newKey });

    server.online = false;
    const key = queue.add(WEEK, "2 lemons");
    time.tick();
    queue.tickAdded(key, true);

    server.online = true;
    await queue.flush();
    expect(server.lines.get(3)).toEqual({ have: true, haveAt: "2026-10-24T10:01:00.000Z", text: "2 lemons" });
    expect(queue.pending()).toEqual([]);
  });

  test("a tick made while a flush is under way is kept, and overlapping flushes send each change once", async () => {
    const { server, transport } = fakeServer();
    const time = clock();
    const sent: number[] = [];
    const counting = transport();
    const queue = createTickQueue({
      storage: memoryStorage(),
      transport: {
        ...counting,
        setHaveTick: (input) => {
          sent.push(input.line);
          return counting.setHaveTick(input);
        },
      },
      now: time.now,
      newKey,
    });

    queue.tick(1, true);
    const first = queue.flush();
    const second = queue.flush();
    time.tick();
    queue.tick(2, true);
    await Promise.all([first, second]);
    await queue.flush();

    expect(sent).toEqual([1, 2]);
    expect(server.lines.get(2)?.have).toBe(true);
    expect(queue.pending()).toEqual([]);
  });

  test("a change the household refuses is dropped and reported, and the rest still go", async () => {
    const { server, transport } = fakeServer();
    const queue = createTickQueue({ storage: memoryStorage(), transport: transport(), now: clock().now, newKey });

    // Line 9 went when the list was rebuilt.
    queue.tick(9, true);
    queue.tick(1, true);
    await queue.flush();

    expect(server.lines.get(1)?.have).toBe(true);
    expect(queue.pending()).toEqual([]);
    expect(queue.refused()).toMatchObject([{ kind: "tick", line: 9, have: true }]);
    queue.dismissRefused();
    expect(queue.refused()).toEqual([]);
  });

  test("changes survive the page closing: a queue opened on the same storage sends them", async () => {
    const { server, transport } = fakeServer();
    const storage = memoryStorage();
    server.online = false;
    createTickQueue({ storage, transport: transport(), now: clock().now, newKey }).tick(1, true);

    server.online = true;
    const reopened = createTickQueue({ storage, transport: transport(), now: clock().now, newKey });
    expect(reopened.pending()).toHaveLength(1);
    await reopened.flush();
    expect(server.lines.get(1)?.have).toBe(true);
  });

  test("listeners hear of every change to what is pending", async () => {
    const { transport } = fakeServer();
    const queue = createTickQueue({ storage: memoryStorage(), transport: transport(), now: clock().now, newKey });
    const heard: number[] = [];
    const unsubscribe = queue.subscribe(() => heard.push(queue.pending().length));

    queue.tick(1, true);
    await queue.flush();
    unsubscribe();
    queue.tick(2, true);
    expect(heard).toEqual([1, 0]);
  });
});
