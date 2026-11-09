import type { Address } from "./types.js";

/**
 * A seller claims its page by signing a plain message from the seller wallet. The same text is
 * built here on both sides, so the signature the browser produces is the one the API verifies.
 */
export interface ClaimFields {
  address: Address;
  action: "claim" | "release";
  name: string;
  url: string;
  x: string;
  logoUrl: string;
  /** One line on what the seller sells, for the directory. */
  what: string;
  category: SellerCategory | "";
  /** Unix seconds; the API accepts it for ten minutes. */
  issuedAt: number;
  nonce: string;
}

export const SELLER_CATEGORIES = [
  "data",
  "ai",
  "payments",
  "compute",
  "social",
  "commerce",
  "finance",
  "identity",
  "other",
] as const;
export type SellerCategory = (typeof SELLER_CATEGORIES)[number];

export const CLAIM_LIMITS = { name: 40, url: 200, logoUrl: 300, x: 15, what: 80 } as const;

/** Names that would read as someone else's. A claim says "this wallet's owner", nothing more. */
const RESERVED_WORDS = [
  "assay",
  "celo",
  "ripio",
  "tether",
  "usdt",
  "usdc",
  "usat",
  "coinbase",
  "binance",
  "circle",
  "mento",
  "minipay",
  "opera",
  "google",
  "self",
  "loops",
  "official",
  "admin",
];

export function claimMessage(f: ClaimFields): string {
  return [
    "Assay page claim",
    `address: ${f.address.toLowerCase()}`,
    `action: ${f.action}`,
    `name: ${f.name}`,
    `url: ${f.url}`,
    `x: ${f.x}`,
    `logo: ${f.logoUrl}`,
    `what: ${f.what}`,
    `category: ${f.category}`,
    `issued: ${f.issuedAt}`,
    `nonce: ${f.nonce}`,
    "",
    "Signing this proves you control the wallet. It moves no funds.",
  ].join("\n");
}

