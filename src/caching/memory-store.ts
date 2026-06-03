import type {
  HttpCacheHeaders,
  HttpCacheRequest,
  HttpCacheResponse,
  HttpCacheResponseBody,
  HttpCache,
} from './store';

export interface NonEvictingMemoryHttpCache extends HttpCache {
  clear(): Promise<void>;
}

export interface NonEvictingMemoryHttpCacheOptions {
  createKey?: (request: Readonly<HttpCacheRequest>) => string;
}

function defaultCreateKey(request: Readonly<HttpCacheRequest>): string {
  return `${request.method.toUpperCase()} ${request.url}`;
}

function cloneHeaders(headers: undefined | HttpCacheHeaders): HttpCacheHeaders {
  const cloned: HttpCacheHeaders = {};

  if (!headers) {
    return cloned;
  }

  for (const [key, value] of Object.entries(headers)) {
    cloned[key] = Array.isArray(value) ? [...value] : value;
  }

  return cloned;
}

function cloneBody(body: undefined | HttpCacheResponseBody): null | string | ArrayBuffer {
  if (typeof body === 'undefined' || body === null) {
    return null;
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof ArrayBuffer) {
    return body.slice(0);
  }

  if (ArrayBuffer.isView(body)) {
    const source = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    const copied = new Uint8Array(source.byteLength);
    copied.set(source);
    return copied.buffer;
  }

  throw new TypeError('Unsupported cache response body');
}

function cloneResponse(response: Readonly<HttpCacheResponse>): HttpCacheResponse {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: cloneHeaders(response.headers),
    body: cloneBody(response.body),
  };
}

function getHeader(headers: undefined | HttpCacheHeaders, name: string): null | string {
  const normalizedName = name.toLowerCase();

  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== normalizedName) {
      continue;
    }

    return Array.isArray(value) ? (value[0] ?? null) : value;
  }

  return null;
}

function mergeHeaders(cachedHeaders: undefined | HttpCacheHeaders, networkHeaders: undefined | HttpCacheHeaders): HttpCacheHeaders {
  return {
    ...cloneHeaders(cachedHeaders),
    ...cloneHeaders(networkHeaders),
  };
}

export function createNonEvictingMemoryHttpCache(options: NonEvictingMemoryHttpCacheOptions = {}): NonEvictingMemoryHttpCache {
  const createKey = options.createKey ?? defaultCreateKey;
  const responses = new Map<string, HttpCacheResponse>();

  return {
    async match(request) {
      const response = responses.get(createKey(request));
      if (!response) {
        return null;
      }

      const clonedResponse = cloneResponse(response);

      if (request.cache === 'force-cache' || request.cache === 'only-if-cached') {
        return {
          kind: 'hit',
          response: clonedResponse,
        };
      }

      const etag = getHeader(clonedResponse.headers, 'etag');

      if (etag !== null && getHeader(request.headers, 'if-none-match') === null) {
        return {
          kind: 'revalidate',
          response: clonedResponse,
          headers: {
            'if-none-match': etag,
          },
        };
      }

      return null;
    },
    async put(request, response) {
      responses.set(createKey(request), cloneResponse(response));
    },
    async revalidate(request, cachedResponse, networkResponse) {
      if (networkResponse.status !== 304) {
        return null;
      }

      const response = cloneResponse({
        status: cachedResponse.status,
        statusText: cachedResponse.statusText,
        headers: mergeHeaders(cachedResponse.headers, networkResponse.headers),
        body: cachedResponse.body,
      });

      responses.set(createKey(request), response);
      return cloneResponse(response);
    },
    async delete(request) {
      responses.delete(createKey(request));
    },
    async clear() {
      responses.clear();
    },
  };
}
