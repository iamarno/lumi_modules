import { ModuleRegistry } from 'lumi';
import { BotConfig } from 'lumi';

// ── Mock axios ────────────────────────────────────────────────────────────────

const mockHttp = { get: jest.fn(), post: jest.fn() };

jest.mock('axios', () => ({
  create: jest.fn(() => mockHttp),
  isAxiosError: jest.fn().mockReturnValue(false),
}));

// ── Mock ModuleStore ──────────────────────────────────────────────────────────

let storeData: Record<string, unknown> = {};

const mockStore = {
  get: jest.fn((key: string, fallback: unknown) => storeData[key] ?? fallback),
  set: jest.fn((key: string, value: unknown) => { storeData[key] = value; }),
  delete: jest.fn((key: string) => { delete storeData[key]; }),
};

jest.mock('lumi', () => ({
  ...jest.requireActual('lumi'),
  ModuleStore: jest.fn().mockImplementation(() => mockStore),
}));

// ── Load module after mocks ───────────────────────────────────────────────────

const mod = require('../src/sentinel');
const { timeAgo, getSimPhase } = mod;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockConfig: BotConfig = {
  homeserver: '', userId: '', accessToken: '',
  logLevel: 'info',
  e2eeEnabled: false, deviceId: '', cryptoPassword: '', cryptoSaveInterval: 60,
  adminUsers: [],
};

function hassState(entity_id: string, state: string, attrs: Record<string, unknown> = {}, last_changed = '2026-01-01T12:00:00.000Z') {
  return { data: { entity_id, state, last_changed, attributes: attrs } };
}

async function invoke(registry: ModuleRegistry, args: string[]) {
  return registry.get('sentinel')!.handler({
    args, roomId: '', event: {} as any, client: {} as any,
  });
}

// ── timeAgo helper ────────────────────────────────────────────────────────────

describe('timeAgo', () => {
  test('returns "just now" for < 1 minute ago', () => {
    const iso = new Date(Date.now() - 10_000).toISOString();
    expect(timeAgo(iso)).toBe('just now');
  });

  test('returns Xm ago for < 1 hour', () => {
    const iso = new Date(Date.now() - 15 * 60_000).toISOString();
    expect(timeAgo(iso)).toBe('15m ago');
  });

  test('returns Xh ago for < 1 day', () => {
    const iso = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(timeAgo(iso)).toBe('3h ago');
  });

  test('returns Xd ago for >= 1 day', () => {
    const iso = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(timeAgo(iso)).toBe('2d ago');
  });
});

// ── getSimPhase helper ────────────────────────────────────────────────────────

describe('getSimPhase', () => {
  const RealDate = Date;

  function mockTime(hours: number, minutes = 0) {
    const fake = new RealDate();
    fake.setHours(hours, minutes, 0, 0);
    jest.spyOn(global, 'Date').mockImplementation((...args) =>
      args.length ? new RealDate(...(args as [any])) : fake
    );
  }

  afterEach(() => jest.restoreAllMocks());

  test('returns "morning" during morning window', () => {
    mockTime(7, 30);
    expect(getSimPhase('06:00-09:00', '18:00-23:00')).toBe('morning');
  });

  test('returns "evening" during evening window', () => {
    mockTime(20);
    expect(getSimPhase('06:00-09:00', '18:00-23:00')).toBe('evening');
  });

  test('returns "off" outside both windows', () => {
    mockTime(13);
    expect(getSimPhase('06:00-09:00', '18:00-23:00')).toBe('off');
  });

  test('returns "off" at night (after evening window)', () => {
    mockTime(23, 30);
    expect(getSimPhase('06:00-09:00', '18:00-23:00')).toBe('off');
  });
});

// ── Commands ──────────────────────────────────────────────────────────────────

