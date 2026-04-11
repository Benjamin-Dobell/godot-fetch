import {
  Engine,
  HTTPClient,
  OS,
  PackedByteArray,
  PackedStringArray,
  ProjectSettings,
  StreamPeerTCP as GodotStreamPeerTCP,
  StreamPeerTLS as GodotStreamPeerTLS,
  String as GodotString,
  TLSOptions as GodotTLSOptions,
  X509Certificate,
  is_instance_valid,
} from 'godot.lib.api';
import { unpackStringArray } from './utils/godot';
import { CancellablePromise, toCancellable, waitForTimeout } from './utils/promise';
import { getRequestCookies, handleCookies } from './cookies/handling';
import { ReadableStream } from './standards/stream';

export type HttpHeaders = Record<string, string | string[]>;

export type HttpResponse<B> = {
  statusCode: number;
  headers: HttpHeaders;
  body: B;
  bodyError?: Error;
};

type HttpResponseBody = PackedByteArray | ReadableStream;

type HttpClientRequestOptions = {
  allowRawFallback?: boolean;
  allowUnknownLengthRawStreamFallback?: boolean;
  streamResponse?: boolean;
};

type HttpClientSlot = {
  id: number;
  client: HTTPClient;
  connectedOrigin: null | string;
  inUse: boolean;
  lastPolledProcessFrame: number;
  sameFrameSkips: number;
};

type PendingRequest = {
  cancel: () => void;
  isCancelled: () => boolean;
  origin: string;
  run: (slot: HttpClientSlot) => Promise<void>;
  skipCount: number;
};

const HttpClientPoolSize = 4;
const HttpClientHostLookahead = 4;
const HttpClientMaxSkipCount = 3;
const HttpConnectTimeoutMs = 30_000;
const HttpRequestTimeoutMs = 120_000;
const RawHttpHeaderTimeoutMs = HttpRequestTimeoutMs;
const InitialPolledProcessFrame = -1;
const SameFramePollThreshold = 8;
const GodotErrorOk = 0; // GError.OK
const GodotErrorFileCorrupt = 27; // GError.ERR_FILE_CORRUPT
const StreamPeerSocketStatusConnecting = 1;
const StreamPeerSocketStatusConnected = 2;
const StreamPeerTlsStatusHandshaking = 1;
const StreamPeerTlsStatusConnected = 2;
const InsecureTlsEnv = 'GODOT_FETCH_TLS_UNSAFE';
const TrustedTlsCertPathEnv = 'GODOT_FETCH_TLS_CA_CERT_PATH';
const DebugHttpClientEnv = 'GODOT_FETCH_DEBUG_HTTP_CLIENT';

type HttpMethod = HTTPClient.Method | string;

const MethodStringMap: Partial<Record<HTTPClient.Method, string>> = {
  [HTTPClient.Method.METHOD_GET]: 'GET',
  [HTTPClient.Method.METHOD_HEAD]: 'HEAD',
  [HTTPClient.Method.METHOD_POST]: 'POST',
  [HTTPClient.Method.METHOD_PUT]: 'PUT',
  [HTTPClient.Method.METHOD_DELETE]: 'DELETE',
  [HTTPClient.Method.METHOD_OPTIONS]: 'OPTIONS',
  [HTTPClient.Method.METHOD_TRACE]: 'TRACE',
  [HTTPClient.Method.METHOD_CONNECT]: 'CONNECT',
  [HTTPClient.Method.METHOD_PATCH]: 'PATCH',
};

const MethodEnumMap: Record<string, HTTPClient.Method> = {
  CONNECT: HTTPClient.Method.METHOD_CONNECT,
  DELETE: HTTPClient.Method.METHOD_DELETE,
  GET: HTTPClient.Method.METHOD_GET,
  HEAD: HTTPClient.Method.METHOD_HEAD,
  OPTIONS: HTTPClient.Method.METHOD_OPTIONS,
  PATCH: HTTPClient.Method.METHOD_PATCH,
  POST: HTTPClient.Method.METHOD_POST,
  PUT: HTTPClient.Method.METHOD_PUT,
  TRACE: HTTPClient.Method.METHOD_TRACE,
};

function getMethodName(method: HttpMethod): string {
  if (typeof method === 'string') {
    return method.toUpperCase();
  }
  return MethodStringMap[method] ?? '<UNKNOWN METHOD>';
}

function getMethodEnum(method: HttpMethod): null | HTTPClient.Method {
  if (typeof method === 'string') {
    return MethodEnumMap[method.toUpperCase()] ?? null;
  }
  return method;
}

const pendingRequests: PendingRequest[] = [];
const httpClientPool: HttpClientSlot[] = [];

