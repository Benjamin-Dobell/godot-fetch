import { Cookie } from './cookie';

export interface CookieStore {
  deleteCookie(domain: string, path: string, name: string): Promise<void>;
  getCookies(domain: string): Promise<null | Readonly<Record<string, Readonly<Record<string, Cookie>>>>>; // [path][name]
  setCookies(cookies: Cookie[]): Promise<void>;
}
