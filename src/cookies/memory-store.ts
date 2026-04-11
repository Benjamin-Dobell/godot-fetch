import { Cookie } from './cookie';
import { CookieStore } from './store';

type PathCookieMap = Record<string, Cookie>;
type DomainCookieMap = Record<string, PathCookieMap>;
type CookieStorage = Record<string, DomainCookieMap>;

export function createMemoryCookieStore(): CookieStore {
  const allCookies: CookieStorage = {}; // [domain][path][name]
  const deleteStoredCookie = (domain: string, path: string, name: string): void => {
    const domainCookies = allCookies[domain];

    if (!domainCookies) {
      return;
    }

    const pathCookies = domainCookies[path];

    if (!pathCookies) {
      return;
    }

    delete pathCookies[name];

    if (Object.keys(pathCookies).length === 0) {
      delete domainCookies[path];

      if (Object.keys(domainCookies).length === 0) {
        delete allCookies[domain];
      }
    }
  };

  return {
    async deleteCookie(domain, path, name) {
      deleteStoredCookie(domain, path, name);
    },
    async getCookies(domain) {
      return allCookies[domain] ?? null;
    },
    async setCookies(cookies) {
      const now = Date.now();

      for (const cookie of cookies) {
        if (now >= cookie.expiry) {
          deleteStoredCookie(cookie.domain, cookie.path, cookie.name);
          continue;
        }

        const domainCookies = (allCookies[cookie.domain] ||= {});
        const pathCookies = (domainCookies[cookie.path] ||= {});

        pathCookies[cookie.name] = cookie;
      }
    },
  };
}
