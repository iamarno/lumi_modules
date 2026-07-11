import axios from 'axios';
import { ModuleRegistry } from 'lumi';
import { BotConfig } from 'lumi';

jest.mock('axios');
const mockedAxios = jest.mocked(axios);

const mod = require('../src/weather');

const mockConfig: BotConfig = {
  homeserver: '', userId: '', accessToken: '',
  prometheusUrl: '', hassUrl: '', hassToken: '', grafanaUrl: '', grafanaToken: '', httpAllowedDomains: [],
  weatherEnabled: true, logLevel: 'info',
  e2eeEnabled: false, deviceId: '', cryptoPassword: '', cryptoSaveInterval: 60,
};

const hourly = Array(8).fill({ weatherDesc: [{ value: 'Sunny' }] });
const wttrResponse = {
  data: {
    current_condition: [{
      temp_C: '15', temp_F: '59', FeelsLikeC: '13', humidity: '70',
      windspeedKmph: '20', winddir16Point: 'NW',
      weatherDesc: [{ value: 'Partly cloudy' }],
    }],
    nearest_area: [{ areaName: [{ value: 'London' }], country: [{ value: 'United Kingdom' }] }],
    weather: [
      { date: '2024-01-01', maxtempC: '18', mintempC: '10', hourly },
      { date: '2024-01-02', maxtempC: '16', mintempC: '9',  hourly },
      { date: '2024-01-03', maxtempC: '14', mintempC: '8',  hourly },
    ],
  },
};

async function invoke(registry: ModuleRegistry, name: string, args: string[]) {
  return registry.get(name)!.handler({
    args, roomId: '', event: {} as any, client: {} as any,
  });
}

describe('weather module', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
    mod.register(registry, mockConfig);
    (mockedAxios.isAxiosError as jest.Mock) = jest.fn().mockReturnValue(false);
  });

  test('registers !weather and !forecast commands', () => {
    expect(registry.get('weather')).toBeDefined();
    expect(registry.get('forecast')).toBeDefined();
  });

  test('does not register commands when WEATHER_ENABLED is false', () => {
    process.env.WEATHER_ENABLED = 'false';
    const reg = new ModuleRegistry();
    mod.register(reg, mockConfig);
    expect(reg.get('weather')).toBeUndefined();
    expect(reg.get('forecast')).toBeUndefined();
    delete process.env.WEATHER_ENABLED;
  });

  test('!weather returns current conditions', async () => {
    mockedAxios.get.mockResolvedValueOnce(wttrResponse);
    const result = await invoke(registry, 'weather', ['London']);
    expect(result).toContain('London');
    expect(result).toContain('15');
    expect(result).toContain('Partly cloudy');
  });

  test('!weather returns usage hint when no city given', async () => {
    expect(await invoke(registry, 'weather', [])).toContain('Usage');
  });

  test('!forecast returns 3-day forecast section', async () => {
    mockedAxios.get.mockResolvedValueOnce(wttrResponse);
    const result = await invoke(registry, 'forecast', ['London']);
    expect(result).toContain('Forecast');
    expect(result).toContain('2024-01-01');
  });

  test('!forecast returns usage hint when no city given', async () => {
    expect(await invoke(registry, 'forecast', [])).toContain('Usage');
  });
});
