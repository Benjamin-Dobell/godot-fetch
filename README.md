# godot-fetch

![Compliance](.github/badges/wpt-host-pass-rate.svg)
[![License: MIT](.github/badges/license-mit.svg)](./LICENSE)

`godot-fetch` provides a [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) implementation for
native GodotJS runtimes. Created and maintained by [Breaka Club](https://breaka.club).

The desktop/mobile/console implementation is backed by Godot socket streams and implements HTTP 1.1 directly.

In a web browser export, `godot-fetch` does not run its native HTTP implementation. It passes through to the browser's
built-in `fetch`, so browser networking behavior applies.

## Additional Web APIs

In addition to `fetch`, we also provide polyfills for common related web APIs:

- `AbortController` and `AbortSignal`
- `Blob`
- `DOMException`
- `FormData`
- `Headers`
- `Request` and `Response`
- `ReadableStream` and `WritableStream`
- `TextEncoder` and `TextDecoder`
- `URL` and `URLSearchParams`

When consumed in a web export, these APIs use the browser's native implementations where available.

## Installation

Install via your preferred package manager e.g.

```shell
pnpm add godot-fetch
```

```shell
yarn add godot-fetch
```

```shell
npm install --save godot-fetch
```

## Usage

Import `fetch`, and any other HTTP-related APIs you're interested in from `godot-fetch` as follows:

```ts
import { fetch, Request, Response, Headers, URL } from 'godot-fetch';
```

We do not generally recommend trying to replace the global `fetch` with our implementation, in particular because it's
impossible to do so on the web, because replacing the global fetch would result in infinite recursion since our web
implementation is itself a wrapper around the global `fetch` implementation.

On native platforms, `godot-fetch` uses Godot's native `StreamPeerTCP` and `StreamPeerTLS` APIs, and we handle HTTP 1.1
ourselves.

> [!NOTE]
> We do not make use of Godot's `HTTPClient`. This allows us to be much more compliant with the HTTP 1.1 and fetch
> specifications than is possible if we were to use `HTTPClient` API.

## Cookies

> [!NOTE]
> On the web, cookies are browser-managed as per usual. This section pertains to native platform exports only.

`godot-fetch` supports automatic cookie handling for HTTP requests/responses on non-web runtimes.

Typically on the web, cookies are restricted by the same origin policy. The same origin policy doesn't apply for native
platform builds, so you can configure your cookie store with APIs from `godot-fetch/cookies`:

```ts
import {
  getCookiePermittedDomains,
  getCookieStore,
  setCookiePermittedDomains,
  setCookieStore,
} from 'godot-fetch/cookies';
```

### Cookie Persistence

By default, cookies are stored in-memory only and are **not persisted across restarts**. If you wish to persist cookies,
you must provide godot-fetch with a persistent cookie store.

We provide a SQLite-backed persistent cookie store implementation via a separate package which you may optionally
install e.g.

```shell
pnpm add @godot-fetch/cookies-sqlite
```

You use it like:

```ts
import { setCookieStore } from 'godot-fetch/cookies';
import { createSqliteCookieStore } from '@godot-fetch/cookies-sqlite';

setCookieStore(createSqliteCookieStore({
  path: 'user://cookies',
}));
```

The above code is fine to include in Web exports — it is essentially ignored. However, any attempt to explicitly use a
cookie store on the web will raise an error. For example, if you're going to manually set cookies with
`getCookieStore().setCookie(...)`, you must make sure you do not attempt to execute that code on the web.

### 1. Allow cookie domains explicitly

By default, only `localhost` is permitted.
To accept cookies from your backend domains, set them at startup:

```ts
import { setCookiePermittedDomains } from 'godot-fetch/cookies';

setCookiePermittedDomains(['localhost', 'yourdomain.com']);
```

### 2. How automatic cookie handling works

- Response cookies:
    - `Set-Cookie` headers are parsed and filtered by the permitted-domain list.
    - Valid cookies are stored in the active `CookieStore`.
- Request cookies:
    - Matching cookies are attached as a `Cookie` header based on domain/path/expiry.
    - Secure cookies are only sent on secure requests (`https`) except for localhost.

### 3. Read or replace the cookie store

You can inspect or replace the backing store:

```ts
import { getCookieStore, setCookieStore } from 'godot-fetch/cookies';

const store = getCookieStore();
const localhostCookies = store.getCookies('localhost');
// localhostCookies shape: [path][cookieName] => cookie

// Optionally provide your own CookieStore implementation.
setCookieStore({
  deleteCookie(domain, path, name) {
    // ...
  },
  getCookies(domain) {
    return null;
  },
  setCookies(cookies) {
    // ...
  },
});
```

`CookieStore` contract:

- `deleteCookie(domain, path, name): void`
- `getCookies(domain): null | Record<path, Record<name, Cookie>>`
- `setCookies(cookies: Cookie[]): void`

## Caching

> [!NOTE]
> On the web, caching is browser-managed as per usual. This section pertains to native platform exports only.

`godot-fetch` supports an optional HTTP response cache for non-web runtimes.

**No HTTP cache is installed by default.**

Games tend to have different caching needs than a web browser; you also have substantially more control over storage.
More often than not we'd expect games to want to handle caching and storage at the application layer, and not cache
HTTP responses themselves. Nonetheless, we do still provide the option to install an HTTP cache.

You're expected to provide your own `HttpCache` implementation since the only implementation we ship is
`createNonEvictingMemoryHttpCache`, which is only (perhaps barely) suitable for automated tests. It has rudimentary ETag
support but does not support expiry/eviction.

```ts
import {
  createNonEvictingMemoryHttpCache,
  getHttpCache,
  setHttpCache,
} from 'godot-fetch/caching';
```

### 1. Install a cache explicitly

You can (but really shouldn't) install the in-memory implementation as follows:

```ts
import { createNonEvictingMemoryHttpCache, setHttpCache } from 'godot-fetch/caching';

setHttpCache(createNonEvictingMemoryHttpCache());
```

### 2. How cache handling works

- Request cache lookup:
    - Only cacheable `GET` requests without a body are looked up.
    - Cache operations are Promise-based so implementations can read from disk or another async store.
    - `createNonEvictingMemoryHttpCache` only returns direct hits for explicit direct-cache modes like `force-cache`
      and `only-if-cached`; otherwise it revalidates entries with `ETag` and misses entries it cannot revalidate.
- Response cache writes:
    - HTTP caches may persist eligible responses and return them for later matching requests.
    - Freshness and revalidation policy is owned by the installed `HttpCache` implementation.
    - Cache matches can be direct hits, or revalidation instructions that add conditional request headers.
    - Response body caching happens in the background and must not change `fetch()` resolution or body stream errors.

### 3. Read or replace the HTTP cache

You can inspect or replace the backing HTTP cache:

```ts
import { getHttpCache, setHttpCache } from 'godot-fetch/caching';

const httpCache = getHttpCache();

// Optionally provide your own HttpCache implementation.
setHttpCache({
  async match(request) {
    return null;
  },
  async put(request, response) {
    // ...
  },
  async revalidate(request, cachedResponse, networkResponse) {
    return null;
  },
  async delete(request) {
    // ...
  },
});
```

`HttpCache` contract:

- `match(request): Promise<null | HttpCacheMatch>`
- `put(request, response): Promise<void>`
- `revalidate(request, cachedResponse, networkResponse): Promise<null | HttpCacheResponse>`
- `delete(request): Promise<void>`

## Conformance

This project runs the Web Platform Tests (WPT) Fetch suite as the primary compatibility signal for the native
implementation. Web-browser checks exercise the browser pass-through path.

- WPT project: https://github.com/web-platform-tests/wpt

Local test commands:

```bash
pnpm -C demo run test:fetch:wpt:host
pnpm -C demo run test:fetch:wpt:matrix
pnpm -C demo run test:fetch:wpt:web:browser
```

### Specification Compliance

Compliance is assessed by pass rate on the WPT test suite. We do, however, exclude a number of tests, predominantly
CORS.

### CORS

The native implementation does **NOT** implement any CORS (cross-origin resource sharing) components of the Fetch
specification. This is by design since it simply
doesn't make sense for a native runtime. If you are targeting the web, `godot-fetch` passes through to the browser's
`fetch`, so CORS is enforced by the browser exactly
as if you had called `globalThis.fetch` directly.

## Development

```bash
pnpm build
pnpm lint
pnpm test
```

## License

MIT

## AI Disclosure

LLMs were used during the development of this software.

HTTP clients aren't traditionally considered novel software, particularly since this is simply an implementation of the
fetch specification. This software was produced substantially by allowing LLMs to iterate on the codebase with the goal
of increasing the pass rate of the official fetch test suite (https://github.com/web-platform-tests/wpt). Additionally,
significant human effort has been expended cleaning up the codebase and guiding the LLM, particularly in areas where our
API goes beyond the bounds of the fetch API (cookies and caching).
