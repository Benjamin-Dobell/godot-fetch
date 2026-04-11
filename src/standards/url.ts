import { Blob } from './blob';
import type { URLSearchParamsInit } from './types';

type HeaderEntry = [string, string];
const blobUrlStore = new Map<string, Blob>();
let blobUrlCounter = 0;

function nextBlobUrl(): string {
  const origin = typeof globalThis.location?.origin === 'string' && globalThis.location.origin.length > 0
    ? globalThis.location.origin
    : 'null';
  blobUrlCounter += 1;
  return `blob:${origin}/${String(blobUrlCounter)}`;
}

function tryDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseAbsoluteUrl(value: unknown): {
  hash: string;
  host: string;
  hostname: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
} {
  const text = String(value);
  const match = text.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/);

  if (!match) {
    throw new TypeError(`Invalid URL: ${text}`);
  }

  const protocol = match[1] ?? '';
  const host = match[2] ?? '';

  if (host.length === 0) {
    throw new TypeError(`Invalid URL: ${text}`);
  }

  if (/\s/.test(host)) {
    throw new TypeError(`Invalid URL: ${text}`);
  }

  const pathname = (match[3] ?? '').length > 0 ? (match[3] as string) : '/';
  const search = match[4] ?? '';
  const hash = match[5] ?? '';
  let hostname = host;
  let port = '';

  if (host.startsWith('[')) {
    const closingBracket = host.indexOf(']');

    if (closingBracket === -1) {
      throw new TypeError(`Invalid URL: ${text}`);
    }

    hostname = host.slice(0, closingBracket + 1);
    const afterBracket = host.slice(closingBracket + 1);

    if (afterBracket.length > 0) {
      if (!afterBracket.startsWith(':')) {
        throw new TypeError(`Invalid URL: ${text}`);
      }

      port = afterBracket.slice(1);
    }
  } else {
    const colonIndex = host.lastIndexOf(':');
    const hasPort = colonIndex > -1 && colonIndex !== host.length - 1;
    hostname = hasPort ? host.slice(0, colonIndex) : host;
    port = hasPort ? host.slice(colonIndex + 1) : '';
  }

  if (hostname.length === 0) {
    throw new TypeError(`Invalid URL: ${text}`);
  }

  if (port.length > 0 && !/^[0-9]+$/.test(port)) {
    throw new TypeError(`Invalid URL: ${text}`);
  }

  return {
    hash,
    host,
    hostname,
    pathname,
    port,
    protocol,
    search,
  };
}

function normalizePath(pathname: string): string {
  const rawSegments = pathname.split('/');
  const normalized: string[] = [];

  for (const segment of rawSegments) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }

    if (segment === '..') {
      normalized.pop();
      continue;
    }

    normalized.push(segment);
  }

  return `/${normalized.join('/')}`;
}

function resolveRelativePath(relativePath: string, basePath: string): string {
  if (relativePath.startsWith('/')) {
    return normalizePath(relativePath);
  }

  const baseDirectory = basePath.endsWith('/') ? basePath : basePath.slice(0, basePath.lastIndexOf('/') + 1);
  return normalizePath(`${baseDirectory}${relativePath}`);
}

function resolveUrl(input: string, base?: string): {
  hash: string;
  host: string;
  hostname: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
} {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
    return parseAbsoluteUrl(input);
  }

  if (!base) {
    throw new TypeError(`Invalid URL without base: ${input}`);
  }

  const baseParts = parseAbsoluteUrl(base);
  const hashIndex = input.indexOf('#');
  const queryIndex = input.indexOf('?');
  const pathEnd = queryIndex > -1 ? queryIndex : (hashIndex > -1 ? hashIndex : input.length);

  const relativePath = input.slice(0, pathEnd);
  const search = queryIndex > -1 ? input.slice(queryIndex, hashIndex > -1 ? hashIndex : undefined) : '';
  const hash = hashIndex > -1 ? input.slice(hashIndex) : '';

  return {
    hash,
    host: baseParts.host,
    hostname: baseParts.hostname,
    pathname: resolveRelativePath(relativePath.length > 0 ? relativePath : baseParts.pathname, baseParts.pathname),
    port: baseParts.port,
    protocol: baseParts.protocol,
    search,
  };
}

export class URLSearchParams {
  private readonly entries: HeaderEntry[] = [];
  private readonly onChange?: () => void;

  constructor(init: URLSearchParamsInit = '', onChange?: () => void) {
    this.onChange = onChange;

    if (typeof init === 'string') {
      const value = init.startsWith('?') ? init.slice(1) : init;

      if (value.length === 0) {
        return;
      }

      for (const segment of value.split('&')) {
        if (segment.length === 0) {
          continue;
        }

        const separator = segment.indexOf('=');
        const rawKey = separator === -1 ? segment : segment.slice(0, separator);
        const rawValue = separator === -1 ? '' : segment.slice(separator + 1);
        this.entries.push([tryDecodeUriComponent(rawKey), tryDecodeUriComponent(rawValue)]);
      }
      return;
    }

    if (init instanceof URLSearchParams) {
      this.entries.push(...init.entries);
      return;
    }

    if (Array.isArray(init)) {
      for (const [key, value] of init) {
        this.entries.push([String(key), String(value)]);
      }

      return;
    }

    for (const key of Object.keys(init)) {
      this.entries.push([key, String(init[key])]);
    }
  }

  append(name: string, value: string): void {
    this.entries.push([name, value]);
    this.onChange?.();
  }

