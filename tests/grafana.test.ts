import { ModuleRegistry } from 'lumi';
import { BotConfig } from 'lumi';

jest.mock('../src/lib/grafana_render', () => ({
  renderAndUpload: jest.fn(),
}));

import { renderAndUpload } from '../src/lib/grafana_render';
const mockedRender = jest.mocked(renderAndUpload);

const mod = require('../src/grafana');

const mockConfig: BotConfig = {
  homeserver: '', userId: '', accessToken: '',
  logLevel: 'info',
  e2eeEnabled: false, deviceId: '', cryptoPassword: '', cryptoSaveInterval: 60,
  adminUsers: [],
};

const mockClient = {};

async function invoke(registry: ModuleRegistry, args: string[]) {
  return registry.get('graph')!.handler({
    args, roomId: '!room:x', event: {} as any, client: mockClient as any,
  });
}

describe('grafana module', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
    mockedRender.mockResolvedValue(undefined);
    process.env.GRAFANA_URL = 'http://grafana:3000';
    process.env.GRAFANA_TOKEN = 'gtoken';
  });

  afterEach(() => {
    delete process.env.GRAFANA_URL;
    delete process.env.GRAFANA_TOKEN;
  });

  test('does not register !graph when GRAFANA_URL is empty', () => {
    delete process.env.GRAFANA_URL;
    mod.register(registry, mockConfig);
    expect(registry.get('graph')).toBeUndefined();
  });

  test('returns usage when no args given', async () => {
    mod.register(registry, mockConfig);
    const result = await invoke(registry, []);
    expect(result).toContain('Usage');
    expect(result).toContain('render-path');
  });

  test('resolves relative path against grafanaUrl', async () => {
    mod.register(registry, mockConfig);
    await invoke(registry, ['/render/d-solo/abc/dash?panelId=1']);
    expect(mockedRender).toHaveBeenCalledWith(
      mockClient,
      '!room:x',
      'http://grafana:3000/render/d-solo/abc/dash?panelId=1',
      'gtoken',
    );
  });

  test('passes through absolute URL directly', async () => {
    mod.register(registry, mockConfig);
    await invoke(registry, ['http://other-grafana/render/d-solo/abc?panelId=1']);
    expect(mockedRender).toHaveBeenCalledWith(
      mockClient,
      '!room:x',
      'http://other-grafana/render/d-solo/abc?panelId=1',
      'gtoken',
    );
  });

  test('returns null after successful render', async () => {
    mod.register(registry, mockConfig);
    const result = await invoke(registry, ['/render/d-solo/abc?panelId=1']);
    expect(result).toBeNull();
  });
});
