/** Hosts that WHATWG URL parses as IPv4 but rewrites to a different canonical spelling. */
export const NONCANONICAL_WHATWG_IPV4_HOSTS = [
  "0x7f.0.0.1",
  "127.0.0.0x1",
  "0x7f.1",
  "0x7f.0x0.0x0.0x1",
  "0177.0.0.1",
  "127.1",
  "2130706433",
  "0x08080808",
  "010.010.010.010",
  "8.8.2056",
  "8.8.0x808",
  "example.1",
  "example.0x1",
] as const;

/** Canonical representatives of IPv4 blocks that are not public Internet endpoints. */
export const NONPUBLIC_SPECIAL_USE_IPV4_HOSTS = [
  "0.1.2.3",
  "10.1.2.3",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.1.1",
  "172.16.0.1",
  "192.0.0.1",
  "192.0.2.1",
  "192.31.196.1",
  "192.52.193.1",
  "192.88.99.1",
  "192.168.1.1",
  "192.175.48.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
] as const;

export const CANONICAL_PUBLIC_IPV4_HOSTS = ["8.8.8.8", "93.184.216.34"] as const;
