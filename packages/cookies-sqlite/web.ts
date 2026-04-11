import type { SqliteCookieStoreOptions } from './native';
import type { SqliteCookieStore } from './store';

export function createSqliteCookieStore(_options?: SqliteCookieStoreOptions): SqliteCookieStore {
  const fail = (): never => {
    throw new Error(
      '@godot-fetch/cookies-sqlite cannot be used on the web. Browser cookies are managed by the browser fetch implementation.',
    );
  };

  return {
    async deleteCookie() {
      fail();
    },
    async getCookies() {
      return fail();
    },
    async setCookies() {
      fail();
    },
  };
}
