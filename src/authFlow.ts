export type AuthEvent =
  | { kind: "password"; secretKey: string; wrong: boolean }
  | { kind: "passphrase"; secretKey: string; wrong: boolean }
  | { kind: "hostkey"; label: string; known: string; got: string }
  | null;

export function parseAuthError(err: unknown): AuthEvent {
  const s = String(err);
  const [tag, ...rest] = s.split("\t");
  switch (tag) {
    case "AUTH_PASSWORD_REQUIRED":
      return { kind: "password", secretKey: rest[0] ?? "", wrong: false };
    case "AUTH_PASSWORD_WRONG":
      return { kind: "password", secretKey: rest[0] ?? "", wrong: true };
    case "AUTH_PASSPHRASE_REQUIRED":
      return { kind: "passphrase", secretKey: rest[0] ?? "", wrong: false };
    case "AUTH_PASSPHRASE_WRONG":
      return { kind: "passphrase", secretKey: rest[0] ?? "", wrong: true };
    case "HOSTKEY_MISMATCH":
      return { kind: "hostkey", label: rest[0] ?? "", known: rest[1] ?? "", got: rest[2] ?? "" };
    default:
      return null;
  }
}
