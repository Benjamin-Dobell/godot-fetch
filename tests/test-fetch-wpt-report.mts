import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Variant = {
  label: string;
  script: string;
  env: NodeJS.ProcessEnv;
  allowNonCanonicalSummary?: boolean;
};

type Summary = {
  summarySource: string;
  incomplete: boolean;
  passed: number;
  total: number;
  passRatePercent: number;
  failed: number;
  errors: number;
  filesRan: number;
  selectedFiles: number;
};

type FileSummary = {
  file: string;
  passed: number;
  total: number;
  error: null | string;
};

type FailedTest = {
  file: string;
  name: string;
  message: string;
};

type VariantResult = {
  summary: Summary;
  output: string;
  files: FileSummary[];
  failedTests: FailedTest[];
};

const marker = '[WPT_RUNNER_SUMMARY]';
const reportTimeoutMs = Number.parseInt(process.env.WPT_REPORT_TIMEOUT_MS ?? '1200000', 10);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(scriptDirectory, '../demo');

const variants: Variant[] = [
  {
    label: 'host/polyfill/conformant',
    script: '../tests/test-fetch-wpt.mts',
    env: {
      GODOT_FETCH_MODE: 'conformant',
      WPT_FETCH_IMPLEMENTATION: 'polyfill',
    },
  },
  {
    label: 'host/polyfill/fast',
    script: '../tests/test-fetch-wpt.mts',
    env: {
      GODOT_FETCH_MODE: 'fast',
      WPT_FETCH_IMPLEMENTATION: 'polyfill',
    },
  },
  {
    label: 'web/browser',
    script: '../tests/test-fetch-wpt-web.mts',
    allowNonCanonicalSummary: true,
    env: {
      GODOT_FETCH_MODE: 'conformant',
      WPT_WEB_FETCH_IMPLEMENTATION: 'browser',
      WPT_WEB_TIMEOUT_MS: '600000',
    },
  },
];

function parseSummary(output: string): Summary {
  const line = output.split(/\r?\n/).find((entry) => entry.includes(marker));
  if (!line) {
    throw new Error(`Missing ${marker} in command output.`);
  }

  const index = line.indexOf(marker);
  const parsed = JSON.parse(line.slice(index + marker.length)) as Summary;
  return parsed;
}

function parseFileSummaries(output: string): FileSummary[] {
  const lines = output.split(/\r?\n/);
  const out: FileSummary[] = [];
  const passPattern = /^\[WPT\]\[file\]\s+(.+)\s+(\d+)\/(\d+)\s+passed$/;
  const errorPattern = /^\[WPT\]\[file\]\s+(.+)\s+ERROR\s+(.+)$/;

  for (const line of lines) {
    const passMatch = line.match(passPattern);
    if (passMatch) {
      out.push({
        file: passMatch[1]!,
        passed: Number.parseInt(passMatch[2]!, 10),
        total: Number.parseInt(passMatch[3]!, 10),
        error: null,
      });
      continue;
    }

    const errorMatch = line.match(errorPattern);
    if (errorMatch) {
      out.push({
        file: errorMatch[1]!,
        passed: 0,
        total: 0,
        error: errorMatch[2]!,
      });
    }
  }

  return out;
}

function parseFailedTests(output: string): FailedTest[] {
  const lines = output.split(/\r?\n/);
  const out: FailedTest[] = [];
  const pattern = /^\[WPT\]\[fail\]\s+(.+?)\s+::\s+(.+?)\s+::\s*(.*)$/;

  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }
    out.push({
      file: match[1]!,
      name: match[2]!,
      message: match[3] ?? '',
    });
  }

  return out;
}

