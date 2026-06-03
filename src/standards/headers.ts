import type { HeadersInit } from './types';

function normalizeHeaderName(value: string): string {
  return value.trim().toLowerCase();
}

const HEADER_NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function assertByteString(value: string, kind: 'name' | 'value'): void {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0xff) {
      throw new TypeError(`Invalid header ${kind}`);
    }
  }
}

function assertValidHeaderName(name: string): void {
  const value = String(name);
  assertByteString(value, 'name');
  if (!HEADER_NAME_TOKEN.test(value)) {
    throw new TypeError('Invalid header name');
  }
}

function assertValidHeaderValue(value: string): void {
  const text = String(value);
  assertByteString(text, 'value');
  if (/[\u0000\u000A\u000D]/.test(text)) {
    throw new TypeError('Invalid header value');
  }
}

function assertValidResponseHeaderValue(value: string): void {
  const text = String(value);
  if (/[\u0000\u000A\u000D]/.test(text)) {
    throw new TypeError('Invalid header value');
  }
}

function normalizeHeaderValue(value: string, mode: 'response' | 'strict'): string {
  const text = String(value);
  if (mode === 'response') {
    return text;
  }
  return text.replace(/^[\t\r\n ]+|[\t\r\n ]+$/g, '');
}

type HeadersIteratorKind = 'entries' | 'keys' | 'values';
type HeadersIteratorValue = [string, string] | string;
type HeadersIterator = IterableIterator<HeadersIteratorValue> & {
  headers: Headers;
  index: number;
  kind: HeadersIteratorKind;
};

const IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
const HeadersIteratorPrototype = Object.create(IteratorPrototype);

Object.defineProperty(HeadersIteratorPrototype, 'next', {
  configurable: true,
  enumerable: true,
  writable: true,
  value(this: HeadersIterator): IteratorResult<HeadersIteratorValue> {
    const entries = this.headers.sortedEntries();

    if (this.index >= entries.length) {
      return {
        done: true,
        value: undefined,
      };
    }

    const [name, value] = entries[this.index++]!;

    if (this.kind === 'keys') {
      return {
        done: false,
        value: name,
      };
    }

    if (this.kind === 'values') {
      return {
        done: false,
        value,
      };
    }

    return {
      done: false,
      value: [name, value],
    };
  },
});

Object.defineProperty(HeadersIteratorPrototype, Symbol.iterator, {
  configurable: true,
  enumerable: false,
  writable: true,
  value(this: HeadersIterator): HeadersIterator {
    return this;
  },
});

function createHeadersIterator(
  headers: Headers,
  kind: HeadersIteratorKind,
): IterableIterator<HeadersIteratorValue> {
  const iterator = Object.create(HeadersIteratorPrototype) as HeadersIterator;
  iterator.headers = headers;
  iterator.index = 0;
  iterator.kind = kind;
  return iterator;
}

export class Headers {
  private readonly map = new Map<string, { originalName: string; values: string[] }>();
  private guard: 'none' | 'request' | 'response' | 'immutable';
  private readonly valueValidationMode: 'response' | 'strict';

  constructor(
    init?: HeadersInit,
    guard: 'none' | 'request' | 'response' | 'immutable' = 'none',
    valueValidationMode: 'response' | 'strict' = 'strict',
  ) {
    this.guard = guard;
    this.valueValidationMode = valueValidationMode;

    if (typeof init === 'undefined') {
      return;
    }

    if (init === null) {
      throw new TypeError('Invalid headers init');
    }

    const iteratorMethod = Reflect.get(init as object, Symbol.iterator);

    if (typeof iteratorMethod === 'function') {
      for (const pair of init as Iterable<unknown>) {
        if (!Array.isArray(pair) || pair.length !== 2) {
          throw new TypeError('Header pairs must be [name, value]');
        }

        const [name, value] = pair;
        this.append(String(name), String(value));
      }
      return;
    }

    if (typeof init !== 'object') {
      throw new TypeError('Invalid headers init');
    }

    for (const key of Reflect.ownKeys(init as object)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(init as object, key);

      if (!descriptor || !descriptor.enumerable) {
        continue;
      }

      if (typeof key === 'symbol') {
        throw new TypeError('Invalid header name');
      }

      const headerName = String(key);
      assertValidHeaderName(headerName);
      const value = Reflect.get(init as object, key);
      this.append(headerName, String(value));
    }
  }

