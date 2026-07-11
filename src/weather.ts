/**
 * Module: weather
 * Fetch weather data from wttr.in (no API key needed).
 *
 * Commands:
 *   !weather <city>    — current conditions
 *   !forecast <city>   — 3-day forecast
 *
 * Scheduled auto-post (configured via .env):
 *   WEATHER_SCHEDULE_CITY=London
 *   WEATHER_SCHEDULE_INTERVAL=21600        # seconds (e.g. 21600 = every 6 h)
 *   WEATHER_SCHEDULE_ROOMS=!abc:matrix.org,!def:matrix.org
 *   WEATHER_SCHEDULE_FORECAST=false        # set true for 3-day forecast
 */

import axios from "axios";
import { BotModule, ModuleRegistry, errMsg } from "lumi";
import { BotConfig, env, envInt, envList, envBool } from "lumi";

interface WttrCurrent {
  temp_C: string;
  temp_F: string;
  FeelsLikeC: string;
  humidity: string;
  windspeedKmph: string;
  winddir16Point: string;
  weatherDesc: Array<{ value: string }>;
}

interface WttrDay {
  date: string;
  maxtempC: string;
  mintempC: string;
  hourly: Array<{ weatherDesc: Array<{ value: string }> }>;
}

interface WttrResponse {
  current_condition: WttrCurrent[];
  nearest_area: Array<{
    areaName: Array<{ value: string }>;
    country: Array<{ value: string }>;
  }>;
  weather: WttrDay[];
}

const mod: BotModule = {
  register(registry: ModuleRegistry, config: BotConfig) {
    registry.registerModule('weather', 'Current weather and forecasts');

    if (!envBool("WEATHER_ENABLED", true)) return;

    registry.register({
      name: "weather",
      module: 'weather',
      help: "Current weather for a city",
      description: "Fetches current conditions including temperature, wind, and description.",
      usage: "<city>",
      handler: async ({ args }) => {
        if (!args.length) return "Usage: `!weather <city>`";
        return fetchWeather(args.join("+"), false);
      },
    });

    registry.register({
      name: "forecast",
      module: 'weather',
      help: "3-day weather forecast",
      description: "Shows a 3-day forecast with daily high/low temperatures.",
      usage: "<city>",
      handler: async ({ args }) => {
        if (!args.length) return "Usage: `!forecast <city>`";
        return fetchWeather(args.join("+"), true);
      },
    });

    // ── Scheduled auto-post ────────────────────────────────────────────────
    const city     = env("WEATHER_SCHEDULE_CITY");
    const interval = envInt("WEATHER_SCHEDULE_INTERVAL", 0);
    const rooms    = envList("WEATHER_SCHEDULE_ROOMS");
    const forecast = envBool("WEATHER_SCHEDULE_FORECAST", false);

    if (city && interval > 0 && rooms.length > 0) {
      registry.schedule({
        name: "weather:auto",
        intervalSecs: interval,
        rooms,
        handler: () => fetchWeather(city.replace(/\s+/g, "+"), forecast),
      });
    }
  },
};

async function fetchWeather(city: string, showForecast: boolean): Promise<string> {
  try {
    const { data } = await axios.get<WttrResponse>(
      `https://wttr.in/${encodeURIComponent(city)}`,
      {
        params: { format: "j1" },
        timeout: 10_000,
        headers: { "User-Agent": "lumi/1.0" },
      }
    );

    const cur = data.current_condition[0]!;
    const area = data.nearest_area[0]!;
    const cityName = area.areaName[0]!.value;
    const country = area.country[0]!.value;
    const desc = cur.weatherDesc[0]!.value;

    const lines = [
      `🌍 **Weather for ${cityName}, ${country}**\n`,
      `🌡️ **${cur.temp_C}°C / ${cur.temp_F}°F** (feels like ${cur.FeelsLikeC}°C)`,
      `⛅ ${desc}`,
      `💧 Humidity: ${cur.humidity}%`,
      `💨 Wind: ${cur.windspeedKmph} km/h ${cur.winddir16Point}`,
    ];

    if (showForecast && data.weather?.length) {
      lines.push("\n**3-Day Forecast:**");
      for (const day of data.weather.slice(0, 3)) {
        const dayDesc = day.hourly[4]?.weatherDesc?.[0]?.value ?? "?";
        lines.push(
          `• **${day.date}**: ${dayDesc}, ${day.mintempC}–${day.maxtempC}°C`
        );
      }
    }

    return lines.join("\n");
  } catch (err) {
    if (axios.isAxiosError(err) && !err.response) {
      return "❌ Could not reach weather service.";
    }
    return `❌ Weather error: ${errMsg(err)}`;
  }
}

module.exports = mod;