describe('sentinel module', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
    storeData = {};
    mockHttp.get.mockReset();
    mockHttp.post.mockReset();
    mockStore.get.mockClear();
    mockStore.set.mockClear();
    process.env.SENTINEL_ROOMS = '!test:server';
    process.env.SENTINEL_SENSORS = '';
    process.env.SENTINEL_SENSOR_POLL = '0';
    process.env.SENTINEL_SIMULATION_LIGHTS = '';
    process.env.SENTINEL_PRESENCE_ENTITIES = '';
    process.env.HASS_URL = 'http://ha.local:8123';
    process.env.HASS_TOKEN = 'sentinel-token';
    mod.register(registry, mockConfig);
    // Clear set calls caused by the armMode seed in register()
    mockStore.set.mockClear();
  });

  afterEach(() => {
    delete process.env.SENTINEL_ROOMS;
    delete process.env.SENTINEL_SENSORS;
    delete process.env.SENTINEL_SENSOR_POLL;
    delete process.env.SENTINEL_SIMULATION_LIGHTS;
    delete process.env.SENTINEL_PRESENCE_ENTITIES;
    delete process.env.HASS_URL;
    delete process.env.HASS_TOKEN;
  });

  test('does not register when HASS_TOKEN is empty', () => {
    const reg = new ModuleRegistry();
    delete process.env.HASS_TOKEN;
    mod.register(reg, mockConfig);
    expect(reg.get('sentinel')).toBeUndefined();
  });

  test('does not register when SENTINEL_ROOMS is empty', () => {
    const reg = new ModuleRegistry();
    process.env.SENTINEL_ROOMS = '';
    mod.register(reg, mockConfig);
    expect(reg.get('sentinel')).toBeUndefined();
  });

  test('!sentinel with no args shows help', async () => {
    const result = await invoke(registry, []);
    expect(result).toContain('arm');
    expect(result).toContain('disarm');
    expect(result).toContain('status');
  });

  test('!sentinel arm enters sentinel mode', async () => {
    const result = await invoke(registry, ['arm']);
    expect(result).toContain('armed');
    expect(mockStore.set).toHaveBeenCalledWith(
      'state',
      expect.objectContaining({ mode: 'sentinel' }),
    );
  });

  test('!sentinel arm when already armed returns already message', async () => {
    storeData['state'] = { mode: 'sentinel', armedAt: '2026-01-01T00:00:00.000Z', lastSummaryAt: null, armMode: 'manual' };
    const result = await invoke(registry, ['arm']);
    expect(result).toContain('Already');
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  test('!sentinel disarm returns to observation mode', async () => {
    storeData['state'] = { mode: 'sentinel', armedAt: '2026-01-01T00:00:00.000Z', lastSummaryAt: null, armMode: 'manual' };
    const result = await invoke(registry, ['disarm']);
    expect(result).toContain('observation');
    expect(mockStore.set).toHaveBeenCalledWith(
      'state',
      expect.objectContaining({ mode: 'observation', armedAt: null }),
    );
  });

  test('!sentinel disarm when already in observation returns already message', async () => {
    const result = await invoke(registry, ['disarm']);
    expect(result).toContain('Already');
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  test('!sentinel status shows observation mode', async () => {
    const result = await invoke(registry, ['status']);
    expect(result).toContain('observation');
    expect(result).toContain('Mode');
  });

  test('!sentinel status shows sentinel mode and schedule when armed', async () => {
    storeData['state'] = { mode: 'sentinel', armedAt: '2026-01-01T00:00:00.000Z', lastSummaryAt: null, armMode: 'manual' };
    const result = await invoke(registry, ['status']);
    expect(result).toContain('sentinel');
    expect(result).toContain('Armed at');
    expect(result).toContain('morning');
    expect(result).toContain('evening');
  });

  test('!sentinel status shows arm mode', async () => {
    const result = await invoke(registry, ['status']);
    expect(result).toContain('Arm mode');
    expect(result).toContain('manual');
  });

  test('!sentinel armmode shows current mode', async () => {
    const result = await invoke(registry, ['armmode']);
    expect(result).toContain('Arm mode');
    expect(result).toContain('manual');
  });

  test('!sentinel armmode auto switches to auto', async () => {
    const result = await invoke(registry, ['armmode', 'auto']);
    expect(result).toContain('auto');
    expect(mockStore.set).toHaveBeenCalledWith(
      'state',
      expect.objectContaining({ armMode: 'auto' }),
    );
  });

  test('!sentinel armmode manual switches to manual', async () => {
    storeData['state'] = { mode: 'observation', armedAt: null, lastSummaryAt: null, armMode: 'auto' };
    const result = await invoke(registry, ['armmode', 'manual']);
    expect(result).toContain('manual');
    expect(mockStore.set).toHaveBeenCalledWith(
      'state',
      expect.objectContaining({ armMode: 'manual' }),
    );
  });

  test('!sentinel armmode rejects unknown value', async () => {
    const result = await invoke(registry, ['armmode', 'onfire']);
    expect(result).toContain('Unknown');
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  test('!sentinel summarymode shows current mode', async () => {
    const result = await invoke(registry, ['summarymode']);
    expect(result).toContain('Summary mode');
    expect(result).toContain('armed');
  });

  test('!sentinel summarymode always switches to always', async () => {
    const result = await invoke(registry, ['summarymode', 'always']);
    expect(result).toContain('always');
    expect(mockStore.set).toHaveBeenCalledWith(
      'state',
      expect.objectContaining({ summaryMode: 'always' }),
    );
  });

  test('!sentinel summarymode armed switches to armed', async () => {
    storeData['state'] = { mode: 'observation', armedAt: null, lastSummaryAt: null, armMode: 'manual', summaryMode: 'always' };
    const result = await invoke(registry, ['summarymode', 'armed']);
    expect(result).toContain('armed');
    expect(mockStore.set).toHaveBeenCalledWith(
      'state',
      expect.objectContaining({ summaryMode: 'armed' }),
    );
  });

  test('!sentinel summarymode rejects unknown value', async () => {
    const result = await invoke(registry, ['summarymode', 'never']);
    expect(result).toContain('Unknown');
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  test('SENTINEL_SUMMARY_MODE env var sets initial summary mode to always', () => {
    process.env.SENTINEL_SUMMARY_MODE = 'always';
    storeData = {};
    const reg = new ModuleRegistry();
    mod.register(reg, mockConfig);
    expect(mockStore.set).toHaveBeenCalledWith(
      'state',
      expect.objectContaining({ summaryMode: 'always' }),
    );
    delete process.env.SENTINEL_SUMMARY_MODE;
  });

  test('!sentinel status shows summary mode', async () => {
    const result = await invoke(registry, ['status']);
    expect(result).toContain('Summary mode');
    expect(result).toContain('armed');
  });

  test('SENTINEL_ARM_MODE env var sets initial arm mode to auto', () => {
    process.env.SENTINEL_ARM_MODE = 'auto';
    storeData = {}; // clear so seed runs
    const reg = new ModuleRegistry();
    mod.register(reg, mockConfig);
    expect(mockStore.set).toHaveBeenCalledWith(
      'state',
      expect.objectContaining({ armMode: 'auto' }),
    );
    delete process.env.SENTINEL_ARM_MODE;
  });

  test('!sentinel summary with no sensors returns message', async () => {
    const result = await invoke(registry, ['summary']);
    expect(result).toContain('no sensors configured');
  });

  test('!sentinel summary includes last-changed time', async () => {
    process.env.SENTINEL_SENSORS = 'binary_sensor.motion';
    const reg = new ModuleRegistry();
    mod.register(reg, mockConfig);

    const lastChanged = new Date(Date.now() - 2 * 3_600_000).toISOString(); // 2h ago
    mockHttp.get.mockResolvedValueOnce(
      hassState('binary_sensor.motion', 'clear', { friendly_name: 'Motion' }, lastChanged),
    );

    const result = await reg.get('sentinel')!.handler({
      args: ['summary'], roomId: '', event: {} as any, client: {} as any,
    });

    expect(result).toContain('binary_sensor.motion');
    expect(result).toContain('clear');
    expect(result).toContain('2h ago');
  });

  test('!sentinel summary includes battery warning when below threshold', async () => {
    process.env.SENTINEL_SENSORS = 'binary_sensor.door';
    process.env.SENTINEL_BATTERY_WARN = '20';
    const reg = new ModuleRegistry();
    mod.register(reg, mockConfig);

    mockHttp.get.mockResolvedValueOnce(
      hassState('binary_sensor.door', 'closed', { battery_level: 12 }),
    );

    const result = await reg.get('sentinel')!.handler({
      args: ['summary'], roomId: '', event: {} as any, client: {} as any,
    });

    expect(result).toContain('Low battery');
    expect(result).toContain('12%');

    delete process.env.SENTINEL_BATTERY_WARN;
  });

  test('!sentinel summary omits battery warning when above threshold', async () => {
    process.env.SENTINEL_SENSORS = 'binary_sensor.door';
    process.env.SENTINEL_BATTERY_WARN = '20';
    const reg = new ModuleRegistry();
    mod.register(reg, mockConfig);

    mockHttp.get.mockResolvedValueOnce(
      hassState('binary_sensor.door', 'closed', { battery_level: 85 }),
    );

    const result = await reg.get('sentinel')!.handler({
      args: ['summary'], roomId: '', event: {} as any, client: {} as any,
    });

    expect(result).not.toContain('Low battery');

    delete process.env.SENTINEL_BATTERY_WARN;
  });

  test('!sentinel summary includes presence section when log has events', async () => {
    storeData['presenceLog'] = [
      { state: 'someone_home', at: new Date(Date.now() - 3 * 3_600_000).toISOString() },
      { state: 'all_away',     at: new Date(Date.now() - 1 * 3_600_000).toISOString() },
    ];
    const result = await invoke(registry, ['summary']);
    expect(result).toContain('Presence');
    expect(result).toContain('All away');
    expect(result).toContain('transition');
  });

  test('!sentinel summary shows no presence section when log is empty', async () => {
    storeData['presenceLog'] = [];
    const result = await invoke(registry, ['summary']);
    expect(result).not.toContain('Presence');
  });

  test('!sentinel summary does not clear the presence log', async () => {
    storeData['presenceLog'] = [{ state: 'all_away', at: new Date().toISOString() }];
    await invoke(registry, ['summary']);
    expect(mockStore.set).not.toHaveBeenCalledWith('presenceLog', []);
  });

  test('!sentinel summary queries each sensor', async () => {
    process.env.SENTINEL_SENSORS = 'binary_sensor.motion,binary_sensor.door';
    const reg = new ModuleRegistry();
    mod.register(reg, mockConfig);

    mockHttp.get
      .mockResolvedValueOnce(hassState('binary_sensor.motion', 'clear', { friendly_name: 'Motion' }))
      .mockResolvedValueOnce(hassState('binary_sensor.door', 'closed', {}));

    const result = await reg.get('sentinel')!.handler({
      args: ['summary'], roomId: '', event: {} as any, client: {} as any,
    });

    expect(result).toContain('binary_sensor.motion');
    expect(result).toContain('clear');
    expect(result).toContain('binary_sensor.door');
    expect(result).toContain('closed');
    expect(mockStore.set).toHaveBeenCalledWith('state', expect.objectContaining({ lastSummaryAt: expect.any(String) }));
  });

  test('!sentinel simulate with no lights returns config message', async () => {
    const result = await invoke(registry, ['simulate']);
    expect(result).toContain('SENTINEL_SIMULATION_LIGHTS');
  });

  test('!sentinel simulate calls service for each light and reports phase', async () => {
    process.env.SENTINEL_SIMULATION_LIGHTS = 'light.living,light.bedroom';
    const reg = new ModuleRegistry();
    mod.register(reg, mockConfig);
    mockHttp.post.mockResolvedValue({ data: {} });

    const result = await reg.get('sentinel')!.handler({
      args: ['simulate'], roomId: '', event: {} as any, client: {} as any,
    });

    expect(result).toContain('2 light(s)');
    expect(result).toMatch(/morning|evening|off/);
    expect(mockHttp.post).toHaveBeenCalledTimes(2);
  });

  test('!sentinel unknown subcommand shows help', async () => {
    const result = await invoke(registry, ['unknowncmd']);
    expect(result).toContain('arm');
  });
});

// ── Scheduled summary ─────────────────────────────────────────────────────────

describe('sentinel scheduled summary', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
    storeData = {};
    mockHttp.get.mockReset();
    process.env.SENTINEL_ROOMS = '!test:server';
    process.env.SENTINEL_SENSORS = 'binary_sensor.motion';
    process.env.SENTINEL_SENSOR_POLL = '0';
    process.env.SENTINEL_SIMULATION_LIGHTS = '';
    process.env.SENTINEL_PRESENCE_ENTITIES = '';
    process.env.HASS_URL = 'http://ha.local:8123';
    process.env.HASS_TOKEN = 'sentinel-token';
    mod.register(registry, mockConfig);
  });

  afterEach(() => {
    delete process.env.SENTINEL_ROOMS;
    delete process.env.SENTINEL_SENSORS;
    delete process.env.SENTINEL_SENSOR_POLL;
    delete process.env.SENTINEL_SIMULATION_LIGHTS;
    delete process.env.SENTINEL_PRESENCE_ENTITIES;
    delete process.env.HASS_URL;
    delete process.env.HASS_TOKEN;
  });

  function getSummaryTask(reg: ModuleRegistry) {
    return (reg as any).tasks.find((t: any) => t.name === 'sentinel:summary');
  }

  test('summary task returns null when mode is observation (summaryMode=armed)', async () => {
    storeData['state'] = { mode: 'observation', armedAt: null, lastSummaryAt: null, armMode: 'manual', summaryMode: 'armed' };
    const task = getSummaryTask(registry);
    expect(task).toBeDefined();
    const result = await task.handler();
    expect(result).toBeNull();
  });

  test('summary task sends when mode is observation and summaryMode=always', async () => {
    storeData['state'] = { mode: 'observation', armedAt: null, lastSummaryAt: null, armMode: 'manual', summaryMode: 'always' };
    mockHttp.get.mockResolvedValueOnce(
      hassState('binary_sensor.motion', 'clear', { friendly_name: 'Motion Sensor' }),
    );
    const task = getSummaryTask(registry);
    const result = await task.handler();
    expect(result).toContain('Sentinel summary');
  });

  test('summary task returns report when mode is sentinel', async () => {
    storeData['state'] = { mode: 'sentinel', armedAt: '2026-01-01T00:00:00.000Z', lastSummaryAt: null, armMode: 'manual', summaryMode: 'armed' };
    mockHttp.get.mockResolvedValueOnce(
      hassState('binary_sensor.motion', 'clear', { friendly_name: 'Motion Sensor' }),
    );

    const task = getSummaryTask(registry);
    const result = await task.handler();
    expect(result).toContain('Sentinel summary');
    expect(result).toContain('binary_sensor.motion');
    expect(mockStore.set).toHaveBeenCalledWith('state', expect.objectContaining({ lastSummaryAt: expect.any(String) }));
  });

  test('summary task clears presence log after sending', async () => {
    storeData['state'] = { mode: 'sentinel', armedAt: '2026-01-01T00:00:00.000Z', lastSummaryAt: null, armMode: 'manual', summaryMode: 'armed' };
    storeData['presenceLog'] = [{ state: 'all_away', at: new Date().toISOString() }];
    mockHttp.get.mockResolvedValueOnce(
      hassState('binary_sensor.motion', 'clear', {}),
    );
    const task = getSummaryTask(registry);
    await task.handler();
    expect(mockStore.set).toHaveBeenCalledWith('presenceLog', []);
  });

  test('summary task includes presence section when log has events', async () => {
    storeData['state'] = { mode: 'sentinel', armedAt: '2026-01-01T00:00:00.000Z', lastSummaryAt: null, armMode: 'manual', summaryMode: 'armed' };
    storeData['presenceLog'] = [
      { state: 'all_away', at: new Date(Date.now() - 2 * 3_600_000).toISOString() },
      { state: 'someone_home', at: new Date(Date.now() - 1 * 3_600_000).toISOString() },
    ];
    mockHttp.get.mockResolvedValueOnce(
      hassState('binary_sensor.motion', 'clear', {}),
    );
    const task = getSummaryTask(registry);
    const result = await task.handler();
    expect(result).toContain('Presence');
    expect(result).toContain('Someone home');
  });
});
