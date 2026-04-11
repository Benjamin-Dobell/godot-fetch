import { Control, FileAccess, JSON as GodotJSON, SceneNodes } from 'godot';
import { createClassBinder } from 'godot.annotations';
import { runWptSuite as runWptSuitePolyfill } from './scripts/wpt/fetch-wpt-runner-polyfill';
import { runWptSuite as runWptSuiteBrowser } from './scripts/wpt/fetch-wpt-runner-browser';

const bind = createClassBinder();

type WptSummary = {
  passed: number;
  failed: number;
  errors: number;
  total: number;
  filesRan: number;
};

type WptWebState = {
  __WPT_GODOT_JSON__?: WptSummary;
  __WPT_WEB_ENTER_TREE__?: boolean;
  __WPT_WEB_ERROR__?: string;
  __WPT_WEB_LOCATION__?: string;
  __WPT_WEB_MODE_REQUESTED__?: boolean;
  __WPT_WEB_SKIPPED__?: string;
  __WPT_WEB_STARTED__?: boolean;
};

type WptBridgeMessage =
  | {
    __godotFetchWpt: true;
    type: 'summary';
    summary: WptSummary;
  }
  | {
    __godotFetchWpt: true;
    type: 'error';
    error: string;
  }
  | {
    __godotFetchWpt: true;
    type: 'state';
    state: Partial<WptWebState>;
  };

type WptBridgePayload =
  | {
    type: 'summary';
    summary: WptSummary;
  }
  | {
    type: 'error';
    error: string;
  }
  | {
    type: 'state';
    state: Partial<WptWebState>;
  };

type WptRunOptions = {
  files: string[];
  debug: boolean;
  fetchMode: 'conformant' | 'fast';
  fetchImplementation: 'browser' | 'polyfill';
  timeoutMs: number;
};

const WPT_WEB_CONFIG_PATH = 'res://.wpt-web-config.json';

function readQueryParam(name: string): string | null {
  const location = (globalThis as {
    location?: {
      search?: string;
      href?: string;
      hash?: string;
    };
  }).location;
  const queryCandidates: string[] = [];

  if (typeof location?.search === 'string' && location.search.length > 0) {
    queryCandidates.push(location.search);
  }
  if (typeof location?.href === 'string') {
    const questionIndex = location.href.indexOf('?');
    if (questionIndex >= 0) {
      const hashIndex = location.href.indexOf('#', questionIndex);
      queryCandidates.push(
        hashIndex >= 0 ? location.href.slice(questionIndex, hashIndex) : location.href.slice(questionIndex),
      );
    }
  }
  if (typeof location?.hash === 'string' && location.hash.includes('?')) {
    queryCandidates.push(location.hash.slice(location.hash.indexOf('?')));
  }
  if (typeof location !== 'undefined') {
    const locationText = String(location);
    const questionIndex = locationText.indexOf('?');
    if (questionIndex >= 0) {
      const hashIndex = locationText.indexOf('#', questionIndex);
      queryCandidates.push(
        hashIndex >= 0 ? locationText.slice(questionIndex, hashIndex) : locationText.slice(questionIndex),
      );
    }
  }

  for (const candidate of queryCandidates) {
    const query = candidate.startsWith('?') ? candidate.slice(1) : candidate;
    for (const pair of query.split('&')) {
      if (pair.length === 0) {
        continue;
      }
      const separatorIndex = pair.indexOf('=');
      const rawKey = separatorIndex >= 0 ? pair.slice(0, separatorIndex) : pair;
      if (decodeURIComponent(rawKey) !== name) {
        continue;
      }
      const rawValue = separatorIndex >= 0 ? pair.slice(separatorIndex + 1) : '';
      return decodeURIComponent(rawValue);
    }
  }
  return null;
}

function shouldRunWptWebMode(): boolean {
  return readQueryParam('wpt_browser') === '1'
    || readQueryParam('wpt_files') !== null
    || readQueryParam('wpt_fetch_mode') !== null
    || readQueryParam('wpt_fetch_implementation') !== null
    || readQueryParam('wpt_timeout_ms') !== null;
}

function parseWptFileList(): string[] {
  const raw = readQueryParam('wpt_files');
  if (!raw) {
    return [];
  }
  return raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
}

function parseWptWebConfig(rawConfig: unknown): WptRunOptions | null {
  if (!rawConfig || typeof rawConfig !== 'object') {
    return null;
  }

  const config = rawConfig as {
    files?: unknown;
    debug?: unknown;
    fetchMode?: unknown;
    fetchImplementation?: unknown;
    timeoutMs?: unknown;
  };

  const rawFiles = Array.isArray(config.files)
    ? config.files
    : config.files && typeof config.files === 'object' && Symbol.iterator in config.files
      ? Array.from(config.files as Iterable<unknown>)
      : [];
  const files = rawFiles
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const debug = config.debug === true;
  const fetchMode = config.fetchMode === 'fast' ? 'fast' : 'conformant';
  const fetchImplementation = config.fetchImplementation === 'browser' ? 'browser' : 'polyfill';
  const timeoutMs = Number.isFinite(config.timeoutMs) && Number(config.timeoutMs) > 0
    ? Number(config.timeoutMs)
    : 30_000;

  return {
    files,
    debug,
    fetchMode,
    fetchImplementation,
    timeoutMs,
  };
}

