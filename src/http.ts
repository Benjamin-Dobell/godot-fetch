import {
  OS,
  PackedByteArray,
  StreamPeerSocket,
  StreamPeerTCP,
  StreamPeerTLS,
  String as GodotString,
  TLSOptions,
  X509Certificate,
} from 'godot.lib.api';
import { TextDecoder } from './standards/encoding';
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
type HttpMethod = string;

type ReadableStreamController = {
  close: () => void;
  enqueue: (value: unknown) => void;
  error: (reason?: unknown) => void;
};

const HttpConnectTimeoutMs = 30_000;
const HttpRequestTimeoutMs = 120_000;
const HttpHeaderTimeoutMs = HttpRequestTimeoutMs;
const HttpResponseTimeoutMs = HttpRequestTimeoutMs;
const HttpWriteChunkSize = 64 * 1024;
const HttpWriteBatchBudgetBytes = 4 * 1024 * 1024;
const HttpReadBatchBudgetBytes = 4 * 1024 * 1024;
const HttpReadRequestChunkBytes = 64 * 1024;
const StreamingMaxConcurrency = 16;
const GodotErrorOk = 0; // GError.OK
const GodotErrorFileEof = 18; // GError.ERR_FILE_EOF
const InsecureTlsEnv = 'GODOT_FETCH_TLS_UNSAFE';
const TrustedTlsCertPathEnv = 'GODOT_FETCH_TLS_CA_CERT_PATH';
const BodyMethodNames = new Set(['POST', 'PUT', 'PATCH']);
const UserRequestHeadersToDrop = new Set([
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'host',
]);

let activeStreamingRequests = 0;
const pendingStreamingAcquires: Array<() => void> = [];
let activeBufferedRequests = 0;

const cookieRegex = /^(https?):\/\/([^:/]+)(?::\d+)?([^?#]+)/i;
const urlRegex = /^(https?):\/\/([^:/?#]+)(?::(\d+))?([^?#]*)(\?[^#]*)?/i;

type ParsedUrl = {
  host: string;
  origin: string;
  pathWithQuery: string;
  port: number;
  scheme: 'http' | 'https';
  url: string;
};

type HeaderBoundary = {
  headerEnd: number;
  terminatorLength: number;
};

let cachedUnsafeTlsOptions: null | TLSOptions = null;
let cachedTrustedTlsOptions: null | TLSOptions = null;
let cachedDefaultTlsOptions: null | TLSOptions = null;

function getMethodName(method: HttpMethod): string {
  return method.toUpperCase();
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

function shouldSendContentLength(methodName: string, bodySize: number): boolean {
  return bodySize > 0 || BodyMethodNames.has(methodName);
}

function parseHttpHeaders(headerText: string): { headers: HttpHeaders; statusCode: number } {
  const lines = headerText.split(/\r?\n/);
  const statusLine = lines.shift() ?? '';
  const match = statusLine.match(/^HTTP\/\d+\.\d+\s+(\d{3})(?:\s+.*)?$/i);
  if (!match) {
    throw new HttpInternalError(`Invalid HTTP status line in HTTP response: ${statusLine}`);
  }

  const statusCode = Number.parseInt(match[1]!, 10);
  const headers: HttpHeaders = {};

  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }

    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new HttpInternalError(`Invalid HTTP header line: ${line}`);
    }

    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).replace(/^[ \t]*/, '').replace(/[ \t]*$/, '');
    appendHeaderValue(headers, key, value);
  }

  return { headers, statusCode };
}

function tryParseHttpHeadersAtEof(responseBytes: Uint8Array): null | { headers: HttpHeaders; statusCode: number } {
  if (responseBytes.length === 0) {
    return null;
  }

  try {
    return parseHttpHeaders(bytesToLatin1String(responseBytes));
  } catch {
    return null;
  }
}

function appendBytes(existing: Uint8Array, chunk: Uint8Array): Uint8Array {
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

function toPackedByteArrayFromBytes(bytes: Uint8Array): PackedByteArray {
  if (bytes.length === 0) {
    return new PackedByteArray();
  }
  const copied = new Uint8Array(bytes);
  return new PackedByteArray(copied.buffer);
}

function bytesToUtf8String(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }

  return new TextDecoder().decode(bytes);
}

function bytesToLatin1String(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }

  let output = '';

  for (const byte of bytes) {
    output += String.fromCharCode(byte);
  }

  return output;
}

function toResponseStreamError(error: unknown): unknown {
  if (error instanceof HttpInternalError || error instanceof HttpResponseError) {
    return new TypeError(error.message);
  }
  return error;
}

