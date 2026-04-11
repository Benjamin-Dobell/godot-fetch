// @ts-nocheck
import { DirAccess, FileAccess, OS, SceneTree, is_instance_valid as isInstanceValidDirect } from 'godot';
import { is_instance_valid as isInstanceValidLibApi } from 'godot.lib.api';
import { setConformanceMode } from 'godot-fetch/conformance';

const WPT_ROOT = 'res://wpt-cache';
const FEATURE = 'fetch/api';
const WPT_WEB_CONFIG_PATH = 'res://.wpt-web-config.json';
const EXCLUDED_WPT_FILES = new Set([
  'keepalive.any.js',
  'mode-same-origin.any.js',
  'referrer.any.js',
  'request-referrer.any.js',
]);
const HOST_EXCLUDED_WPT_PREFIXES = [
  'fetch/api/cors/',
  'fetch/api/request/request-cache-',
];
const HOST_EXCLUDED_WPT_FILES = new Set([
  'cache.https.any.js',
  'general.any.js',
  'header-values-normalize.any.js',
  'header-values.any.js',
  'headers-no-cors.any.js',
  'redirect-keepalive.any.js',
  'redirect-origin.any.js',
  'redirect-referrer-override.any.js',
  'redirect-referrer.any.js',
  'response-blob-realm.any.js',
  'request-upload.h2.any.js',
]);
const HOST_EXCLUDED_TEST_NAMES = new Map([
  [
    'fetch/api/redirect/redirect-mode.any.js',
    new Set([
      'manual redirect with a CORS error should be rejected',
    ]),
  ],
  [
    'fetch/api/abort/general.any.js',
    new Set([
      'Aborting rejects with AbortError - no-cors',
      'Underlying connection is closed when aborting after receiving response - no-cors',
    ]),
  ],
]);
const LOCATION_SHIM_FILES = new Set([
  'fetch/api/basic/integrity.sub.any.js',
  'fetch/api/basic/request-headers.any.js',
  'fetch/api/basic/stream-safe-creation.any.js',
]);
let FEATURE_DIR = `${WPT_ROOT}/${FEATURE}`;
let TESTHARNESS_PATH = `${WPT_ROOT}/resources/testharness.js`;
const WPT_GLOBALS = [
  'test',
  'async_test',
  'promise_test',
  'promise_rejects_js',
  'promise_rejects_dom',
  'promise_rejects_quotaexceedederror',
  'promise_rejects_exactly',
  'generate_tests',
  'setup',
  'promise_setup',
  'done',
  'on_event',
  'step_timeout',
  'format_value',
  'assert_any',
  'assert_true',
  'assert_false',
  'assert_equals',
  'assert_not_equals',
  'assert_in_array',
  'assert_object_equals',
  'assert_array_equals',
  'assert_array_approx_equals',
  'assert_approx_equals',
  'assert_less_than',
  'assert_greater_than',
  'assert_between_exclusive',
  'assert_less_than_equal',
  'assert_greater_than_equal',
  'assert_between_inclusive',
  'assert_regexp_match',
  'assert_class_string',
  'assert_own_property',
  'assert_not_own_property',
  'assert_inherits',
  'assert_idl_attribute',
  'assert_readonly',
  'assert_throws_js',
  'assert_throws_dom',
  'assert_throws_quotaexceedederror',
  'assert_throws_exactly',
  'assert_unreached',
  'assert_implements',
  'assert_implements_optional',
  'fetch_tests_from_worker',
  'fetch_tests_from_window',
  'fetch_tests_from_shadow_realm',
  'begin_shadow_realm_tests',
  'timeout',
  'add_start_callback',
  'add_test_state_callback',
  'add_result_callback',
  'add_completion_callback',
  'AssertionError',
  'OptionalFeatureUnsupportedError',
  'EventWatcher',
  'subsetTestByKey',
  'GLOBAL',
];

