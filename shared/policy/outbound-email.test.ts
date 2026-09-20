import { describe, expect, test } from "bun:test";

import {
  canonicalPolicyDomain,
  domainIsAllowed,
  recipientDomainsFromAddressList,
  recipientDomainsFromRawMessage,
} from "./outbound-email";

const encode = (message: string): string => Buffer.from(message).toString("base64url");

describe("outbound email recipient parsing", () => {
  test("normalizes display names, folded encoded headers, IDNs and all recipient fields", () => {
    const raw = encode(
      'From: User <sender@example.org>\r\nTo: "Doe, Jane" <jane@team.example.org>,\r\n =?UTF-8?B?VGVzdA==?= <other@bücher.example>\r\nCc: Cc <cc@example.org>\r\nBcc: hidden@EXAMPLE.ORG\r\nSubject: Hello\r\n\r\nBody',
    );
    expect(recipientDomainsFromRawMessage(raw)).toEqual([
      "team.example.org",
      "xn--bcher-kva.example",
      "example.org",
    ]);
    expect(
      recipientDomainsFromAddressList('"Doe, Jane" <jane@example.org>, test@team.example.org'),
    ).toEqual(["example.org", "team.example.org"]);
  });

  test("rejects malformed, ambiguous, missing and noncanonical MIME", () => {
    for (const message of [
      "From: sender@example.org\r\n\r\nBody",
      "To: a@example.org\r\nTo: b@outside.org\r\n\r\nBody",
      "To: a@example.org\r\nResent-To: b@outside.org\r\n\r\nBody",
      "To: a@example.org, b@\r\n\r\nBody",
      'To: "unterminated <a@example.org>\r\n\r\nBody',
      "To: a@example.org\r\nBad line\r\n\r\nBody",
    ]) {
      expect(recipientDomainsFromRawMessage(encode(message))).toBeUndefined();
    }
    expect(recipientDomainsFromRawMessage("not base64url!")).toBeUndefined();
    expect(
      recipientDomainsFromRawMessage(encode("To: a@example.org\r\n\r\nBody") + "="),
    ).toBeUndefined();
  });

  test("matches exact domains and subdomains without suffix confusion", () => {
    expect(canonicalPolicyDomain("example.org")).toBe("example.org");
    expect(canonicalPolicyDomain("bücher.example")).toBeUndefined();
    expect(canonicalPolicyDomain("1.2.3.4")).toBeUndefined();
    expect(domainIsAllowed("a.example.org", "example.org")).toBe(true);
    expect(domainIsAllowed("badexample.org", "example.org")).toBe(false);
  });
});
