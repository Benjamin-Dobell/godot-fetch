const DOM_EXCEPTION_CODE_BY_NAME: Record<string, number> = {
  AbortError: 20,
};

function getDomExceptionCode(name: string): number {
  return DOM_EXCEPTION_CODE_BY_NAME[name] ?? 0;
}

export class DOMException extends Error {
  readonly code: number;

  constructor(message = '', name = 'Error') {
    super(String(message));
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = String(name);
    this.code = getDomExceptionCode(this.name);
  }
}
