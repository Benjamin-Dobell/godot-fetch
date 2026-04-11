import { Marshalls, OS, PackedByteArray } from 'godot.lib.api';
import { HttpAbortError, HttpResponseError, submit, type HttpHeaders, type HttpResponse } from '../http';
import {
  createAbortError,
  isNeverAbortSignal,
  normalizeAbortRejectionReason,
  type AbortSignal,
} from './abort';
import { Blob } from './blob';
import { TextEncoder } from './encoding';
import { FormData } from './form-data';
import { Headers } from './headers';
import { ReadableStream, isReadableStreamLike } from './stream';
import type { BodyInit } from './types';
import { URL, URLSearchParams, getBlobFromObjectUrl } from './url';
import { Request, type RequestInfo, type RequestInit } from './request';
import { Response } from './response';
import { markAsGodotFetchImplementation } from '../utils/install';

export type Fetch = (input: RequestInfo | URL, init?: FetchRequestInit) => Promise<Response>;

const DEFAULT_ACCEPT_HEADER = '*/*';
const DEFAULT_ACCEPT_LANGUAGE_HEADER = 'en-US,en;q=0.9';
const DEFAULT_USER_AGENT_HEADER = 'godot-fetch';

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'connection',
  'content-length',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

const HOST_POLICY_OVERRIDE_HEADERS = new Set([
  'access-control-request-headers',
  'access-control-request-method',
  'origin',
  'referer',
]);

const FORBIDDEN_METHOD_OVERRIDE_HEADERS = new Set([
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
]);

const REDIRECT_REWRITTEN_BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
  'content-length',
];

const MAX_REDIRECTS = 20;

const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 77, 79, 87,
  95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 139, 143,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556,
  563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045,
  5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const isWebRuntime = OS.has_feature('web');

export type FetchBodyInit = BodyInit | PackedByteArray;

export interface FetchRequestInit extends Omit<RequestInit, 'body'> {
  body?: null | FetchBodyInit;
}

function inferContentType(body: null | FetchBodyInit): null | string {
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

function resolveUrl(rawUrl: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawUrl)) {
    return rawUrl;
  }

  const base = globalThis.location?.href;

  if (!base) {
    throw new TypeError(`Cannot resolve relative URL without a base: ${rawUrl}`);
  }

  return new URL(rawUrl, base).toString();
}

function resolveRelativeRedirect(locationHeader: string, currentUrl: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(locationHeader)) {
    return locationHeader;
  }

  return new URL(locationHeader, currentUrl).toString();
}

function containsForbiddenMethodToken(value: string): boolean {
  return value
    .split(',')
    .map(token => token.trim().toUpperCase())
    .some(token => token === 'CONNECT' || token === 'TRACE' || token === 'TRACK');
}

function isForbiddenRequestHeader(name: string, value: string): boolean {
  const normalized = name.toLowerCase();

  if (!isWebRuntime && HOST_POLICY_OVERRIDE_HEADERS.has(normalized)) {
    // Host polyfill intentionally allows overriding browser-origin policy headers
    // so non-browser runtimes can interoperate with CORS-protected servers.
    return false;
  }

  if (normalized.startsWith('proxy-') || normalized.startsWith('sec-')) {
    return true;
  }

  if (FORBIDDEN_REQUEST_HEADERS.has(normalized)) {
    return true;
  }

  if (FORBIDDEN_METHOD_OVERRIDE_HEADERS.has(normalized) && containsForbiddenMethodToken(value)) {
    return true;
  }

  return false;
}

function getRequestReferrer(input: RequestInfo | URL, init?: FetchRequestInit): string {
  if (typeof init?.referrer === 'string') {
    return init.referrer;
  }

  if (input instanceof Request) {
    return input.referrer;
  }

  return 'about:client';
}

function getRequestReferrerPolicy(input: RequestInfo | URL, init?: FetchRequestInit): string {
  if (typeof init?.referrerPolicy === 'string') {
    return init.referrerPolicy;
  }

  if (input instanceof Request) {
    return input.referrerPolicy;
  }

  return '';
}