  delete(name: string): void {
    const normalized = String(name);

    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (this.entries[index]![0] === normalized) {
        this.entries.splice(index, 1);
      }
    }
    this.onChange?.();
  }

  get(name: string): null | string {
    const normalized = String(name);
    const found = this.entries.find(([key]) => key === normalized);
    return found ? found[1] : null;
  }

  getAll(name: string): string[] {
    const normalized = String(name);
    return this.entries.filter(([key]) => key === normalized).map(([, value]) => value);
  }

  has(name: string): boolean {
    const normalized = String(name);
    return this.entries.some(([key]) => key === normalized);
  }

  set(name: string, value: string): void {
    const normalized = String(name);
    this.delete(normalized);
    this.append(normalized, value);
  }

  forEach(callback: (value: string, key: string, parent: URLSearchParams) => void): void {
    for (const [key, value] of this.entries) {
      callback(value, key, this);
    }
  }

  toString(): string {
    return this.entries
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
  }

  replaceFromString(init: string): void {
    this.entries.splice(0, this.entries.length);
    const value = init.startsWith('?') ? init.slice(1) : init;

    if (value.length === 0) {
      return;
    }

    for (const segment of value.split('&')) {
      if (segment.length === 0) {
        continue;
      }

      const separator = segment.indexOf('=');
      const rawKey = separator === -1 ? segment : segment.slice(0, separator);
      const rawValue = separator === -1 ? '' : segment.slice(separator + 1);
      this.entries.push([tryDecodeUriComponent(rawKey), tryDecodeUriComponent(rawValue)]);
    }
  }
}

export class URL {
  private _hash: string;
  private _host: string;
  private _hostname: string;
  private _href: string;
  private _origin: string;
  private _pathname: string;
  private _port: string;
  private _protocol: string;
  private _search: string;
  readonly searchParams: URLSearchParams;

  constructor(url: string, base?: string | URL) {
    const resolvedBase = base instanceof URL ? base.toString() : base;
    const parts = resolveUrl(url, resolvedBase);

    this._hash = parts.hash;
    this._host = parts.host;
    this._hostname = parts.hostname;
    this._pathname = parts.pathname;
    this._port = parts.port;
    this._protocol = parts.protocol;
    this._search = parts.search;
    this._origin = `${this._protocol}//${this._host}`;
    this.searchParams = new URLSearchParams(this.search, () => {
      const serialized = this.searchParams.toString();
      this._search = serialized.length > 0 ? `?${serialized}` : '';
      this.rebuildHref();
    });
    this._href = '';
    this.rebuildHref();
  }

  get hash(): string {
    return this._hash;
  }

  set hash(value: string) {
    const text = String(value);
    this._hash = text.length === 0 ? '' : (text.startsWith('#') ? text : `#${text}`);
    this.rebuildHref();
  }

  get host(): string {
    return this._host;
  }

  set host(value: string) {
    this._host = String(value);
    const colonIndex = this._host.lastIndexOf(':');
    const hasPort = colonIndex > -1 && colonIndex !== this._host.length - 1;
    this._hostname = hasPort ? this._host.slice(0, colonIndex) : this._host;
    this._port = hasPort ? this._host.slice(colonIndex + 1) : '';
    this.rebuildHref();
  }

  get hostname(): string {
    return this._hostname;
  }

  set hostname(value: string) {
    this._hostname = String(value);
    this._host = this._port.length > 0 ? `${this._hostname}:${this._port}` : this._hostname;
    this.rebuildHref();
  }

  get href(): string {
    return this._href;
  }

  set href(value: string) {
    const parts = parseAbsoluteUrl(String(value));
    this._hash = parts.hash;
    this._host = parts.host;
    this._hostname = parts.hostname;
    this._pathname = parts.pathname;
    this._port = parts.port;
    this._protocol = parts.protocol;
    this._search = parts.search;
    this.searchParams.replaceFromString(this._search);
    this.rebuildHref();
  }

  get origin(): string {
    return this._origin;
  }

  get pathname(): string {
    return this._pathname;
  }

  set pathname(value: string) {
    const text = String(value);
    this._pathname = text.startsWith('/') ? text : `/${text}`;
    this.rebuildHref();
  }

  get port(): string {
    return this._port;
  }

  set port(value: string) {
    const text = String(value);
    this._port = text.startsWith(':') ? text.slice(1) : text;
    this._host = this._port.length > 0 ? `${this._hostname}:${this._port}` : this._hostname;
    this.rebuildHref();
  }

  get protocol(): string {
    return this._protocol;
  }

  set protocol(value: string) {
    const text = String(value);
    this._protocol = text.endsWith(':') ? text : `${text}:`;
    this.rebuildHref();
  }

  get search(): string {
    return this._search;
  }

  set search(value: string) {
    const text = String(value);
    this._search = text.length === 0 ? '' : (text.startsWith('?') ? text : `?${text}`);
    this.searchParams.replaceFromString(this._search);
    this.rebuildHref();
  }

  toString(): string {
    return this._href;
  }

  static createObjectURL(object: unknown): string {
    if (!(object instanceof Blob)) {
      throw new TypeError('URL.createObjectURL expects a Blob');
    }

    const objectUrl = nextBlobUrl();
    blobUrlStore.set(objectUrl, object);
    return objectUrl;
  }

  static revokeObjectURL(url: string): void {
    blobUrlStore.delete(String(url));
  }

  private rebuildHref(): void {
    this._origin = `${this._protocol}//${this._host}`;
    this._href = `${this._protocol}//${this._host}${this._pathname}${this._search}${this._hash}`;
  }
}

export function getBlobFromObjectUrl(url: string): Blob | null {
  return blobUrlStore.get(url) ?? null;
}
