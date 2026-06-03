import { FileAccess, JSON as GodotJSON, Node } from 'godot';
import {
  AbortController,
  AbortSignal,
  Blob,
  DOMException,
  fetch as godotFetch,
  FormData,
  Headers,
  ReadableStream,
  Request,
  Response,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  WritableStream,
} from 'godot-fetch';
import { parseArgs, runWptSuite } from './fetch-wpt-runner.js';
const WPT_WEB_CONFIG_PATH = 'res://.wpt-web-config.json';

type SmokeConfig = {
  webHttpExpected?: string;
  webHttpSmoke?: boolean;
  webHttpUrl?: string;
  webStreamExpectedBytes?: number;
  webStreamSmoke?: boolean;
  webStreamUrl?: string;
};

function parseQueryValue(query: string, key: string): null | string {
  for (const pair of query.split('&')) {
    if (pair.length === 0) {
      continue;
    }
    const separator = pair.indexOf('=');
    const rawKey = separator >= 0 ? pair.slice(0, separator) : pair;
    if (decodeURIComponent(rawKey) !== key) {
      continue;
    }
    const rawValue = separator >= 0 ? pair.slice(separator + 1) : '';
    return decodeURIComponent(rawValue);
  }
  return null;
}

function readQueryParam(name: string): null | string {
  const location = (globalThis as { location?: { href?: string; search?: string } }).location;
  const search = location?.search;
  if (typeof search === 'string' && search.length > 0) {
    return parseQueryValue(search.startsWith('?') ? search.slice(1) : search, name);
  }

  const href = typeof location?.href === 'string' ? location.href : '';
  if (href.includes('?')) {
    const query = href.slice(href.indexOf('?') + 1).split('#')[0] ?? '';
    return parseQueryValue(query, name);
  }

  return null;
}

function readSmokeConfig(): SmokeConfig {
  console.log(`[WEB_SMOKE_MODE] config_file_exists=${String(FileAccess.file_exists(WPT_WEB_CONFIG_PATH))}`);
  if (!FileAccess.file_exists(WPT_WEB_CONFIG_PATH)) {
    return {};
  }
  const raw = FileAccess.get_file_as_string(WPT_WEB_CONFIG_PATH);
  if (raw.trim().length === 0) {
    return {};
  }
  const parsed = GodotJSON.parse_string(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }
  const config: SmokeConfig = {};
  if (parsed.webHttpSmoke === true) {
    config.webHttpSmoke = true;
  }
  if (typeof parsed.webHttpUrl === 'string') {
    config.webHttpUrl = parsed.webHttpUrl;
  }
  if (typeof parsed.webHttpExpected === 'string') {
    config.webHttpExpected = parsed.webHttpExpected;
  }
  if (parsed.webStreamSmoke === true) {
    config.webStreamSmoke = true;
  }
  if (typeof parsed.webStreamUrl === 'string') {
    config.webStreamUrl = parsed.webStreamUrl;
  }
  if (typeof parsed.webStreamExpectedBytes === 'number') {
    config.webStreamExpectedBytes = parsed.webStreamExpectedBytes;
  }
  return config;
}

async function ensureWptGlobalsInstalled(): Promise<void> {
  const globals = globalThis as Record<string, unknown>;
  const missingGlobals: Record<string, unknown> = {
    AbortController,
    AbortSignal,
    Blob,
    DOMException,
    FormData,
    Headers,
    ReadableStream,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    WritableStream,
  };

  for (const [key, value] of Object.entries(missingGlobals)) {
    if (!(key in globals)) {
      globals[key] = value;
    }
  }

  if (typeof globals.fetch !== 'function') {
    globals.fetch = godotFetch;
  }
}

async function runHttpSmoke(config: SmokeConfig): Promise<void> {
  const url = readQueryParam('web_http_url') ?? config.webHttpUrl ?? '/http-smoke';
  const expected = readQueryParam('web_http_expected') ?? config.webHttpExpected ?? 'ok';
  const response = await godotFetch(url, { method: 'GET' });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP smoke status mismatch (status=${String(response.status)})`);
  }
  if (body.trim() !== expected) {
    throw new Error(`HTTP smoke body mismatch (expected=${expected}, got=${body.trim()})`);
  }
  console.log(`[WEB_HTTP_SMOKE] PASS status=${String(response.status)} body=${body.trim()}`);
}

async function runStreamSmoke(config: SmokeConfig): Promise<void> {
  const url = readQueryParam('web_stream_url') ?? config.webStreamUrl ?? '/stream.bin';
  const expectedBytesRaw = readQueryParam('web_stream_expected_bytes')
    ?? (typeof config.webStreamExpectedBytes === 'number' ? String(config.webStreamExpectedBytes) : '');
  const expectedBytes = Number.parseInt(expectedBytesRaw, 10);
  if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
    throw new Error(`Invalid web_stream_expected_bytes=${expectedBytesRaw}`);
  }

  const response = await godotFetch(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Stream smoke status mismatch (status=${String(response.status)})`);
  }
  if (!response.body) {
    throw new Error('Stream smoke expected response.body to be present');
  }

  const reader = response.body.getReader();
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const value = result.value;
    if (!(value instanceof Uint8Array)) {
      throw new Error(`Stream smoke received non-Uint8Array chunk: ${typeof value}`);
    }
    bytes += value.byteLength;
  }

  if (bytes !== expectedBytes) {
    throw new Error(`Stream smoke byte mismatch (expected=${String(expectedBytes)} got=${String(bytes)})`);
  }
  console.log(`[WEB_STREAM_SMOKE] PASS bytes=${String(bytes)}`);
}

export default class FetchRunnerPolyfillNode extends Node {
  override _ready(): void {
    console.log('[WEB_SMOKE_MODE] _ready entered');
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      await ensureWptGlobalsInstalled();
      const config = readSmokeConfig();
      const httpSmoke = readQueryParam('web_http_smoke') === '1' || config.webHttpSmoke === true;
      const streamSmoke = readQueryParam('web_stream_smoke') === '1' || config.webStreamSmoke === true;
      console.log(`[WEB_SMOKE_MODE] selected http=${String(httpSmoke)} stream=${String(streamSmoke)}`);
      if (httpSmoke || streamSmoke) {
        if (httpSmoke) {
          await runHttpSmoke(config);
        }
        if (streamSmoke) {
          await runStreamSmoke(config);
        }
        this.get_tree()?.quit(0);
        return;
      }

      const args = parseArgs();
      const summary = await runWptSuite({
        files: args.files,
        debug: args.debug,
        fetchMode: args.fetchMode,
        host: args.host,
        domainWww: args.domainWww,
        domainWww2: args.domainWww2,
        httpPort0: args.httpPort0,
        httpPort1: args.httpPort1,
        httpsPort0: args.httpsPort0,
        httpsPort1: args.httpsPort1,
        h2Port0: args.h2Port0,
        timeoutMs: args.timeoutMs,
        fetchImplementation: 'polyfill',
      });
      console.log(`[WPT_GODOT_JSON]${JSON.stringify(summary)}`);
      this.get_tree()?.quit(0);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[WPT] ${message}`);
      this.get_tree()?.quit(1);
    }
  }
}
