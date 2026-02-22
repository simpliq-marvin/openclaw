import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SHORT_ID_LENGTH = 5;

export function buildAgentOrchShortId(input: string): string {
  const digest = crypto.createHash("sha1").update(input).digest();
  let value = 0;
  for (let idx = 0; idx < SHORT_ID_LENGTH; idx += 1) {
    value = (value << 8) | digest[idx];
  }
  let out = "";
  for (let idx = 0; idx < SHORT_ID_LENGTH; idx += 1) {
    out = ALPHABET[value % ALPHABET.length] + out;
    value = Math.floor(value / ALPHABET.length);
  }
  return out;
}
