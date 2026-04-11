import { AbortController, AbortSignal } from '../standards/abort';
import { Blob } from '../standards/blob';
import { DOMException } from '../standards/dom-exception';
import { TextDecoder, TextEncoder } from '../standards/encoding';
import { Fetch } from '../standards/fetch';
import { FormData } from '../standards/form-data';
import { Headers } from '../standards/headers';
import { Request } from '../standards/request';
import { Response } from '../standards/response';
import { ReadableStream, WritableStream } from '../standards/stream';
import { URL, URLSearchParams } from '../standards/url';

const GODOT_FETCH = Symbol('godot-fetch');
type TaggedFetch = Fetch & { [GODOT_FETCH]?: true };

export interface InstallFetchImplementationOptions {
  installWebApis?: 'always' | 'if-missing' | 'never';
  overwriteFetch?: boolean;
}

function installWebStandards(target: Record<string, unknown>, mode: 'always' | 'if-missing' | 'never'): void {
  if (mode === 'never') {
    return;
  }

  const standards: Record<string, unknown> = {
    AbortController,
    AbortSignal,
    Blob,
    DOMException,
    FormData,
    Headers,
    ReadableStream,
    WritableStream,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
  };

  for (const [key, value] of Object.entries(standards)) {
    if (mode === 'if-missing' && key in target) {
      continue;
    }
    target[key] = value;
  }
}

export function isGodotFetchImplementation(value: unknown): value is Fetch {
  if (typeof value !== 'function') {
    return false;
  }

  return (value as TaggedFetch)[GODOT_FETCH] === true;
}

export function markAsGodotFetchImplementation(fetchImpl: unknown): void {
  if (typeof fetchImpl !== 'function') {
    return;
  }

  (fetchImpl as TaggedFetch)[GODOT_FETCH] = true;
}

export function installFetchImplementation(
  target: Record<string, unknown>,
  fetchImplementation: Fetch,
  options: InstallFetchImplementationOptions = {},
): void {
  installWebStandards(target, options.installWebApis ?? 'always');

  if (options.overwriteFetch === false && typeof (target as { fetch?: unknown }).fetch === 'function') {
    return;
  }

  target.fetch = fetchImplementation;
  markAsGodotFetchImplementation(fetchImplementation);
}