const cookieRegex = /^(https?):\/\/([^:/]+)(?::\d+)?([^?#]+)/i;
const urlRegex = /^(https?):\/\/([^:/?#]+)(?::(\d+))?([^?#]*)(\?[^#]*)?/i;
const headerRegex = /([^:]+)\s*:\s*(.*)/;

type TlsOptionsLike = Exclude<Parameters<HTTPClient['connect_to_host']>[2], undefined>;
type HttpClientSnapshotView = HTTPClient & {
  constructor?: { name?: string };
};

let cachedUnsafeTlsOptions: null | TlsOptionsLike = null;
let cachedTrustedTlsOptions: null | TlsOptionsLike = null;
let cachedDefaultTlsOptions: null | TlsOptionsLike = null;
let nextHttpClientSlotId = 1;
const importedIsInstanceValidType = typeof is_instance_valid;

const debugHttpClient = OS.has_environment(DebugHttpClientEnv)
  && OS.get_environment(DebugHttpClientEnv) === '1';

type ParsedUrl = {
  host: string;
  origin: string;
  pathWithQuery: string;
  port: number;
  scheme: 'http' | 'https';
  url: string;
};

type ByteView = Uint8Array<ArrayBufferLike>;

type HeaderBoundary = {
  headerEnd: number;
  terminatorLength: number;
};

type StreamPeerReadResult = {
  get: (index: number) => unknown;
};

type StreamPeerTCP = {
  connect_to_host: (host: string, port: number) => number;
  disconnect_from_host: () => void;
  get_available_bytes: () => number;
  get_partial_data: (bytes: number) => StreamPeerReadResult;
  get_status: () => number;
  poll: () => number;
  put_data: (data: PackedByteArray) => number;
};

type StreamPeerTLS = {
  connect_to_stream: (
    stream: StreamPeerTCP,
    commonName: string,
    clientOptions?: unknown,
  ) => number;
  disconnect_from_stream: () => void;
  get_available_bytes: () => number;
  get_partial_data: (bytes: number) => StreamPeerReadResult;
  get_status: () => number;
  poll: () => void;
  put_data: (data: PackedByteArray) => number;
};

type TLSOptionsApi = {
  client: (trustedChain?: X509Certificate) => null | unknown;
  client_unsafe: (trustedChain?: X509Certificate) => null | unknown;
};

const StreamPeerTCP = GodotStreamPeerTCP as unknown as new () => StreamPeerTCP;
const StreamPeerTLS = GodotStreamPeerTLS as unknown as new () => StreamPeerTLS;
const TLSOptions = GodotTLSOptions as unknown as TLSOptionsApi;

const httpProxyHost = OS.has_environment('BREAKA_HTTP_PROXY_HOST')
  ? OS.get_environment('BREAKA_HTTP_PROXY_HOST')
  : (() => {
    try {
      if (!ProjectSettings.has_setting('network/http_proxy/host')) {
        return '';
      }
      const value = ProjectSettings.get_setting_with_override('network/http_proxy/host');
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  })();
const httpProxyPort = OS.has_environment('BREAKA_HTTP_PROXY_PORT')
  ? Number.parseInt(OS.get_environment('BREAKA_HTTP_PROXY_PORT'), 10)
  : (() => {
    try {
      if (!ProjectSettings.has_setting('network/http_proxy/port')) {
        return Number.NaN;
      }
      const value = ProjectSettings.get_setting_with_override('network/http_proxy/port');
      if (typeof value === 'number') return value;
      if (typeof value === 'string') return Number.parseInt(value, 10);
      return Number.NaN;
    } catch {
      return Number.NaN;
    }
  })();

function parseHeaders(headers: PackedStringArray | string[]): HttpHeaders {
  const unpacked = Array.isArray(headers) ? headers : unpackStringArray(headers);
  const parsed: HttpHeaders = {};

  for (const header of unpacked) {
    const [, encodedKey, encodedValue] = header.match(headerRegex) ?? [];

    if (typeof encodedValue === 'undefined') {
      throw new Error(`Received invalid header value: ${header}`);
    }

    const key = decodeURIComponent(encodedKey!).toLowerCase();
    const value = decodeURIComponent(encodedValue);
    appendHeaderValue(parsed, key, value);
  }

  return parsed;
}

function appendHeaderValue(headers: HttpHeaders, key: string, value: string): void {
  const existing = headers[key];
  if (typeof existing === 'undefined') {
    headers[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  headers[key] = [existing, value];
}

function toPackedBody(body: null | string | ArrayBuffer | PackedByteArray): PackedByteArray {
  if (body === null) {
    return new PackedByteArray();
  }
  if (typeof body === 'string') {
    return GodotString.to_utf8_buffer(body);
  }
  if (body instanceof ArrayBuffer) {
    return new PackedByteArray(body);
  }
  return body;
}

function shouldResponseHaveBody(methodName: string, statusCode: number): boolean {
  if (methodName === 'HEAD') {
    return false;
  }
  if (statusCode >= 100 && statusCode < 200) {
    return false;
  }
  return statusCode !== 204 && statusCode !== 205 && statusCode !== 304;
}

function parseRawHttpHeaders(headerText: string): { headers: HttpHeaders; statusCode: number } {
  const lines = headerText.split(/\r?\n/);
  const statusLine = lines.shift() ?? '';
  const match = statusLine.match(/^HTTP\/\d+\.\d+\s+(\d{3})(?:\s+.*)?$/i);
  if (!match) {
    throw new HttpInternalError(`Invalid HTTP status line in raw fallback: ${statusLine}`);
  }

  const statusCode = Number.parseInt(match[1]!, 10);
  const headers: HttpHeaders = {};

  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).replace(/^[ \t]*/, '').replace(/[ \t]*$/, '');
    appendHeaderValue(headers, key, value);
  }

  return { headers, statusCode };
}

function appendBytes(existing: ByteView, chunk: ByteView): ByteView {
  if (chunk.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return chunk;
  }
  const merged = new Uint8Array(existing.length + chunk.length);
  merged.set(existing, 0);
  merged.set(chunk, existing.length);
  return merged;
}

function toPackedByteArrayFromBytes(bytes: ByteView): PackedByteArray {
  if (bytes.length === 0) {
    return new PackedByteArray();
  }
  const copied = new Uint8Array(bytes);
  return new PackedByteArray(copied.buffer);
}

function bytesToUtf8String(bytes: ByteView): string {
  if (bytes.length === 0) {
    return '';
  }
  return toPackedByteArrayFromBytes(bytes).get_string_from_utf8();
}

function findHeaderBoundary(responseBytes: ByteView): null | HeaderBoundary {
  for (let i = 0; i < responseBytes.length - 1; i++) {
    if (responseBytes[i] === 10 && responseBytes[i + 1] === 10) {
      return {
        headerEnd: i,
        terminatorLength: 2,
      };
    }
    if (i < responseBytes.length - 3
      && responseBytes[i] === 13
      && responseBytes[i + 1] === 10
      && responseBytes[i + 2] === 13
      && responseBytes[i + 3] === 10) {
      return {
        headerEnd: i,
        terminatorLength: 4,
      };
    }
  }
  return null;
}

function findCrlf(bytes: ByteView, start: number): number {
  for (let i = start; i < bytes.length - 1; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) {
      return i;
    }
  }
  return -1;
}

class IncompleteChunkedBodyError extends Error {
  constructor() {
    super('Raw HTTP fallback chunk parse incomplete');
  }
}

function decodeChunkedHttpBodyBytes(bodyBytes: ByteView): ByteView {
  let cursor = 0;
  const chunks: ByteView[] = [];
  let totalLength = 0;

  while (true) {
    const sizeLineEnd = findCrlf(bodyBytes, cursor);
    if (sizeLineEnd < 0) {
      throw new IncompleteChunkedBodyError();
    }

    const rawSizeLine = bytesToUtf8String(bodyBytes.subarray(cursor, sizeLineEnd));
    const rawSize = rawSizeLine.split(';')[0]?.trim() ?? '';
    const chunkSize = Number.parseInt(rawSize, 16);
    if (!Number.isFinite(chunkSize) || chunkSize < 0) {
      throw new HttpInternalError(`Raw HTTP fallback chunk parse failed: invalid size "${rawSize}"`);
    }

    cursor = sizeLineEnd + 2;
    if (chunkSize === 0) {
      while (true) {
        const trailerLineEnd = findCrlf(bodyBytes, cursor);
        if (trailerLineEnd < 0) {
          throw new IncompleteChunkedBodyError();
        }
        if (trailerLineEnd === cursor) {
          const decoded: ByteView = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            decoded.set(chunk, offset);
            offset += chunk.length;
          }
          return decoded;
        }
        cursor = trailerLineEnd + 2;
      }
    }

    const chunkEnd = cursor + chunkSize;
    if (chunkEnd + 2 > bodyBytes.length) {
      throw new IncompleteChunkedBodyError();
    }

    if (bodyBytes[chunkEnd] !== 13 || bodyBytes[chunkEnd + 1] !== 10) {
      throw new HttpInternalError('Raw HTTP fallback chunk parse failed: missing chunk terminator');
    }

    const chunk = bodyBytes.slice(cursor, chunkEnd);
    chunks.push(chunk);
    totalLength += chunk.length;
    cursor = chunkEnd + 2;
  }
}

function buildRawRequest(
  methodName: string,
  parsedUrl: ParsedUrl,
  headers: string[],
  body: PackedByteArray,
): PackedByteArray {
  const headerLines = headers.slice();
  const hasHost = headerLines.some(line => line.toLowerCase().startsWith('host:'));
  if (!hasHost) {
    const defaultPort = parsedUrl.scheme === 'https' ? 443 : 80;
    const hostHeader = parsedUrl.port === defaultPort
      ? parsedUrl.host
      : `${parsedUrl.host}:${String(parsedUrl.port)}`;
    headerLines.push(`Host: ${hostHeader}`);
  }
  if (!headerLines.some(line => line.toLowerCase().startsWith('connection:'))) {
    headerLines.push('Connection: close');
  }
  if (body.size() > 0 && !headerLines.some(line => line.toLowerCase().startsWith('content-length:'))) {
    headerLines.push(`Content-Length: ${String(body.size())}`);
  }

  const prelude = `${methodName} ${parsedUrl.pathWithQuery} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`;
  const preludeBytes = GodotString.to_utf8_buffer(prelude);
  if (body.size() === 0) {
    return preludeBytes;
  }

  const requestBytes = new PackedByteArray();
  requestBytes.append_array(preludeBytes);
  requestBytes.append_array(body);
  return requestBytes;
}

function isRawFallbackEligible(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes(`Godot error: ${GodotErrorFileCorrupt}`)
    && error.message.includes('has_response=false');
}

function isRecoverableWebPollDisconnectError(slot: HttpClientSlot, error: unknown): boolean {
  void slot;
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  if (!message.includes(`Godot error: ${GodotErrorFileCorrupt}`)) {
    return false;
  }
  if (!message.includes('has_response=false')) {
    return false;
  }
  const responseCodeMatch = message.match(/response_code=(\d+)/);
  if (responseCodeMatch === null) {
    return false;
  }
  const responseCode = Number.parseInt(responseCodeMatch[1] ?? '', 10);
  return Number.isFinite(responseCode) && responseCode > 0;
}

async function runRawHttpFallbackRequest(
  methodName: string,
  url: string,
  body: null | string | ArrayBuffer | PackedByteArray,
  headers: string[],
  cancelled: () => boolean,
): Promise<HttpResponse<PackedByteArray>> {
  const parsedUrl = parseRequestUrl(url);
  const tcp = new StreamPeerTCP();
  const connectError = tcp.connect_to_host(parsedUrl.host, parsedUrl.port);
  if (connectError !== GodotErrorOk) {
    throw new HttpInternalError(`Raw HTTP fallback connect failed with Godot error: ${connectError}`);
  }

  const connectStartMs = Date.now();
  while (tcp.get_status() === StreamPeerSocketStatusConnecting) {
    if (cancelled()) {
      tcp.disconnect_from_host();
      throw new HttpAbortError();
    }
    const pollError = tcp.poll();
    if (pollError !== GodotErrorOk) {
      throw new HttpInternalError(`Raw HTTP fallback poll failed with Godot error: ${pollError}`);
    }
    if (Date.now() - connectStartMs > HttpConnectTimeoutMs) {
      throw new HttpInternalError(`Raw HTTP fallback connect timed out after ${HttpConnectTimeoutMs}ms for ${url}`);
    }
    await yieldHttpClientTick();
  }

  if (tcp.get_status() !== StreamPeerSocketStatusConnected) {
    throw new HttpInternalError(`Raw HTTP fallback socket did not connect for ${url} (status=${tcp.get_status()})`);
  }

  let peer: StreamPeerTCP | StreamPeerTLS = tcp;
  if (parsedUrl.scheme === 'https') {
    const tls = new StreamPeerTLS();
    const tlsOptions = getTlsOptionsForUrl(parsedUrl);
    const tlsError = typeof tlsOptions === 'undefined'
      ? tls.connect_to_stream(tcp, parsedUrl.host)
      : tls.connect_to_stream(tcp, parsedUrl.host, tlsOptions);
    if (tlsError !== GodotErrorOk) {
      throw new HttpInternalError(`Raw HTTPS fallback TLS handshake failed with Godot error: ${tlsError}`);
    }

    const tlsStartMs = Date.now();
    while (tls.get_status() === StreamPeerTlsStatusHandshaking) {
      if (cancelled()) {
        tls.disconnect_from_stream();
        tcp.disconnect_from_host();
        throw new HttpAbortError();
      }
      tls.poll();
      if (Date.now() - tlsStartMs > HttpConnectTimeoutMs) {
        throw new HttpInternalError(`Raw HTTPS fallback handshake timed out after ${HttpConnectTimeoutMs}ms for ${url}`);
      }
      await yieldHttpClientTick();
    }

    if (tls.get_status() !== StreamPeerTlsStatusConnected) {
      throw new HttpInternalError(`Raw HTTPS fallback socket did not connect for ${url} (status=${tls.get_status()})`);
    }
    peer = tls;
  }

  const rawBody = toPackedBody(body);
  const requestBytes = buildRawRequest(methodName, parsedUrl, headers, rawBody);
  const writeError = peer.put_data(requestBytes);
  if (writeError !== GodotErrorOk) {
    throw new HttpInternalError(`Raw HTTP fallback write failed with Godot error: ${writeError}`);
  }

  let responseBytes: ByteView = new Uint8Array(0);
  const readStartMs = Date.now();
  let finalStatus = -1;
  let parsedHeaders: null | HttpHeaders = null;
  let parsedStatusCode = -1;
  let headerBodyOffset = -1;

  const shouldExpectBody = methodName !== 'HEAD';

  while (true) {
    if (cancelled()) {
      if (peer instanceof StreamPeerTLS) {
        peer.disconnect_from_stream();
      }
      tcp.disconnect_from_host();
      throw new HttpAbortError();
    }

    if (peer instanceof StreamPeerTLS) {
      peer.poll();
    } else {
      const pollError = peer.poll();
      if (pollError !== GodotErrorOk) {
        throw new HttpInternalError(`Raw HTTP fallback read poll failed with Godot error: ${pollError}`);
      }
    }

    const available = peer.get_available_bytes();
    if (available > 0) {
      const result = peer.get_partial_data(available) as StreamPeerReadResult;
      const readError = result.get(0);
      if (typeof readError !== 'number' || readError !== GodotErrorOk) {
        throw new HttpInternalError(`Raw HTTP fallback read failed with Godot error: ${String(readError)}`);
      }
      const readChunk = result.get(1);
      if (!(readChunk instanceof PackedByteArray)) {
        throw new HttpInternalError('Raw HTTP fallback read returned invalid data payload');
      }
      const readChunkBytes = new Uint8Array(readChunk.size());
      readChunkBytes.set(new Uint8Array(readChunk.to_array_buffer()));
      responseBytes = appendBytes(responseBytes, readChunkBytes);
    }

    if (parsedHeaders === null) {
      const boundary = findHeaderBoundary(responseBytes);
      if (boundary !== null) {
        const headerText = bytesToUtf8String(responseBytes.subarray(0, boundary.headerEnd));
        const parsed = parseRawHttpHeaders(headerText);
        parsedHeaders = parsed.headers;
        parsedStatusCode = parsed.statusCode;
        headerBodyOffset = boundary.headerEnd + boundary.terminatorLength;
      }
    }

    if (parsedHeaders !== null) {
      if (!shouldExpectBody || parsedStatusCode === 204 || parsedStatusCode === 304 || (parsedStatusCode >= 100 && parsedStatusCode < 200)) {
        return {
          statusCode: parsedStatusCode,
          headers: parsedHeaders,
          body: new PackedByteArray(),
        };
      }

      const bodyBytes = responseBytes.subarray(headerBodyOffset);
      const contentLengthHeader = getHeaderValue(parsedHeaders, 'content-length');
      const transferEncoding = getHeaderValue(parsedHeaders, 'transfer-encoding')?.toLowerCase() ?? '';

      if (transferEncoding.includes('chunked')) {
        try {
          const decodedBody = decodeChunkedHttpBodyBytes(bodyBytes);
          return {
            statusCode: parsedStatusCode,
            headers: parsedHeaders,
            body: toPackedByteArrayFromBytes(decodedBody),
          };
        } catch (error) {
          if (!(error instanceof IncompleteChunkedBodyError)) {
            throw error;
          }
          // Continue reading until a complete chunked body is available.
        }
      } else if (contentLengthHeader !== null) {
        const contentLength = Number.parseInt(contentLengthHeader, 10);
        if (Number.isFinite(contentLength) && contentLength >= 0 && bodyBytes.length >= contentLength) {
          return {
            statusCode: parsedStatusCode,
            headers: parsedHeaders,
            body: toPackedByteArrayFromBytes(bodyBytes.slice(0, contentLength)),
          };
        }
      }
    }

    const status = peer.get_status();
    finalStatus = status;
    if (status === 0) {
      if (parsedHeaders === null && responseBytes.length > 0) {
        const headerText = bytesToUtf8String(responseBytes);
        const parsed = parseRawHttpHeaders(headerText);
        parsedHeaders = parsed.headers;
        parsedStatusCode = parsed.statusCode;
        headerBodyOffset = responseBytes.length;
      }

      if (parsedHeaders !== null) {
        const bodyBytes = responseBytes.subarray(Math.max(0, headerBodyOffset));
        return {
          statusCode: parsedStatusCode,
          headers: parsedHeaders,
          body: toPackedByteArrayFromBytes(bodyBytes),
        };
      }
    }
    if ((peer instanceof StreamPeerTLS && status !== StreamPeerTlsStatusConnected && status !== StreamPeerTlsStatusHandshaking)
      || (!(peer instanceof StreamPeerTLS) && status !== StreamPeerSocketStatusConnected)) {
      break;
    }

    if (Date.now() - readStartMs > RawHttpHeaderTimeoutMs) {
      throw new HttpInternalError(`Raw HTTP fallback timed out waiting for response headers after ${RawHttpHeaderTimeoutMs}ms for ${url}`);
    }
    await yieldHttpClientTick();
  }

  throw new HttpInternalError(
    `Raw HTTP fallback ended before complete response was received for ${url} (status=${finalStatus}, bytes=${responseBytes.length})`,
  );
}

function parseRequestUrl(url: string): ParsedUrl {
  const match = url.match(urlRegex);

  if (!match) {
    throw new Error(`Invalid HTTP URL: ${url}`);
  }

  const [, rawScheme, rawHost, rawPort, rawPath, rawQuery] = match;

  if (!rawScheme || !rawHost) {
    throw new Error(`Invalid HTTP URL components: ${url}`);
  }

  const scheme = rawScheme.toLowerCase() === 'https' ? 'https' : 'http';
  const port = rawPort
    ? Number.parseInt(rawPort, 10)
    : (scheme === 'https' ? 443 : 80);
  const path = rawPath && rawPath.length > 0 ? rawPath : '/';
  const query = rawQuery ?? '';

  return {
    host: rawHost,
    origin: `${scheme}://${rawHost}:${port}`,
    pathWithQuery: `${path}${query}`,
    port,
    scheme,
    url,
  };
}

function isHttpClientStatusError(status: HTTPClient.Status): boolean {
  return status === HTTPClient.Status.STATUS_CANT_RESOLVE
    || status === HTTPClient.Status.STATUS_CANT_CONNECT
    || status === HTTPClient.Status.STATUS_CONNECTION_ERROR
    || status === HTTPClient.Status.STATUS_TLS_HANDSHAKE_ERROR;
}

function getUnsafeTlsOptions(): TlsOptionsLike {
  if (cachedUnsafeTlsOptions !== null) {
    return cachedUnsafeTlsOptions;
  }

  const created = TLSOptions.client_unsafe();
  if (created === null) {
    throw new Error('Failed to create unsafe TLS options');
  }

  cachedUnsafeTlsOptions = created as TlsOptionsLike;
  return cachedUnsafeTlsOptions;
}

function getTrustedTlsOptions(): null | TlsOptionsLike {
  if (cachedTrustedTlsOptions !== null) {
    return cachedTrustedTlsOptions;
  }

  if (!OS.has_environment(TrustedTlsCertPathEnv)) {
    return null;
  }

  const certPath = OS.get_environment(TrustedTlsCertPathEnv).trim();
  if (certPath.length === 0) {
    return null;
  }

  const certificate = new X509Certificate();
  const loadError = certificate.load(certPath);
  if (loadError !== GodotErrorOk) {
    throw new Error(`Failed to load TLS CA certificate at ${certPath} (error=${String(loadError)})`);
  }

  const created = TLSOptions.client(certificate);
  if (created === null) {
    throw new Error(`Failed to create trusted TLS options from ${certPath}`);
  }

  cachedTrustedTlsOptions = created as TlsOptionsLike;
  return cachedTrustedTlsOptions;
}

function getDefaultTlsOptions(): TlsOptionsLike {
  if (cachedDefaultTlsOptions !== null) {
    return cachedDefaultTlsOptions;
  }

  const created = TLSOptions.client();
  if (created === null) {
    throw new Error('Failed to create default TLS options');
  }

  cachedDefaultTlsOptions = created as TlsOptionsLike;
  return cachedDefaultTlsOptions;
}

function getTlsOptionsForUrl(parsedUrl: ParsedUrl): undefined | TlsOptionsLike {
  if (parsedUrl.scheme !== 'https') {
    return undefined;
  }

  const trusted = getTrustedTlsOptions();
  if (trusted !== null) {
    return trusted;
  }

  if (OS.has_environment(InsecureTlsEnv) && OS.get_environment(InsecureTlsEnv) === '1') {
    return getUnsafeTlsOptions();
  }

  return getDefaultTlsOptions();
}

function createHttpClient(): HTTPClient {
  const client = new HTTPClient();

  if (httpProxyHost.length > 0 && Number.isSafeInteger(httpProxyPort) && httpProxyPort > 0) {
    client.set_http_proxy(httpProxyHost, httpProxyPort);
    client.set_https_proxy(httpProxyHost, httpProxyPort);
  }

  return client;
}

function getClientSnapshot(slot: HttpClientSlot): string {
  const client: HttpClientSnapshotView = slot.client;
  const proto = client && typeof client === 'object' ? Object.getPrototypeOf(client) : null;
  const protoMethods = proto && typeof proto === 'object'
    ? Object.getOwnPropertyNames(proto).slice(0, 20).join(',')
    : '<no-proto>';
  const validResult = (() => {
    try {
      return `ok:type=${typeof is_instance_valid}:value=${String(is_instance_valid(slot.client))}`;
    } catch (error) {
      const detail = error instanceof Error
        ? `${error.name}:${error.message}`
        : String(error);
      return `throw:type=${typeof is_instance_valid}:${detail}`;
    }
  })();
  const hasClose = (() => {
    try {
      return String('close' in (client as object));
    } catch {
      return '<throw>';
    }
  })();
  const hasGetStatus = (() => {
    try {
      return String('get_status' in (client as object));
    } catch {
      return '<throw>';
    }
  })();
  const closeDescriptor = (() => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(client as object, 'close');
      return descriptor ? `own:${Object.keys(descriptor).join('|')}` : 'none';
    } catch {
      return '<throw>';
    }
  })();
  const getStatusDescriptor = (() => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(client as object, 'get_status');
      return descriptor ? `own:${Object.keys(descriptor).join('|')}` : 'none';
    } catch {
      return '<throw>';
    }
  })();
  const reflectCloseType = (() => {
    try {
      return typeof Reflect.get(client as object, 'close');
    } catch {
      return '<throw>';
    }
  })();
  const reflectGetStatusType = (() => {
    try {
      return typeof Reflect.get(client as object, 'get_status');
    } catch {
      return '<throw>';
    }
  })();
  return `slot=${slot.id} importType=${importedIsInstanceValidType} valid=${validResult} clientType=${client === null ? 'null' : typeof client} ctor=${typeof client?.constructor?.name === 'string' ? client.constructor.name : '<unknown>'} closeType=${typeof client?.close} getStatusType=${typeof client?.get_status} hasClose=${hasClose} hasGetStatus=${hasGetStatus} closeDesc=${closeDescriptor} getStatusDesc=${getStatusDescriptor} reflectCloseType=${reflectCloseType} reflectGetStatusType=${reflectGetStatusType} protoMethods=${protoMethods}`;
}

