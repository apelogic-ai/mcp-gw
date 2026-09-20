import { domainToASCII } from "node:url";

const MAX_RAW_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const RECIPIENT_HEADERS = new Set(["to", "cc", "bcc"]);

/** Only canonical, public-style DNS domains are accepted as policy entries. */
export function canonicalPolicyDomain(value: string): string | undefined {
  const canonical = canonicalRecipientDomain(value);
  const topLevel = canonical?.split(".").at(-1);
  return canonical === value && canonical.includes(".") && topLevel && /[a-z]/.test(topLevel)
    ? canonical
    : undefined;
}

export function domainIsAllowed(recipient: string, allowed: string): boolean {
  return recipient === allowed || recipient.endsWith(`.${allowed}`);
}

export function recipientDomainsFromAddressList(value: string): string[] | undefined {
  if (!value || /[\r\n\0]/.test(value)) return undefined;
  const mailboxes = splitMailboxes(value);
  if (!mailboxes || mailboxes.length === 0) return undefined;
  const domains: string[] = [];
  for (const mailbox of mailboxes) {
    const trimmed = mailbox.trim();
    const firstAngle = trimmed.indexOf("<");
    let address = trimmed;
    if (firstAngle >= 0) {
      if (
        trimmed.slice(firstAngle + 1).includes("<") ||
        trimmed.indexOf(">") !== trimmed.length - 1 ||
        firstAngle === 0
      )
        return undefined;
      address = trimmed.slice(firstAngle + 1, -1);
    }
    if (!/^[^\s<>(),;:@"\\]+@[^\s<>(),;:@"\\]+$/u.test(address)) return undefined;
    const domain = canonicalRecipientDomain(address.slice(address.lastIndexOf("@") + 1));
    if (!domain) return undefined;
    domains.push(domain);
  }
  return [...new Set(domains)];
}

/** Parse only the exact raw Gmail message supplied to messages.send. */
export function recipientDomainsFromRawMessage(raw: string): string[] | undefined {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(raw) || raw.length % 4 === 1) return undefined;
  if (Math.floor((raw.length * 3) / 4) > MAX_RAW_MESSAGE_BYTES) return undefined;
  const unpadded = raw.replace(/=+$/, "");
  const padded = `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
  if (raw !== unpadded && raw !== padded) return undefined;
  const bytes = Buffer.from(raw.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (bytes.toString("base64url") !== unpadded) return undefined;
  const crlfEnd = bytes.indexOf("\r\n\r\n");
  const lfEnd = bytes.indexOf("\n\n");
  const headerEnd = crlfEnd >= 0 ? crlfEnd : lfEnd;
  if (headerEnd < 0 || headerEnd > MAX_HEADER_BYTES) return undefined;
  let headerText: string;
  try {
    headerText = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, headerEnd));
  } catch {
    return undefined;
  }
  if (/\r(?!\n)|\0/.test(headerText)) return undefined;
  const lines = headerText.replaceAll("\r\n", "\n").split("\n");
  const fields = new Map<string, string>();
  let lastName: string | undefined;
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (!lastName) return undefined;
      fields.set(lastName, `${fields.get(lastName) ?? ""} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) return undefined;
    const name = line.slice(0, colon).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name) || name.startsWith("resent-")) return undefined;
    if (RECIPIENT_HEADERS.has(name) && fields.has(name)) return undefined;
    fields.set(name, line.slice(colon + 1).trim());
    lastName = name;
  }
  const domains: string[] = [];
  for (const name of RECIPIENT_HEADERS) {
    const value = fields.get(name);
    if (value === undefined || value === "") continue;
    const parsed = recipientDomainsFromAddressList(value);
    if (!parsed) return undefined;
    domains.push(...parsed);
  }
  return domains.length > 0 ? [...new Set(domains)] : undefined;
}

function canonicalRecipientDomain(value: string): string | undefined {
  if (!value || value.endsWith(".") || value.includes(":")) return undefined;
  let ascii: string;
  try {
    ascii = domainToASCII(value).toLowerCase();
  } catch {
    return undefined;
  }
  if (ascii.length > 253 || !ascii) return undefined;
  const labels = ascii.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return undefined;
  }
  return ascii;
}

function splitMailboxes(value: string): string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angle = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "<") {
      if (angle) return undefined;
      angle = true;
    } else if (!quoted && char === ">") {
      if (!angle) return undefined;
      angle = false;
    } else if (!quoted && !angle && char === ",") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped || angle) return undefined;
  parts.push(value.slice(start));
  return parts.some((part) => !part.trim()) ? undefined : parts;
}
