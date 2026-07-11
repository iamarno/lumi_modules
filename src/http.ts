/**
 * Module: http
 * Fetch arbitrary URLs and return the response.
 *
 * Commands:
 *   !fetch <url>                  — GET a URL and show the response
 *   !json <url> <field.path>      — GET JSON and extract a dotted field path
 *
 * Security:
 *   - Set HTTP_ALLOWED_DOMAINS in .env to restrict which hostnames may be fetched.
 *   - Requests to non-public addresses (loopback, private, link-local incl. the
 *     169.254.169.254 cloud-metadata endpoint) are always blocked, even when the
 *     allowlist is empty — enforced at connection time to defeat DNS rebinding
 *     and redirects to internal targets.
 */

import axios from "axios";
import { URL } from "url";
import * as dns from "dns";
import * as net from "net";
import * as http from "http";
import * as https from "https";
import { BotModule, ModuleRegistry, errMsg, envList } from "lumi";
import { BotConfig } from "lumi";

// ── SSRF guard ────────────────────────────────────────────────────────────────
// Block requests that resolve to non-public addresses (loopback, private,
// link-local incl. the 169.254.169.254 cloud-metadata endpoint, ULA, etc.).
// This is enforced in two layers: a synchronous pre-check for IP-literal URLs,
// and a custom DNS lookup on the HTTP(S) agents so hostname→private resolution
// and redirects to internal targets are blocked at connection time.

const SSRF_MARKER = "SSRF_BLOCKED";

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = [m[1], m[2], m[3], m[4]].map((x) => Number(x));
  if (o.some((n) => n > 255)) return null;
  return (((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!) >>> 0;
}

// base CIDR → prefix length; everything here is non-public / reserved
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],       // "this" network
  ["10.0.0.0", 8],      // private
  ["100.64.0.0", 10],   // CGNAT
  ["127.0.0.0", 8],     // loopback
  ["169.254.0.0", 16],  // link-local (incl. 169.254.169.254 metadata)
  ["172.16.0.0", 12],   // private
  ["192.0.0.0", 24],    // IETF protocol assignments
  ["192.0.2.0", 24],    // TEST-NET-1
  ["192.168.0.0", 16],  // private
  ["198.18.0.0", 15],   // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24],  // TEST-NET-3
  ["224.0.0.0", 4],     // multicast
  ["240.0.0.0", 4],     // reserved
];

function isBlockedV4(ip: string): boolean {
  const addr = ipv4ToInt(ip);
  if (addr === null) return true;
  for (const [base, bits] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((addr & mask) >>> 0) === ((ipv4ToInt(base)! & mask) >>> 0)) return true;
  }
  return false;
}

function isBlockedV6(ip: string): boolean {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct); // strip zone id
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]!);
  if (s === "::" || s === "::1") return true;                 // unspecified, loopback
  if (/^fe[89ab]/.test(s)) return true;                        // fe80::/10 link-local
  if (/^f[cd]/.test(s)) return true;                           // fc00::/7 unique-local
  if (s.startsWith("ff")) return true;                         // multicast
  return false;
}

/** True if the given IP literal is a non-public / reserved address. */
export function isBlockedIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return true; // not a valid IP → block
}

/** Synchronous pre-check: bad scheme, localhost, or an IP-literal private host. */
function preflightBlocked(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (net.isIP(host)) return isBlockedIp(host);
  return false;
}

// DNS lookup that rejects resolution to any non-public address. Used by the
// agents so hostname→private and redirect-to-internal are blocked at connect.
function guardedLookup(hostname: string, options: unknown, callback: unknown): void {
  const cb = (typeof options === "function" ? options : callback) as (
    err: NodeJS.ErrnoException | null,
    address?: unknown,
    family?: number
  ) => void;
  const opts = (typeof options === "function" ? {} : options) as dns.LookupOptions;
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as dns.LookupAddress[];
    for (const a of list) {
      if (isBlockedIp(a.address)) {
        return cb(new Error(`${SSRF_MARKER}: ${hostname} -> ${a.address}`));
      }
    }
    if ((opts as { all?: boolean }).all) return cb(null, list);
    return cb(null, list[0]!.address, list[0]!.family);
  });
}

const guardedHttpAgent = new http.Agent({ lookup: guardedLookup as never });
const guardedHttpsAgent = new https.Agent({ lookup: guardedLookup as never });