function readWptRunOptionsFromConfigFile(): WptRunOptions | null {
  if (!FileAccess.file_exists(WPT_WEB_CONFIG_PATH)) {
    return null;
  }

  const content = FileAccess.get_file_as_string(WPT_WEB_CONFIG_PATH);
  if (content.length === 0) {
    return null;
  }

  return parseWptWebConfig(GodotJSON.parse_string(content));
}

function readWptRunOptionsFromQuery(): WptRunOptions | null {
  if (!shouldRunWptWebMode()) {
    return null;
  }

  const timeoutMs = Number.parseInt(readQueryParam('wpt_timeout_ms') ?? '30000', 10);
  return {
    files: parseWptFileList(),
    debug: readQueryParam('wpt_debug') === '1',
    fetchMode: readQueryParam('wpt_fetch_mode') === 'fast' ? 'fast' : 'conformant',
    fetchImplementation: readQueryParam('wpt_fetch_implementation') === 'browser' ? 'browser' : 'polyfill',
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000,
  };
}

function resolveWptRunOptions(): WptRunOptions | null {
  const fromConfig = readWptRunOptionsFromConfigFile();
  const fromQuery = readWptRunOptionsFromQuery();

  if (fromConfig && fromQuery) {
    return {
      ...fromConfig,
      ...fromQuery,
      files: fromQuery.files.length > 0 ? fromQuery.files : fromConfig.files,
    };
  }

  if (fromConfig) {
    return fromConfig;
  }

  return fromQuery;
}

function postWptBridgeMessage(message: WptBridgePayload): void {
  const maybePostMessage = (globalThis as { postMessage?: (payload: unknown) => void }).postMessage;
  if (typeof maybePostMessage !== 'function') {
    return;
  }
  const payload: WptBridgeMessage = {
    __godotFetchWpt: true,
    ...message,
  } as WptBridgeMessage;
  maybePostMessage(payload);
}

async function runWptWebSuite(options: WptRunOptions): Promise<void> {
  const webState = globalThis as WptWebState;
  webState.__WPT_WEB_STARTED__ = true;
  postWptBridgeMessage({ type: 'state', state: { __WPT_WEB_STARTED__: true } });
  console.log('[WPT_WEB_TRACE] runWptWebSuite:start');

  const runWptSuite = options.fetchImplementation === 'browser' ? runWptSuiteBrowser : runWptSuitePolyfill;
  console.log('[WPT_WEB_TRACE] runWptWebSuite:module-loaded');

  console.log('[WPT_WEB_TRACE] runWptWebSuite:runWptSuite-call');
  const summary = await runWptSuite({
    files: options.files,
    debug: options.debug,
    fetchMode: options.fetchMode,
    fetchImplementation: options.fetchImplementation,
    timeoutMs: options.timeoutMs,
  });
  console.log('[WPT_WEB_TRACE] runWptWebSuite:runWptSuite-resolved');

  webState.__WPT_GODOT_JSON__ = summary;
  postWptBridgeMessage({ type: 'summary', summary });
  console.log(`[WPT_GODOT_JSON]${JSON.stringify(summary)}`);
}

@bind()
export default class Main extends Control<SceneNodes['Main.tscn']> {
  override _enter_tree(): void {
    const webState = globalThis as WptWebState;
    webState.__WPT_WEB_ENTER_TREE__ = true;
    webState.__WPT_WEB_LOCATION__ = String(
      (globalThis as { location?: { href?: string } }).location?.href ?? 'missing',
    );

    const runOptions = resolveWptRunOptions();
    const shouldRun = runOptions !== null;
    webState.__WPT_WEB_MODE_REQUESTED__ = shouldRun;
    console.log(
      `[WPT_WEB_BOOT] mode=${shouldRun ? 'run' : 'skip'} config=${FileAccess.file_exists(WPT_WEB_CONFIG_PATH) ? 'present' : 'missing'} location=${webState.__WPT_WEB_LOCATION__}`,
    );
    postWptBridgeMessage({
      type: 'state',
      state: {
        __WPT_WEB_ENTER_TREE__: webState.__WPT_WEB_ENTER_TREE__,
        __WPT_WEB_LOCATION__: webState.__WPT_WEB_LOCATION__,
        __WPT_WEB_MODE_REQUESTED__: webState.__WPT_WEB_MODE_REQUESTED__,
      },
    });

    if (runOptions) {
      runWptWebSuite(runOptions).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        webState.__WPT_WEB_ERROR__ = message;
        postWptBridgeMessage({ type: 'error', error: message });
        console.error(`[WPT_WEB] ${message}`);
      });
      return;
    }

    webState.__WPT_WEB_SKIPPED__ = 'config_and_query_not_detected';
    postWptBridgeMessage({
      type: 'state',
      state: { __WPT_WEB_SKIPPED__: webState.__WPT_WEB_SKIPPED__ },
    });
  }
}
