export type SqliteCookie = {
  domain: string;
  expiry: number;
  httpOnly: boolean;
  name: string;
  path: string;
  secure: boolean;
  value: string;
};

export interface SqliteCookieStore {
  deleteCookie(domain: string, path: string, name: string): Promise<void>;
  getCookies(domain: string): Promise<null | Readonly<Record<string, Readonly<Record<string, SqliteCookie>>>>>;
  setCookies(cookies: SqliteCookie[]): Promise<void>;
}