function logHttpClient(slot: HttpClientSlot, context: string): void {
  if (!debugHttpClient) {
    return;
  }
  console.log(`[HTTP_CLIENT_DEBUG] ${context} ${getClientSnapshot(slot)}`);
}

function closeSlotClientForContext(slot: HttpClientSlot, context: string): void {
  logHttpClient(slot, `${context}:before-close`);
  const closeFn = Reflect.get(slot.client as object, 'close');
  if (typeof closeFn !== 'function') {
    throw new HttpInternalError(`HTTP client close() not callable in ${context}; ${getClientSnapshot(slot)}`);
  }
  closeFn.call(slot.client);
  slot.connectedOrigin = null;
  slot.lastPolledProcessFrame = InitialPolledProcessFrame;
  logHttpClient(slot, `${context}:after-close`);
}

function createHttpClientSlot(): HttpClientSlot {
  const slotId = nextHttpClientSlotId;
  nextHttpClientSlotId += 1;
  const client = createHttpClient();
  const slot: HttpClientSlot = {
    id: slotId,
    client,
    connectedOrigin: null,
    inUse: false,
    lastPolledProcessFrame: InitialPolledProcessFrame,
    sameFrameSkips: 0,
  };
  logHttpClient(slot, 'slot-created');

  return {
    ...slot,
  };
}

