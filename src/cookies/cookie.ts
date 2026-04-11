type Timestamp = number;

export interface Cookie {
  domain: string;
  expiry: Timestamp; // Derived from Max-Age, or Expires (when Max-Age is omitted).
  httpOnly: boolean;
  name: string;
  path: string;
  secure: boolean;
  value: string;
}
