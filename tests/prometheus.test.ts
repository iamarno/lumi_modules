import axios from 'axios';
import { ModuleRegistry } from 'lumi';
import { BotConfig } from 'lumi';

jest.mock('axios');
const mockedAxios = jest.mocked(axios);

const mod = require('../src/prometheus');

const mockConfig: BotConfig = {
  homeserver: '', userId: '', accessToken: '',
  prometheusUrl: 'http://prom:9090',
  hassUrl: '', hassToken: '', grafanaUrl: '', grafanaToken: '', httpAllowedDomains: [],
  weatherEnabled: false, logLevel: 'info',
  e2eeEnabled: false, deviceId: '', cryptoPassword: '', cryptoSaveInterval: 60,
};

async function invoke(registry: ModuleRegistry, args: string[]) {
  return registry.get('prom')!.handler({
    args, roomId: '', event: {} as any, client: {} as any,
  });
}

const queryOk = {
  data: {
    status: 'success',
    data: { result: [{ metric: { __name__: 'up', job: 'node' }, value: [1, '1'] }] },
  },
};

describe('prometheus module', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
    mod.register(registry, mockConfig);
    (mockedAxios.isAxiosError as jest.Mock) = jest.fn().mockReturnValue(false);
  });

  test('!prom with no args shows subcommand help', async () => {
    const result = await invoke(registry, []);
    expect(result).toContain('query');
    expect(result).toContain('targets');
    expect(result).toContain('alerts');
  });

  test('!prom query returns result rows', async () => {
    mockedAxios.get.mockResolvedValueOnce(queryOk);
    expect(await invoke(registry, ['query', 'up'])).toContain('up');
  });

  test('!prom query with no PromQL returns usage', async () => {
    expect(await invoke(registry, ['query'])).toContain('Usage');
  });

  test('!prom query reports empty result set', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { status: 'success', data: { result: [] } },
    });
    expect(await invoke(registry, ['query', 'nonexistent'])).toContain('No results');
  });

  test('!prom targets lists active targets', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { data: { activeTargets: [{ labels: { job: 'node', instance: 'localhost:9100' }, health: 'up' }] } },
    });
    const result = await invoke(registry, ['targets']);
    expect(result).toContain('node');
    expect(result).toContain('localhost:9100');
  });

  test('!prom alerts shows clear when no alerts firing', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { data: { alerts: [] } } });
    expect(await invoke(registry, ['alerts'])).toContain('No firing alerts');
  });

  test('!prom alerts lists firing alerts', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: {
          alerts: [{
            labels: { alertname: 'HighCPU', severity: 'warning' },
            annotations: { summary: 'CPU is high' },
            state: 'firing',
          }],
        },
      },
    });
    expect(await invoke(registry, ['alerts'])).toContain('HighCPU');
  });

  test('registers named shortcut as a chat command', () => {
    process.env.PROM_SHORTCUTS = 'myq';
    process.env.PROM_MYQ_QUERY = 'up';
    process.env.PROM_MYQ_CMD = 'myquery';
    const reg = new ModuleRegistry();
    mod.register(reg, mockConfig);
    expect(reg.get('myquery')).toBeDefined();
    delete process.env.PROM_SHORTCUTS;
    delete process.env.PROM_MYQ_QUERY;
    delete process.env.PROM_MYQ_CMD;
  });
});