function getFreeClientSlot(): null | HttpClientSlot {
  const free = httpClientPool.find(slot => !slot.inUse);

  if (free) {
    return free;
  }

  if (httpClientPool.length < HttpClientPoolSize) {
    const created = createHttpClientSlot();
    httpClientPool.push(created);
    return created;
  }

  return null;
}

function pollClientSlot(slot: HttpClientSlot): boolean {
  const currentProcessFrame = Engine.get_process_frames();

  if (slot.lastPolledProcessFrame === currentProcessFrame) {
    slot.sameFrameSkips += 1;
    if (slot.sameFrameSkips < SameFramePollThreshold) {
      return false;
    }
  }

  const error = slot.client.poll();
  slot.lastPolledProcessFrame = currentProcessFrame;
  slot.sameFrameSkips = 0;

  if (error !== GodotErrorOk) {
    const status = slot.client.get_status();
    const hasResponse = slot.client.has_response();
    const responseCode = slot.client.get_response_code();
    throw new HttpInternalError(
      `HTTP poll failed with Godot error: ${error} (status=${status}, has_response=${String(hasResponse)}, response_code=${responseCode})`,
    );
  }

  return true;
}

function yieldHttpClientTick(): Promise<void> {
  return waitForTimeout(0);
}

async function ensureClientConnected(slot: HttpClientSlot, parsedUrl: ParsedUrl, cancelled: () => boolean): Promise<void> {
  logHttpClient(slot, `ensureClientConnected:start origin=${parsedUrl.origin}`);
  if (slot.connectedOrigin === parsedUrl.origin && slot.client.get_status() === HTTPClient.Status.STATUS_CONNECTED) {
    logHttpClient(slot, `ensureClientConnected:already-connected origin=${parsedUrl.origin}`);
    return;
  }

  closeSlotClientForContext(slot, 'ensureClientConnected[reconnect]');

  const tlsOptions = getTlsOptionsForUrl(parsedUrl);
  const connectError = typeof tlsOptions === 'undefined'
    ? slot.client.connect_to_host(parsedUrl.host, parsedUrl.port)
    : slot.client.connect_to_host(parsedUrl.host, parsedUrl.port, tlsOptions);

  if (connectError !== GodotErrorOk) {
    throw new HttpInternalError(`HTTP connect failed with Godot error: ${connectError}`);
  }

  const startMs = Date.now();

  while (slot.client.get_status() !== HTTPClient.Status.STATUS_CONNECTED) {
    if (cancelled()) {
      closeSlotClientForContext(slot, 'ensureClientConnected[cancel]');
      throw new HttpAbortError();
    }

    let polled = false;

    try {
      polled = pollClientSlot(slot);
    } catch (error) {
      if (isRecoverableWebPollDisconnectError(slot, error)) {
        await yieldHttpClientTick();
        continue;
      }

      throw error;
    }

    if (!polled) {
      await yieldHttpClientTick();

      continue;
    }

    const status = slot.client.get_status();

    if (isHttpClientStatusError(status)) {
      throw new HttpInternalError(`HTTP connect failed for ${parsedUrl.url} (status=${status})`);
    }

    if (Date.now() - startMs > HttpConnectTimeoutMs) {
      throw new HttpInternalError(`HTTP connect timed out after ${HttpConnectTimeoutMs}ms for ${parsedUrl.url}`);
    }

    await yieldHttpClientTick();
  }

  slot.connectedOrigin = parsedUrl.origin;

  logHttpClient(slot, `ensureClientConnected:connected origin=${parsedUrl.origin}`);
}