/** Normalises a claim and says what is wrong with it, in words a person can act on. */
export function validateClaim(
  input: Partial<ClaimFields>,
): { ok: true; fields: ClaimFields } | { ok: false; error: string } {
  const address = String(input.address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return { ok: false, error: "Expected a Celo address." };
  const action = input.action === "release" ? "release" : "claim";
  const name = String(input.name ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const url = String(input.url ?? "").trim();
  const x = String(input.x ?? "")
    .trim()
    .replace(/^@/, "");
  const logoUrl = String(input.logoUrl ?? "").trim();
  const what = String(input.what ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const category = String(input.category ?? "")
    .trim()
    .toLowerCase();
  const issuedAt = Number(input.issuedAt);
  const nonce = String(input.nonce ?? "");
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) return { ok: false, error: "Missing issue time." };
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) return { ok: false, error: "Missing nonce." };
  if (action === "claim") {
    if (name.length < 2 || name.length > CLAIM_LIMITS.name)
      return { ok: false, error: `Name must be 2 to ${CLAIM_LIMITS.name} characters.` };
    if (!/^[\p{L}\p{N} .,'&_-]+$/u.test(name))
      return { ok: false, error: "Name can use letters, numbers, spaces and . , ' & _ -" };
    const words = name.toLowerCase().split(/[^a-z0-9]+/);
    const hit = RESERVED_WORDS.find((w) => words.includes(w) || name.toLowerCase().includes("assay"));
    if (hit) return { ok: false, error: `"${hit}" could be read as someone else's name. Use your own.` };
    if (url) {
      const bad = checkHttpsUrl(url, CLAIM_LIMITS.url);
      if (bad) return { ok: false, error: `Website: ${bad}` };
    }
    if (logoUrl) {
      const bad = checkHttpsUrl(logoUrl, CLAIM_LIMITS.logoUrl);
      if (bad) return { ok: false, error: `Logo: ${bad}` };
      if (!/\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(logoUrl))
        return { ok: false, error: "Logo must be a PNG, JPG, WebP, GIF or SVG link." };
    }
    if (x && !/^[A-Za-z0-9_]{1,15}$/.test(x))
      return { ok: false, error: "X handle: letters, numbers and _ only." };
    if (what.length > CLAIM_LIMITS.what)
      return { ok: false, error: `What you sell: at most ${CLAIM_LIMITS.what} characters.` };
    if (what && /[<>]/.test(what))
      return { ok: false, error: "What you sell: plain words, no angle brackets." };
    if (category && !(SELLER_CATEGORIES as readonly string[]).includes(category))
      return { ok: false, error: `Category must be one of ${SELLER_CATEGORIES.join(", ")}.` };
  }
  return {
    ok: true,
    fields: {
      address: address as Address,
      action,
      name: action === "claim" ? name : "",
      url: action === "claim" ? url : "",
      x: action === "claim" ? x : "",
      logoUrl: action === "claim" ? logoUrl : "",
      what: action === "claim" ? what : "",
      category: action === "claim" ? (category as SellerCategory | "") : "",
      issuedAt,
      nonce,
    },
  };
}

// The core package is built without the DOM library; URL exists at runtime in Node 18+ and browsers.
declare const URL: new (
  input: string,
) => { protocol: string; username: string; password: string; hostname: string };

/** An https link to a public host, or the reason it is not. */
export function checkHttpsUrl(raw: string, max: number): string | null {
  if (raw.length > max) return `at most ${max} characters.`;
  let u: { protocol: string; username: string; password: string; hostname: string };
  try {
    u = new URL(raw);
  } catch {
    return "not a valid link.";
  }
  if (u.protocol !== "https:") return "must start with https://";
  if (u.username || u.password) return "must not contain a password.";
  if (isPrivateHost(u.hostname)) return "must be a public website.";
  return null;
}

/** Hosts that point inside a network rather than at the public internet. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".lan") ||
    h.endsWith(".home.arpa")
  )
    return true;
  if (!h.includes(".") && !h.includes(":")) return true;
  if (/^\[?[0-9a-f:.]+\]?$/i.test(h) && h.includes(":")) return isPrivateIp(h);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIp(h);
  return false;
}

/** The four octets of a dotted IPv4 address, or null. */
function ipv4Octets(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** The eight 16-bit groups of an IPv6 address (with "::" and a dotted IPv4 tail expanded), or null. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, ""); // drop a zone id
  const tail = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const o = ipv4Octets(tail[2]!);
    if (!o) return null;
    s = `${tail[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (x: string) => (x === "" ? [] : x.split(":"));
  const head = part(halves[0]!);
  const rest = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => Number.parseInt(g, 16));
}

function privateV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF assignments, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a! >= 224 // multicast, reserved, broadcast
  );
}

/**
 * True for any address a server must not be pointed at: loopback, private, link-local, CGNAT,
 * documentation, multicast and unspecified ranges, in IPv4 or IPv6 form, including IPv4 addresses
 * written inside IPv6 (IPv4-mapped ::ffff:7f00:1, IPv4-compatible, NAT64 64:ff9b::/96, 6to4
 * 2002::/16). Anything that does not parse as an IP address is treated as private.
 */
export function isPrivateIp(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, "");
  const v4 = ipv4Octets(host);
  if (v4) return privateV4(v4);
  const g = ipv6Groups(host);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.slice(0, 5).every((x) => x === 0)) {
    if (g[5] === 0xffff) return embedded(g[6]!, g[7]!); // ::ffff:a.b.c.d
    if (g[5] === 0) return g[6] === 0 && g[7]! <= 1 ? true : embedded(g[6]!, g[7]!); // ::, ::1, ::a.b.c.d
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!, g[7]!);
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4 carries an IPv4 address
  return (
    (g[0]! & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g[0]! & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g[0]! & 0xffc0) === 0xfec0 || // site-local fec0::/10 (deprecated)
    (g[0]! & 0xff00) === 0xff00 || // multicast
    (g[0] === 0x2001 && g[1] === 0x0db8) || // documentation
    (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) // discard-only 100::/64
  );
}
