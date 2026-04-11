# godot-fetch
![Compliance](.github/badges/wpt-host-pass-rate.svg)
[![License: MIT](.github/badges/license-mit.svg)](./LICENSE)

`godot-fetch` provides a [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) implementation for GodotJS. Created and maintained by [Breaka Club](https://breaka.club).

The desktop/mobile/console implementation is backed by Godot's
[HTTPClient](https://docs.godotengine.org/en/stable/classes/class_httpclient.html).

On the web, `godot-fetch` will seamlessly use the browser's built-in `fetch` and does so directly without routing via `HTTPClient`. Using
the browser's `fetch` implementation directly saves on WASM bridge round trips and is more efficient that using `HTTPClient` in web exports.

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

When consumed in a web export, these will simply refer to the browser's native implementation of these APIs. 

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

We do not generally recommend trying to replace the global `fetch` with our implementation, in particular because it's impossible on the
web, where replacing the global fetch would result in infinite recursion.

## Cookies

> [!NOTE]
> On the web, cookies are browser-managed as per usual. This section pertains to native platform exports only.

`godot-fetch` supports automatic cookie handling for HTTP requests/responses on non-web runtimes.

Typically on the web, cookies are restricted by the same origin policy. The same origin policy doesn't apply for native platform builds, so
you can configure your cookie store with APIs from `godot-fetch/cookies`:

```ts
import {
  getCookiePermittedDomains,
  getCookieStore,
  setCookiePermittedDomains,
  setCookieStore,
} from 'godot-fetch/cookies';
```

### Cookie Persistence

By default, cookies are stored in-memory only and are **not persisted across restarts**. If you wish to persist cookies, you must provide godot-fetch with a persistent cookie store.

We provide a SQLite-backed persistent cookie store implementation via a separate package which you may optionally install e.g.

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

The above code is fine to include in Web exports — it is essentially ignored. However, any attempt to explicitly use a cookie store on the
web will raise an error. For example, if you're going to manually set cookies with `getCookieStore().setCookie(...)`, you must make sure you
do not attempt to execute that code on the web.

### 1. Allow cookie domains explicitly

By default, only `localhost` is permitted.
To accept cookies from your backend domains, set them at startup:

```ts
import { setCookiePermittedDomains } from 'godot-fetch/cookies';

setCookiePermittedDomains(['localhost', 'game.breaka.club', 'breaka.club']);
```

This matches how Breaka configures API calls in `breaka-rpg/src/web/breaka/submit.ts`.

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

## Conformance

This project runs the Web Platform Tests (WPT) Fetch suite as the primary compatibility signal.

- WPT project: https://github.com/web-platform-tests/wpt

Local test commands:

```bash
pnpm -C demo run test:fetch:wpt:host
pnpm -C demo run test:fetch:wpt:matrix
pnpm -C demo run test:fetch:wpt:web:browser
```

### Specification Compliance

Compliance is assessed by pass rate on the WPT test suite. We do, however, exclude a number of tests, predominantly CORS.

### CORS

We do **NOT** implement any CORS (cross-origin resource sharing) components of the Fetch specification. This is by design since it simply
doesn't make sense in this environment. However, do keep in mind, if you are targetting the web, CORS will be enforced by the browser just
the same as if you were to call Godot's HTTPClient APIs directly yourself.

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

The original GodotJS HTTP implementation was handwritten, taken from an internal [Breaka Club](https://breaka.club/) project. However, LLMs
were used extensively to modify the codebase to be more compliant with the Fetch spec. This was achieved by automated iteration on the WPT
test suite. It's fair to say said LLMs really came in and _LLM'd up the place_. Much manual effort was expended reviewing and cleaning up
the codebase thereafter.
