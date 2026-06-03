import { Blob } from './blob';

type FormDataEntryValue = string | Blob;

export class FormData {
  private readonly boundary: string;
  private readonly fields: Array<{ name: string; value: FormDataEntryValue }> = [];

  constructor() {
    this.boundary = `----godot-fetch-${String(Math.random()).slice(2)}`;
  }

  append(name: string, value: FormDataEntryValue): void {
    this.fields.push({
      name: String(name),
      value: value instanceof Blob ? value : String(value),
    });
  }

  get(name: string): FormDataEntryValue | null {
    const normalizedName = String(name);
    const field = this.fields.find((entry) => entry.name === normalizedName);
    return field ? field.value : null;
  }

  has(name: string): boolean {
    const normalizedName = String(name);
    return this.fields.some((entry) => entry.name === normalizedName);
  }

  *entries(): IterableIterator<[string, FormDataEntryValue]> {
    for (const field of this.fields) {
      yield [field.name, field.value];
    }
  }

  [Symbol.iterator](): IterableIterator<[string, FormDataEntryValue]> {
    return this.entries();
  }

  isEmpty(): boolean {
    return this.fields.length === 0;
  }

  getContentType(): string {
    return `multipart/form-data; boundary=${this.boundary}`;
  }

  toMultipartBody(): string {
    const lines: string[] = [];
    for (const field of this.fields) {
      lines.push(`--${this.boundary}`);
      if (field.value instanceof Blob) {
        lines.push(`Content-Disposition: form-data; name="${field.name}"; filename="blob"`);
        if (field.value.type.length > 0) {
          lines.push(`Content-Type: ${field.value.type}`);
        }
        lines.push('');
        lines.push(field.value.text());
        continue;
      }
      lines.push(`Content-Disposition: form-data; name="${field.name}"`);
      lines.push('');
      lines.push(field.value);
    }
    lines.push(`--${this.boundary}--`);
    lines.push('');
    return lines.join('\r\n');
  }
}

type AbortListener = () => void;
