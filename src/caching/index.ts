import { OS } from 'godot.lib.api';
import { createNonEvictingMemoryHttpCache } from './memory-store';
import type { HttpCache } from './store';

const isWebRuntime = OS.has_feature('web');

let httpCache: null | HttpCache = null;

export function getHttpCache(): null | HttpCache {
  return isWebRuntime ? null : httpCache;
}

export function setHttpCache(nextHttpCache: null | HttpCache): void {
  if (isWebRuntime) {
    return;
  }

  httpCache = nextHttpCache;
}

export { createNonEvictingMemoryHttpCache };

export type { NonEvictingMemoryHttpCache, NonEvictingMemoryHttpCacheOptions } from './memory-store';

export type {
  HttpCacheHeaders,
  HttpCacheHit,
  HttpCacheMatch,
  HttpCacheRequest,
  HttpCacheResponse,
  HttpCacheResponseBody,
  HttpCacheRevalidation,
  HttpCache,
} from './store';
