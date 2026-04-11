export type CancellablePromise<T> = Omit<Promise<T>, 'then'> & {
  cancel(): void;
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): CancellablePromise<TResult1 | TResult2>;
};

export function toCancellable<T>(cancel: () => void, promise: Promise<T>): CancellablePromise<T> {
  const cancellablePromise = promise as CancellablePromise<T>;
  cancellablePromise.cancel = cancel;

  const originalThen = cancellablePromise.then.bind(cancellablePromise);
  cancellablePromise.then = function then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): CancellablePromise<TResult1 | TResult2> {
    return toCancellable(cancel, originalThen(onfulfilled, onrejected));
  };

  return cancellablePromise;
}

export function waitForTimeout(delayMs: number): Promise<void> {
  const normalizedDelayMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, normalizedDelayMs);
  });
}
