export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(max = 1): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];

  function release(): void {
    active--;
    const next = waiting.shift();
    if (next) next();
  }

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
