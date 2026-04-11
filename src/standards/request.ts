import { AbortSignal, followAbortSignal, getNeverAbortSignal } from './abort';
import { PackedByteArray } from 'godot.lib.api';
import { Blob } from './blob';
import { FormData } from './form-data';
import { parseFormDataFromBody } from './form-data-utils';
import { Headers } from './headers';
import { ReadableStream, isReadableStreamLike } from './stream';
import { URL, URLSearchParams } from './url';
import type {
  BodyInit,
  HeadersInit,
  RequestCache,
  ReferrerPolicy,
  RequestCredentials,
  RequestMode,
  RequestRedirect,
} from './types';
import { BodyContainer } from './body-container';

export type RequestInfo = Request | URL | string;

export interface RequestInit {
  body?: null | BodyInit;
  cache?: RequestCache;
  credentials?: RequestCredentials;
  duplex?: string;
  headers?: HeadersInit;
  integrity?: string;
  keepalive?: boolean;
  method?: string;
  mode?: RequestMode;
  referrer?: string;
  referrerPolicy?: ReferrerPolicy;
  redirect?: RequestRedirect;
  signal?: null | AbortSignal;
  window?: null;
}

const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
const METHOD_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SIMPLE_METHODS = new Set(['GET', 'HEAD', 'POST']);
const ALLOWED_MODES = new Set(['cors', 'no-cors', 'same-origin', 'navigate']);
const ALLOWED_CREDENTIALS = new Set(['include', 'omit', 'same-origin']);
const ALLOWED_CACHES = new Set(['default', 'force-cache', 'no-cache', 'no-store', 'only-if-cached', 'reload']);
const ALLOWED_REDIRECTS = new Set(['error', 'follow', 'manual']);
const ALLOWED_REFERRER_POLICIES = new Set(['', 'no-referrer', 'origin', 'origin-when-cross-origin']);

function parseAllowedString<T extends string>(
  value: string,
  allowed: ReadonlySet<string>,
  errorMessage: string,
): T {
  if (!allowed.has(value)) {
    throw new TypeError(errorMessage);
  }

  return value as T;
}

function normalizeRequestBody(body: null | unknown): null | BodyInit {
  if (body === null || typeof body === 'undefined') {
    return null;
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return body;
  }

  if (
    body instanceof Blob
    || body instanceof FormData
    || body instanceof URLSearchParams
    || isReadableStreamLike(body)
  ) {
    return body;
  }

  if (body instanceof PackedByteArray) {
    return body;
  }

  return String(body);
}

function normalizeMethod(method: string): string {
  const normalized = method.toUpperCase();

  if (!METHOD_TOKEN.test(normalized)) {
    throw new TypeError('Invalid HTTP method');
  }

  if (FORBIDDEN_METHODS.has(normalized)) {
    throw new TypeError('Forbidden HTTP method');
  }

  return normalized;
}

function inferBodyContentType(body: null | BodyInit): null | string {
  if (body === null) {
    return null;
  }

  if (typeof body === 'string') {
    return 'text/plain;charset=UTF-8';
  }

  if (body instanceof URLSearchParams) {
    return 'application/x-www-form-urlencoded;charset=UTF-8';
  }

  if (body instanceof FormData) {
    return body.getContentType();
  }

  if (body instanceof Blob) {
    return body.type.length > 0 ? body.type : null;
  }

  return null;
}

function resolveRequestUrl(input: RequestInfo): string {
  const source = input instanceof Request ? input.url : (input instanceof URL ? input.toString() : String(input));

  if (/^(blob:|data:|about:)/i.test(source)) {
    return source;
  }

  const base = globalThis.location?.href;
  const parse = (candidate: string): string => (typeof base === 'string' && base.length > 0
    ? new URL(candidate, base).toString()
    : new URL(candidate).toString());

  try {
    return parse(source);
  } catch {
    try {
      return parse(encodeURI(source));
    } catch {
      throw new TypeError('Invalid URL');
    }
  }
}

function hasCredentialInUrl(url: string): boolean {
  const schemeIndex = url.indexOf('://');

  if (schemeIndex < 0) {
    return false;
  }

  const authorityStart = schemeIndex + 3;
  const pathOffset = url.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = pathOffset < 0 ? url.length : authorityStart + pathOffset;
  const authority = url.slice(authorityStart, authorityEnd);
  return authority.lastIndexOf('@') > 0;
}

function resolveReferrer(referrer: string): string {
  if (referrer === '' || referrer === 'about:client') {
    return referrer;
  }

  try {
    const base = globalThis.location?.href;
    return typeof base === 'string' && base.length > 0
      ? new URL(referrer, base).toString()
      : new URL(referrer).toString();
  } catch {
    throw new TypeError('Invalid referrer URL');
  }
}

export class Request {
  private readonly _cache: RequestCache;
  private readonly _credentials: RequestCredentials;
  private readonly _destination = '';
  private readonly _duplex = 'half';
  private readonly _headers: Headers;
  private readonly _integrity: string;
  private readonly _isHistoryNavigation = false;
  private readonly _isReloadNavigation = false;
  private readonly _keepalive: boolean;
  private readonly _method: string;
  private readonly _mode: RequestMode;
  private readonly _redirect: RequestRedirect;
  private readonly _referrer: string;
  private readonly _referrerPolicy: ReferrerPolicy;
  private readonly _signal?: AbortSignal;
  private readonly _url: string;
  private readonly _bodySourceIsStream: boolean;

  get body(): null | ReadableStream {
    return this.bodyContainer.body;
  }

  get cache(): RequestCache {
    return this._cache;
  }

  get credentials(): RequestCredentials {
    return this._credentials;
  }

