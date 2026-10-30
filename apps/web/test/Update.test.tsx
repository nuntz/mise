import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test, vi } from "vitest";
import { UpdateBanner } from "../src/Update";

/**
 * The page's service worker container, as a browser keeps it: `controller` is the worker in charge
 * of the page, and a newly activated worker that claims it fires `controllerchange`.
 */
function fakeServiceWorkers(controlled: boolean) {
  const updated = vi.fn(async (): Promise<void> => {});
  const container = Object.assign(new EventTarget(), {
    controller: (controlled ? {} : null) as ServiceWorker | null,
    getRegistration: async () => ({ update: updated }) as unknown as ServiceWorkerRegistration,
  });
  const claim = () => {
    container.controller = {} as ServiceWorker;
    container.dispatchEvent(new Event("controllerchange"));
  };
  return { container: container as unknown as ServiceWorkerContainer, claim, updated };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

test("a newer build taking over an open page offers a reload, and reloads only when asked", async () => {
  const user = userEvent.setup();
  const workers = fakeServiceWorkers(true);
  const reload = vi.fn();
  render(() => <UpdateBanner container={workers.container} reload={reload} />);
  expect(screen.queryByRole("status")).toBeNull();

  workers.claim();

  expect((await screen.findByRole("status")).textContent).toContain("A newer Mise is ready");
  expect(reload).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Reload" }));
  expect(reload).toHaveBeenCalledTimes(1);
});

test("a first visit, claimed by its first worker, offers nothing; a later build does", async () => {
  const workers = fakeServiceWorkers(false);
  render(() => <UpdateBanner container={workers.container} reload={vi.fn()} />);

  workers.claim();
  await Promise.resolve();
  expect(screen.queryByText(/A newer Mise is ready/)).toBeNull();

  workers.claim();
  expect(await screen.findByText(/A newer Mise is ready/)).toBeTruthy();
});

test("coming back to the page asks for a newer build, so a resumed app finds a deploy", async () => {
  onTestFinished(() => setVisibility("visible"));
  const workers = fakeServiceWorkers(true);
  render(() => <UpdateBanner container={workers.container} reload={vi.fn()} />);

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
  render(() => <UpdateBanner container={workers.container} reload={vi.fn()} />);

  setVisibility("visible");
  await vi.waitFor(() => expect(workers.updated).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("status")).toBeNull();
});

test("without service workers, there's nothing to offer and nothing breaks", () => {
  render(() => <UpdateBanner container={undefined} reload={vi.fn()} />);
  setVisibility("visible");
  expect(screen.queryByRole("status")).toBeNull();
});
