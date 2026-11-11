import { vi } from "vitest";

/**
 * The page's service worker container, as a browser keeps it: `controller` is the worker in charge
 * of the page, and a newly activated worker that claims it fires `controllerchange`.
 */
export function fakeServiceWorkers(controlled: boolean) {
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