function findHeaderBoundary(responseBytes: Uint8Array): null | HeaderBoundary {
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

function findCrlf(bytes: Uint8Array, start: number): number {
  for (let i = start; i < bytes.length - 1; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) {
      return i;
    }
  }

  return -1;
}

class IncompleteChunkedBodyError extends Error {
  constructor() {
    super('HTTP chunk parse incomplete');
  }
}

function hasHeaderLine(headers: string[], name: string): boolean {
  const prefix = `${name.toLowerCase()}:`;
  return headers.some(header => header.toLowerCase().startsWith(prefix));
}

function getDefaultPortForScheme(scheme: ParsedUrl['scheme']): number {
  return scheme === 'https' ? 443 : 80;
}

function formatHostHeader(parsedUrl: ParsedUrl): string {
  const defaultPort = getDefaultPortForScheme(parsedUrl.scheme);

  return parsedUrl.port === defaultPort
    ? parsedUrl.host
    : `${parsedUrl.host}:${String(parsedUrl.port)}`;
}

function decodeChunkedHttpBodyBytes(bodyBytes: Uint8Array): Uint8Array {
  let cursor = 0;
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const sizeLineEnd = findCrlf(bodyBytes, cursor);

    if (sizeLineEnd < 0) {
      throw new IncompleteChunkedBodyError();
    }

    const chunkSizeLine = bytesToUtf8String(bodyBytes.subarray(cursor, sizeLineEnd));
    const chunkSizeText = chunkSizeLine.split(';')[0]?.trim() ?? '';
    const chunkSize = Number.parseInt(chunkSizeText, 16);

    if (!Number.isFinite(chunkSize) || chunkSize < 0) {
      throw new HttpInternalError(`HTTP chunk parse failed: invalid size "${chunkSizeText}"`);
    }

    cursor = sizeLineEnd + 2;

    if (chunkSize === 0) {
      while (true) {
        const trailerLineEnd = findCrlf(bodyBytes, cursor);

        if (trailerLineEnd < 0) {
          throw new IncompleteChunkedBodyError();
        }

        if (trailerLineEnd === cursor) {
          const decoded = new Uint8Array(totalLength);
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
      throw new HttpInternalError('HTTP chunk parse failed: missing chunk terminator');
    }

    const chunk = bodyBytes.slice(cursor, chunkEnd);
    chunks.push(chunk);

    totalLength += chunk.length;
    cursor = chunkEnd + 2;
  }
}

function buildHttpRequest(
  methodName: string,
  parsedUrl: ParsedUrl,
  headers: string[],
  body: PackedByteArray,
): PackedByteArray {
  const headerLines = headers.slice();

  if (!hasHeaderLine(headerLines, 'host')) {
    headerLines.push(`Host: ${formatHostHeader(parsedUrl)}`);
  }

  if (shouldSendContentLength(methodName, body.size()) && !hasHeaderLine(headerLines, 'content-length')) {
    headerLines.push(`Content-Length: ${String(body.size())}`);
  }

  const prelude = [
    `${methodName} ${parsedUrl.pathWithQuery} HTTP/1.1`,
    ...headerLines,
    '',
    '',
  ].join('\r\n');

  const preludeBytes = GodotString.to_utf8_buffer(prelude);

  if (body.size() === 0) {
    return preludeBytes;
  }

  const requestBytes = new PackedByteArray();
  requestBytes.append_array(preludeBytes);
  requestBytes.append_array(body);
  return requestBytes;
}

function closeHttpPeer(peer: StreamPeerTCP | StreamPeerTLS, tcp: StreamPeerTCP): void {
  if (peer instanceof StreamPeerTLS) {
    peer.disconnect_from_stream();
  }

  tcp.disconnect_from_host();
}

async function connectHttpPeer(
  parsedUrl: ParsedUrl,
  url: string,
  cancelled: () => boolean,
): Promise<{ peer: StreamPeerTCP | StreamPeerTLS; tcp: StreamPeerTCP }> {
  const tcp = new StreamPeerTCP();
  let peer: StreamPeerTCP | StreamPeerTLS = tcp;

  try {
    const connectError = tcp.connect_to_host(parsedUrl.host, parsedUrl.port);

    if (connectError !== GodotErrorOk) {
      throw new HttpInternalError(`HTTP connect failed with Godot error: ${connectError}`);
    }

    const connectStartMs = Date.now();
    while (tcp.get_status() === StreamPeerSocket.Status.STATUS_CONNECTING) {
      if (cancelled()) {
        throw new HttpAbortError();
      }

      const pollError = tcp.poll();

      if (pollError !== GodotErrorOk) {
        throw new HttpInternalError(`HTTP connect poll failed with Godot error: ${pollError}`);
      }

      if (Date.now() - connectStartMs > HttpConnectTimeoutMs) {
        throw new HttpInternalError(`HTTP connect timed out after ${HttpConnectTimeoutMs}ms for ${url}`);
      }

      await yieldHttpTick();
    }

    if (tcp.get_status() !== StreamPeerSocket.Status.STATUS_CONNECTED) {
      throw new HttpInternalError(`HTTP socket did not connect for ${url} (status=${tcp.get_status()})`);
    }

    if (parsedUrl.scheme === 'https') {
      const tls = new StreamPeerTLS();
      const tlsOptions = getTlsOptionsForUrl(parsedUrl);
      const tlsError = typeof tlsOptions === 'undefined'
        ? tls.connect_to_stream(tcp, parsedUrl.host)
        : tls.connect_to_stream(tcp, parsedUrl.host, tlsOptions);

      if (tlsError !== GodotErrorOk) {
        throw new HttpInternalError(`HTTPS TLS handshake failed with Godot error: ${tlsError}`);
      }

      const tlsStartMs = Date.now();

      while (tls.get_status() === StreamPeerTLS.Status.STATUS_HANDSHAKING) {
        if (cancelled()) {
          throw new HttpAbortError();
        }

        tls.poll();

        if (Date.now() - tlsStartMs > HttpConnectTimeoutMs) {
          throw new HttpInternalError(`HTTPS handshake timed out after ${HttpConnectTimeoutMs}ms for ${url}`);
        }

        await yieldHttpTick();
      }

      if (tls.get_status() !== StreamPeerTLS.Status.STATUS_CONNECTED) {
        throw new HttpInternalError(`HTTPS socket did not connect for ${url} (status=${tls.get_status()})`);
      }

      peer = tls;
    }

    return { peer, tcp };
  } catch (error) {
    closeHttpPeer(peer, tcp);
    throw error;
  }
}

function pollHttpPeer(peer: StreamPeerTCP | StreamPeerTLS, context: string): void {
  if (peer instanceof StreamPeerTLS) {
    peer.poll();
    return;
  }

  const pollError = peer.poll();
  if (pollError !== GodotErrorOk) {
    throw new HttpInternalError(`${context} poll failed with Godot error: ${pollError}`);
  }

}

async function writeHttpRequest(
  peer: StreamPeerTCP | StreamPeerTLS,
  methodName: string,
  parsedUrl: ParsedUrl,
  url: string,
  body: null | string | ArrayBuffer | PackedByteArray,
  headers: string[],
  cancelled: () => boolean,
): Promise<void> {
  const packedBody = toPackedBody(body);
  const requestBytes = buildHttpRequest(methodName, parsedUrl, headers, packedBody);
  const requestBuffer = new Uint8Array(requestBytes.to_array_buffer());
  let zeroWriteStartMs: null | number = null;
  let bytesWrittenSinceYield = 0;

  for (let offset = 0; offset < requestBuffer.length; offset += HttpWriteChunkSize) {
    if (cancelled()) {
      throw new HttpAbortError();
    }

    const chunkEnd = Math.min(offset + HttpWriteChunkSize, requestBuffer.length);
    const chunk = requestBuffer.slice(offset, chunkEnd);

    let chunkOffset = 0;

    while (chunkOffset < chunk.byteLength) {
      if (cancelled()) {
        throw new HttpAbortError();
      }

      const remainingChunk = chunk.subarray(chunkOffset);
      const remainingBuffer = remainingChunk.buffer.slice(
        remainingChunk.byteOffset,
        remainingChunk.byteOffset + remainingChunk.byteLength,
      );

      const writeResult = peer.put_partial_data(new PackedByteArray(remainingBuffer));
      const writeError = writeResult.get(0);

      if (typeof writeError !== 'number' || writeError !== GodotErrorOk) {
        throw new HttpInternalError(`HTTP write failed with Godot error: ${String(writeError)}`);
      }

      const bytesSent = writeResult.get(1);

      if (typeof bytesSent !== 'number' || !Number.isFinite(bytesSent) || bytesSent < 0) {
        throw new HttpInternalError(`HTTP write returned invalid sent-byte count: ${String(bytesSent)}`);
      }

      if (bytesSent === 0) {
        if (zeroWriteStartMs === null) {
          zeroWriteStartMs = Date.now();
        } else if (Date.now() - zeroWriteStartMs > HttpConnectTimeoutMs) {
          throw new HttpInternalError(`HTTP write stalled for ${HttpConnectTimeoutMs}ms for ${url}`);
        }

        pollHttpPeer(peer, 'HTTP write');

        await yieldHttpTick();

        continue;
      }

      zeroWriteStartMs = null;
      chunkOffset += bytesSent;
      bytesWrittenSinceYield += bytesSent;
      pollHttpPeer(peer, 'HTTP write');

      if (bytesWrittenSinceYield >= HttpWriteBatchBudgetBytes) {
        bytesWrittenSinceYield = 0;
        await yieldHttpTick();
      }
    }
  }
}

function isHttpPeerOpen(peer: StreamPeerTCP | StreamPeerTLS): boolean {
  const status = peer.get_status();
  return peer instanceof StreamPeerTLS
    ? status === StreamPeerTLS.Status.STATUS_CONNECTED || status === StreamPeerTLS.Status.STATUS_HANDSHAKING
    : status === StreamPeerSocket.Status.STATUS_CONNECTED;
}

function readAvailableHttpBytes(
  peer: StreamPeerTCP | StreamPeerTLS,
  byteCount: number = HttpReadRequestChunkBytes,
): Uint8Array {
  pollHttpPeer(peer, 'HTTP response read chunk');
  const available = peer.get_available_bytes();

  if (available <= 0) {
    return new Uint8Array(0);
  }

  const bytesToRequest = Math.max(1, Math.min(byteCount, available));
  const result = peer.get_partial_data(bytesToRequest);
  const readError = result.get(0);

  if (
    typeof readError !== 'number'
    || (readError !== GodotErrorOk && readError !== GodotErrorFileEof)
  ) {
    throw new HttpInternalError(`HTTP read failed with Godot error: ${String(readError)}`);
  }

  const readChunk = result.get(1);

  if (!(readChunk instanceof PackedByteArray)) {
    throw new HttpInternalError('HTTP read returned invalid data payload');
  }

  const readChunkBytes = new Uint8Array(readChunk.size());
  readChunkBytes.set(new Uint8Array(readChunk.to_array_buffer()));
  return readChunkBytes;
}

function processAvailableHttpChunksUpToBudget(
  peer: StreamPeerTCP | StreamPeerTLS,
  onChunk: (chunk: Uint8Array) => boolean | void,
  byteBudget: number = HttpReadBatchBudgetBytes,
): number {
  let totalBytes = 0;

  while (true) {
    const remainingByteBudget = Math.max(1, byteBudget - totalBytes);
    const chunk = readAvailableHttpBytes(
      peer,
      Math.min(HttpReadRequestChunkBytes, remainingByteBudget),
    );

    if (chunk.length === 0) {
      return totalBytes;
    }

    totalBytes += chunk.length;

    if (onChunk(chunk) === false) {
      return totalBytes;
    }

    if (totalBytes >= byteBudget) {
      return totalBytes;
    }
  }
}

function processChunkedStreamingBodyBytes(
  input: Uint8Array,
  controller: ReadableStreamController,
): { complete: boolean; remaining: Uint8Array } {
  let buffer = input;

  while (buffer.length > 0) {
    const sizeLineEnd = findCrlf(buffer, 0);

    if (sizeLineEnd < 0) {
      return { complete: false, remaining: buffer };
    }

    const chunkSizeLine = bytesToUtf8String(buffer.subarray(0, sizeLineEnd));
    const chunkSizeText = chunkSizeLine.split(';')[0]?.trim() ?? '';
    const chunkSize = Number.parseInt(chunkSizeText, 16);

    if (!Number.isFinite(chunkSize) || chunkSize < 0) {
      throw new HttpInternalError(`HTTP chunk parse failed: invalid size "${chunkSizeText}"`);
    }

    const chunkStart = sizeLineEnd + 2;

    if (chunkSize === 0) {
      let trailerCursor = chunkStart;

      while (true) {
        const trailerLineEnd = findCrlf(buffer, trailerCursor);

        if (trailerLineEnd < 0) {
          return { complete: false, remaining: buffer };
        }

        if (trailerLineEnd === trailerCursor) {
          return {
            complete: true,
            remaining: buffer.subarray(trailerLineEnd + 2),
          };
        }

        trailerCursor = trailerLineEnd + 2;
      }
    }

    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd + 2 > buffer.length) {
      return { complete: false, remaining: buffer };
    }

    if (buffer[chunkEnd] !== 13 || buffer[chunkEnd + 1] !== 10) {
      throw new HttpInternalError('HTTP chunk parse failed: missing chunk terminator');
    }

    controller.enqueue(buffer.slice(chunkStart, chunkEnd));
    buffer = buffer.subarray(chunkEnd + 2);
  }

  return { complete: false, remaining: buffer };
}

