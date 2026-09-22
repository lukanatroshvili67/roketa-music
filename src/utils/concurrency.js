/** Counting semaphore to bound the number of concurrent external processes. */
export class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.waiters = [];
  }

  async run(fn) {
    if (this.active >= this.max) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/** Serialises async operations (per guild) so rapid button spam can't interleave state changes. */
export class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(fn) {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
