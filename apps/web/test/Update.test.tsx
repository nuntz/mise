import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test, vi } from "vitest";
import { UpdateBanner, watchForNewBuild } from "../src/Update";
import { fakeServiceWorkers } from "./fakeServiceWorkers";

/** The banner as the app shows it, over its own watch of `container`. */
function Offered(props: { container: ServiceWorkerContainer | undefined; reload: () => void }) {
  const ready = watchForNewBuild(props.container);
  return <UpdateBanner ready={ready()} reload={props.reload} />;
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

test("a newer build taking over an open page offers a reload, and reloads only when asked", async () => {
  const user = userEvent.setup();
  const workers = fakeServiceWorkers(true);
  const reload = vi.fn();
  render(() => <Offered container={workers.container} reload={reload} />);
  expect(screen.queryByRole("status")).toBeNull();

  workers.claim();

  expect((await screen.findByRole("status")).textContent).toContain("A newer Mise is ready");
  expect(reload).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Reload" }));
  expect(reload).toHaveBeenCalledTimes(1);
});

test("a first visit, claimed by its first worker, offers nothing; a later build does", async () => {
  const workers = fakeServiceWorkers(false);
  render(() => <Offered container={workers.container} reload={vi.fn()} />);

  workers.claim();
  await Promise.resolve();
  expect(screen.queryByText(/A newer Mise is ready/)).toBeNull();

  workers.claim();
  expect(await screen.findByText(/A newer Mise is ready/)).toBeTruthy();
});

test("coming back to the page asks for a newer build, so a resumed app finds a deploy", async () => {
  onTestFinished(() => setVisibility("visible"));
  const workers = fakeServiceWorkers(true);
  render(() => <Offered container={workers.container} reload={vi.fn()} />);

  setVisibility("hidden");
  await Promise.resolve();
  expect(workers.updated).not.toHaveBeenCalled();
  setVisibility("visible");
  await vi.waitFor(() => expect(workers.updated).toHaveBeenCalledTimes(1));
});

test("offline, coming back to the page asks for a newer build and quietly finds none", async () => {
  onTestFinished(() => setVisibility("visible"));
  const workers = fakeServiceWorkers(true);
  workers.updated.mockRejectedValue(new TypeError("Failed to update a ServiceWorker: network error"));
  render(() => <Offered container={workers.container} reload={vi.fn()} />);

  setVisibility("visible");
  await vi.waitFor(() => expect(workers.updated).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("status")).toBeNull();
});

test("without service workers, there's nothing to offer and nothing breaks", () => {
  render(() => <Offered container={undefined} reload={vi.fn()} />);
  setVisibility("visible");
  expect(screen.queryByRole("status")).toBeNull();
});
