import { HttpHeaders } from '../http';
import { Cookie } from './cookie';
import { getCookiePermittedDomains, getCookieStore } from './index';

function isCookieDomainAllowed(requestDomain: string, cookieDomain: string): boolean {
  if (requestDomain === cookieDomain) {
    return true;
  }
  return requestDomain.endsWith(`.${cookieDomain}`);
}

function parseCookies(requestDomain: string, headers: HttpHeaders): Array<Readonly<Cookie>> {
  const cookies: Cookie[] = [];
  const setCookieHeaderValue = headers['set-cookie'];

  if (!setCookieHeaderValue) {
    return cookies;
  }

  const setCookieHeaders = Array.isArray(setCookieHeaderValue) ? setCookieHeaderValue : [setCookieHeaderValue];

  for (const header of setCookieHeaders) {
    const [setCookie, ...propertyValues] = header.split(/\s*;\s*/);
    const properties: Record<string, string> = {};

    for (const propertyValue of propertyValues) {
      const [name, value] = propertyValue.split(/\s*=\s*/);
      properties[name!.toLowerCase()] = value ?? 'true';
    }

    const {
      domain = requestDomain,
      expires: expiresText,
      httponly: httpOnlyText,
      "max-age": maxAgeText,
      path: pathText,
      secure: secureText,
    } = properties;

    // For localhost requests, accept cookies regardless of domain (backend may report different hostname)
    // This handles the case where the backend reports a machine hostname instead of localhost
    const isLocalhostRequest = requestDomain === 'localhost' || requestDomain === '127.0.0.1';
    const effectiveDomain = isLocalhostRequest ? 'localhost' : domain;

    if (!isLocalhostRequest && !isCookieDomainAllowed(requestDomain, domain)) {
      console.warn(`HTTP response from ${requestDomain} attempted to set a cookie against ${domain}`);
      continue;
    }

    const path = pathText?.endsWith('/') ? pathText : `${pathText ?? ''}/`;
    const httpOnly = httpOnlyText === 'true';
    const secure = secureText === 'true';
    const maxAge = typeof maxAgeText === 'string' ? Number.parseInt(maxAgeText, 10) : undefined;

    if (typeof maxAge !== 'undefined' && (!Number.isSafeInteger(maxAge) || Number.isNaN(maxAge))) {
      console.warn(`HTTP response from ${requestDomain} included a Set-Cookie header with a malformed Max-Age`);
      continue;
    }

    const expires = expiresText && new Date(expiresText);

    if (typeof expires !== 'undefined' && (typeof expires !== 'object' || Number.isNaN(expires.valueOf()))) {
      console.warn(`HTTP response from ${requestDomain} included a Set-Cookie header with a malformed Expires`);
      continue;
    }

    const [receivedName, value] = setCookie!.split(/\s*=\s*/);

    if (typeof value === 'undefined') {
      console.warn(`HTTP response from ${requestDomain} included a Set-Cookie header without a value assignment`);
      continue; // Malformed header
    }

    const name = receivedName!.toLowerCase();
    const expiry = typeof maxAge === 'number' ? new Date(Date.now() + maxAge * 1000) : expires;

    cookies.push({
      domain: effectiveDomain,
      expiry: expiry?.valueOf() ?? Number.POSITIVE_INFINITY,
      httpOnly,
      name,
      path,
      secure,
      value,
    });
  }

  return cookies;
}

export async function handleCookies(requestDomain: string, headers: HttpHeaders): Promise<void> {
  const cookies = parseCookies(requestDomain, headers);
  const permittedCookieDomains = getCookiePermittedDomains();
  const permittedCookies = cookies.filter(cookie => permittedCookieDomains.includes(cookie.domain));
  await getCookieStore().setCookies(permittedCookies);
}

export async function getRequestCookies(
  requestDomain: string,
  requestPath: string,
  secure: boolean,
): Promise<null | Array<Readonly<Cookie>>> {
  const cookieStore = getCookieStore();
  const domainCookies = await cookieStore.getCookies(requestDomain);

  if (!domainCookies) {
    return null;
  }

  const lookupPath = requestPath?.endsWith('/') ? requestPath : `${requestPath ?? ''}/`;

  const matchedCookies: Record<string, Cookie> = {}; // [name]
  const now = Date.now();

  for (const [path, pathCookies] of Object.entries(domainCookies)) {
    if (!lookupPath.startsWith(path)) {
      continue;
    }

    for (const cookie of Object.values(pathCookies)) {
      if (now > cookie.expiry) {
        await cookieStore.deleteCookie(cookie.domain, cookie.path, cookie.name);
        continue;
      }

      if (!secure && cookie.secure && requestDomain !== 'localhost') {
        continue;
      }

      const name = cookie.name;

      if (!matchedCookies[name] || matchedCookies[name].path.length < path.length) {
        matchedCookies[name] = cookie;
      }
    }
  }

  return Object.values(matchedCookies);
}
