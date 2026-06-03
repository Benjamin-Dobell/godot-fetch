import type { HttpHeaders } from '../http';
import type { RequestCache, RequestCredentials, RequestRedirect } from '../standards/types';

export type HttpCacheHeaders = HttpHeaders;
export type HttpCacheResponseBody = null | string | ArrayBuffer | ArrayBufferView;

export interface HttpCacheRequest {
  method: string;
  url: string;
  headers: HttpCacheHeaders;
  body: null | Uint8Array;
  cache: RequestCache;
  credentials: RequestCredentials;
  redirect: RequestRedirect;
}

export interface HttpCacheResponse {
  status: number;
  statusText?: string;
  headers?: HttpCacheHeaders;
  body?: HttpCacheResponseBody;
}

export interface HttpCacheHit {
  kind: 'hit';
  response: HttpCacheResponse;
}

export interface HttpCacheRevalidation {
  kind: 'revalidate';
  response: HttpCacheResponse;
  headers: HttpCacheHeaders;
}

export type HttpCacheMatch = HttpCacheHit | HttpCacheRevalidation;

export interface HttpCache {
  match(request: Readonly<HttpCacheRequest>): Promise<null | HttpCacheMatch>;
  put?(request: Readonly<HttpCacheRequest>, response: Readonly<HttpCacheResponse>): Promise<void>;
  revalidate?(
    request: Readonly<HttpCacheRequest>,
    cachedResponse: Readonly<HttpCacheResponse>,
    networkResponse: Readonly<HttpCacheResponse>,
  ): Promise<null | HttpCacheResponse>;
  delete?(request: Readonly<HttpCacheRequest>): Promise<void>;
}
