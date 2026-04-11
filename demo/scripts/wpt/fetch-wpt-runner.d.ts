export type WptFetchMode = 'conformant' | 'fast';
export type WptFetchImplementation = 'browser' | 'polyfill';

export type WptRunOptions = {
  files?: string[];
  debug?: boolean;
  fetchMode?: WptFetchMode;
  fetchImplementation?: WptFetchImplementation;
  host?: string;
  domainWww?: string;
  domainWww2?: string;
  httpPort0?: number;
  httpPort1?: number;
  httpsPort0?: number;
  httpsPort1?: number;
  h2Port0?: number;
  timeoutMs?: number;
};

export type WptSummary = {
  feature: string;
  fetchImplementation: WptFetchImplementation;
  filesRan: number;
  filesTotal: number;
  passed: number;
  failed: number;
  errors: number;
  total: number;
};

export function parseArgs(): {
  files: string[];
  debug: boolean;
  fetchMode: WptFetchMode;
  fetchImplementation: WptFetchImplementation;
  host: string;
  domainWww: string;
  domainWww2: string;
  httpPort0: number;
  httpPort1: number;
  httpsPort0: number;
  httpsPort1: number;
  h2Port0: number;
  timeoutMs: number;
};

export function runWptSuite(options?: WptRunOptions): Promise<WptSummary>;
