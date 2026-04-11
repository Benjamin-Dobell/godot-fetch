import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseRate(text: string): null | number {
  const ariaMatch = text.match(/aria-label="compliance:\s*([0-9]+(?:\.[0-9]+)?)%"/i);
  if (ariaMatch) {
    return Number.parseFloat(ariaMatch[1]);
  }

  const textMatch = text.match(/>\s*([0-9]+(?:\.[0-9]+)?)%\s*<\/text>/i);
  if (textMatch) {
    return Number.parseFloat(textMatch[1]);
  }

  return null;
}

const currentArg = process.argv[2];
const currentRate = Number.parseFloat(currentArg ?? '');
if (!Number.isFinite(currentRate)) {
  throw new Error(`Invalid current host WPT pass rate: ${String(currentArg)}`);
}

const badgePath = resolve(process.cwd(), '.github/badges/wpt-host-pass-rate.svg');
if (!existsSync(badgePath)) {
  console.log('[WPT_BADGE_GUARD] baseline badge missing; skipping no-regression check');
  process.exit(0);
}

const badgeText = readFileSync(badgePath, 'utf8');
const baselineRate = parseRate(badgeText);
if (baselineRate === null || !Number.isFinite(baselineRate)) {
  throw new Error('Unable to parse baseline host WPT pass rate from badge SVG');
}

if (currentRate < baselineRate) {
  throw new Error(
    `[WPT_BADGE_GUARD] host WPT pass rate regressed: current=${currentRate.toFixed(1)}% baseline=${baselineRate.toFixed(1)}%`,
  );
}

console.log(
  `[WPT_BADGE_GUARD] no regression: current=${currentRate.toFixed(1)}% baseline=${baselineRate.toFixed(1)}%`,
);

