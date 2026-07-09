import { BotModule, ModuleRegistry } from "lumi";
import { BotConfig } from "lumi";
import { logger } from "lumi";
import { renderAndUpload } from "./lib/grafana_render";

const log = logger.getLogger('grafana');

const mod: BotModule = {
  register(registry: ModuleRegistry, config: BotConfig) {
    registry.registerModule('grafana', 'Render Grafana panels as images');

    if (!config.grafanaUrl) {
      log.info("GRAFANA_URL not set — module disabled");
      return;
    }

    registry.register({
      name: "graph",
      module: 'grafana',
      help: "Render a Grafana panel as an image",
      description: "Provide the panel render path from your Grafana URL. Supports optional width/height via query params.",
      usage: "<render-path>",
      handler: async ({ client, roomId, args }) => {
        if (args.length === 0) {
          return "Usage: `!graph <render-path>`\nExample: `!graph /render/d-solo/abc123/my-dashboard?panelId=1&from=now-1h&to=now`";
        }

        const renderPath = args[0]!;
        const url = renderPath.startsWith("http")
          ? renderPath
          : `${config.grafanaUrl.replace(/\/$/, "")}${renderPath.startsWith("/") ? "" : "/"}${renderPath}`;

        await renderAndUpload(client, roomId, url, config.grafanaToken);
        return null;
      },
    });
  },
};

module.exports = mod;
