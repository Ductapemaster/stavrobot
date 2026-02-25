import { encode } from "@toon-format/toon";

export function encodeToToon(value: unknown): string {
  return encode(value, { indent: 2, delimiter: "," });
}
