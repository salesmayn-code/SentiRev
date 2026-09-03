import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const VERSION = "v1";

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/**
 * Seal small server-owned values for an HttpOnly cookie.
 * The caller is responsible for validating the unsealed value.
 */
export function seal(value: unknown, secret: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [VERSION, encode(iv), encode(ciphertext), encode(authTag)].join(".");
}

export function unseal<T>(value: string, secret: string): T | null {
  try {
    const [version, encodedIv, encodedCiphertext, encodedAuthTag] = value.split(".");
    if (
      version !== VERSION ||
      !encodedIv ||
      !encodedCiphertext ||
      !encodedAuthTag
    ) {
      return null;
    }

    const decipher = createDecipheriv(
      ALGORITHM,
      deriveKey(secret),
      decode(encodedIv),
    );
    decipher.setAuthTag(decode(encodedAuthTag));
    const plaintext = Buffer.concat([
      decipher.update(decode(encodedCiphertext)),
      decipher.final(),
    ]).toString("utf8");

    return JSON.parse(plaintext) as T;
  } catch {
    return null;
  }
}