const mod: BotModule = {
  register(registry: ModuleRegistry, config: BotConfig) {
    registry.registerModule('http', 'Make HTTP requests from chat');

    const allowed = envList("HTTP_ALLOWED_DOMAINS");

    registry.register({
      name: "fetch",
      module: 'http',
      help: "HTTP GET a URL",
      description: "Only domains listed in HTTP_ALLOWED_DOMAINS are permitted.",
      usage: "<url>",
      handler: async ({ args }) => {
        if (!args.length) return "Usage: `!fetch <url>`";
        return fetchUrl(args[0]!, allowed);
      },
    });

    registry.register({
      name: "json",
      module: 'http',
      help: "GET JSON and extract a field",
      description: "Fetches JSON and extracts a nested value using dot notation, e.g. data.temperature.",
      usage: "<url> <field.path>",
      handler: async ({ args }) => {
        if (args.length < 2) return "Usage: `!json <url> <field.path>`";
        return fetchJson(args[0]!, args[1]!, allowed);
      },
    });
  },
};

function normalise(url: string): string {
  // Preserve an explicit scheme (so non-http(s) schemes are rejected by the
  // preflight rather than silently rewritten); default bare hosts to https.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : "https://" + url;
}

function isAllowed(rawUrl: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  try {
    const { hostname } = new URL(rawUrl);
    return allowed.some((d) => hostname === d || hostname.endsWith("." + d));
  } catch {
    return false;
  }
}

async function fetchUrl(rawUrl: string, allowed: string[]): Promise<string> {
  const url = normalise(rawUrl);
  if (preflightBlocked(url)) {
    return "❌ Blocked: only public http(s) URLs are allowed (no private/internal addresses).";
  }
  if (!isAllowed(url, allowed)) {
    return "❌ Domain not in HTTP_ALLOWED_DOMAINS list.";
  }
  try {
    const { data, headers, status } = await axios.get<string>(url, {
      timeout: 10_000,
      responseType: "text",
      maxContentLength: 50_000,
      maxRedirects: 5,
      httpAgent: guardedHttpAgent,
      httpsAgent: guardedHttpsAgent,
    });

    const ct = String(headers["content-type"] ?? "");
    let body = String(data);

    if (ct.includes("json")) {
      try {
        const pretty = JSON.stringify(JSON.parse(body), null, 2);
        body = pretty.length > 1500 ? pretty.slice(0, 1500) + "\n…(truncated)" : pretty;
        return `✅ **${url}** (HTTP ${status})\n\`\`\`json\n${body}\n\`\`\``;
      } catch {
        // fall through to plain text
      }
    }

    if (body.length > 1000) body = body.slice(0, 1000) + "\n…(truncated)";
    return `✅ **${url}** (HTTP ${status})\n\`\`\`\n${body}\n\`\`\``;
  } catch (err) {
    if (isSsrfError(err)) {
      return "❌ Blocked: target resolves to a private/internal address.";
    }
    if (axios.isAxiosError(err) && !err.response) {
      return `❌ Could not connect to \`${url}\``;
    }
    return `❌ Fetch error: ${errMsg(err)}`;
  }
}

/** Detect an error raised by the guarded DNS lookup (through axios wrapping). */
function isSsrfError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error && cur.message.includes(SSRF_MARKER)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

async function fetchJson(
  rawUrl: string,
  fieldPath: string,
  allowed: string[]
): Promise<string> {
  const url = normalise(rawUrl);
  if (preflightBlocked(url)) {
    return "❌ Blocked: only public http(s) URLs are allowed (no private/internal addresses).";
  }
  if (!isAllowed(url, allowed)) {
    return "❌ Domain not in HTTP_ALLOWED_DOMAINS list.";
  }
  try {
    const { data } = await axios.get(url, {
      timeout: 10_000,
      maxContentLength: 200_000,
      maxRedirects: 5,
      httpAgent: guardedHttpAgent,
      httpsAgent: guardedHttpsAgent,
    });

    // Walk the dotted path, supporting array indices (e.g. items.0.name)
    const parts = fieldPath.split(".");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let current: any = data;
    for (const part of parts) {
      if (current === null || current === undefined) break;
      current = current[part] ?? current[parseInt(part, 10)];
    }

    if (current === undefined) {
      return `❌ Field path \`${fieldPath}\` not found in response.`;
    }

    const result =
      typeof current === "object"
        ? JSON.stringify(current, null, 2)
        : String(current);
    const trimmed =
      result.length > 1200 ? result.slice(0, 1200) + "\n…(truncated)" : result;

    return `🔍 \`${fieldPath}\` from **${url}**:\n\`\`\`\n${trimmed}\n\`\`\``;
  } catch (err) {
    if (isSsrfError(err)) {
      return "❌ Blocked: target resolves to a private/internal address.";
    }
    return `❌ JSON fetch error: ${errMsg(err)}`;
  }
}

module.exports = mod;
module.exports.isBlockedIp = isBlockedIp;
