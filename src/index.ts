import { PackedByteArray } from 'godot.lib.api';
import { isGodotFetchImplementation, markAsGodotFetchImplementation } from './utils/install';
import {
    AbortController as StandardsAbortController,
    AbortSignal as StandardsAbortSignal,
    Blob as StandardsBlob,
    DOMException as StandardsDOMException,
    type Fetch,
    type FetchBodyInit,
    FormData as StandardsFormData,
    Headers as StandardsHeaders,
    ReadableStream as StandardsReadableStream,
    Request as StandardsRequest,
    Response as StandardsResponse,
    TextDecoder as StandardsTextDecoder,
    TextEncoder as StandardsTextEncoder,
    FetchRequestInit,
    URL as StandardsURL,
    URLSearchParams as StandardsURLSearchParams,
    WritableStream as StandardsWritableStream,
    type HeadersInit,
    type RequestInfo,
    type RequestInit,
    fetch as ourFetch,
} from './standards';

function toWrappedBody(body: null | FetchBodyInit | undefined): null | FetchBodyInit | undefined {
    if (body instanceof PackedByteArray) {
        return new Uint8Array(body.to_array_buffer());
    }

    return body;
}

function toWrappedInit(init?: FetchRequestInit): undefined | FetchRequestInit {
    if (!init) {
        return init;
    }

    if (!(init.body instanceof PackedByteArray)) {
        return init;
    }

    return {
        ...init,
        body: toWrappedBody(init.body),
    };
}

function wrapFetchWithPackedByteArraySupport(fetchImpl: Fetch): Fetch {
    const wrapped: Fetch = async (input: RequestInfo, init?: FetchRequestInit) => {
        return await fetchImpl(input, toWrappedInit(init));
    };

    markAsGodotFetchImplementation(wrapped);
    return wrapped;
}

function selectWebFetchImplementation(target: Record<string, unknown>): Fetch {
    const existingFetch = (target as { fetch?: unknown }).fetch;

    if (typeof existingFetch === 'function') {
        if (isGodotFetchImplementation(existingFetch)) {
            return existingFetch as Fetch;
        }

        return wrapFetchWithPackedByteArraySupport(existingFetch as Fetch);
    }

    return ourFetch as Fetch;
}

export const fetch = selectWebFetchImplementation(globalThis as Record<string, unknown>);

const webGlobals = globalThis as Record<string, unknown>;

function selectWebConstructor<T>(name: string, fallback: T): T {
    const value = webGlobals[name];
    return typeof value === 'function' ? (value as T) : fallback;
}

const AbortController = selectWebConstructor('AbortController', StandardsAbortController);
const AbortSignal = selectWebConstructor('AbortSignal', StandardsAbortSignal);
const Blob = selectWebConstructor('Blob', StandardsBlob);
const DOMException = selectWebConstructor('DOMException', StandardsDOMException);
const FormData = selectWebConstructor('FormData', StandardsFormData);
const Headers = selectWebConstructor('Headers', StandardsHeaders);
const ReadableStream = selectWebConstructor('ReadableStream', StandardsReadableStream);
const Request = selectWebConstructor('Request', StandardsRequest);
const Response = selectWebConstructor('Response', StandardsResponse);
const TextDecoder = selectWebConstructor('TextDecoder', StandardsTextDecoder);
const TextEncoder = selectWebConstructor('TextEncoder', StandardsTextEncoder);
const URL = selectWebConstructor('URL', StandardsURL);
const URLSearchParams = selectWebConstructor('URLSearchParams', StandardsURLSearchParams);
const WritableStream = selectWebConstructor('WritableStream', StandardsWritableStream);

export {
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
    type HeadersInit,
    type RequestInfo,
    type RequestInit,
};