type BodyReadResult = {
  body: PackedByteArray;
  error: null | Error;
};

function preloadAvailableBodyChunks(slot: HttpClientSlot): PackedByteArray {
  const preloaded = new PackedByteArray();

  while (true) {
    const chunk = slot.client.read_response_body_chunk();

    if (chunk.size() === 0) {
      break;

    }
    preloaded.append_array(chunk);
  }

  return preloaded;
}

function createHttpClientResponseStream(
  slot: HttpClientSlot,
  cancelled: () => boolean,
  url: string,
  initialBytes: Uint8Array,
): ReadableStream {
  let closed = false;
  let sawBody = false;
  let emittedBytes = initialBytes.byteLength;
  const expectedLength = slot.client.get_response_body_length();
  const preloadedBytes = initialBytes;

  const closeStreamClient = (context: string): void => {
    if (closed) {
      return;
    }

    closed = true;
    closeSlotClientForContext(slot, context);
  };

  return new ReadableStream({
    start(controller) {
      void (async () => {
        const pumpStartMs = Date.now();
        let lastProgressLogMs = pumpStartMs;

        if (preloadedBytes.byteLength > 0) {
          controller.enqueue(preloadedBytes);
          if (expectedLength >= 0 && emittedBytes >= expectedLength) {
            closeStreamClient('createHttpClientResponseStream[start-preloaded-content-length-complete]');
            controller.close();
            return;
          }
        }

        while (true) {
          if (closed) {
            controller.close();
            return;
          }

          if (cancelled()) {
            closeStreamClient('createHttpClientResponseStream[start-cancel]');
            controller.error(new HttpAbortError());
            return;
          }

          const statusBeforePoll = slot.client.get_status();

          if (statusBeforePoll === HTTPClient.Status.STATUS_DISCONNECTED) {
            closeStreamClient('createHttpClientResponseStream[start-complete-before-poll]');
            controller.close();
            return;
          }

          if (isHttpClientStatusError(statusBeforePoll)) {
            closeStreamClient('createHttpClientResponseStream[start-status-error-before-poll]');
            controller.error(new HttpInternalError(`HTTP body stream failed for ${url} (status=${statusBeforePoll})`));
            return;
          }

          try {
            const polled = pollClientSlot(slot);

            if (!polled) {
              await yieldHttpClientTick();

              continue;
            }

          } catch (error) {
            if (isRecoverableWebPollDisconnectError(slot, error)) {
              closeStreamClient('createHttpClientResponseStream[start-poll-recoverable-disconnect]');
              controller.close();
              return;
            }

            closeStreamClient('createHttpClientResponseStream[start-poll-error]');

            controller.error(error instanceof Error
              ? error
              : new HttpInternalError(`HTTP body stream poll failed for ${url}`, error));

            return;
          }

          if (Date.now() - pumpStartMs > HttpRequestTimeoutMs) {
            closeStreamClient('createHttpClientResponseStream[start-timeout]');
            controller.error(new HttpInternalError(`HTTP body stream timed out after ${HttpRequestTimeoutMs}ms for ${url}`));
            return;
          }

          const status = slot.client.get_status();
          const hasResponse = slot.client.has_response();

          if (debugHttpClient && Date.now() - lastProgressLogMs >= 1000) {
            lastProgressLogMs = Date.now();
            console.log(
              `[HTTP_CLIENT_DEBUG] createHttpClientResponseStream:start url=${url} elapsed_ms=${String(lastProgressLogMs - pumpStartMs)} status=${String(status)} has_response=${String(hasResponse)} saw_body=${String(sawBody)} emitted=${String(emittedBytes)} expected=${String(expectedLength)}`,
            );
          }

          if (status === HTTPClient.Status.STATUS_BODY) {
            sawBody = true;

            const chunk = slot.client.read_response_body_chunk();

            if (chunk.size() > 0) {
              const bytes = new Uint8Array(chunk.to_array_buffer());
              emittedBytes += bytes.byteLength;
              controller.enqueue(bytes);

              if (expectedLength >= 0 && emittedBytes >= expectedLength) {
                closeStreamClient('createHttpClientResponseStream[start-content-length-complete]');
                controller.close();
                return;
              }
            } else {
              const statusAfterRead = slot.client.get_status();

              if (statusAfterRead === HTTPClient.Status.STATUS_DISCONNECTED) {
                closeStreamClient('createHttpClientResponseStream[start-body-finished]');
                controller.close();
                return;
              }
            }
          } else if (isHttpClientStatusError(status)) {
            closeStreamClient('createHttpClientResponseStream[start-status-error]');
            controller.error(new HttpInternalError(`HTTP body stream failed for ${url} (status=${status})`));
            return;
          } else if (status === HTTPClient.Status.STATUS_DISCONNECTED || !hasResponse) {
            closeStreamClient('createHttpClientResponseStream[start-complete]');
            controller.close();
            return;
          }

          await yieldHttpClientTick();
        }
      })();
    },
    cancel() {
      closeStreamClient('createHttpClientResponseStream[cancel]');
    },
  });
}

