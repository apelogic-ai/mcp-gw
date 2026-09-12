import type { ConnectionLifecycle } from "./connection-lifecycle";

export interface RevocationWorker {
  runOnce(): Promise<number>;
  start(): void;
  stop(): void;
}

export function createRevocationWorker(
  lifecycles: ConnectionLifecycle[],
  intervalMs = 30_000,
): RevocationWorker {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<number> | undefined;
  const runOnce = (): Promise<number> => {
    if (running) return running;
    running = Promise.all(lifecycles.map((lifecycle) => lifecycle.retryPendingRevocations()))
      .then((counts) => counts.reduce((total, count) => total + count, 0))
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  return {
    runOnce,
    start: () => {
      if (timer) return;
      timer = setInterval(() => void runOnce().catch(() => undefined), intervalMs);
      timer.unref();
    },
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
