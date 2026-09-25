// Create an object on first use, so importing the web backend starts nothing:
// the page can check browser support first, and nothing fails at load time.

/** An object whose methods (all async) make it on the first call. A failed
 *  make rejects that call and is tried again on the next. */
export function lazy<T extends object>(make: () => T | Promise<T>): T {
  let made: Promise<T> | null = null;
  const get = () => {
    if (!made) {
      const attempt = Promise.resolve().then(make);
      made = attempt;
      attempt.catch(() => {
        if (made === attempt) made = null;
      });
    }
    return made;
  };
  return new Proxy({} as T, {
    get: (_target, key) =>
      (...args: unknown[]) =>
        get().then((o) => (o as Record<PropertyKey, (...a: unknown[]) => unknown>)[key](...args)),
  });
}
