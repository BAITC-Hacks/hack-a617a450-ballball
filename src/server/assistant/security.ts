import { Buffer } from "node:buffer";

/** Used before tool/model output is traced, returned, or stored in history. */
export function createRedactor(env: Record<string, string | undefined> = process.env): (text: string) => string {
  const secrets = [env.OPENAI_API_KEY, env.OPENAI_MODEL, env.EKT_API_USERNAME, env.EKT_API_PASSWORD].filter((s): s is string => Boolean(s));
  if (env.EKT_API_USERNAME && env.EKT_API_PASSWORD) {
    secrets.push(Buffer.from(`${env.EKT_API_USERNAME}:${env.EKT_API_PASSWORD}`).toString("base64"));
  }
  return text => {
    let result = text;
    for (const secret of secrets.sort((a, b) => b.length - a.length)) result = result.split(secret).join("[REDACTED]");
    return result.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  };
}

/** Reject likely card numbers before model calls or conversation storage. */
export function containsCardNumber(text: string): boolean {
  return [...text.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)].some(match => {
    const digits = match[0].replace(/\D/g, "");
    let sum = 0;
    for (let i = digits.length - 1, n = 0; i >= 0; i--, n++) {
      let value = Number(digits[i]);
      if (n % 2) { value *= 2; if (value > 9) value -= 9; }
      sum += value;
    }
    return sum > 0 && sum % 10 === 0;
  });
}