function toOriginUrl(urlText: string): null | string {
  try {
    return `${new URL(urlText).origin}/`;
  } catch {
    return null;
  }
}

function stripUserInfo(urlText: string): string {
  return urlText.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, '$1');
}

function resolveReferrerHeader(input: RequestInfo | URL, init: FetchRequestInit | undefined, resolvedUrl: string): null | string {
  const currentHref = globalThis.location?.href;

  if (typeof currentHref !== 'string' || currentHref.length === 0) {
    return null;
  }

  const referrerPolicy = getRequestReferrerPolicy(input, init);

  if (referrerPolicy === 'no-referrer') {
    return null;
  }

  const referrer = getRequestReferrer(input, init);

  if (referrer === '') {
    return null;
  }

  const absoluteReferrer = referrer === 'about:client'
    ? stripFragment(currentHref)
    : stripFragment(resolveUrl(stripUserInfo(referrer)));

  if (absoluteReferrer.length === 0) {
    return null;
  }

  if (referrerPolicy === 'origin') {
    return toOriginUrl(absoluteReferrer);
  }

  if (referrerPolicy === 'origin-when-cross-origin') {
    const targetOrigin = toOriginUrl(resolvedUrl);
    const sourceOrigin = toOriginUrl(absoluteReferrer);

    if (targetOrigin === null || sourceOrigin === null) {
      return null;
    }

    if (targetOrigin !== sourceOrigin) {
      return sourceOrigin;
    }
  }

  return absoluteReferrer;
}

function buildHeaders(input: RequestInfo | URL, init: FetchRequestInit | undefined, resolvedUrl: string): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  const method = (input instanceof Request ? input.method : (init?.method ?? 'GET')).toUpperCase();

  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      if (isForbiddenRequestHeader(key, value)) {
        return;
      }

      headers.set(key, value);
    });
  }

  if (!headers.has('accept')) {
    headers.set('accept', DEFAULT_ACCEPT_HEADER);
  }

  if (!headers.has('accept-language')) {
    headers.set('accept-language', DEFAULT_ACCEPT_LANGUAGE_HEADER);
  }

  if (!headers.has('user-agent')) {
    headers.set('user-agent', DEFAULT_USER_AGENT_HEADER);
  }

  const referer = resolveReferrerHeader(input, init, resolvedUrl);

  if (referer !== null && !headers.has('referer')) {
    headers.set('referer', referer);
  }

  if (method !== 'GET' && method !== 'HEAD' && !headers.has('origin')) {
    const origin = globalThis.location?.origin;

    if (typeof origin === 'string' && origin.length > 0) {
      headers.set('origin', origin);
    }
  }

  return headers;
}

async function getRequestBody(input: RequestInfo | URL, init?: FetchRequestInit): Promise<null | FetchBodyInit> {
  if (typeof init?.body !== 'undefined') {
    return init.body;
  }

  if (input instanceof Request) {
    if (input.body === null) {
      return null;
    }

    return await input.bytes();
  }

  return null;
}

async function bodyToBytes(body: FetchBodyInit): Promise<Uint8Array> {
  if (typeof body === 'string') {
    return new TextEncoder().encode(body);
  }

  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString());
  }

  if (body instanceof FormData) {
    return new TextEncoder().encode(body.toMultipartBody());
  }

  if (body instanceof Blob) {
    return body.bytes();
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }

  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }

  throw new TypeError('Unsupported request body type');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function toTransportBody(body: null | FetchBodyInit): Promise<null | string | ArrayBuffer | PackedByteArray> {
  if (body === null) {
    return null;
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof PackedByteArray) {
    return body;
  }

  const bytes = await bodyToBytes(body);
  return toArrayBuffer(bytes);
}