  get destination(): string {
    return this._destination;
  }

  get duplex(): string {
    return this._duplex;
  }

  get headers(): Headers {
    return this._headers;
  }

  get integrity(): string {
    return this._integrity;
  }

  get isHistoryNavigation(): boolean {
    return this._isHistoryNavigation;
  }

  get isReloadNavigation(): boolean {
    return this._isReloadNavigation;
  }

  get keepalive(): boolean {
    return this._keepalive;
  }

  get method(): string {
    return this._method;
  }

  get mode(): RequestMode {
    return this._mode;
  }

  get redirect(): RequestRedirect {
    return this._redirect;
  }

  get referrer(): string {
    return this._referrer;
  }

  get referrerPolicy(): ReferrerPolicy {
    return this._referrerPolicy;
  }

  get signal(): AbortSignal | undefined {
    return this._signal;
  }

  get url(): string {
    return this._url;
  }

  get bodyUsed(): boolean {
    return this.bodyContainer.isBodyUsed();
  }

  get bodySourceIsStream(): boolean {
    return this._bodySourceIsStream;
  }

  private readonly bodyContainer: BodyContainer;

  constructor(input: RequestInfo, init: RequestInit = {}) {
    const source = input instanceof Request ? input : null;

    if (Object.prototype.hasOwnProperty.call(init, 'window') && init.window !== null) {
      throw new TypeError('RequestInit.window must be null');
    }

    this._url = resolveRequestUrl(input);

    if (hasCredentialInUrl(this._url)) {
      throw new TypeError('Request URL must not contain credentials');
    }

    this._method = normalizeMethod(init.method ?? source?.method ?? 'GET');

    this._mode = parseAllowedString<RequestMode>(
      init.mode ?? source?.mode ?? 'cors',
      ALLOWED_MODES,
      'Invalid request mode',
    );

    this._credentials = parseAllowedString<RequestCredentials>(
      init.credentials ?? source?.credentials ?? 'same-origin',
      ALLOWED_CREDENTIALS,
      'Invalid request credentials',
    );

    this._cache = parseAllowedString<RequestCache>(
      init.cache ?? source?.cache ?? 'default',
      ALLOWED_CACHES,
      'Invalid request cache mode',
    );

    this._referrer = resolveReferrer(init.referrer ?? source?.referrer ?? 'about:client');
    this._referrerPolicy = parseAllowedString<ReferrerPolicy>(
      init.referrerPolicy ?? source?.referrerPolicy ?? '',
      ALLOWED_REFERRER_POLICIES,
      'Invalid request referrer policy',
    );

    this._redirect = parseAllowedString<RequestRedirect>(
      init.redirect ?? source?.redirect ?? 'follow',
      ALLOWED_REDIRECTS,
      'Invalid request redirect mode',
    );

    this._keepalive = init.keepalive ?? source?.keepalive ?? false;

    if (this._mode === 'navigate') {
      throw new TypeError('navigate mode is not allowed');
    }

    if (this._cache === 'only-if-cached' && this._mode !== 'same-origin') {
      throw new TypeError('only-if-cached requires same-origin mode');
    }

    if (this._mode === 'no-cors' && !SIMPLE_METHODS.has(this._method)) {
      throw new TypeError('no-cors requests only allow simple methods');
    }

    if (Object.prototype.hasOwnProperty.call(init, 'signal')) {
      this._signal = init.signal === null ? undefined : followAbortSignal(init.signal);
    } else {
      this._signal = followAbortSignal(source?.signal) ?? getNeverAbortSignal();
    }

    this._integrity = init.integrity ?? source?.integrity ?? '';

    this._headers = init.headers
      ? new Headers(undefined, 'request')
      : new Headers(source ? source.headers : undefined, 'request');

    if (init.headers) {
      new Headers(init.headers).forEach((value, key) => this._headers.set(key, value));
    }

    const normalizedInitBody = typeof init.body !== 'undefined'
      ? normalizeRequestBody(init.body)
      : undefined;

    const bodyForMethodValidation = typeof normalizedInitBody !== 'undefined'
      ? normalizedInitBody
      : (source?.body ?? null);

    if ((this._method === 'GET' || this._method === 'HEAD') && bodyForMethodValidation !== null) {
      throw new TypeError('Request with GET/HEAD method cannot have body');
    }

    if (source && typeof normalizedInitBody !== 'undefined') {
      source.bodyContainer.markUsedForRequestInitOverride();
    }

    const sourceBody = typeof normalizedInitBody !== 'undefined'
      ? normalizedInitBody
      : (source ? source.bodyContainer.cloneBodyForRequestTransfer() : null);

    const body = normalizeRequestBody(sourceBody);

    this._bodySourceIsStream = isReadableStreamLike(body);

    const inferredType = inferBodyContentType(body);

    if (inferredType !== null && !this._headers.has('content-type')) {
      this._headers.set('content-type', inferredType);
    }

    this.bodyContainer = new BodyContainer(
      body,
      // Request body readers are not aborted by request signal state.
      undefined,
      () => this._headers.get('content-type'),
    );
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.bodyContainer.arrayBuffer();
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  blob(): Promise<Blob> {
    return this.bodyContainer.blob();
  }

  bytes(): Promise<Uint8Array> {
    return this.bodyContainer.bytes();
  }

  clone(): Request {
    if (this.bodyUsed) {
      throw new TypeError('Cannot clone a request with consumed body');
    }

    return new Request(this);
  }

  async formData(): Promise<FormData> {
    return parseFormDataFromBody(this.headers.get('content-type'), await this.text());
  }

  text(): Promise<string> {
    return this.bodyContainer.text();
  }
}