function createBufferedReadableStream(bytes: Uint8Array): ReadableStream {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) {
        controller.enqueue(bytes);
      }

      controller.close();
    },
  });
}

async function readResponseBody(
  slot: HttpClientSlot,
  cancelled: () => boolean,
  url: string,
  initialBody?: PackedByteArray,
): Promise<BodyReadResult> {
  const output = initialBody ?? new PackedByteArray();
  const startMs = Date.now();
  let bodyError: null | Error = null;

  while (true) {
    if (cancelled()) {
      closeSlotClientForContext(slot, 'readResponseBody[cancel]');
      throw new HttpAbortError();
    }

    const status = slot.client.get_status();
    if (status === HTTPClient.Status.STATUS_BODY) {
      const chunk = slot.client.read_response_body_chunk();
      if (chunk.size() > 0) {
        output.append_array(chunk);
        continue;
      }

      const statusAfterRead = slot.client.get_status();

      if (statusAfterRead === HTTPClient.Status.STATUS_DISCONNECTED) {
        break;
      }

      if (isHttpClientStatusError(statusAfterRead)) {
        bodyError = new HttpInternalError(`HTTP body read failed for ${url} (status=${statusAfterRead})`);
        break;
      }

      try {
        const polled = pollClientSlot(slot);

        if (!polled) {
          await yieldHttpClientTick();
          continue;
        }
      } catch (error) {
        if (isRecoverableWebPollDisconnectError(slot, error)) {
          break;
        }

        bodyError = error instanceof Error
          ? error
          : new HttpInternalError(`HTTP body read failed for ${url}`, error);

        break;
      }

      if (Date.now() - startMs > HttpRequestTimeoutMs) {
        bodyError = new HttpInternalError(`HTTP body read timed out after ${HttpRequestTimeoutMs}ms for ${url}`);
        break;
      }

      await yieldHttpClientTick();

      continue;
    }

    if (status === HTTPClient.Status.STATUS_DISCONNECTED) {
      break;
    }

    if (isHttpClientStatusError(status)) {
      bodyError = new HttpInternalError(`HTTP body read failed for ${url} (status=${status})`);
      break;
    }

    try {
      const polled = pollClientSlot(slot);

      if (!polled) {
        await yieldHttpClientTick();
        continue;
      }

    } catch (error) {
      if (isRecoverableWebPollDisconnectError(slot, error)) {
        break;
      }

      bodyError = error instanceof Error
        ? error
        : new HttpInternalError(`HTTP body read failed for ${url}`, error);

      break;
    }

    if (Date.now() - startMs > HttpRequestTimeoutMs) {
      bodyError = new HttpInternalError(`HTTP body read timed out after ${HttpRequestTimeoutMs}ms for ${url}`);
      break;
    }

    await yieldHttpClientTick();
  }

  return {
    body: output,
    error: bodyError,
  };
}