function getKnownBodyLength(body: FetchBodyInit): null | number {
  if (typeof body === 'string') {
    return new TextEncoder().encode(body).byteLength;
  }

  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString()).byteLength;
  }

  if (body instanceof FormData) {
    return new TextEncoder().encode(body.toMultipartBody()).byteLength;
  }

  if (body instanceof Blob) {
    return body.size;
  }

  if (body instanceof PackedByteArray) {
    return body.size();
  }

  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }

  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }

  return null;
}

function applyContentLengthHeader(headers: Headers, method: string, body: null | FetchBodyInit): void {
  if (headers.has('content-length')) {
    return;
  }

  const upperMethod = method.toUpperCase();

  if (body === null) {
    if (upperMethod === 'POST' || upperMethod === 'PUT') {
      headers.set('content-length', '0');
    }

    return;
  }

  const knownLength = getKnownBodyLength(body);

  if (knownLength !== null) {
    headers.set('content-length', String(knownLength));
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isBadPort(urlText: string): boolean {
  try {
    const parsed = new URL(urlText);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    if (parsed.port.length === 0) {
      return false;
    }

    const port = Number.parseInt(parsed.port, 10);
    return Number.isFinite(port) && BAD_PORTS.has(port);
  } catch {
    return false;
  }
}

function toHeaderRecord(headers: Headers): HttpHeaders {
  const out: HttpHeaders = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function stripFragment(url: string): string {
  const hashIndex = url.indexOf('#');

  if (hashIndex === -1) {
    return url;
  }

  return url.slice(0, hashIndex);
}

function normalizeResponseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return stripFragment(url);
  }
}

function validateResponseHeaders(headers: Headers): void {
  headers.forEach((value, key) => {
    if (key.includes('\0') || value.includes('\0')) {
      throw new TypeError('Invalid response header');
    }
  });
}

function toHeaders(headers: HttpHeaders): Headers {
  const out = new Headers(undefined, 'none', 'response');
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        out.append(key, entry);
      }
    } else {
      out.set(key, value);
    }
  }
  return out;
}

function copyUint8ArrayToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toResponseBodyArrayBuffer(value: unknown): ArrayBuffer {
  if (typeof value === 'string') {
    return copyUint8ArrayToArrayBuffer(new TextEncoder().encode(value));
  }

  if (value instanceof PackedByteArray) {
    return copyUint8ArrayToArrayBuffer(new Uint8Array(value.to_array_buffer()));
  }

  if (value instanceof ArrayBuffer) {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    const view = value;
    const bytes = new Uint8Array(view.byteLength);
    bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return bytes.buffer;
  }

  if (typeof value === 'object' && value !== null && 'to_array_buffer' in value && typeof value.to_array_buffer === 'function') {
    const arrayBufferLike = value.to_array_buffer() as ArrayBufferLike;
    return copyUint8ArrayToArrayBuffer(new Uint8Array(arrayBufferLike));
  }

  if (value !== null && typeof value === 'object') {
    try {
      return copyUint8ArrayToArrayBuffer(new TextEncoder().encode(JSON.stringify(value)));
    } catch {
      // fall through to consistent type error
    }
  }

  throw new TypeError('Unsupported HTTP transport response body');
}

function buildHttpResponse(
  httpResponse: HttpResponse<unknown>,
  resolvedUrl: string,
  method: string,
  signal?: AbortSignal,
): Response {
  const responseHeaders = toHeaders(httpResponse.headers);
  validateResponseHeaders(responseHeaders);
  const upperMethod = method.toUpperCase();
  const responseBody = upperMethod === 'HEAD'
    ? null
    : (isReadableStreamLike(httpResponse.body)
      ? httpResponse.body
      : (() => {
        const responseBodyBytes = toResponseBodyArrayBuffer(httpResponse.body);

        if (!httpResponse.bodyError) {
          return responseBodyBytes;
        }

        return new ReadableStream({
          start(controller) {
            if (responseBodyBytes.byteLength > 0) {
              controller.enqueue(new Uint8Array(responseBodyBytes));
            }
            controller.error(httpResponse.bodyError);
          },
        });
      })());

  const response = new Response(responseBody, {
    status: httpResponse.statusCode,
    headers: responseHeaders,
  }, { signal });
  response.type = 'basic';
  response.url = normalizeResponseUrl(resolvedUrl);
  return response;
}

