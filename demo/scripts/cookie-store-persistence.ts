import { DirAccess, FileAccess, GDExtensionManager, OS, ProjectSettings, SceneTree } from 'godot';
import { getCookieStore, setCookieStore, type CookieStore } from 'godot-fetch/cookies';

type TestOptions = {
  dbPath: string;
  expect: 'present' | 'absent';
  phase: 'read' | 'write';
  reset: boolean;
  store: 'memory' | 'sqlite';
};

const COOKIE_DOMAIN = 'localhost';
const COOKIE_PATH = '/';
const COOKIE_NAME = 'session';
const COOKIE_VALUE = 'cookie-store-test';
const SQLITE_EXTENSION_PATH = 'res://addons/godot-sqlite/gdsqlite.gdextension';

function createSqliteCookieStore(options: { path: string }): CookieStore {
  const requireFn = (globalThis as { require?: (id: string) => unknown }).require;
  if (typeof requireFn !== 'function') {
    throw new Error('globalThis.require is unavailable in this runtime');
  }
  const module = requireFn('@godot-fetch/cookies-sqlite') as {
    createSqliteCookieStore: (opts: { path: string }) => CookieStore;
  };
  return module.createSqliteCookieStore(options);
}

function ensureSqliteExtensionLoaded(): void {
  if (GDExtensionManager.is_extension_loaded(SQLITE_EXTENSION_PATH)) {
    return;
  }

  const error = GDExtensionManager.load_extension(SQLITE_EXTENSION_PATH);
  if (error !== 0) {
    throw new Error(
      `Failed to load sqlite GDExtension (${SQLITE_EXTENSION_PATH}) with error=${String(error)}`,
    );
  }
}

function applyEnvironmentOptions(options: TestOptions): void {
  if (OS.has_environment('COOKIE_STORE')) {
    const value = OS.get_environment('COOKIE_STORE');
    if (value === 'memory' || value === 'sqlite') {
      options.store = value;
    }
  }
  if (OS.has_environment('COOKIE_PHASE')) {
    const value = OS.get_environment('COOKIE_PHASE');
    if (value === 'read' || value === 'write') {
      options.phase = value;
    }
  }
  if (OS.has_environment('COOKIE_EXPECT')) {
    const value = OS.get_environment('COOKIE_EXPECT');
    if (value === 'present' || value === 'absent') {
      options.expect = value;
    }
  }
  if (OS.has_environment('COOKIE_DB_PATH')) {
    const value = OS.get_environment('COOKIE_DB_PATH');
    if (value.length > 0) {
      options.dbPath = value;
    }
  }
  if (OS.has_environment('COOKIE_RESET') && OS.get_environment('COOKIE_RESET') === '1') {
    options.reset = true;
  }
}

function applyCommandLineOptions(options: TestOptions): void {
  const args = OS.get_cmdline_args();
  for (let index = 0; index < args.size(); index += 1) {
    const argument = String(args.get(index));
    if (argument.startsWith('--cookie-store=')) {
      const value = argument.slice('--cookie-store='.length);
      if (value === 'memory' || value === 'sqlite') {
        options.store = value;
      }
      continue;
    }
    if (argument.startsWith('--cookie-phase=')) {
      const value = argument.slice('--cookie-phase='.length);
      if (value === 'read' || value === 'write') {
        options.phase = value;
      }
      continue;
    }
    if (argument.startsWith('--cookie-expect=')) {
      const value = argument.slice('--cookie-expect='.length);
      if (value === 'present' || value === 'absent') {
        options.expect = value;
      }
      continue;
    }
    if (argument.startsWith('--cookie-db-path=')) {
      options.dbPath = argument.slice('--cookie-db-path='.length);
      continue;
    }
    if (argument === '--cookie-reset=1') {
      options.reset = true;
      continue;
    }
  }
}

function parseOptions(): TestOptions {
  const options: TestOptions = {
    dbPath: 'user://godot-fetch-cookie-store-test',
    expect: 'present',
    phase: 'read',
    reset: false,
    store: 'memory',
  };

  applyEnvironmentOptions(options);
  applyCommandLineOptions(options);

  return options;
}

function deleteDbFile(path: string): void {
  const absolutePath = ProjectSettings.globalize_path(path);
  if (!FileAccess.file_exists(absolutePath)) {
    return;
  }
  const error = DirAccess.remove_absolute(absolutePath);
  if (error !== 0) {
    throw new Error(`Failed to delete sqlite db at ${absolutePath} (error=${String(error)})`);
  }
}

export default class CookieStorePersistenceTest extends SceneTree {
  override _initialize(): void {
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      const options = parseOptions();
      if (options.store === 'sqlite') {
        ensureSqliteExtensionLoaded();
        if (options.reset) {
          deleteDbFile(options.dbPath);
        }
        setCookieStore(createSqliteCookieStore({ path: options.dbPath }));
      }

      const store = getCookieStore();

      if (options.phase === 'write') {
        await store.setCookies([{
          domain: COOKIE_DOMAIN,
          expiry: Date.now() + 60_000,
          httpOnly: false,
          name: COOKIE_NAME,
          path: COOKIE_PATH,
          secure: false,
          value: COOKIE_VALUE,
        }]);
        console.log(`[COOKIE_STORE_TEST] write store=${options.store} ok`);
      } else {
        const domainCookies = await store.getCookies(COOKIE_DOMAIN);
        const cookie = domainCookies?.[COOKIE_PATH]?.[COOKIE_NAME] ?? null;
        const hasCookie = cookie?.value === COOKIE_VALUE;
        const expectPresent = options.expect === 'present';
        if (hasCookie !== expectPresent) {
          throw new Error(
            `cookie presence mismatch store=${options.store} expected=${options.expect} actual=${hasCookie ? 'present' : 'absent'}`,
          );
        }
        console.log(`[COOKIE_STORE_TEST] read store=${options.store} ${options.expect} ok`);
      }

      this.quit(0);
    } catch (error) {
      console.error(`[COOKIE_STORE_TEST] FAIL ${error instanceof Error ? error.message : String(error)}`);
      this.quit(1);
    }
  }
}
