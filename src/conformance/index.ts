export type ConformanceMode = 'conformant' | 'fast';
export type Utf8DecodingConformance = 'conformant' | 'fast';

export type FetchConformance = {
  utf8Decoding: Utf8DecodingConformance;
};

const DEFAULT_CONFORMANCE: FetchConformance = {
  utf8Decoding: 'conformant',
};

let conformance: FetchConformance = { ...DEFAULT_CONFORMANCE };

export function getConformance(): Readonly<FetchConformance> {
  return { ...conformance };
}

export function setConformance(next: Partial<FetchConformance>): Readonly<FetchConformance> {
  conformance = {
    ...conformance,
    ...next,
  };
  return conformance;
}

export function setConformanceMode(mode: ConformanceMode): Readonly<FetchConformance> {
  conformance = {
    ...conformance,
    utf8Decoding: mode === 'fast' ? 'fast' : 'conformant',
  };
  return conformance;
}

export function resetConformance(): Readonly<FetchConformance> {
  conformance = { ...DEFAULT_CONFORMANCE };
  return conformance;
}
