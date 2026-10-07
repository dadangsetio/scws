"use strict";

// Each Pangdam PM2 worker admits one ADB/scrcpy setup. With at most four
// workers, the shared ADB server sees at most four concurrent setups while
// already-running device streams remain unrestricted.
export function createSetupSlots({ waitMs = 25_000, maxQueued = 128 } = {}) {
  let active = 0;
  const queued = [];

  function release() {
    const next = queued.shift();
    if (next) {
      next.activate();
    } else {
      active -= 1;
    }
  }

  return {
    get active() { return active; },
    get queued() { return queued.length; },
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(new Error("stream setup cancelled"));
      if (active < 1 && queued.length === 0) {
        active += 1;
        return Promise.resolve(release);
      }
      if (queued.length >= maxQueued) {
        return Promise.reject(new Error("stream setup queue is full"));
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          activate() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve(release);
          },
        };
        const remove = (reason) => {
          const index = queued.indexOf(waiter);
          if (index < 0) return;
          queued.splice(index, 1);
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(new Error(reason));
        };
        const onAbort = () => remove("stream setup cancelled");
        const timer = setTimeout(() => remove("stream setup queue timed out"), waitMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        queued.push(waiter);
        if (signal?.aborted) onAbort();
      });
    },
  };
}
