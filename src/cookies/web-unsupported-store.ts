import type { CookieStore } from './store';

export function createUnsupportedWebCookieStore(): CookieStore {
  async function fail(): Promise<never> {
    throw new Error('Cookie persistence stores are unavailable on web runtime. Use browser-managed cookies instead.');
  }

  return {
    deleteCookie: fail,
    getCookies: fail,
    setCookies: fail,
  };
}
