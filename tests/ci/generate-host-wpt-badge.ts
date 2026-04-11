import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function pickColor(passRate: number): string {
  if (passRate >= 95) {
    return '#4c1';
  }
  if (passRate >= 90) {
    return '#97CA00';
  }
  if (passRate >= 80) {
    return '#a4a61d';
  }
  if (passRate >= 70) {
    return '#dfb317';
  }
  return '#e05d44';
}

function buildBadgeSvg(label: string, value: string, color: string): string {
  const labelWidth = Math.max(56, 7 * label.length + 12);
  const valueWidth = Math.max(40, 7 * value.length + 12);
  const totalWidth = labelWidth + valueWidth;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(totalWidth)}" height="20" role="img" aria-label="${label}: ${value}">`,
    '<linearGradient id="s" x2="0" y2="100%">',
    '<stop offset="0" stop-color="#bbb" stop-opacity=".1"/>',
    '<stop offset="1" stop-opacity=".1"/>',
    '</linearGradient>',
    '<clipPath id="r"><rect width="' + String(totalWidth) + '" height="20" rx="3" fill="#fff"/></clipPath>',
    '<g clip-path="url(#r)">',
    `<rect width="${String(labelWidth)}" height="20" fill="#555"/>`,
    `<rect x="${String(labelWidth)}" width="${String(valueWidth)}" height="20" fill="${color}"/>`,
    `<rect width="${String(totalWidth)}" height="20" fill="url(#s)"/>`,
    '</g>',
    '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">',
    `<text x="${String(Math.floor(labelWidth / 2))}" y="15" fill="#010101" fill-opacity=".3">${label}</text>`,
    `<text x="${String(Math.floor(labelWidth / 2))}" y="14">${label}</text>`,
    `<text x="${String(labelWidth + Math.floor(valueWidth / 2))}" y="15" fill="#010101" fill-opacity=".3">${value}</text>`,
    `<text x="${String(labelWidth + Math.floor(valueWidth / 2))}" y="14">${value}</text>`,
    '</g>',
    '</svg>',
    '',
  ].join('');
}

const rateArg = process.argv[2];
const parsedRate = Number.parseFloat(rateArg ?? '');

if (!Number.isFinite(parsedRate)) {
  throw new Error(`Invalid pass rate: ${String(rateArg)}`);
}

const passRate = Math.max(0, Math.min(100, parsedRate));
const label = 'compliance';
const value = `${passRate.toFixed(1)}%`;
const color = pickColor(passRate);
const svg = buildBadgeSvg(label, value, color);
const outputPath = resolve(process.cwd(), '.github/badges/wpt-host-pass-rate.svg');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, svg, 'utf8');