function createHttpResponseStream(
  peer: StreamPeerTCP | StreamPeerTLS,
  tcp: StreamPeerTCP,
  methodName: string,
  statusCode: number,
  url: string,
  headers: HttpHeaders,
  initialBodyBytes: Uint8Array,
  cancelled: () => boolean,
  onStreamingResponseTerminated?: () => void,
): ReadableStream {
  let closed = false;
  let chunkedBuffer: Uint8Array = new Uint8Array(0);
  let emittedBodyBytes = 0;
  const shouldExpectBody = shouldResponseHaveBody(methodName, statusCode);
  const transferEncoding = getHeaderValue(headers, 'transfer-encoding')?.toLowerCase() ?? '';
  const isChunked = transferEncoding.includes('chunked');
  const contentLengthHeader = getHeaderValue(headers, 'content-length');
  const contentLength = contentLengthHeader === null
    ? Number.NaN
    : Number.parseInt(contentLengthHeader, 10);
  const hasKnownContentLength = Number.isFinite(contentLength) && contentLength >= 0;

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;

    try {
      closeHttpPeer(peer, tcp);
    } finally {
      onStreamingResponseTerminated?.();
    }
  };

  const enqueuePlainBytes = (controller: ReadableStreamController, bytes: Uint8Array): boolean => {
    if (bytes.length === 0) {
      return hasKnownContentLength && emittedBodyBytes >= contentLength;
    }

    if (hasKnownContentLength) {
      const remainingLength = contentLength - emittedBodyBytes;

      if (remainingLength <= 0) {
        return true;
      }

      const bytesToEmit = bytes.slice(0, remainingLength);

      if (bytesToEmit.length > 0) {
        emittedBodyBytes += bytesToEmit.length;
        controller.enqueue(bytesToEmit);
      }

      return emittedBodyBytes >= contentLength;
    }

    emittedBodyBytes += bytes.length;
    controller.enqueue(bytes.slice(0));
    return false;
  };

  return new ReadableStream({
    start(controller) {
      void (async () => {
        let lastActivityMs = Date.now();
        let bytesReadSinceYield = 0;

        try {
          if (!shouldExpectBody) {
            controller.close();
            close();
            return;
          }

          if (initialBodyBytes.length > 0) {
            if (isChunked) {
              chunkedBuffer = appendBytes(chunkedBuffer, initialBodyBytes);
              const processed = processChunkedStreamingBodyBytes(chunkedBuffer, controller);
              chunkedBuffer = processed.remaining;

              if (processed.complete) {
                controller.close();
                close();
                return;
              }
            } else if (enqueuePlainBytes(controller, initialBodyBytes)) {
              controller.close();
              close();
              return;
            }

            lastActivityMs = Date.now();
          } else if (hasKnownContentLength && contentLength === 0) {
            controller.close();
            close();
            return;
          }

          while (!closed) {
            if (cancelled()) {
              throw new HttpAbortError();
            }

            let responseComplete = false;
            const bytesRead = processAvailableHttpChunksUpToBudget(peer, (chunk) => {
              lastActivityMs = Date.now();

              if (isChunked) {
                chunkedBuffer = appendBytes(chunkedBuffer, chunk);
                const processed = processChunkedStreamingBodyBytes(chunkedBuffer, controller);
                chunkedBuffer = processed.remaining;

                if (processed.complete) {
                  controller.close();
                  close();
                  responseComplete = true;
                  return false;
                }

                return;
              }

              if (enqueuePlainBytes(controller, chunk)) {
                controller.close();
                close();
                responseComplete = true;
                return false;
              }
            });

            if (responseComplete) {
              return;
            }

            if (bytesRead !== 0) {
              bytesReadSinceYield += bytesRead;
            }

            if (!isHttpPeerOpen(peer)) {
              if (isChunked && chunkedBuffer.length > 0) {
                throw new HttpInternalError(`HTTP response stream ended before complete chunked body was received for ${url}`);
              }

              controller.close();
              close();
              return;
            }

            if (Date.now() - lastActivityMs > HttpRequestTimeoutMs) {
              throw new HttpInternalError(`HTTP response stream timed out after ${HttpRequestTimeoutMs}ms for ${url}`);
            }

            if (bytesRead === 0) {
              bytesReadSinceYield = 0;

              await yieldHttpTick();

              continue;
            }

            if (bytesReadSinceYield >= HttpReadBatchBudgetBytes) {
              bytesReadSinceYield = 0;

              await yieldHttpTick();
            }
          }
        } catch (error) {
          close();
          const streamError = toResponseStreamError(error);
          controller.error(streamError instanceof Error
            ? streamError
            : new HttpInternalError(`HTTP response stream failed for ${url}`, streamError));
        }
      })();
    },
    cancel() {
      close();
    },
  });
}

