import { OS } from 'godot.lib.api';
import { createMemoryCookieStore } from './memory-store';
import { CookieStore } from './store';
import { createUnsupportedWebCookieStore } from './web-unsupported-store';

const isWebRuntime = OS.has_feature('web');
const defaultStore: CookieStore = isWebRuntime ? createUnsupportedWebCookieStore() : createMemoryCookieStore();

let permittedDomains: string[] = ['localhost'];
let store: CookieStore = defaultStore;

export function setCookiePermittedDomains(domains: string[]) {
  permittedDomains = domains
    .map(domain => domain.trim().toLowerCase())
    .filter(domain => domain.length > 0);
}

export function getCookiePermittedDomains() {
  return [...permittedDomains];
}

export function getCookieStore() {
  return store;
}

export function setCookieStore(cookieStore: CookieStore) {
  if (isWebRuntime) {
    return;
  }

  store = cookieStore;
}

export { createMemoryCookieStore };

export type { CookieStore } from './store';
export type { Cookie } from './cookie';