async function runHttpClientRequest(
  slot: HttpClientSlot,
  method: HttpMethod,
  url: string,
  body: null | string | ArrayBuffer | PackedByteArray,
  headers: string[],
  cancelled: () => boolean,
  options: HttpClientRequestOptions = {},
): Promise<HttpResponse<HttpResponseBody>> {
  const methodName = getMethodName(method);
  const methodEnum = getMethodEnum(method);
  const isWebRuntime = OS.has_feature('web');
  const allowRawFallback = options.allowRawFallback !== false;
  const canUseRawFallback = allowRawFallback && !isWebRuntime;
  const allowUnknownLengthRawStreamFallback = options.allowUnknownLengthRawStreamFallback === true;
  const streamResponse = options.streamResponse === true;
  const requestBytes = toPackedBody(body);
  const hasContentLength = headers.some(header => header.toLowerCase().startsWith('content-length:'));
  const requestHeaders = !hasContentLength && requestBytes.size() > 0
    ? [...headers, `Content-Length: ${String(requestBytes.size())}`]
    : headers;
  const shouldUseRawFallback = canUseRawFallback && (
    requestBytes.size() > 0
    || methodEnum === null
    || methodName === 'GET'
    || methodName === 'HEAD'
  );

  if (shouldUseRawFallback) {
    const response = await runRawHttpFallbackRequest(methodName, url, body, requestHeaders, cancelled);

    if (Math.floor(response.statusCode / 100) !== 2) {
      throw new HttpResponseError(method, url, response);
    }

    return response;
  }

  const parsedUrl = parseRequestUrl(url);

  await ensureClientConnected(slot, parsedUrl, cancelled);

  logHttpClient(slot, `runHttpClientRequest:request_raw method=${methodName} url=${url}`);

  if (methodEnum === null) {
    throw new HttpInternalError(`HTTP ${methodName} ${url} request failed: unsupported method enum`);
  }

  const requestPayload = requestBytes.to_array_buffer();
  const requestError = slot.client.request_raw(methodEnum, parsedUrl.pathWithQuery, requestHeaders, requestPayload);

  if (requestError !== GodotErrorOk) {
    throw new HttpInternalError(`HTTP ${methodName} ${url} request failed due to Godot error: ${requestError}`);
  }

  const startMs = Date.now();
  let lastProgressLogMs = startMs;

  while (!slot.client.has_response()) {
    if (cancelled()) {
      closeSlotClientForContext(slot, 'runHttpClientRequest[cancel]');

      throw new HttpAbortError();
    }

    let polled = false;

    try {
      polled = pollClientSlot(slot);
    } catch (error) {
      if (canUseRawFallback && isRawFallbackEligible(error)) {
        closeSlotClientForContext(slot, 'runHttpClientRequest[raw-fallback]');

        return await runRawHttpFallbackRequest(methodName, url, body, headers, cancelled);
      }

      if (isRecoverableWebPollDisconnectError(slot, error)) {
        break;
      }

      throw error;
    }

    if (!polled) {
      await yieldHttpClientTick();

      continue;
    }

    const status = slot.client.get_status();

    if (isHttpClientStatusError(status)) {
      throw new HttpInternalError(`HTTP ${methodName} ${url} request failed with status: ${status}`);
    }

    if (Date.now() - startMs > HttpRequestTimeoutMs) {
      throw new HttpInternalError(`HTTP request timed out after ${HttpRequestTimeoutMs}ms for ${url}`);
    }

    if (debugHttpClient && Date.now() - lastProgressLogMs >= 1000) {
      lastProgressLogMs = Date.now();
      console.log(
        `[HTTP_CLIENT_DEBUG] runHttpClientRequest:waiting-response method=${methodName} url=${url} elapsed_ms=${String(lastProgressLogMs - startMs)} status=${String(slot.client.get_status())} has_response=${String(slot.client.has_response())}`,
      );
    }

    await yieldHttpClientTick();
  }

  logHttpClient(slot, `runHttpClientRequest:headers-received method=${methodName} url=${url}`);

  const responseStatusCode = slot.client.get_response_code();
  const responseHeaders = parseHeaders(slot.client.get_response_headers());
  const contentLengthHeader = getHeaderValue(responseHeaders, 'content-length');
  const hasExplicitZeroContentLength = contentLengthHeader !== null && Number.parseInt(contentLengthHeader, 10) === 0;

  if (streamResponse && shouldResponseHaveBody(methodName, responseStatusCode)) {
    const preloadedBodyChunks = new PackedByteArray();

    while (slot.client.get_status() === HTTPClient.Status.STATUS_BODY) {
      const chunk = slot.client.read_response_body_chunk();

      if (chunk.size() === 0) {
        break;
      }

      preloadedBodyChunks.append_array(chunk);
    }
    const preloadedBytes = preloadedBodyChunks.size() > 0
      ? new Uint8Array(preloadedBodyChunks.to_array_buffer())
      : new Uint8Array(0);
    const statusAfterPreload = slot.client.get_status();
    const hasResponseAfterPreload = slot.client.has_response();
    const contentLengthHeader = getHeaderValue(responseHeaders, 'content-length');
    const contentLength = contentLengthHeader === null
      ? Number.NaN
      : Number.parseInt(contentLengthHeader, 10);
    const hasKnownPositiveContentLength = Number.isFinite(contentLength) && contentLength > 0;
    const shouldAllowUnknownLengthFallback = !Number.isFinite(contentLength)
      && allowUnknownLengthRawStreamFallback;
    const shouldFallbackToRawBufferedStream = preloadedBytes.byteLength === 0
      && (hasKnownPositiveContentLength || shouldAllowUnknownLengthFallback)
      && statusAfterPreload !== HTTPClient.Status.STATUS_BODY
      && !hasResponseAfterPreload;

    if (canUseRawFallback && shouldFallbackToRawBufferedStream) {
      closeSlotClientForContext(slot, 'runHttpClientRequest[stream-raw-fallback]');

      const rawResponse = await runRawHttpFallbackRequest(methodName, url, body, requestHeaders, cancelled);

      const rawBytes = rawResponse.body.size() > 0
        ? new Uint8Array(rawResponse.body.to_array_buffer())
        : new Uint8Array(0);

      const response: HttpResponse<ReadableStream> = {
        statusCode: rawResponse.statusCode,
        headers: rawResponse.headers,
        body: createBufferedReadableStream(rawBytes),
      };

      if (Math.floor(response.statusCode / 100) !== 2) {
        throw new HttpResponseError(method, url, response);
      }

      return response;
    }

    const response: HttpResponse<ReadableStream> = {
      statusCode: responseStatusCode,
      headers: responseHeaders,
      body: createHttpClientResponseStream(slot, cancelled, url, preloadedBytes),
    };

    if (Math.floor(response.statusCode / 100) !== 2) {
      throw new HttpResponseError(method, url, response);
    }

    return response;
  }

  if (!shouldResponseHaveBody(methodName, responseStatusCode) || hasExplicitZeroContentLength) {
    const response: HttpResponse<PackedByteArray> = {
      statusCode: responseStatusCode,
      headers: responseHeaders,
      body: new PackedByteArray(),
    };

    if (Math.floor(response.statusCode / 100) !== 2) {
      throw new HttpResponseError(method, url, response);
    }

    return response;
  }

  const preloadedBody = preloadAvailableBodyChunks(slot);

  const bodyRead = await readResponseBody(slot, cancelled, url, preloadedBody);

  const response: HttpResponse<PackedByteArray> = {
    statusCode: responseStatusCode,
    headers: responseHeaders,
    body: bodyRead.body,
    ...(bodyRead.error ? { bodyError: bodyRead.error } : {}),
  };

  if (Math.floor(response.statusCode / 100) !== 2) {
    throw new HttpResponseError(method, url, response);
  }

  return response;
}

function getPendingIndexForSlot(slot: HttpClientSlot): number {
  if (pendingRequests.length === 0) {
    return -1;
  }

  const head = pendingRequests[0]!;

  if (!slot.connectedOrigin || head.skipCount >= HttpClientMaxSkipCount) {
    return 0;
  }

  const searchLimit = Math.min(HttpClientHostLookahead, pendingRequests.length);

  for (let i = 0; i < searchLimit; i++) {
    const candidate = pendingRequests[i]!;

    if (candidate.origin !== slot.connectedOrigin) {
      continue;
    }

    let canSkip = true;

    for (let s = 0; s < i; s++) {
      if (pendingRequests[s]!.skipCount >= HttpClientMaxSkipCount) {
        canSkip = false;
        break;
      }
    }

    if (!canSkip) {
      continue;
    }

    for (let s = 0; s < i; s++) {
      pendingRequests[s]!.skipCount += 1;
    }

    return i;
  }

  return 0;
}

function returnToPool(slot: HttpClientSlot): void {
  slot.inUse = false;
  logHttpClient(slot, 'returnToPool:enter');

  const index = getPendingIndexForSlot(slot);

  if (debugHttpClient) {
    console.log(`[HTTP_CLIENT_DEBUG] returnToPool:index slot=${slot.id} index=${index} pending=${pendingRequests.length}`);
  }

  if (index < 0) {
    closeSlotClientForContext(slot, 'returnToPool[index<0]');
    return;
  }

  const pending = pendingRequests.splice(index, 1)[0]!;

  if (pending.origin !== slot.connectedOrigin) {
    closeSlotClientForContext(slot, 'returnToPool[origin-change]');
  }

  slot.inUse = true;

  void (async () => {
    try {
      if (!pending.isCancelled()) {
        await pending.run(slot);
      } else {
        pending.cancel();
      }
    } finally {
      returnToPool(slot);
    }
  })();
}

