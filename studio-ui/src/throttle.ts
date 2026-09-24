/** Call `fn` at most once per `ms`; the latest arguments always get a final call. */
export function throttleLatest<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let last = -Infinity;
  let pending: A | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    const now = Date.now();
    if (now - last >= ms && timer === null) {
      last = now;
      fn(...a);
      return;
    }
    pending = a;
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        if (pending) fn(...pending);
        pending = null;
      }, ms - (now - last));
    }
  };
}
