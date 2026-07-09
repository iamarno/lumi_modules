/**
 * Module: http
 * Fetch arbitrary URLs and return the response.
 *
 * Commands:
 *   !fetch <url>                  — GET a URL and show the response
 *   !json <url> <field.path>      — GET JSON and extract a dotted field path
 *
 * Security: set HTTP_ALLOWED_DOMAINS in .env to restrict allowed hostnames.
 */

import axios from "axios";
import { URL } from "url";
import { BotModule, ModuleRegistry, errMsg } from "lumi";
import { BotConfig } from "lumi";

const mod: BotModule = {
  register(registry: ModuleRegistry, config: BotConfig) {
    registry.registerModule('http', 'Make HTTP requests from chat');

    const allowed = config.httpAllowedDomains;

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
  return url.startsWith("http://") || url.startsWith("https://")
    ? url
    : "https://" + url;
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
  if (!isAllowed(url, allowed)) {
    return "❌ Domain not in HTTP_ALLOWED_DOMAINS list.";
  }
  try {
    const { data, headers, status } = await axios.get<string>(url, {
      timeout: 10_000,
      responseType: "text",
      maxContentLength: 50_000,
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
    if (axios.isAxiosError(err) && !err.response) {
      return `❌ Could not connect to \`${url}\``;
    }
    return `❌ Fetch error: ${errMsg(err)}`;
  }
}

async function fetchJson(
  rawUrl: string,
  fieldPath: string,
  allowed: string[]
): Promise<string> {
  const url = normalise(rawUrl);
  if (!isAllowed(url, allowed)) {
    return "❌ Domain not in HTTP_ALLOWED_DOMAINS list.";
  }
  try {
    const { data } = await axios.get(url, {
      timeout: 10_000,
      maxContentLength: 200_000,
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
    return `❌ JSON fetch error: ${errMsg(err)}`;
  }
}

module.exports = mod;