async function runHttpStreamingRequest(
  methodName: string,
  url: string,
  body: null | string | ArrayBuffer | PackedByteArray,
  headers: string[],
  cancelled: () => boolean,
  onStreamingResponseTerminated?: () => void,
): Promise<HttpResponse<HttpResponseBody>> {
  const parsedUrl = parseRequestUrl(url);
  const { peer, tcp } = await connectHttpPeer(parsedUrl, url, cancelled);
  let shouldTransferPeerToStream = false;

  try {
    await writeHttpRequest(peer, methodName, parsedUrl, url, body, headers, cancelled);
    let responseBytes: Uint8Array = new Uint8Array(0);
    let bytesReadSinceYield = 0;
    const readStartMs = Date.now();

    while (true) {
      if (cancelled()) {
        throw new HttpAbortError();
      }

      const bytesRead = processAvailableHttpChunksUpToBudget(peer, (chunk) => {
        responseBytes = appendBytes(responseBytes, chunk);
      });

      if (bytesRead > 0) {
        bytesReadSinceYield += bytesRead;
      }

      const boundary = findHeaderBoundary(responseBytes);

      if (boundary !== null) {
        const headerText = bytesToLatin1String(responseBytes.subarray(0, boundary.headerEnd));
        const parsed = parseHttpHeaders(headerText);
        const initialBodyOffset = boundary.headerEnd + boundary.terminatorLength;
        const initialBodyBytes = responseBytes.subarray(initialBodyOffset);

        if (!shouldResponseHaveBody(methodName, parsed.statusCode)) {
          return {
            statusCode: parsed.statusCode,
            headers: parsed.headers,
            body: new PackedByteArray(),
          };
        }

        shouldTransferPeerToStream = true;

        return {
          statusCode: parsed.statusCode,
          headers: parsed.headers,
          body: createHttpResponseStream(
            peer,
            tcp,
            methodName,
            parsed.statusCode,
            url,
            parsed.headers,
            initialBodyBytes,
            cancelled,
            onStreamingResponseTerminated,
          ),
        };
      }

      if (!isHttpPeerOpen(peer)) {
        const eofHeaders = tryParseHttpHeadersAtEof(responseBytes);

        if (eofHeaders !== null) {
          return {
            statusCode: eofHeaders.statusCode,
            headers: eofHeaders.headers,
            body: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
          };
        }

        throw new HttpInternalError(`HTTP streaming response ended before headers were received for ${url}`);
      }

      if (Date.now() - readStartMs > HttpHeaderTimeoutMs) {
        throw new HttpInternalError(`HTTP streaming response timed out waiting for headers after ${HttpHeaderTimeoutMs}ms for ${url}`);
      }

      if (bytesRead === 0) {
        bytesReadSinceYield = 0;
        await yieldHttpTick();
        continue;
      }

      if (bytesReadSinceYield >= HttpReadBatchBudgetBytes) {
        bytesReadSinceYield = 0;
        await yieldHttpTick();
      }
    }
  } finally {
    if (!shouldTransferPeerToStream) {
      closeHttpPeer(peer, tcp);
    }
  }
}