function base64DecodeToBytes(encoded: string): Uint8Array {
  const cleaned = encoded.replace(/[\r\n\t ]+/g, '');

  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cleaned)) {
    throw new TypeError('Invalid base64 payload in data URL');
  }

  const packed = Marshalls.base64_to_raw(cleaned);
  return new Uint8Array(packed.to_array_buffer());
}

function buildDataUrlResponse(resolvedUrl: string, method: string): Response {
  const commaIndex = resolvedUrl.indexOf(',');

  if (commaIndex === -1) {
    throw new TypeError(`Invalid data URL: ${resolvedUrl}`);
  }

  const metadata = resolvedUrl.slice(5, commaIndex);
  const payload = resolvedUrl.slice(commaIndex + 1);
  const segments = metadata.length === 0 ? [] : metadata.split(';');
  const isBase64 = segments[segments.length - 1] === 'base64';
  const mimeSegments = isBase64 ? segments.slice(0, -1) : segments;
  const contentType = mimeSegments.length > 0 && mimeSegments[0]!.length > 0
    ? mimeSegments.join(';')
    : 'text/plain;charset=US-ASCII';

  const bodyBytes = isBase64
    ? base64DecodeToBytes(payload)
    : new TextEncoder().encode(decodeURIComponent(payload));

  const response = new Response(method.toUpperCase() === 'HEAD' ? null : bodyBytes, {
    headers: { 'content-type': contentType },
    status: 200,
    statusText: 'OK',
  });
  response.type = 'basic';
  response.url = normalizeResponseUrl(resolvedUrl);
  return response;
}

function buildBlobUrlResponse(resolvedUrl: string, method: string): Response {
  if (method.toUpperCase() !== 'GET') {
    throw new TypeError('Only GET is supported for blob URLs');
  }

  const blob = getBlobFromObjectUrl(resolvedUrl);
  if (blob === null) {
    throw new TypeError('Blob URL is not backed by a Blob');
  }

  const response = new Response(blob, {
    headers: {
      'content-length': String(blob.size),
      'content-type': blob.type,
    },
    status: 200,
  });
  response.type = 'basic';
  response.url = normalizeResponseUrl(resolvedUrl);
  return response;
}

async function runHttpTransport(
  method: string,
  resolvedUrl: string,
  headers: Headers,
  body: null | FetchBodyInit,
  signal?: AbortSignal,
  onCancelReady?: (cancel: () => void) => void,
): Promise<Response> {
  const bodyForTransport = await toTransportBody(body);
  const request = submit<unknown>(
    method,
    resolvedUrl,
    bodyForTransport,
    toHeaderRecord(headers),
    {
      allowUnknownLengthRawStreamFallback: isNeverAbortSignal(signal),
    },
  );
  onCancelReady?.(() => request.cancel());

  try {
    const response = await request;
    return buildHttpResponse(response, resolvedUrl, method, signal);
  } catch (error) {
    if (error instanceof HttpResponseError) {
      return buildHttpResponse(error.response as HttpResponse<unknown>, resolvedUrl, method, signal);
    }

    if (error instanceof HttpAbortError) {
      throw createAbortError();
    }

    if (error instanceof Error && error.message.startsWith('Invalid HTTP URL:')) {
      throw new TypeError(error.message);
    }

    throw error;
  }
}

function toOpaqueResponse(url: string, type: 'opaque' | 'opaqueredirect'): Response {
  const response = new Response(null, { status: 0, statusText: '' });
  response.type = type;
  response.url = normalizeResponseUrl(url);
  return response;
}

