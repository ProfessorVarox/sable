/** Runs `task` serially, collapsing requests that arrive mid-run into one further run. */
export const createCoalescedRunner = (task: () => Promise<void>, stopped = () => false) => {
  let next: PromiseWithResolvers<void> | undefined;
  let running = false;

  const loop = async (): Promise<void> => {
    running = true;
    try {
      while (!stopped() && next) {
        const pending = next;
        next = undefined;
        // eslint-disable-next-line no-await-in-loop
        await task().catch(() => undefined);
        pending.resolve();
      }
    } finally {
      running = false;
      next?.resolve();
      next = undefined;
    }
  };

  return {
    schedule: (): Promise<void> => {
      next ??= Promise.withResolvers<void>();
      const done = next.promise;
      if (!running) void loop();
      return done;
    },
    cancel: (): void => {
      next?.resolve();
      next = undefined;
    },
  };
};
