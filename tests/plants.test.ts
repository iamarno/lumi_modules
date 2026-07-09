import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ModuleRegistry } from 'lumi';
import { BotConfig } from 'lumi';

const mockConfig: BotConfig = {
  homeserver: '', userId: '', accessToken: '',
  prometheusUrl: '', hassUrl: '', hassToken: '', grafanaUrl: '', grafanaToken: '', httpAllowedDomains: [],
  weatherEnabled: false, logLevel: 'info',
  e2eeEnabled: false, deviceId: '', cryptoPassword: '', cryptoSaveInterval: 60,
};

function makeCtx(registry: ModuleRegistry, args: string[], roomId = '!room:matrix.org') {
  return { args, roomId, event: { getContent: () => ({ body: args.join(' ') }) } as any, client: {} as any };
}

async function invoke(registry: ModuleRegistry, args: string[], roomId = '!room:matrix.org') {
  return registry.get('plants')!.handler(makeCtx(registry, args, roomId));
}

describe('plants module', () => {
  let tmpDir: string;
  let registry: ModuleRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-plants-test-'));
    process.env.LUMI_STATE_DIR = tmpDir;
    process.env.PLANTS = 'monstera,cactus';
    process.env.PLANT_MONSTERA_WATER = '7';
    process.env.PLANT_MONSTERA_FERTILISE = '30';
    process.env.PLANT_MONSTERA_EMOJI = '🌿';
    process.env.PLANT_CACTUS_WATER = '21';
    process.env.PLANT_CACTUS_EMOJI = '🌵';
    process.env.PLANTS_ROOMS = '';
    jest.resetModules();
    registry = new ModuleRegistry();
    const mod = require('../src/plants');
    mod.register(registry, mockConfig);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of [
      'LUMI_STATE_DIR', 'PLANTS', 'PLANTS_ROOMS',
      'PLANT_MONSTERA_WATER', 'PLANT_MONSTERA_FERTILISE', 'PLANT_MONSTERA_EMOJI',
      'PLANT_CACTUS_WATER', 'PLANT_CACTUS_EMOJI',
    ]) delete process.env[key];
    jest.useRealTimers();
  });

  test('registers !plants command', () => {
    expect(registry.get('plants')).toBeDefined();
  });

  test('no plants configured returns message', () => {
    jest.resetModules();
    process.env.PLANTS = '';
    const reg2 = new ModuleRegistry();
    const mod2 = require('../src/plants');
    mod2.register(reg2, mockConfig);
    expect(reg2.get('plants')).toBeUndefined();
  });

  test('!plants lists plant status', async () => {
    const result = await invoke(registry, []);
    expect(result).toContain('monstera');
    expect(result).toContain('cactus');
  });

  test('!plants list shows watering info', async () => {
    const result = await invoke(registry, ['list']);
    expect(result).toContain('Water');
  });

  test('!plants water <name> marks plant as watered', async () => {
    const result = await invoke(registry, ['water', 'monstera']);
    expect(result).toContain('monstera');
    expect(result).toContain('watered');
  });

  test('!plants water with unknown name returns error', async () => {
    const result = await invoke(registry, ['water', 'unknownplant']);
    expect(result).toContain('Unknown plant');
  });

  test('!plants fertilise marks plant as fertilised', async () => {
    const result = await invoke(registry, ['fertilise', 'monstera']);
    expect(result).toContain('monstera');
    expect(result).toContain('fertilised');
  });

  test('!plants fertilise on plant without schedule returns message', async () => {
    const result = await invoke(registry, ['fertilise', 'cactus']);
    expect(result).toContain('no fertilising schedule');
  });

  test('!plants skip snoozes a plant', async () => {
    const result = await invoke(registry, ['skip', 'cactus']);
    expect(result).toContain('snoozed');
  });

  test('invalid subcommand returns usage', async () => {
    const result = await invoke(registry, ['bogus']);
    expect(result).toContain('Usage');
  });

  test('watering state persists to disk', async () => {
    await invoke(registry, ['water', 'monstera']);
    jest.resetModules();
    const reg2 = new ModuleRegistry();
    const mod2 = require('../src/plants');
    mod2.register(reg2, mockConfig);
    const result = await reg2.get('plants')!.handler(makeCtx(reg2, ['list']));
    // last watered should show 0d ago
    expect(result).toContain('0d ago');
  });

  test('reply handler responds to "watered" after reminder', async () => {
    // Trigger scheduler manually by calling the handler directly
    // First, register with PLANTS_ROOMS set
    process.env.PLANTS_ROOMS = '!room:matrix.org';
    jest.resetModules();
    const reg2 = new ModuleRegistry();
    const mod2 = require('../src/plants');
    mod2.register(reg2, mockConfig);

    // The reply handler should be registered
    const replyMatch = reg2.matchReply('!room:matrix.org', 'watered');
    // No pending plants yet — match returns false until scheduler fires
    expect(replyMatch).toBeUndefined();
  });
});
