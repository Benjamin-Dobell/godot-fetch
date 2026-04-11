import { OS } from 'godot.lib.api';
import type { SqliteCookieStoreOptions } from './native';
import type { SqliteCookieStore } from './store';

type SqliteCookieStoreModule = {
  createSqliteCookieStore(options?: SqliteCookieStoreOptions): SqliteCookieStore;
};

function isWebRuntime(): boolean {
  return OS.has_feature('web');
}

const runtimeModule = (
  isWebRuntime()
    ? require('./web')
    : require('./native')
) as SqliteCookieStoreModule;

export const createSqliteCookieStore = runtimeModule.createSqliteCookieStore;
export type { SqliteCookieStoreOptions };
export type { SqliteCookie, SqliteCookieStore } from './store';
