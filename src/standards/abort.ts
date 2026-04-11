import { DOMException as PolyfillDOMException } from './dom-exception';

type AbortListener = () => void;
type AbortEvent = { readonly target: AbortSignal; readonly type: 'abort' };
type DomExceptionLike = { name?: unknown };
type DomExceptionConstructor = new (message?: string, name?: string) => DomExceptionLike;

let abortDispatchDepth = 0;
const deferredAbortNotifications: Array<() => void> = [];

function runAbortNotification(notify: () => void): void {
  abortDispatchDepth += 1;

  try {
    notify();
  } finally {
    abortDispatchDepth -= 1;

    if (abortDispatchDepth !== 0) {
      return;
    }

    while (deferredAbortNotifications.length > 0) {
      const next = deferredAbortNotifications.shift();
      if (!next) {
        continue;
      }
      runAbortNotification(next);
    }
  }
}

function asDomExceptionConstructor(value: unknown): null | DomExceptionConstructor {
  if (typeof value !== 'function') {
    return null;
  }
  return value as DomExceptionConstructor;
}

function getDomExceptionCtor(): DomExceptionConstructor {
  return asDomExceptionConstructor(globalThis.DOMException)
    ?? asDomExceptionConstructor(PolyfillDOMException)
    ?? PolyfillDOMException;
}

function buildAbortError(reason?: unknown): unknown {
  if (typeof reason !== 'undefined') {
    return reason;
  }
  const DOMExceptionCtor = getDomExceptionCtor();
  return new DOMExceptionCtor('The operation was aborted.', 'AbortError');
}

function isAbortErrorLike(reason: unknown): reason is { message?: unknown; name?: unknown } {
  return typeof reason === 'object'
    && reason !== null
    && 'name' in reason
    && (reason as { name?: unknown }).name === 'AbortError';
}

export class AbortSignal {
  aborted = false;
  reason: unknown = undefined;
  onabort: null | ((event: AbortEvent) => void) = null;
  private readonly neverSignal: boolean;
  private notified = false;
  private readonly listeners = new Set<AbortListener>();

  constructor(neverSignal = false) {
    this.neverSignal = neverSignal;
  }

  addEventListener(type: string, listener: AbortListener): void {
    if (type !== 'abort') return;
    this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: AbortListener): void {
    if (type !== 'abort') return;
    this.listeners.delete(listener);
  }

  dispatchAbort(): void {
    if (this.neverSignal) {
      return;
    }

    this.aborted = true;

    if (this.notified) {
      return;
    }

    const event: AbortEvent = { target: this, type: 'abort' };

    const notify = () => {
      if (this.notified) {
        return;
      }

      this.notified = true;

      const onAbort = this.onabort;

      if (typeof onAbort === 'function') {
        onAbort(event);
      }

      for (const listener of Array.from(this.listeners)) {
        listener();
      }
    };

    if (abortDispatchDepth > 0) {
      deferredAbortNotifications.push(notify);
      return;
    }

    runAbortNotification(notify);
  }

  isNeverSignal(): boolean {
    return this.neverSignal;
  }
}

export class AbortController {
  readonly signal = new AbortSignal(false);

  abort(reason?: unknown): void {
    this.signal.reason = buildAbortError(reason);
    this.signal.dispatchAbort();
  }
}

const neverAbortSignal = new AbortSignal(true);

export function getNeverAbortSignal(): AbortSignal {
  return neverAbortSignal;
}

export function isNeverAbortSignal(signal: undefined | AbortSignal): boolean {
  return signal?.isNeverSignal() === true;
}

export function followAbortSignal(source: null | undefined | AbortSignal): AbortSignal | undefined {
  if (!source) {
    return undefined;
  }

  if (source.isNeverSignal()) {
    return source;
  }

  const controller = new AbortController();

  if (source.aborted) {
    controller.abort(source.reason);
    return controller.signal;
  }

  source.addEventListener('abort', () => {
    controller.abort(source.reason);
  });

  return controller.signal;
}

export function createAbortError(reason?: unknown): unknown {
  return buildAbortError(reason);
}

export function normalizeAbortRejectionReason(reason: unknown): unknown {
  if (typeof reason === 'undefined') {
    return buildAbortError(undefined);
  }

  if (!isAbortErrorLike(reason)) {
    return reason;
  }

  const DOMExceptionCtor = getDomExceptionCtor();

  if (reason instanceof DOMExceptionCtor) {
    return reason;
  }

  return buildAbortError(undefined);
}
