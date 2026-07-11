/**
 * Feature Module Template — copy this file to src/modules/mymodule.ts
 *
 * The bot auto-discovers all .ts/.js files in src/modules/ (files starting
 * with _ are skipped). Each module must export a BotModule object as
 * `module.exports`.
 *
 * Steps:
 *  1. Copy this file to src/modules/mymodule.ts
 *  2. Choose a short, lowercase module name (e.g. "mymodule")
 *  3. Call registry.registerModule() with a one-line description
 *  4. Implement your commands and handlers
 *  5. Restart the bot — it auto-loads the new file
 *
 * ── Help system ──────────────────────────────────────────────────────────────
 * Every module must call registry.registerModule() so !help can list it.
 * Every registry.register() call must include `module: 'mymodule'`.
 *
 * Fields on CommandDef:
 *   help        (required) One-liner shown in !help overview
 *   description (optional) Longer explanation shown in !help <module>
 *   usage       (optional) Argument pattern shown next to the command name
 *   module      (required) Your module name — used to group commands in !help
 *
 * ── Scheduling ──────────────────────────────────────────────────────────────
 * Call registry.schedule() to post messages automatically on a timer.
 * The handler returns a string to post, or null to skip a tick silently.
 *
 * ── Config helpers ──────────────────────────────────────────────────────────
 * Read env vars with the helpers exported from "lumi":
 *   env(key, fallback?)      — string
 *   envInt(key, fallback?)   — integer
 *   envList(key)             — comma-separated string[]
 *   envBool(key, fallback?)  — boolean
 */

import { BotModule, ModuleRegistry, CommandContext } from "lumi";
import { BotConfig, env, envInt, envList } from "lumi";

// ── Module name — used in registerModule() and every register() call ──────────

const MODULE = "mymodule";

// ── Module definition ─────────────────────────────────────────────────────────

const mod: BotModule = {
  register(registry: ModuleRegistry, config: BotConfig) {

    // Register the module itself so !help can list and describe it.
    registry.registerModule(MODULE, "Short description shown in !help overview");

    // ── Commands ─────────────────────────────────────────────────────────────

    registry.register({
      name: "greet",        // the !command name (without !)
      module: MODULE,       // required — links this command to the module
      help: "Say hello",    // one-liner shown in !help overview
      description:          // optional — shown in !help mymodule
        "Greets the caller by Matrix ID, or by name if one is provided.",
      usage: "[name]",      // optional argument hint shown in !help mymodule
      handler: cmdGreet,
    });

    // Factory pattern — read your module's own env vars and capture them in a
    // closure. Use a module-specific prefix (MYMODULE_*) to avoid collisions.
    registry.register({
      name: "myapi",
      module: MODULE,
      help: "Query my API",
      description: "Sends a query to the configured API endpoint and returns the result.",
      usage: "<query>",
      handler: makeApiHandler(env("MYMODULE_API_URL", "http://localhost:8080")),
    });

    // ── Scheduled tasks ──────────────────────────────────────────────────────
    // Use your own env var prefix (e.g. MYMODULE_*) to avoid collisions.
    //
    // Example .env:
    //   MYMODULE_SCHEDULE_INTERVAL=3600
    //   MYMODULE_SCHEDULE_ROOMS=!abc:matrix.org,!def:matrix.org
    const interval = envInt("MYMODULE_SCHEDULE_INTERVAL", 0);
    const rooms    = envList("MYMODULE_SCHEDULE_ROOMS");

    if (interval > 0 && rooms.length > 0) {
      registry.schedule({
        name: "mymodule:auto",  // unique name used in logs and !lumi tasks
        intervalSecs: interval,
        rooms,
        handler: async () => {
          // Return a string to post, or null to skip this tick silently.
          const value = env("MYMODULE_SOME_VALUE", "hello");
          return `Scheduled message: **${value}**`;
        },
      });
    }
  },
};

// ── Handlers ──────────────────────────────────────────────────────────────────

async function cmdGreet(ctx: CommandContext): Promise<string> {
  // ctx.args   — string[] of words after the command name
  // ctx.roomId — Matrix room ID the message was sent in
  // ctx.event  — full Matrix event (ctx.event.getSender(), etc.)
  // ctx.client — MatrixClient instance (for advanced use, e.g. room lookups)

  const name = ctx.args.join(" ") || ctx.event.getSender();
  return `Hello, **${name}**!`;
}

// Factory pattern — capture config values at registration time.
function makeApiHandler(apiUrl: string) {
  return async function (ctx: CommandContext): Promise<string> {
    const query = ctx.args.join(" ");
    if (!query) return "Usage: `!myapi <query>`";

    // Make HTTP requests, query databases, etc.
    // Throw an Error to have it shown as an error message in chat.
    return `Would query ${apiUrl} with: ${query}`;
  };
}

module.exports = mod;
