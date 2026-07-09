import { ModuleRegistry } from 'lumi';
import { BotConfig } from 'lumi';

const mockHttp = { get: jest.fn(), post: jest.fn() };

jest.mock('axios', () => ({
  create: jest.fn(() => mockHttp),
  isAxiosError: jest.fn().mockReturnValue(false),
}));

const mod = require('../src/homeassistant');

const mockConfig: BotConfig = {
  homeserver: '', userId: '', accessToken: '',
  prometheusUrl: '', hassUrl: 'http://ha.local:8123', hassToken: 'token123',
  grafanaUrl: '', grafanaToken: '', httpAllowedDomains: [], weatherEnabled: false, logLevel: 'info',
  e2eeEnabled: false, deviceId: '', cryptoPassword: '', cryptoSaveInterval: 60,
};

async function invoke(registry: ModuleRegistry, args: string[]) {
  return registry.get('ha')!.handler({
    args, roomId: '', event: {} as any, client: {} as any,
  });
}

describe('homeassistant module', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
    mod.register(registry, mockConfig);
  });

  test('does not register !ha when HASS_TOKEN is empty', () => {
    const reg = new ModuleRegistry();
    mod.register(reg, { ...mockConfig, hassToken: '' });
    expect(reg.get('ha')).toBeUndefined();
  });

  test('!ha with no args shows subcommand help', async () => {
    const result = await invoke(registry, []);
    expect(result).toContain('state');
    expect(result).toContain('list');
    expect(result).toContain('turn_on');
  });

  test('!ha state returns entity state and attributes', async () => {
    mockHttp.get.mockResolvedValueOnce({
      data: {
        entity_id: 'sensor.temp',
        state: '22.5',
        attributes: { friendly_name: 'Temperature', unit_of_measurement: '°C' },
      },
    });
    const result = await invoke(registry, ['state', 'sensor.temp']);
    expect(result).toContain('22.5');
    expect(result).toContain('Temperature');
  });

  test('!ha state returns usage hint when no entity given', async () => {
    expect(await invoke(registry, ['state'])).toContain('Usage');
  });

  test('!ha list returns entity list', async () => {
    mockHttp.get.mockResolvedValueOnce({
      data: [
        { entity_id: 'light.living_room', state: 'on', attributes: { friendly_name: 'Living Room' } },
        { entity_id: 'sensor.temp', state: '22', attributes: {} },
      ],
    });
    const result = await invoke(registry, ['list']);
    expect(result).toContain('light.living_room');
  });

  test('!ha list filters by domain', async () => {
    mockHttp.get.mockResolvedValueOnce({
      data: [
        { entity_id: 'light.bedroom', state: 'off', attributes: {} },
        { entity_id: 'sensor.temp', state: '22', attributes: {} },
      ],
    });
    const result = await invoke(registry, ['list', 'light']);
    expect(result).toContain('light.bedroom');
    expect(result).not.toContain('sensor.temp');
  });

  test('!ha turn_on calls service and confirms', async () => {
    mockHttp.post.mockResolvedValueOnce({ data: {} });
    const result = await invoke(registry, ['turn_on', 'light.bedroom']);
    expect(result).toContain('turn_on');
    expect(mockHttp.post).toHaveBeenCalledWith(
      expect.stringContaining('turn_on'),
      expect.objectContaining({ entity_id: 'light.bedroom' })
    );
  });

  test('!ha turn_off calls service', async () => {
    mockHttp.post.mockResolvedValueOnce({ data: {} });
    await invoke(registry, ['turn_off', 'light.bedroom']);
    expect(mockHttp.post).toHaveBeenCalledWith(
      expect.stringContaining('turn_off'),
      expect.any(Object)
    );
  });

  test('!ha toggle calls service', async () => {
    mockHttp.post.mockResolvedValueOnce({ data: {} });
    await invoke(registry, ['toggle', 'light.bedroom']);
    expect(mockHttp.post).toHaveBeenCalledWith(
      expect.stringContaining('toggle'),
      expect.any(Object)
    );
  });

  test('!ha unknown subcommand returns error message', async () => {
    expect(await invoke(registry, ['unknown'])).toContain('Unknown subcommand');
  });
});