  append(name: string, value: string): void {
    assertValidHeaderName(name);

    const headerValue = normalizeHeaderValue(value, this.valueValidationMode);

    if (this.valueValidationMode === 'response') {
      assertValidResponseHeaderValue(headerValue);
    } else {
      assertValidHeaderValue(headerValue);
    }

    if (!this.canSetHeader(name, headerValue)) {
      return;
    }

    const originalName = String(name);
    const key = normalizeHeaderName(originalName);
    const existing = this.map.get(key);

    if (existing) {
      existing.values.push(headerValue);
      return;
    }

    this.map.set(key, { originalName, values: [headerValue] });
  }

  delete(name: string): void {
    assertValidHeaderName(name);
    if (this.guard === 'immutable') {
      throw new TypeError('Headers are immutable');
    }
    this.map.delete(normalizeHeaderName(String(name)));
  }

  get(name: string): null | string {
    assertValidHeaderName(name);

    const entry = this.map.get(normalizeHeaderName(String(name)));

    if (!entry || entry.values.length === 0) {
      return null;
    }

    return entry.values.join(', ');
  }

  getSetCookie(): string[] {
    const entry = this.map.get('set-cookie');
    return entry ? [...entry.values] : [];
  }

  has(name: string): boolean {
    assertValidHeaderName(name);
    return this.map.has(normalizeHeaderName(String(name)));
  }

  set(name: string, value: string): void {
    assertValidHeaderName(name);

    const headerValue = normalizeHeaderValue(value, this.valueValidationMode);

    if (this.valueValidationMode === 'response') {
      assertValidResponseHeaderValue(headerValue);
    } else {
      assertValidHeaderValue(headerValue);
    }

    if (!this.canSetHeader(name, headerValue)) {
      return;
    }

    const originalName = String(name);

    this.map.set(normalizeHeaderName(originalName), {
      originalName,
      values: [headerValue],
    });
  }

  forEach(callback: (value: string, key: string, parent: Headers) => void): void {
    for (const [key, value] of this.entries()) {
      callback(value, key, this);
    }
  }

  entries(): IterableIterator<[string, string]> {
    return createHeadersIterator(this, 'entries') as IterableIterator<[string, string]>;
  }

  keys(): IterableIterator<string> {
    return createHeadersIterator(this, 'keys') as IterableIterator<string>;
  }

  values(): IterableIterator<string> {
    return createHeadersIterator(this, 'values') as IterableIterator<string>;
  }

  rawEntries(): [string, string][] {
    return Array.from(this.map.values()).map((entry) => [
      entry.originalName,
      entry.values.join(', '),
    ]);
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  makeImmutable(): void {
    this.guard = 'immutable';
  }

  private canSetHeader(name: string, value: string): boolean {
    if (this.guard === 'immutable') {
      throw new TypeError('Headers are immutable');
    }

    const normalized = normalizeHeaderName(String(name));

    if (this.guard === 'response') {
      return !FORBIDDEN_RESPONSE_HEADERS.has(normalized);
    }

    if (this.guard !== 'request') {
      return true;
    }

    if (normalized.startsWith('proxy-') || normalized.startsWith('sec-')) {
      return false;
    }
    if (FORBIDDEN_REQUEST_HEADERS.has(normalized)) {
      return false;
    }
    if (FORBIDDEN_METHOD_OVERRIDE_HEADERS.has(normalized) && containsForbiddenMethodToken(String(value))) {
      return false;
    }
    return true;
  }

  sortedEntries(): [string, string][] {
    const entries: [string, string][] = [];

    for (const key of Array.from(this.map.keys()).sort()) {
      const entry = this.map.get(key);
      if (!entry) {
        continue;
      }
      if (key === 'set-cookie') {
        for (const value of entry.values) {
          entries.push([key, value]);
        }
      } else {
        entries.push([key, entry.values.join(', ')]);
      }
    }

    return entries;
  }
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'access-control-request-private-network',
  'connection',
  'cookie',
  'cookie2',
  'content-length',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'set-cookie',
]);

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
]);

const FORBIDDEN_METHOD_OVERRIDE_HEADERS = new Set([
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
]);

function containsForbiddenMethodToken(value: string): boolean {
  return value
    .split(',')
    .map(token => token.trim().toUpperCase())
    .some(token => token === 'CONNECT' || token === 'TRACE' || token === 'TRACK');
}
