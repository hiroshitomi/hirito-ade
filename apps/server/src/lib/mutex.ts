// Cola FIFO mínima: serializa operaciones que escriben en el mismo repo
// (git falla con `index.lock` / `config.lock` si dos procesos escriben a la vez).
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
