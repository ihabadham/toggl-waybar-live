const signaturePattern = /^sha256=([0-9a-f]{64})$/;

function decodeHex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

export async function verifyTogglSignature(
  rawBody: Uint8Array<ArrayBuffer>,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  const match = signatureHeader?.match(signaturePattern);
  if (!match) {
    return false;
  }

  const signature = match[1];
  if (!signature) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify("HMAC", key, decodeHex(signature), rawBody);
}