async function runHttpBufferedRequest(
  methodName: string,
  url: string,
  body: null | string | ArrayBuffer | PackedByteArray,
  headers: string[],
  cancelled: () => boolean,
): Promise<HttpResponse<PackedByteArray>> {
  const parsedUrl = parseRequestUrl(url);
  activeBufferedRequests += 1;

  const { peer, tcp } = await connectHttpPeer(parsedUrl, url, cancelled);

  try {
    await writeHttpRequest(peer, methodName, parsedUrl, url, body, headers, cancelled);
    let responseBytes: Uint8Array = new Uint8Array(0);
    let bytesReadSinceYield = 0;
    const readStartMs = Date.now();
    let finalStatus = -1;
    let parsedHeaders: null | HttpHeaders = null;
    let parsedStatusCode = -1;
    let headerBodyOffset = -1;

    while (true) {
      if (cancelled()) {
        throw new HttpAbortError();
      }

      const bytesRead = processAvailableHttpChunksUpToBudget(peer, (chunk) => {
        responseBytes = appendBytes(responseBytes, chunk);
      });

      if (bytesRead > 0) {
        bytesReadSinceYield += bytesRead;
      }

      if (parsedHeaders === null) {
        const boundary = findHeaderBoundary(responseBytes);

        if (boundary !== null) {
          const headerText = bytesToLatin1String(responseBytes.subarray(0, boundary.headerEnd));
          const parsed = parseHttpHeaders(headerText);
          parsedHeaders = parsed.headers;
          parsedStatusCode = parsed.statusCode;
          headerBodyOffset = boundary.headerEnd + boundary.terminatorLength;
        }
      }

      if (parsedHeaders !== null) {
        if (!shouldResponseHaveBody(methodName, parsedStatusCode)) {
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

      finalStatus = peer.get_status();
      if (!isHttpPeerOpen(peer)) {
        const eofHeaders = tryParseHttpHeadersAtEof(responseBytes);

        if (eofHeaders !== null) {
          return {
            statusCode: eofHeaders.statusCode,
            headers: eofHeaders.headers,
            body: new PackedByteArray(),
          };
        }

        if (parsedHeaders !== null) {
          const bodyBytes = responseBytes.subarray(Math.max(0, headerBodyOffset));

          return {
            statusCode: parsedStatusCode,
            headers: parsedHeaders,
            body: toPackedByteArrayFromBytes(bodyBytes),
          };
        }
        break;
      }

      if (Date.now() - readStartMs > HttpResponseTimeoutMs) {
        throw new HttpInternalError(`HTTP timed out waiting for response after ${HttpResponseTimeoutMs}ms for ${url}`);
      }

      if (bytesRead === 0) {
        bytesReadSinceYield = 0;
        await yieldHttpTick();
        continue;
      }

      if (bytesReadSinceYield >= HttpReadBatchBudgetBytes) {
        bytesReadSinceYield = 0;
        await yieldHttpTick();
      }
    }

    throw new HttpInternalError(
      `HTTP ended before complete response was received for ${url} (status=${finalStatus}, bytes=${responseBytes.length})`,
    );
  } finally {
    activeBufferedRequests = Math.max(0, activeBufferedRequests - 1);
    closeHttpPeer(peer, tcp);
  }
}

function parseRequestUrl(url: string): ParsedUrl {
  const match = url.match(urlRegex);

  if (!match) {
    throw new Error(`Invalid HTTP URL: ${url}`);
  }

  const [, schemeText, hostText, portText, pathText, queryText] = match;

  if (!schemeText || !hostText) {
    throw new Error(`Invalid HTTP URL components: ${url}`);
  }

  const scheme = schemeText.toLowerCase() === 'https' ? 'https' : 'http';
  const path = pathText && pathText.length > 0 ? pathText : '/';
  const query = queryText ?? '';
  const port = portText
    ? Number.parseInt(portText, 10)
    : getDefaultPortForScheme(scheme);

  return {
    host: hostText,
    origin: `${scheme}://${hostText}:${port}`,
    pathWithQuery: `${path}${query}`,
    port,
    scheme,
    url,
  };
}

function getUnsafeTlsOptions(): TLSOptions {
  if (cachedUnsafeTlsOptions !== null) {
    return cachedUnsafeTlsOptions;
  }

  const created = TLSOptions.client_unsafe();

  if (created === null) {
    throw new Error('Failed to create unsafe TLS options');
  }

  cachedUnsafeTlsOptions = created;
  return cachedUnsafeTlsOptions;
}

function getTrustedTlsOptions(): null | TLSOptions {
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

  cachedTrustedTlsOptions = created;
  return cachedTrustedTlsOptions;
}

function getDefaultTlsOptions(): TLSOptions {
  if (cachedDefaultTlsOptions !== null) {
    return cachedDefaultTlsOptions;
  }

  const created = TLSOptions.client();

  if (created === null) {
    throw new Error('Failed to create default TLS options');
  }

  cachedDefaultTlsOptions = created;
  return cachedDefaultTlsOptions;
}

function getTlsOptionsForUrl(parsedUrl: ParsedUrl): undefined | TLSOptions {
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

function yieldHttpTick(): Promise<void> {
  return waitForTimeout(0);
}

export class HttpInternalError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'HttpInternalError';
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
    this.name = 'HttpAbortError';
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

function shouldDropUserRequestHeader(name: string): boolean {
  return UserRequestHeadersToDrop.has(name.toLowerCase());
}

async function buildRequestHeadersWithCookies(
  url: string,
  effectiveHeaders: HttpHeaders,
  credentials: 'include' | 'omit' | 'same-origin',
): Promise<string[]> {
  const requestHeaders = Object.entries(effectiveHeaders).flatMap(([k, v]) => {
    if (shouldDropUserRequestHeader(k)) {
      return [];
    }

    return Array.isArray(v)
      ? v.map(e => `${k}: ${e}`)
      : `${k}: ${v}`;
  });

  if (credentials === 'omit') {
    return requestHeaders;
  }

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

function assertSuccessResponse(method: HttpMethod, url: string, response: HttpResponse<HttpResponseBody>): void {
  if (Math.floor(response.statusCode / 100) !== 2) {
    throw new HttpResponseError(method, url, response);
  }
}

async function acquireStreamingSlot(cancelled: () => boolean): Promise<void> {
  while (true) {
    if (cancelled()) {
      throw new HttpAbortError();
    }

    if (activeStreamingRequests < StreamingMaxConcurrency) {
      activeStreamingRequests += 1;
      return;
    }

    await new Promise<void>(resolve => {
      pendingStreamingAcquires.push(resolve);
    });
  }
}

function releaseStreamingSlot(): void {
  if (activeStreamingRequests <= 0) {
    return;
  }

  activeStreamingRequests -= 1;
  const resume = pendingStreamingAcquires.shift();
  if (resume) {
    resume();
  }
}

async function executeBufferedRequest(
  method: HttpMethod,
  url: string,
  body: any,
  effectiveHeaders: HttpHeaders,
  credentials: 'include' | 'omit' | 'same-origin',
  cancelled: () => boolean,
): Promise<HttpResponse<any>> {
  const methodName = getMethodName(method);
  const requestBody = normalizeRequestBody(body);
  const requestHeaders = await buildRequestHeadersWithCookies(url, effectiveHeaders, credentials);
  const response = await runHttpBufferedRequest(methodName, url, requestBody, requestHeaders, cancelled);

  const [, , cookieDomain] = url.match(cookieRegex) ?? [];
  if (credentials !== 'omit' && cookieDomain) {
    await handleCookies(cookieDomain, response.headers);
  }

  assertSuccessResponse(method, url, response);
  return response;
}

async function executeStreamingRequest(
  method: HttpMethod,
  url: string,
  body: any,
  effectiveHeaders: HttpHeaders,
  credentials: 'include' | 'omit' | 'same-origin',
  cancelled: () => boolean,
): Promise<HttpResponse<any>> {
  await acquireStreamingSlot(cancelled);
  let streamOwnedByResponse = false;

  try {
    const methodName = getMethodName(method);
    const requestBody = normalizeRequestBody(body);
    const requestHeaders = await buildRequestHeadersWithCookies(url, effectiveHeaders, credentials);
    const response = await runHttpStreamingRequest(
      methodName,
      url,
      requestBody,
      requestHeaders,
      cancelled,
      () => {
        releaseStreamingSlot();
      },
    );

    streamOwnedByResponse = response.body instanceof ReadableStream;

    const [, , cookieDomain] = url.match(cookieRegex) ?? [];
    if (credentials !== 'omit' && cookieDomain) {
      await handleCookies(cookieDomain, response.headers);
    }

    assertSuccessResponse(method, url, response);
    return response;
  } catch (error) {
    if (streamOwnedByResponse) {
      throw error;
    }
    releaseStreamingSlot();
    throw error;
  } finally {
    if (!streamOwnedByResponse) {
      releaseStreamingSlot();
    }
  }
}

export function submit<B>(
  method: HttpMethod,
  url: string,
  body: any,
  headers?: HttpHeaders,
  options?: {
    credentials?: 'include' | 'omit' | 'same-origin';
  },
): CancellablePromise<HttpResponse<B>> {
  const effectiveHeaders: HttpHeaders = headers ? { ...headers } : {};
  const credentials = options?.credentials ?? 'same-origin';

  let cancelled = false;

  const cancel = () => {
    cancelled = true;
  };

  return toCancellable<HttpResponse<B>>(cancel, (async () => {
    if (cancelled) {
      throw new HttpAbortError();
    }

    const methodName = getMethodName(method);
    const requestBody = normalizeRequestBody(body);
    const shouldUseStreamingResponse = (methodName === 'GET' || methodName === 'HEAD')
      && requestBody === null;

    if (shouldUseStreamingResponse) {
      return await executeStreamingRequest(
        method,
        url,
        body,
        effectiveHeaders,
        credentials,
        () => cancelled,
      );
    }

    return await executeBufferedRequest(
      method,
      url,
      body,
      effectiveHeaders,
      credentials,
      () => cancelled,
    );
  })());
}
