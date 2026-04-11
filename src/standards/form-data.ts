export class FormData {
  private readonly boundary: string;
  private readonly fields: Array<{ name: string; value: string }> = [];

  constructor() {
    this.boundary = `----godot-fetch-${String(Math.random()).slice(2)}`;
  }

  append(name: string, value: string): void {
    this.fields.push({ name: String(name), value: String(value) });
  }

  getContentType(): string {
    return `multipart/form-data; boundary=${this.boundary}`;
  }

  toMultipartBody(): string {
    if (this.fields.length === 0) {
      return '';
    }

    const lines: string[] = [];
    for (const field of this.fields) {
      lines.push(`--${this.boundary}`);
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
