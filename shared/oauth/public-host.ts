/** Conservative public-endpoint policy for canonical dotted-decimal IPv4 hosts. */
export function isSpecialUseIpv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return true;
  }
  const [first = -1, second = -1, third = -1] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 31 && third === 196) ||
    (first === 192 && second === 52 && third === 193) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 175 && third === 48) ||
    (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

/** Reject WHATWG numeric host aliases instead of silently canonicalizing them to IPv4. */
export function hasCanonicalIpv4Hostname(value: string, parsed: URL): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname)) {
    return true;
  }
  const schemeEnd = value.indexOf("://");
  if (schemeEnd === -1) {
    return false;
  }
  const authorityStart = schemeEnd + 3;
  const authorityEndCandidates = ["/", "?", "#"]
    .map((delimiter) => value.indexOf(delimiter, authorityStart))
    .filter((index) => index !== -1);
  const authorityEnd =
    authorityEndCandidates.length === 0 ? value.length : Math.min(...authorityEndCandidates);
  const authority = value.slice(authorityStart, authorityEnd);
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1);
  const rawHostname = hostAndPort.replace(/:\d+$/, "").toLowerCase();
  return rawHostname === parsed.hostname;
}
