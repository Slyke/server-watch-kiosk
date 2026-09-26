export class CapacityError extends Error {}
export class Gate {
  active = 0;
  queue: { start: () => void; reject: (error: Error) => void }[] = [];
  constructor(readonly limit: number, readonly maxQueue = 128) {}
  run = async <T>({ signal, task }: { signal: AbortSignal; task: () => Promise<T> }): Promise<T> => {
    signal.throwIfAborted();
    if (this.active >= this.limit) {
      if (this.queue.length >= this.maxQueue) throw new CapacityError('Observer queue is full');
      await new Promise<void>((resolve, reject) => {
        const entry = { start: () => { signal.removeEventListener('abort', abort); return resolve(); }, reject };
        const abort = () => { this.queue = this.queue.filter(v => v !== entry); return reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true }); this.queue.push(entry);
      });
    } else this.active++;
    try { signal.throwIfAborted(); return await task(); }
    finally { const next = this.queue.shift(); if (next) next.start(); else this.active--; }
  };
}
export const signalWithTimeout = ({ signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number }) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
export const MAX_BYTES = 262144;