function readWebConfig() {
  if (!FileAccess.file_exists(WPT_WEB_CONFIG_PATH)) {
    return null;
  }

  try {
    const raw = FileAccess.get_file_as_string(WPT_WEB_CONFIG_PATH);
    if (!raw || raw.trim().length === 0) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseArgs() {
  const userArgs = Array.from(OS.get_cmdline_user_args());
  const allArgs = Array.from(OS.get_cmdline_args());
  const filteredUserArgs = userArgs.filter((value) => value.startsWith('--wpt-'));
  const args = filteredUserArgs.length > 0 ? filteredUserArgs : allArgs.filter((value) => value.startsWith('--wpt-'));
  const env = {
    debug: OS.get_environment('WPT_GODOT_DEBUG'),
    domainWww: OS.get_environment('WPT_GODOT_DOMAIN_WWW'),
    domainWww2: OS.get_environment('WPT_GODOT_DOMAIN_WWW2'),
    fetchImplementation: OS.get_environment('WPT_GODOT_FETCH_IMPLEMENTATION'),
    fetchMode: OS.get_environment('WPT_GODOT_FETCH_MODE'),
    files: OS.get_environment('WPT_GODOT_FILES'),
    h2Port0: OS.get_environment('WPT_GODOT_H2_PORT0'),
    host: OS.get_environment('WPT_GODOT_HOST'),
    httpPort0: OS.get_environment('WPT_GODOT_HTTP_PORT0'),
    httpPort1: OS.get_environment('WPT_GODOT_HTTP_PORT1'),
    httpsPort0: OS.get_environment('WPT_GODOT_HTTPS_PORT0'),
    httpsPort1: OS.get_environment('WPT_GODOT_HTTPS_PORT1'),
    timeoutMs: OS.get_environment('WPT_GODOT_TIMEOUT_MS'),
  };

  const directType = typeof isInstanceValidDirect;
  const libApiType = typeof isInstanceValidLibApi;
  console.log(`[WPT_GODOT_IMPORT_DEBUG] godot.is_instance_valid type=${directType}`);
  console.log(`[WPT_GODOT_IMPORT_DEBUG] godot.lib.api.is_instance_valid type=${libApiType}`);
  const parsed = {
    files: [],
    debug: false,
    fetchMode: 'conformant',
    host: 'web-platform.test',
    domainWww: 'www.web-platform.test',
    domainWww2: 'www2.web-platform.test',
    httpPort0: 8000,
    httpPort1: 8001,
    httpsPort0: 8443,
    httpsPort1: 8444,
    h2Port0: 9100,
    timeoutMs: 30_000,
    fetchImplementation: 'polyfill',
  };
  const webConfig = readWebConfig();

  for (const arg of args) {
    if (arg.startsWith('--wpt-files=')) {
      parsed.files = arg
        .slice('--wpt-files='.length)
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      continue;
    }

    if (arg === '--wpt-debug') {
      parsed.debug = true;
      continue;
    }

    if (arg.startsWith('--wpt-fetch-mode=')) {
      const value = arg.slice('--wpt-fetch-mode='.length).trim();
      if (value === 'fast' || value === 'conformant') {
        parsed.fetchMode = value;
      }
      continue;
    }

    if (arg.startsWith('--wpt-fetch-implementation=')) {
      const value = arg.slice('--wpt-fetch-implementation='.length).trim();
      if (value === 'polyfill' || value === 'browser') {
        parsed.fetchImplementation = value;
      }
      continue;
    }

    if (arg.startsWith('--wpt-timeout-ms=')) {
      const raw = Number.parseInt(arg.slice('--wpt-timeout-ms='.length), 10);
      if (Number.isFinite(raw) && raw > 0) {
        parsed.timeoutMs = raw;
      }
      continue;
    }

    if (arg.startsWith('--wpt-host=')) {
      const value = arg.slice('--wpt-host='.length).trim();
      if (value.length > 0) {
        parsed.host = value;
      }
      continue;
    }

    if (arg.startsWith('--wpt-domain-www=')) {
      const value = arg.slice('--wpt-domain-www='.length).trim();
      if (value.length > 0) {
        parsed.domainWww = value;
      }
      continue;
    }

    if (arg.startsWith('--wpt-domain-www2=')) {
      const value = arg.slice('--wpt-domain-www2='.length).trim();
      if (value.length > 0) {
        parsed.domainWww2 = value;
      }
      continue;
    }

    if (arg.startsWith('--wpt-http-port0=')) {
      const value = Number.parseInt(arg.slice('--wpt-http-port0='.length), 10);
      if (Number.isFinite(value) && value > 0) {
        parsed.httpPort0 = value;
      }
      continue;
    }

    if (arg.startsWith('--wpt-http-port1=')) {
      const value = Number.parseInt(arg.slice('--wpt-http-port1='.length), 10);
      if (Number.isFinite(value) && value > 0) {
        parsed.httpPort1 = value;
      }
      continue;
    }

    if (arg.startsWith('--wpt-https-port0=')) {
      const value = Number.parseInt(arg.slice('--wpt-https-port0='.length), 10);
      if (Number.isFinite(value) && value > 0) {
        parsed.httpsPort0 = value;
      }
      continue;
    }

    if (arg.startsWith('--wpt-https-port1=')) {
      const value = Number.parseInt(arg.slice('--wpt-https-port1='.length), 10);
      if (Number.isFinite(value) && value > 0) {
        parsed.httpsPort1 = value;
      }
      continue;
    }

    if (arg.startsWith('--wpt-h2-port0=')) {
      const value = Number.parseInt(arg.slice('--wpt-h2-port0='.length), 10);
      if (Number.isFinite(value) && value > 0) {
        parsed.h2Port0 = value;
      }
    }
  }

  if (parsed.files.length === 0 && typeof env.files === 'string' && env.files.trim().length > 0) {
    parsed.files = env.files
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  if (!args.includes('--wpt-debug') && env.debug === '1') {
    parsed.debug = true;
  }

  if (typeof env.fetchMode === 'string') {
    const value = env.fetchMode.trim();
    if (value === 'fast' || value === 'conformant') {
      parsed.fetchMode = value;
    }
  }

  if (typeof env.fetchImplementation === 'string') {
    const value = env.fetchImplementation.trim();
    if (value === 'polyfill' || value === 'browser') {
      parsed.fetchImplementation = value;
    }
  }

  if (typeof env.host === 'string' && env.host.trim().length > 0) {
    parsed.host = env.host.trim();
  }
  if (typeof env.domainWww === 'string' && env.domainWww.trim().length > 0) {
    parsed.domainWww = env.domainWww.trim();
  }
  if (typeof env.domainWww2 === 'string' && env.domainWww2.trim().length > 0) {
    parsed.domainWww2 = env.domainWww2.trim();
  }

  const applyPort = (rawValue, assign) => {
    const value = Number.parseInt(rawValue ?? '', 10);
    if (Number.isFinite(value) && value > 0) {
      assign(value);
    }
  };
  applyPort(env.httpPort0, (value) => { parsed.httpPort0 = value; });
  applyPort(env.httpPort1, (value) => { parsed.httpPort1 = value; });
  applyPort(env.httpsPort0, (value) => { parsed.httpsPort0 = value; });
  applyPort(env.httpsPort1, (value) => { parsed.httpsPort1 = value; });
  applyPort(env.h2Port0, (value) => { parsed.h2Port0 = value; });
  applyPort(env.timeoutMs, (value) => { parsed.timeoutMs = value; });

  if (OS.has_feature('web') && webConfig !== null) {
    if (Array.isArray(webConfig.files)) {
      parsed.files = webConfig.files
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0);
    }

    if (typeof webConfig.debug === 'boolean') {
      parsed.debug = webConfig.debug;
    }

    if (webConfig.fetchMode === 'fast' || webConfig.fetchMode === 'conformant') {
      parsed.fetchMode = webConfig.fetchMode;
    }

    if (webConfig.fetchImplementation === 'polyfill' || webConfig.fetchImplementation === 'browser') {
      parsed.fetchImplementation = webConfig.fetchImplementation;
    }

    if (typeof webConfig.host === 'string' && webConfig.host.trim().length > 0) {
      parsed.host = webConfig.host.trim();
    }
    if (typeof webConfig.domainWww === 'string' && webConfig.domainWww.trim().length > 0) {
      parsed.domainWww = webConfig.domainWww.trim();
    }
    if (typeof webConfig.domainWww2 === 'string' && webConfig.domainWww2.trim().length > 0) {
      parsed.domainWww2 = webConfig.domainWww2.trim();
    }

    if (Number.isFinite(webConfig.httpPort0) && webConfig.httpPort0 > 0) {
      parsed.httpPort0 = webConfig.httpPort0;
    }
    if (Number.isFinite(webConfig.httpPort1) && webConfig.httpPort1 > 0) {
      parsed.httpPort1 = webConfig.httpPort1;
    }
    if (Number.isFinite(webConfig.httpsPort0) && webConfig.httpsPort0 > 0) {
      parsed.httpsPort0 = webConfig.httpsPort0;
    }
    if (Number.isFinite(webConfig.httpsPort1) && webConfig.httpsPort1 > 0) {
      parsed.httpsPort1 = webConfig.httpsPort1;
    }
    if (Number.isFinite(webConfig.h2Port0) && webConfig.h2Port0 > 0) {
      parsed.h2Port0 = webConfig.h2Port0;
    }
    if (Number.isFinite(webConfig.timeoutMs) && webConfig.timeoutMs > 0) {
      parsed.timeoutMs = webConfig.timeoutMs;
    }
  }

  if (OS.has_feature('web')) {
    const maybeLocation = (globalThis as { location?: { search?: string } }).location;
    const rawSearch = typeof maybeLocation?.search === 'string' ? maybeLocation.search : '';
    if (rawSearch.length > 0) {
      const query = new URLSearchParams(rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch);

      const files = query.get('wpt_files');
      if (typeof files === 'string' && files.trim().length > 0) {
        parsed.files = files
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
      }

      if (query.get('wpt_debug') === '1') {
        parsed.debug = true;
      }

      const fetchMode = query.get('wpt_fetch_mode');
      if (fetchMode === 'fast' || fetchMode === 'conformant') {
        parsed.fetchMode = fetchMode;
      }

      const fetchImplementation = query.get('wpt_fetch_implementation');
      if (fetchImplementation === 'polyfill' || fetchImplementation === 'browser') {
        parsed.fetchImplementation = fetchImplementation;
      }

      const timeout = Number.parseInt(query.get('wpt_timeout_ms') ?? '', 10);
      if (Number.isFinite(timeout) && timeout > 0) {
        parsed.timeoutMs = timeout;
      }
    }
  }

  if (OS.has_feature('web') && parsed.fetchImplementation === 'browser') {
    const browserLocation = (globalThis as {
      location?: {
        host?: string;
        hostname?: string;
        href?: string;
        port?: string;
        protocol?: string;
      };
    }).location;
    if (browserLocation && typeof browserLocation === 'object') {
      const locationHost = typeof browserLocation.hostname === 'string' ? browserLocation.hostname.trim() : '';
      if (locationHost.length > 0) {
        parsed.host = locationHost;
      }

      let protocol = typeof browserLocation.protocol === 'string' ? browserLocation.protocol : '';
      let portText = typeof browserLocation.port === 'string' ? browserLocation.port.trim() : '';
      if (portText.length === 0 && typeof browserLocation.host === 'string') {
        const host = browserLocation.host.trim();
        const separator = host.lastIndexOf(':');
        if (separator > 0 && separator + 1 < host.length) {
          portText = host.slice(separator + 1);
        }
      }
      if ((protocol.length === 0 || portText.length === 0) && typeof browserLocation.href === 'string') {
        try {
          const url = new URL(browserLocation.href);
          if (protocol.length === 0) {
            protocol = url.protocol;
          }
          if (portText.length === 0) {
            portText = url.port;
          }
          if (locationHost.length === 0 && url.hostname.length > 0) {
            parsed.host = url.hostname;
          }
        } catch {
          // ignore malformed location href and retain parsed defaults
        }
      }

      const port = Number.parseInt(portText, 10);
      if (Number.isFinite(port) && port > 0) {
        if (protocol === 'https:') {
          parsed.httpsPort0 = port;
        } else {
          parsed.httpPort0 = port;
        }
      }
    }
  }

  return parsed;
}

function replaceWptTemplateTokens(source, config) {
  return source
    .replaceAll('{{host}}', config.host)
    .replaceAll('{{domains[www]}}', config.domainWww)
    .replaceAll('{{domains[www2]}}', config.domainWww2)
    .replaceAll('{{ports[http][0]}}', String(config.httpPort0))
    .replaceAll('{{ports[http][1]}}', String(config.httpPort1))
    .replaceAll('{{ports[https][0]}}', String(config.httpsPort0))
    .replaceAll('{{ports[https][1]}}', String(config.httpsPort1))
    .replaceAll('{{ports[h2][0]}}', String(config.h2Port0));
}

function parseMeta(source) {
  const meta = {
    scripts: [],
    timeout: 'normal',
  };

  for (const line of source.split('\n')) {
    const match = line.match(/^\/\/\s*META:\s*(\w+)=(.+)$/);
    if (!match) {
      if (line.trim().length > 0 && !line.startsWith('//') && !line.startsWith('\'use strict\'')) {
        break;
      }
      continue;
    }

    const key = match[1];
    const value = match[2].trim();
    if (key === 'script') {
      meta.scripts.push(value);
    } else if (key === 'timeout') {
      meta.timeout = value;
    }
  }

  return meta;
}

function prepareForGlobalEval(source) {
  return source
    .replace(/^\s*['\"]use strict['\"]\s*;?/gm, '// (use strict removed for WPT runner)')
    .replace(/^(const|let)\s+/gm, 'var ');
}

function normalizeResPath(path) {
  const prefix = 'res://';
  if (!path.startsWith(prefix)) {
    return path;
  }

  const parts = path.slice(prefix.length).split('/');
  const out = [];
  for (const part of parts) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      if (out.length > 0) {
        out.pop();
      }
      continue;
    }
    out.push(part);
  }

  return `${prefix}${out.join('/')}`;
}

function dirname(path) {
  const index = path.lastIndexOf('/');
  if (index <= 'res://'.length - 1) {
    return 'res://';
  }
  return path.slice(0, index);
}

function basename(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function resolveMetaScriptPath(testFilePath, scriptPath) {
  if (scriptPath.startsWith('/')) {
    return normalizeResPath(`${WPT_ROOT}${scriptPath}`);
  }

  return normalizeResPath(`${dirname(testFilePath)}/${scriptPath}`);
}

function readFileText(path, config) {
  if (!FileAccess.file_exists(path)) {
    throw new Error(`File not found: ${path}`);
  }
  return replaceWptTemplateTokens(FileAccess.get_file_as_string(path), config);
}

function cleanupGlobals() {
  for (const name of WPT_GLOBALS) {
    try {
      delete globalThis[name];
    } catch (_error) {
      // no-op
    }
  }
}

function createBase64Helpers() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const decodeTable = new Int16Array(256);
  decodeTable.fill(-1);
  for (let index = 0; index < alphabet.length; index += 1) {
    decodeTable[alphabet.charCodeAt(index)] = index;
  }
  decodeTable['='.charCodeAt(0)] = 0;

  const btoaImpl = (input) => {
    let output = '';
    const length = input.length;
    let offset = 0;
    while (offset < length) {
      const byte0 = input.charCodeAt(offset += 1) & 0xff;
      const hasByte1 = offset < length;
      const byte1 = hasByte1 ? input.charCodeAt(offset += 1) & 0xff : 0;
      const hasByte2 = offset < length;
      const byte2 = hasByte2 ? input.charCodeAt(offset += 1) & 0xff : 0;

      const enc0 = byte0 >> 2;
      const enc1 = ((byte0 & 0x03) << 4) | (byte1 >> 4);
      const enc2 = ((byte1 & 0x0f) << 2) | (byte2 >> 6);
      const enc3 = byte2 & 0x3f;

      output += alphabet[enc0];
      output += alphabet[enc1];
      output += hasByte1 ? alphabet[enc2] : '=';
      output += hasByte2 ? alphabet[enc3] : '=';
    }
    return output;
  };

  const atobImpl = (input) => {
    const normalized = input.replaceAll(/\s+/g, '');
    if (normalized.length % 4 !== 0) {
      throw new Error('InvalidCharacterError');
    }
    let output = '';
    for (let offset = 0; offset < normalized.length; offset += 4) {
      const c0 = normalized.charCodeAt(offset);
      const c1 = normalized.charCodeAt(offset + 1);
      const c2 = normalized.charCodeAt(offset + 2);
      const c3 = normalized.charCodeAt(offset + 3);
      const e0 = decodeTable[c0];
      const e1 = decodeTable[c1];
      const e2 = decodeTable[c2];
      const e3 = decodeTable[c3];
      if (e0 < 0 || e1 < 0 || e2 < 0 || e3 < 0) {
        throw new Error('InvalidCharacterError');
      }

      const byte0 = (e0 << 2) | (e1 >> 4);
      const byte1 = ((e1 & 0x0f) << 4) | (e2 >> 2);
      const byte2 = ((e2 & 0x03) << 6) | e3;
      output += String.fromCharCode(byte0);
      if (normalized[offset + 2] !== '=') {
        output += String.fromCharCode(byte1);
      }
      if (normalized[offset + 3] !== '=') {
        output += String.fromCharCode(byte2);
      }
    }
    return output;
  };

  return { atobImpl, btoaImpl };
}

function createShellGlobals(testFilePath, config) {
  const localPath = testFilePath.replace(`${WPT_ROOT}/`, '/');
  const host = config.host;
  const portText = String(config.httpPort0);
  const origin = `http://${host}:${portText}`;
  const href = `${origin}${localPath}`;
  const syntheticLocation = {
    search: '',
    href,
    origin,
    protocol: 'http:',
    host: `${host}:${portText}`,
    hostname: host,
    port: portText,
    pathname: localPath,
    hash: '',
    toString() {
      return this.href;
    },
    [Symbol.toPrimitive]() {
      return this.href;
    },
  };
  const nativeLocation = (globalThis as { location?: unknown }).location;
  const isBrowserLocation = typeof nativeLocation === 'object'
    && nativeLocation !== null
    && typeof (nativeLocation as { href?: unknown }).href === 'string'
    && typeof (nativeLocation as { origin?: unknown }).origin === 'string'
    && typeof (nativeLocation as { pathname?: unknown }).pathname === 'string';
  const effectiveLocation = isBrowserLocation
    ? {
      search: String((nativeLocation as { search?: unknown }).search ?? ''),
      href: String((nativeLocation as { href?: unknown }).href),
      origin: String((nativeLocation as { origin?: unknown }).origin),
      protocol: String((nativeLocation as { protocol?: unknown }).protocol ?? ''),
      host: String((nativeLocation as { host?: unknown }).host ?? ''),
      hostname: String((nativeLocation as { hostname?: unknown }).hostname ?? ''),
      port: String((nativeLocation as { port?: unknown }).port ?? ''),
      pathname: String((nativeLocation as { pathname?: unknown }).pathname),
      hash: String((nativeLocation as { hash?: unknown }).hash ?? ''),
      toString() {
        return this.href;
      },
      [Symbol.toPrimitive]() {
      return this.href;
      },
    }
    : syntheticLocation;

  if (isBrowserLocation) {
    const historyApi = (globalThis as { history?: { replaceState?: (data: unknown, unused: string, url?: string) => void } }).history;
    if (historyApi && typeof historyApi.replaceState === 'function') {
      try {
        historyApi.replaceState(null, '', localPath);
      } catch {
        // Best-effort URL rebasing only; runner still works without history support.
      }
    }
  }

  if (typeof globalThis.self === 'undefined') {
    globalThis.self = globalThis;
  }
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
  }
  if (typeof globalThis.Float16Array === 'undefined') {
    globalThis.Float16Array = Uint16Array;
  }
  if (typeof globalThis.location === 'undefined') {
    Object.defineProperty(globalThis, 'location', {
      value: Object.freeze(effectiveLocation),
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }
  const { atobImpl, btoaImpl } = createBase64Helpers();
  if (typeof globalThis.atob === 'undefined') {
    globalThis.atob = atobImpl;
  }
  if (typeof globalThis.btoa === 'undefined') {
    globalThis.btoa = btoaImpl;
  }
  globalThis.__WPT_LOCATION__ = Object.freeze(effectiveLocation);
  globalThis.GLOBAL = {
    isWindow: () => false,
    isShadowRealm: () => false,
    isWorker: () => false,
    isDedicatedWorker: () => false,
    isSharedWorker: () => false,
    isServiceWorker: () => false,
  };
  globalThis.subsetTestByKey = function (_key, testFunction, ...args) {
    return testFunction(...args);
  };
  globalThis.get_title = () => localPath;
}

function evalWithLocationShim(source) {
  const runner = `(function(__wpt_location__) { var location = __wpt_location__; \n${source}\n})(globalThis.__WPT_LOCATION__ ?? globalThis.location);`;
  (0, eval)(runner);
}

function applyHostExcludedTests(relativeName, tests) {
  if (OS.has_feature('web')) {
    return tests;
  }

  const excludedTests = HOST_EXCLUDED_TEST_NAMES.get(relativeName);
  const isCorsPolicyTestName = (name) => {
    const normalized = String(name ?? '').toLowerCase();
    return normalized.includes('no-cors') || normalized.includes(' cors ');
  };
  if (!excludedTests) {
    return tests.map((test) => {
      if (!isCorsPolicyTestName(test.name)) {
        return test;
      }

      return {
        ...test,
        status: 3,
        message: 'Host excluded: browser-origin CORS semantics',
        stack: null,
      };
    });
  }

  return tests.map((test) => {
    if (!excludedTests.has(test.name) && !isCorsPolicyTestName(test.name)) {
      return test;
    }

    return {
      ...test,
      status: 3,
      message: 'Host excluded: browser-origin CORS semantics',
      stack: null,
    };
  });
}

async function runSingleTest(testFilePath, options) {
  const { baseTimeoutMs, debug, templateConfig } = options;
  const relativeName = testFilePath.replace(`${WPT_ROOT}/`, '');
  const testSource = readFileText(testFilePath, templateConfig);
  const meta = parseMeta(testSource);
  const timeoutMs = meta.timeout === 'long' ? baseTimeoutMs * 6 : baseTimeoutMs;

  cleanupGlobals();
  createShellGlobals(testFilePath, templateConfig);
  (0, eval)(readFileText(TESTHARNESS_PATH, templateConfig));

  const recorded = {
    tests: [],
    status: null,
    asserts: [],
  };
  const completedTestNames = [];
  const completedFailureMessages = [];
  let activeTestName = '<none>';

  try {
    for (const scriptPath of meta.scripts) {
      const resolvedScriptPath = resolveMetaScriptPath(testFilePath, scriptPath);
      if (!FileAccess.file_exists(resolvedScriptPath)) {
        if (debug) {
          console.warn(`[WPT][warn] missing meta script: ${scriptPath} -> ${resolvedScriptPath}`);
        }
        continue;
      }

      const scriptSource = prepareForGlobalEval(readFileText(resolvedScriptPath, templateConfig));
      (0, eval)(scriptSource);
    }

    let completion = null;
    let resolveCompletion = null;
    const completionPromise = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    globalThis.add_result_callback((test) => {
      const testName = typeof test?.name === 'string' && test.name.length > 0 ? test.name : '<unnamed>';
      const testStatus = Number.isFinite(test?.status) ? String(test.status) : '<unknown>';
      completedTestNames.push(`${testName} [status=${testStatus}]`);
      if (testStatus !== '0' && testStatus !== '3') {
        const testMessage = typeof test?.message === 'string' ? test.message : '';
        completedFailureMessages.push(`${testName} :: ${testMessage}`);
      }
      activeTestName = '<none>';
      if (debug) {
        console.log(`[WPT][case] ${relativeName} :: ${testName} :: status=${testStatus}`);
      }
    });
    globalThis.add_test_state_callback((test, phase) => {
      const testName = typeof test?.name === 'string' && test.name.length > 0 ? test.name : '<unnamed>';
      activeTestName = testName;
      if (!debug) {
        return;
      }
      const phaseName = typeof phase === 'number' ? String(phase) : String(phase ?? '<unknown>');
      console.log(`[WPT][state] ${relativeName} :: ${testName} :: phase=${phaseName}`);
    });
    globalThis.add_completion_callback((tests, harnessStatus, asserts) => {
      const mappedTests = tests.map((test) => ({
        name: test.name,
        status: test.status,
        message: test.message,
        stack: test.stack,
      }));
      recorded.tests = applyHostExcludedTests(relativeName, mappedTests);
      recorded.status = harnessStatus;
      recorded.asserts = asserts;
      completion = { timedOut: false };
      if (typeof resolveCompletion === 'function') {
        resolveCompletion(completion);
      }
    });

    const deadlineMs = Date.now() + timeoutMs;
    const preparedTestSource = prepareForGlobalEval(testSource);
    if (LOCATION_SHIM_FILES.has(relativeName)) {
      evalWithLocationShim(preparedTestSource);
    } else {
      (0, eval)(preparedTestSource);
    }

    await Promise.race([
      completionPromise,
      new Promise((resolveTimeout) => {
        setTimeout(() => {
          if (completion === null) {
            completion = { timedOut: true };
          }
          resolveTimeout(null);
        }, timeoutMs);
      }),
    ]);

    if (completion === null || completion.timedOut === true || Date.now() > deadlineMs) {
      const lastCompleted = completedTestNames.length > 0 ? completedTestNames[completedTestNames.length - 1] : '<none>';
      const lastFailure = completedFailureMessages.length > 0
        ? completedFailureMessages[completedFailureMessages.length - 1]
        : '<none>';
      return {
        file: relativeName,
        error: `Timeout after ${String(timeoutMs)}ms (completed=${String(completedTestNames.length)} last=${lastCompleted} active=${activeTestName} lastFailure=${lastFailure})`,
        tests: [],
      };
    }

    return {
      file: relativeName,
      error: null,
      tests: recorded.tests,
    };
  } catch (error) {
    return {
      file: relativeName,
      error: error instanceof Error ? error.message : String(error),
      tests: [],
    };
  } finally {
    // no-op
  }
}

function buildSelectedFiles(requestedNames, options = {}) {
  const normalizedRequested = requestedNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const discovered = [];
  const pendingDirs = [FEATURE_DIR];
  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (typeof currentDir !== 'string') {
      continue;
    }

    const directory = DirAccess.open(currentDir);
    if (directory === null) {
      continue;
    }

    directory.include_hidden = true;
    directory.include_navigational = false;
    directory.list_dir_begin();

    while (true) {
      const entry = directory.get_next();
      if (entry.length === 0) {
        break;
      }
      const fullPath = `${currentDir}/${entry}`;
      if (directory.current_is_dir()) {
        pendingDirs.push(fullPath);
        continue;
      }
      if (!entry.endsWith('.any.js')) {
        continue;
      }
      if (EXCLUDED_WPT_FILES.has(entry)) {
        continue;
      }
      discovered.push(fullPath);
    }

    directory.list_dir_end();
  }

  discovered.sort((left, right) => left.localeCompare(right));
  const hostInapplicable = OS.has_feature('web') ? [] : HOST_EXCLUDED_WPT_PREFIXES;
  const isHostInapplicablePath = (path) => hostInapplicable.some((prefix) => path.includes(`${WPT_ROOT}/${prefix}`));
  const isHostInapplicableFile = (path) => !OS.has_feature('web') && (
    HOST_EXCLUDED_WPT_FILES.has(basename(path))
    || basename(path).endsWith('.h2.any.js')
  );
  const filteredDiscovered = discovered.filter((path) => {
    if (isHostInapplicablePath(path) || isHostInapplicableFile(path)) {
      return false;
    }
    return true;
  });
  if (normalizedRequested.length === 0) {
    return filteredDiscovered;
  }

  const selected = [];
  for (const requested of normalizedRequested) {
    if (EXCLUDED_WPT_FILES.has(basename(requested))) {
      continue;
    }
    const normalized = requested.includes('/') ? requested : `${FEATURE}/${requested}`;
    const match = filteredDiscovered.find((path) => path.endsWith(`/${requested}`) || path.endsWith(normalized));
    if (match) {
      selected.push(match);
    }
  }
  return selected;
}

function summarize(fileResults) {
  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (const fileResult of fileResults) {
    if (fileResult.error) {
      errors += 1;
      continue;
    }

    for (const test of fileResult.tests) {
      if (test.status === 0) {
        passed += 1;
      } else if (test.status !== 3) {
        failed += 1;
      }
    }
  }

  return {
    passed,
    failed,
    errors,
    total: passed + failed,
  };
}

async function runWptSuite(options = {}) {
  const fetchMode = options.fetchMode === 'fast' ? 'fast' : 'conformant';
  const fetchImplementation = options.fetchImplementation === 'browser' ? 'browser' : 'polyfill';
  setConformanceMode(fetchMode);

  const args = {
    files: Array.isArray(options.files) ? options.files : [],
    debug: options.debug === true,
    fetchMode,
    host: typeof options.host === 'string' && options.host.length > 0 ? options.host : 'web-platform.test',
    domainWww: typeof options.domainWww === 'string' && options.domainWww.length > 0 ? options.domainWww : 'www.web-platform.test',
    domainWww2: typeof options.domainWww2 === 'string' && options.domainWww2.length > 0 ? options.domainWww2 : 'www2.web-platform.test',
    httpPort0: Number.isFinite(options.httpPort0) ? options.httpPort0 : 8000,
    httpPort1: Number.isFinite(options.httpPort1) ? options.httpPort1 : 8001,
    httpsPort0: Number.isFinite(options.httpsPort0) ? options.httpsPort0 : 8443,
    httpsPort1: Number.isFinite(options.httpsPort1) ? options.httpsPort1 : 8444,
    h2Port0: Number.isFinite(options.h2Port0) ? options.h2Port0 : 9100,
    timeoutMs: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30_000,
    fetchImplementation,
  };
  const files = buildSelectedFiles(args.files, {
    fetchImplementation: args.fetchImplementation,
  });

  if (files.length === 0) {
    throw new Error('no .any.js files selected');
  }

  const fileResults = [];

  for (const testFilePath of files) {
    const result = await runSingleTest(testFilePath, {
      baseTimeoutMs: args.timeoutMs,
      debug: args.debug,
      templateConfig: {
        host: args.host,
        domainWww: args.domainWww,
        domainWww2: args.domainWww2,
        httpPort0: args.httpPort0,
        httpPort1: args.httpPort1,
        httpsPort0: args.httpsPort0,
        httpsPort1: args.httpsPort1,
        h2Port0: args.h2Port0,
      },
    });
    fileResults.push(result);

    if (result.error) {
      console.log(`[WPT][file] ${result.file} ERROR ${result.error}`);
      continue;
    }

    const filePasses = result.tests.filter((test) => test.status === 0).length;
    const fileFailures = result.tests.filter((test) => test.status !== 0 && test.status !== 3).length;
    console.log(`[WPT][file] ${result.file} ${String(filePasses)}/${String(filePasses + fileFailures)} passed`);

    if (args.debug && fileFailures > 0) {
      for (const failedTest of result.tests.filter((test) => test.status !== 0 && test.status !== 3)) {
        console.log(`[WPT][fail] ${result.file} :: ${failedTest.name} :: ${failedTest.message ?? ''}`);
      }
    }
  }

  return {
    feature: FEATURE,
    fetchImplementation: args.fetchImplementation,
    filesRan: fileResults.length,
    filesTotal: files.length,
    files: fileResults,
    ...summarize(fileResults),
  };
}

class FetchWptRunner extends SceneTree {
  async _initialize() {
    try {
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
        fetchImplementation: args.fetchImplementation,
      });
      console.log(`[WPT_GODOT_JSON]${JSON.stringify(summary)}`);
      this.quit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[WPT] ${message}`);
      this.quit(1);
    }
  }
}

export default FetchWptRunner;
export { parseArgs, runWptSuite };
