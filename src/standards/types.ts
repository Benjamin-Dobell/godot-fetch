import { PackedByteArray } from 'godot.lib.api';
import type { Blob } from './blob';
import type { FormData } from './form-data';
import type { Headers } from './headers';
import type { ReadableStream, ReadableStreamLike } from './stream';
import type { URLSearchParams } from './url';

type HeaderEntry = [string, string];

export type HeadersInit = Headers | Array<HeaderEntry> | Record<string, string>;
export type URLSearchParamsInit = URLSearchParams | string | Array<HeaderEntry> | Record<string, string>;
export type RequestMode = 'cors' | 'navigate' | 'no-cors' | 'same-origin';
export type RequestCredentials = 'include' | 'omit' | 'same-origin';
export type RequestCache = 'default' | 'force-cache' | 'no-cache' | 'no-store' | 'only-if-cached' | 'reload';
export type RequestRedirect = 'error' | 'follow' | 'manual';
export type ReferrerPolicy = '' | 'no-referrer' | 'origin' | 'origin-when-cross-origin';
export type ResponseType = 'basic' | 'default' | 'error' | 'opaque' | 'opaqueredirect';
export type BodyInit =
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | FormData
  | PackedByteArray
  | ReadableStream
  | ReadableStreamLike
  | URLSearchParams
  | string;
