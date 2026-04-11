import { FormData } from './form-data';
import { URLSearchParams } from './url';

function parseMultipart(contentType: string, bodyText: string, formData: FormData): boolean {
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);

  if (!boundaryMatch) {
    return false;
  }

  const boundary = boundaryMatch[1]!.trim().replace(/^"|"$/g, '');

  if (boundary.length === 0) {
    return false;
  }

  const marker = `--${boundary}`;
  const parts = bodyText.split(marker);
  let appended = false;

  for (const rawPart of parts) {
    const part = rawPart.trim();

    if (part.length === 0 || part === '--') {
      continue;
    }

    const headerBodySplit = part.split(/\r?\n\r?\n/);

    if (headerBodySplit.length < 2) {
      continue;
    }
    const headers = headerBodySplit[0] ?? '';
    const value = (headerBodySplit.slice(1).join('\n\n')).replace(/\r?\n--$/, '');
    const dispositionLine = headers
      .split(/\r?\n/)
      .find((line) => line.toLowerCase().startsWith('content-disposition:'));

    if (!dispositionLine) {
      continue;
    }

    const nameMatch = dispositionLine.match(/name="([^"]+)"/i);

    if (!nameMatch) {
      continue;
    }

    formData.append(nameMatch[1]!, value.replace(/\r?\n$/, ''));
    appended = true;
  }
  return appended;
}

export function parseFormDataFromBody(contentType: null | string, bodyText: string): FormData {
  const normalized = (contentType ?? '').toLowerCase();
  const formData = new FormData();

  if (normalized.startsWith('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(bodyText);
    params.forEach((value, key) => formData.append(key, value));
    return formData;
  }

  if (normalized.startsWith('multipart/form-data')) {
    if (bodyText.trim().length === 0) {
      return formData;
    }

    if (parseMultipart(normalized, bodyText, formData)) {
      return formData;
    }
  }

  throw new TypeError('Could not parse body as FormData');
}