function tryDispatchNext(): void {
  if (pendingRequests.length === 0) {
    return;
  }

  const slot = getFreeClientSlot();

  if (!slot) {
    return;
  }

  const index = getPendingIndexForSlot(slot);

  if (index < 0) {
    return;
  }

  const pending = pendingRequests.splice(index, 1)[0]!;
  slot.inUse = true;

  void (async () => {
    try {
      if (!pending.isCancelled()) {
        await pending.run(slot);
      } else {
        pending.cancel();
      }
    } finally {
      returnToPool(slot);
    }
  })();
}

export class HttpInternalError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export class HttpResponseError<T> extends Error {
  readonly response: HttpResponse<T>;

  constructor(method: HttpMethod, url: string, response: HttpResponse<T>) {
    super(`HTTP ${getMethodName(method)} ${url} request failed with status code: ${response.statusCode}`);
    this.response = response;
  }
}

export class HttpAbortError extends Error {
  constructor() {
    super('Request was manually aborted');
  }
}

function getHeaderValue(headers: HttpHeaders, key: string): null | string {
  const value = headers[key.toLowerCase()];
  return Array.isArray(value) ? value[0]! : value ?? null;
}

function normalizeRequestBody(body: unknown): null | string | ArrayBuffer | PackedByteArray {
  if (body == null || typeof body === 'string' || body instanceof ArrayBuffer || body instanceof PackedByteArray) {
    return body ?? null;
  }

  return JSON.stringify(body);
}

async function buildRequestHeadersWithCookies(url: string, effectiveHeaders: HttpHeaders): Promise<string[]> {
  const requestHeaders = Object.entries(effectiveHeaders).flatMap(([k, v]) =>
    Array.isArray(v)
      ? v.map(e => `${k}: ${e}`)
      : `${k}: ${v}`
  );

  const [, cookieProtocol, cookieDomain, cookiePath] = url.match(cookieRegex) ?? [];
  const requestCookies = cookieDomain && typeof cookiePath !== 'undefined'
    ? await getRequestCookies(cookieDomain, cookiePath, cookieProtocol!.length === 5)
    : null;

  if (requestCookies && requestCookies.length > 0) {
    const cookieStrings = requestCookies.map(cookie =>
      `${encodeURIComponent(cookie.name)}=${encodeURIComponent(cookie.value)}`);

    requestHeaders.push(`Cookie: ${cookieStrings.join('; ')}`);
  }

  return requestHeaders;
}

async function executePooledRequest(
  method: HttpMethod,
  url: string,
  body: any,
  effectiveHeaders: HttpHeaders,
  cancelled: () => boolean,
  registerCancelListener: (listener: () => void) => null | (() => void),
): Promise<HttpResponse<any>> {
  const parsedUrl = parseRequestUrl(url);

  return await new Promise<HttpResponse<any>>((resolve, reject) => {
    let settled = false;
    let unregisterCancelListener: null | (() => void) = null;

    const requestBody = normalizeRequestBody(body);

    const finalizeResolve = (value: HttpResponse<any>) => {
      if (settled) {
        return;
      }

      settled = true;
      unregisterCancelListener?.();
      unregisterCancelListener = null;
      resolve(value);
    };

    const finalizeReject = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      unregisterCancelListener?.();
      unregisterCancelListener = null;
      reject(error);
    };

    const pending: PendingRequest = {
      cancel: () => {
        if (!settled) {
          finalizeReject(new HttpAbortError());
        }
      },
      isCancelled: cancelled,
      origin: parsedUrl.origin,
      run: async (slot: HttpClientSlot) => {
        try {
          const requestHeaders = await buildRequestHeadersWithCookies(url, effectiveHeaders);

          const response = await runHttpClientRequest(slot, method, url, requestBody, requestHeaders, cancelled);

          const [, , cookieDomain] = url.match(cookieRegex) ?? [];

          if (cookieDomain) {
            await handleCookies(cookieDomain, response.headers);
          }

          finalizeResolve(response);
        } catch (error) {
          finalizeReject(error instanceof Error
            ? error
            : new HttpInternalError('HTTP request failed due to unexpected internal error', error));
        }
      },
      skipCount: 0,
    };

    pendingRequests.push(pending);

    unregisterCancelListener = registerCancelListener(() => {
      const index = pendingRequests.indexOf(pending);

      if (index >= 0) {
        pendingRequests.splice(index, 1);
      }

      pending.cancel();
    });

    tryDispatchNext();

    if (cancelled()) {
      const index = pendingRequests.indexOf(pending);

      if (index >= 0) {
        pendingRequests.splice(index, 1);
      }

      pending.cancel();
    }
  });
}

async function executeDirectStreamingRequest(
  method: HttpMethod,
  url: string,
  body: any,
  effectiveHeaders: HttpHeaders,
  cancelled: () => boolean,
  options: {
    allowUnknownLengthRawStreamFallback: boolean;
  },
): Promise<HttpResponse<any>> {
  const requestBody = normalizeRequestBody(body);
  const requestHeaders = await buildRequestHeadersWithCookies(url, effectiveHeaders);
  const slot = createHttpClientSlot();
  slot.inUse = true;
  let streamOwnedByResponse = false;

  try {
    const response = await runHttpClientRequest(
      slot,
      method,
      url,
      requestBody,
      requestHeaders,
      cancelled,
      {
        allowRawFallback: false,
        allowUnknownLengthRawStreamFallback: options.allowUnknownLengthRawStreamFallback,
        streamResponse: true,
      },
    );

    streamOwnedByResponse = response.body instanceof ReadableStream;

    if (!streamOwnedByResponse) {
      closeSlotClientForContext(slot, 'executeDirectStreamingRequest[no-stream]');
    }

    const [, , cookieDomain] = url.match(cookieRegex) ?? [];

    if (cookieDomain) {
      await handleCookies(cookieDomain, response.headers);
    }

    return response;
  } catch (error) {
    if (!streamOwnedByResponse) {
      try {
        closeSlotClientForContext(slot, 'executeDirectStreamingRequest[error]');
      } catch {
        // ignore close failures while propagating original error.
      }
    }
    throw error;
  }
}

export function submit<B>(
  method: HttpMethod,
  url: string,
  body: any,
  headers?: HttpHeaders,
  options?: {
    allowUnknownLengthRawStreamFallback?: boolean;
  },
): CancellablePromise<HttpResponse<B>> {
  const effectiveHeaders: HttpHeaders = headers ? { ...headers } : {};

  let cancelled = false;
  const cancelListeners = new Set<() => void>();

  const cancel = () => {
    if (cancelled) {
      return;
    }

    cancelled = true;

    const listeners = Array.from(cancelListeners);

    for (const listener of listeners) {
      listener();
    }
  };

  const registerCancelListener = (listener: () => void): null | (() => void) => {
    if (cancelled) {
      listener();
      return null;
    }

    cancelListeners.add(listener);

    return () => {
      cancelListeners.delete(listener);
    };
  };

  return toCancellable<HttpResponse<B>>(cancel, (async () => {
    if (cancelled) {
      throw new HttpAbortError();
    }

    const methodName = getMethodName(method);
    const requestBody = normalizeRequestBody(body);
    const shouldUseStreamingResponse = (methodName === 'GET' || methodName === 'HEAD') && requestBody === null;

    if (shouldUseStreamingResponse) {
      return await executeDirectStreamingRequest(
        method,
        url,
        body,
        effectiveHeaders,
        () => cancelled,
        {
          allowUnknownLengthRawStreamFallback: options?.allowUnknownLengthRawStreamFallback === true,
        },
      );
    }

    return await executePooledRequest(
      method,
      url,
      body,
      effectiveHeaders,
      () => cancelled,
      registerCancelListener,
    );
  })());
}