export async function fetch(input: RequestInfo | URL, init?: FetchRequestInit): Promise<Response> {
  const request = new Request(input, init);
  const redirectMode = request.redirect;
  let resolvedUrl = resolveUrl(request.url);
  const headers = buildHeaders(request, undefined, resolvedUrl);

  let body = await getRequestBody(request, undefined);

  let currentMethod = request.method;
  let redirectCount = 0;
  let retried421 = false;

  if ((currentMethod.toUpperCase() === 'GET' || currentMethod.toUpperCase() === 'HEAD') && body !== null) {
    throw new TypeError('Request with GET/HEAD method cannot have body');
  }

  if (request.bodySourceIsStream) {
    throw new TypeError('Streaming upload is not supported');
  }

  const inferredContentType = inferContentType(body);

  if (inferredContentType && !headers.has('content-type')) {
    headers.set('content-type', inferredContentType);
  }

  applyContentLengthHeader(headers, currentMethod, body);

  if (resolvedUrl.startsWith('data:')) {
    return buildDataUrlResponse(resolvedUrl, currentMethod);
  }

  if (resolvedUrl.startsWith('blob:')) {
    return buildBlobUrlResponse(resolvedUrl, currentMethod);
  }

  if (!resolvedUrl.startsWith('http://') && !resolvedUrl.startsWith('https://')) {
    throw new TypeError(`Unsupported fetch URL scheme: ${resolvedUrl}`);
  }

  if (isBadPort(resolvedUrl)) {
    throw new TypeError('Failed to fetch');
  }

  const signal: AbortSignal | undefined = request.signal;

  const runTransportWithAbort = async (): Promise<Response> => {
    if (!signal) {
      return runHttpTransport(currentMethod, resolvedUrl, headers, body, signal);
    }

    return await new Promise<Response>((resolve, reject) => {
      let settled = false;
      let aborted = false;
      let cancelTransport: (() => void) | null = null;

      const onAbort = () => {
        if (settled) return;
        aborted = true;
        cancelTransport?.();
        if (body instanceof ReadableStream) {
          try {
            body.cancel(signal.reason);
          } catch {
            // Ignore cancellation errors while propagating abort.
          }
        }
        settled = true;
        reject(normalizeAbortRejectionReason(signal.reason));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort);
      runHttpTransport(
        currentMethod,
        resolvedUrl,
        headers,
        body,
        signal,
        (cancel) => {
          cancelTransport = cancel;
          if (aborted) {
            cancel();
          }
        },
      )
        .then((value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          reject(error);
        })
        .finally(() => {
          signal.removeEventListener('abort', onAbort);
        });
    });
  };

  while (true) {
    const response = await runTransportWithAbort();

    if (response.status === 421 && !retried421 && !(body instanceof ReadableStream)) {
      retried421 = true;
      headers.set('connection', 'close');
      continue;
    }

    if (!isRedirectStatus(response.status)) {
      response.redirected = redirectCount > 0;
      return response;
    }

    if (redirectMode === 'error') {
      throw new TypeError('Failed to fetch');
    }

    const locationHeader = response.headers.get('location');

    if (!locationHeader || locationHeader.length === 0) {
      return response;
    }

    const nextUrl = resolveRelativeRedirect(locationHeader, resolvedUrl);

    if (redirectMode === 'manual') {
      return toOpaqueResponse(resolvedUrl, 'opaqueredirect');
    }

    redirectCount += 1;

    if (redirectCount > MAX_REDIRECTS) {
      throw new TypeError('Failed to fetch');
    }

    resolvedUrl = nextUrl;

    if (isBadPort(resolvedUrl)) {
      throw new TypeError('Failed to fetch');
    }

    const upperCurrentMethod = currentMethod.toUpperCase();
    const shouldRewriteToGet = ((response.status === 301 || response.status === 302) && upperCurrentMethod === 'POST')
      || (response.status === 303 && upperCurrentMethod !== 'GET' && upperCurrentMethod !== 'HEAD');

    if (shouldRewriteToGet) {
      currentMethod = 'GET';
      body = null;

      for (const headerName of REDIRECT_REWRITTEN_BODY_HEADERS) {
        headers.delete(headerName);
      }
    }
  }
}

markAsGodotFetchImplementation(fetch);
