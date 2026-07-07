import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ["v1", iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(
    ".",
  );
}

export function decryptSecret(encrypted: string, keyBase64: string): string {
  const [version, ivBase64, tagBase64, ciphertextBase64] = encrypted.split(".");
  if (version !== "v1" || !ivBase64 || !tagBase64 || !ciphertextBase64) {
    throw new Error("Unsupported encrypted secret format");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    decodeKey(keyBase64),
    Buffer.from(ivBase64, "base64"),
    {
      authTagLength: TAG_BYTES,
    },
  );
  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`OAuth token encryption key must decode to ${String(KEY_BYTES)} bytes`);
  }

  return key;
}
