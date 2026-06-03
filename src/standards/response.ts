import type { AbortSignal } from './abort';
import { Blob } from './blob';
import { FormData } from './form-data';
import { parseFormDataFromBody } from './form-data-utils';
import { Headers } from './headers';
import { ReadableStream, isReadableStreamLike } from './stream';
import type { BodyInit, HeadersInit, ResponseType } from './types';
import { URL, URLSearchParams } from './url';
import { BodyContainer } from './body-container';

export interface ResponseInit {
  headers?: HeadersInit;
  status?: number;
  statusText?: string;
}

type ResponseInternalInit = {
  allowStatusZero?: boolean;
  immutableHeaders?: boolean;
  redirected?: boolean;
  signal?: AbortSignal;
};

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

function assertValidStatusText(statusText: string): void {
  for (let index = 0; index < statusText.length; index += 1) {
    if (statusText.charCodeAt(index) > 0xff) {
      throw new TypeError('Invalid response statusText');
    }
  }

  if (/[\r\n]/.test(statusText)) {
    throw new TypeError('Invalid response statusText');
  }
}

function resolveRedirectUrl(url: string): string {
  try {
    const base = globalThis.location?.href;
    return typeof base === 'string' && base.length > 0
      ? new URL(url, base).toString()
      : new URL(url).toString();
  } catch {
    throw new TypeError('Invalid redirect URL');
  }
}

export class Response {
  readonly headers: Headers;
  readonly status: number;
  readonly statusText: string;
  ok: boolean;
  redirected: boolean;
  type: ResponseType;
  url: string;

  get bodyUsed(): boolean {
    return this.bodyContainer.isBodyUsed();
  }

  get body(): null | ReadableStream {
    return this.bodyContainer.body;
  }

  private readonly bodyContainer: BodyContainer;

  constructor(body: null | BodyInit = null, init: ResponseInit = {}, internal: ResponseInternalInit = {}) {
    const status = init.status ?? 200;

    if (
      !Number.isInteger(status)
      || (status === 0 ? !internal.allowStatusZero : (status < 200 || status > 599))
    ) {
      throw new RangeError('Invalid response status');
    }

    const statusText = init.statusText ?? '';
    assertValidStatusText(statusText);

    if (body !== null && NULL_BODY_STATUSES.has(status)) {
      throw new TypeError('Response status must not have a body');
    }

    this.status = status;
    this.statusText = statusText;
    this.headers = new Headers(init.headers, 'response', 'response');

    const inferredType = inferBodyContentType(body);

    if (inferredType !== null && !this.headers.has('content-type')) {
      this.headers.set('content-type', inferredType);
    }

    this.ok = this.status >= 200 && this.status < 300;
    this.redirected = internal.redirected ?? false;
    this.type = 'default';
    this.url = '';

    if (isReadableStreamLike(body) && ((body.isLocked?.() ?? false) || (body.isDisturbed?.() ?? false))) {
      throw new TypeError('ReadableStream body is locked or disturbed');
    }

    if (internal.immutableHeaders) {
      this.headers.makeImmutable();
    }

    this.bodyContainer = new BodyContainer(
      body,
      internal.signal,
      () => this.headers.get('content-type'),
    );
  }

  static error(): Response {
    const response = new Response(null, { status: 0, statusText: '' }, {
      allowStatusZero: true,
      immutableHeaders: true,
    });
    response.type = 'error';
    return response;
  }

  static json(data: unknown, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    let body: string;

    const encoded = JSON.stringify(data);
    if (typeof encoded !== 'string') {
      throw new TypeError('Data is not JSON serializable');
    }
    body = encoded;

    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    return new Response(body, {
      ...init,
      headers,
    });
  }

  static redirect(url: string, status = 302): Response {
    if (!REDIRECT_STATUSES.has(status)) {
      throw new RangeError('Invalid redirect status');
    }

    return new Response(null, {
      headers: {
        location: resolveRedirectUrl(url),
      },
      status,
    }, {
      immutableHeaders: true,
    });
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

  clone(): Response {
    if (this.bodyUsed) {
      throw new TypeError('Cannot clone a response with consumed body');
    }

    const cloned = new Response(this.bodyContainer.cloneBody(), {
      headers: this.headers,
      status: this.status,
      statusText: this.statusText,
    }, {
      allowStatusZero: this.status === 0,
    });

    cloned.type = this.type;
    cloned.url = this.url;
    cloned.redirected = this.redirected;
    return cloned;
  }

  async formData(): Promise<FormData> {
    if (this.bodyContainer.isEmptyFormDataBody()) {
      await this.text();
      return new FormData();
    }

    return parseFormDataFromBody(this.headers.get('content-type'), await this.text());
  }

  text(): Promise<string> {
    return this.bodyContainer.text();
  }
}