async function runVariant(variant: Variant): Promise<VariantResult> {
  const timeoutMs = Number.isFinite(reportTimeoutMs) && reportTimeoutMs > 0 ? reportTimeoutMs : 1200000;
  const child = spawn('pnpm', ['exec', 'node', variant.script], {
    cwd: demoRoot,
    env: {
      ...process.env,
      ...variant.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    output += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    output += text;
    process.stderr.write(text);
  });

  const status = await new Promise<number>((resolveStatus, rejectStatus) => {
    child.once('error', (error) => rejectStatus(error));
    child.once('close', (code) => resolveStatus(code ?? 1));
  });
  clearTimeout(timeout);

  if (didTimeout) {
    throw new Error(`Variant timed out after ${String(timeoutMs)}ms: ${variant.label}`);
  }

  if (status !== 0) {
    throw new Error(`Variant failed: ${variant.label}`);
  }

  let summary: Summary;
  try {
    summary = parseSummary(output);
  } catch (error) {
    const debugName = variant.label.replaceAll('/', '-');
    const debugPath = resolve(process.cwd(), 'tests/reports', `wpt-report-debug-${debugName}.log`);
    mkdirSync(resolve(process.cwd(), 'tests/reports'), { recursive: true });
    writeFileSync(debugPath, output, 'utf8');
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Debug log: ${debugPath}`,
    );
  }
  if ((summary.summarySource !== 'marker' || summary.incomplete) && !variant.allowNonCanonicalSummary) {
    throw new Error(
      `Variant ${variant.label} produced non-canonical summary (source=${summary.summarySource}, incomplete=${String(summary.incomplete)}).`,
    );
  }

  return {
    summary,
    output,
    files: parseFileSummaries(output),
    failedTests: parseFailedTests(output),
  };
}

function buildFileMap(files: FileSummary[]): Map<string, FileSummary> {
  const map = new Map<string, FileSummary>();
  for (const file of files) {
    map.set(file.file, file);
  }
  return map;
}

function fileFailed(file: FileSummary | undefined): boolean {
  if (!file) return false;
  if (file.error !== null) return true;
  return file.total > 0 && file.passed < file.total;
}

async function main(): Promise<void> {
  const rows: Array<{ label: string; summary: Summary; files: FileSummary[] }> = [];
  const resultsByLabel = new Map<string, VariantResult>();
  const reportDir = resolve(process.cwd(), 'tests/reports');
  mkdirSync(reportDir, { recursive: true });

  for (const variant of variants) {
    process.stdout.write(`[wpt-report] running ${variant.label}\n`);
    const result = await runVariant(variant);
    rows.push({ label: variant.label, summary: result.summary, files: result.files });
    resultsByLabel.set(variant.label, result);
  }

  const hostConformant = resultsByLabel.get('host/polyfill/conformant');
  const hostFast = resultsByLabel.get('host/polyfill/fast');
  if (!hostConformant || !hostFast) {
    throw new Error('Missing host variants needed for fast-vs-conformant comparison.');
  }

  const conformantFileMap = buildFileMap(hostConformant.files);
  const fastFileMap = buildFileMap(hostFast.files);
  const fastOnlyFailFiles = [...new Set([
    ...hostConformant.files.map((entry) => entry.file),
    ...hostFast.files.map((entry) => entry.file),
  ])]
    .filter((file) => fileFailed(fastFileMap.get(file)) && !fileFailed(conformantFileMap.get(file)))
    .sort((a, b) => a.localeCompare(b));

  const fastOnlyFailTests: FailedTest[] = [];
  if (fastOnlyFailFiles.length > 0) {
    process.stdout.write(
      `[wpt-report] running host fast/conformant debug reruns for ${String(fastOnlyFailFiles.length)} regression file(s)\n`,
    );
    const selected = fastOnlyFailFiles.join(',');
    const debugConformant = await runVariant({
      label: 'host/polyfill/conformant-debug-regression',
      script: '../tests/test-fetch-wpt.mts',
      env: {
        GODOT_FETCH_MODE: 'conformant',
        WPT_FETCH_IMPLEMENTATION: 'polyfill',
        WPT_DEBUG: '1',
        WPT_FILES: selected,
      },
    });
    const debugFast = await runVariant({
      label: 'host/polyfill/fast-debug-regression',
      script: '../tests/test-fetch-wpt.mts',
      env: {
        GODOT_FETCH_MODE: 'fast',
        WPT_FETCH_IMPLEMENTATION: 'polyfill',
        WPT_DEBUG: '1',
        WPT_FILES: selected,
      },
    });

    const conformantFailed = new Set(
      debugConformant.failedTests.map((entry) => `${entry.file}::${entry.name}`),
    );
    for (const test of debugFast.failedTests) {
      const key = `${test.file}::${test.name}`;
      if (conformantFailed.has(key)) {
        continue;
      }
      fastOnlyFailTests.push(test);
    }
  }

  process.stdout.write('[wpt-report] results\n');
  for (const row of rows) {
    process.stdout.write(
      `- ${row.label}: ${String(row.summary.passed)}/${String(row.summary.total)} (${String(row.summary.passRatePercent)}%) files=${String(row.summary.filesRan)}/${String(row.summary.selectedFiles)} failed=${String(row.summary.failed)} errors=${String(row.summary.errors)}\n`,
    );
  }
  process.stdout.write(
    `[wpt-report] host fast-only regression files=${String(fastOnlyFailFiles.length)}\n`,
  );
  for (const file of fastOnlyFailFiles) {
    process.stdout.write(`  - ${file}\n`);
  }
  process.stdout.write(
    `[wpt-report] host fast-only regression tests=${String(fastOnlyFailTests.length)}\n`,
  );
  for (const test of fastOnlyFailTests) {
    process.stdout.write(`  - ${test.file} :: ${test.name}\n`);
  }

  const now = new Date();
  const stamp = `${String(now.getFullYear())}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const reportPath = resolve(reportDir, `wpt-report-${stamp}.json`);
  writeFileSync(
    reportPath,
    `${JSON.stringify({
      generatedAt: now.toISOString(),
      variants: rows,
      hostFastOnlyRegressionFiles: fastOnlyFailFiles,
      hostFastOnlyRegressionTests: fastOnlyFailTests,
    }, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`[wpt-report] file=${reportPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
