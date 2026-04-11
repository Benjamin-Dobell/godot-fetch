import type { AbortSignal } from './abort';
import { Blob } from './blob';
import { FormData } from './form-data';
import { parseFormDataFromBody } from './form-data-utils';
import { Headers } from './headers';
import { ReadableStream, isReadableStreamLike } from './stream';
import type { BodyInit, HeadersInit, ResponseType } from './types';
import { URLSearchParams } from './url';
import { BodyContainer } from './body-container';

export interface ResponseInit {
  headers?: HeadersInit;
  status?: number;
  statusText?: string;
}

type ResponseInternalInit = {
  redirected?: boolean;
  signal?: AbortSignal;
};

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

    if (status !== 0 && (status < 200 || status > 599)) {
      throw new RangeError('Invalid response status');
    }

    this.status = status;
    this.statusText = init.statusText ?? '';
    this.headers = new Headers(init.headers, 'none', 'response');

    const inferredType = inferBodyContentType(body);

    if (inferredType !== null && !this.headers.has('content-type')) {
      this.headers.set('content-type', inferredType);
    }

    this.ok = this.status >= 200 && this.status < 300;
    this.redirected = internal.redirected ?? false;
    this.type = 'default';
    this.url = '';

    const bodyAllowed = this.status !== 204 && this.status !== 205 && this.status !== 304;

    if (bodyAllowed && isReadableStreamLike(body) && ((body.isLocked?.() ?? false) || (body.isDisturbed?.() ?? false))) {
      throw new TypeError('ReadableStream body is locked or disturbed');
    }

    this.bodyContainer = new BodyContainer(
      bodyAllowed ? body : null,
      internal.signal,
      () => this.headers.get('content-type'),
    );
  }

  static error(): Response {
    const response = new Response(null, { status: 0, statusText: '' });
    response.type = 'error';
    return response;
  }

  static json(data: unknown, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);

    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    return new Response(JSON.stringify(data), {
      ...init,
      headers,
    });
  }

  static redirect(url: string, status = 302): Response {
    if (!REDIRECT_STATUSES.has(status)) {
      throw new RangeError('Invalid redirect status');
    }

    const response = new Response(null, { status });
    response.headers.set('location', url);
    return response;
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
    });

    cloned.type = this.type;
    cloned.url = this.url;
    cloned.redirected = this.redirected;
    return cloned;
  }

  async formData(): Promise<FormData> {
    return parseFormDataFromBody(this.headers.get('content-type'), await this.text());
  }

  text(): Promise<string> {
    return this.bodyContainer.text();
  }
}
