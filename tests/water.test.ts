import { ModuleRegistry } from 'lumi';
import { BotConfig } from 'lumi';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isInWindow, parseDuration } = require('../src/water') as {
  isInWindow: (weekday: string, weekend: string, now?: Date) => boolean;
  parseDuration: (s: string) => number | null;
};

const mockConfig: BotConfig = {
  homeserver: '', userId: '', accessToken: '',
  prometheusUrl: '', hassUrl: '', hassToken: '', grafanaUrl: '', grafanaToken: '', httpAllowedDomains: [],
  weatherEnabled: false, logLevel: 'info',
  e2eeEnabled: false, deviceId: '', cryptoPassword: '', cryptoSaveInterval: 60,
};

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDate(day: number, hour: number, minute = 0): Date {
  // day: 0=Sun,1=Mon,...,6=Sat
  const d = new Date(2024, 0, 7 + day, hour, minute); // 2024-01-07 is a Sunday
  return d;
}

// ── isInWindow ────────────────────────────────────────────────────────────────

describe('isInWindow', () => {
  test('weekday inside window returns true', () => {
    expect(isInWindow('09:00-20:00', '11:00-20:00', makeDate(1, 12))).toBe(true); // Mon 12:00
  });

  test('weekday before window returns false', () => {
    expect(isInWindow('09:00-20:00', '11:00-20:00', makeDate(2, 8, 59))).toBe(false); // Tue 08:59
  });

  test('weekday at window start returns true', () => {
    expect(isInWindow('09:00-20:00', '11:00-20:00', makeDate(3, 9, 0))).toBe(true); // Wed 09:00
  });

  test('weekday at window end returns false', () => {
    expect(isInWindow('09:00-20:00', '11:00-20:00', makeDate(4, 20, 0))).toBe(false); // Thu 20:00
  });

  test('saturday inside weekend window returns true', () => {
    expect(isInWindow('09:00-20:00', '11:00-20:00', makeDate(6, 14))).toBe(true); // Sat 14:00
  });

  test('saturday before weekend window returns false', () => {
    expect(isInWindow('09:00-20:00', '11:00-20:00', makeDate(6, 10, 59))).toBe(false); // Sat 10:59
  });

  test('sunday inside weekend window returns true', () => {
    expect(isInWindow('09:00-20:00', '11:00-20:00', makeDate(0, 15))).toBe(true); // Sun 15:00
  });
});

// ── parseDuration ─────────────────────────────────────────────────────────────

describe('parseDuration', () => {
  test('30m returns 1800', () => expect(parseDuration('30m')).toBe(1800));
  test('2h returns 7200', () => expect(parseDuration('2h')).toBe(7200));
  test('1h returns 3600', () => expect(parseDuration('1h')).toBe(3600));
  test('invalid returns null', () => expect(parseDuration('foo')).toBeNull());
  test('empty returns null', () => expect(parseDuration('')).toBeNull());
});

// ── module integration ────────────────────────────────────────────────────────

describe('water module', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    process.env.WATER_INTERVAL = '60';
    process.env.WATER_ROOMS = '!water:matrix.org';
    delete process.env.WATER_WEEKDAY_HOURS;
    delete process.env.WATER_WEEKEND_HOURS;
  });

  afterEach(() => {
    delete process.env.WATER_INTERVAL;
    delete process.env.WATER_ROOMS;
    delete process.env.WATER_WEEKDAY_HOURS;
    delete process.env.WATER_WEEKEND_HOURS;
    jest.useRealTimers();
    jest.resetModules();
  });

  function loadMod() {
    jest.resetModules();
    const mod = require('../src/water');
    registry = new ModuleRegistry();
    mod.register(registry, mockConfig);
    return registry;
  }

  test('does not schedule when WATER_INTERVAL is 0', () => {
    process.env.WATER_INTERVAL = '0';
    loadMod();
    jest.useFakeTimers();
    const client = { sendMessage: jest.fn() };
    registry.startScheduler(client as any);
    jest.advanceTimersByTime(10_000);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  test('does not schedule when WATER_ROOMS is empty', () => {
    process.env.WATER_ROOMS = '';
    loadMod();
    jest.useFakeTimers();
    const client = { sendMessage: jest.fn() };
    registry.startScheduler(client as any);
    jest.advanceTimersByTime(120_000);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  test('sends a hydration reminder inside the active window', async () => {
    // Default weekday window is 09:00-20:00; fake system time to noon on a Monday
    jest.useFakeTimers();
    jest.setSystemTime(makeDate(1, 12)); // Mon 12:00
    loadMod();
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) };
    registry.startScheduler(client as any);
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(client.sendMessage).toHaveBeenCalledWith(
      '!water:matrix.org',
      expect.objectContaining({ msgtype: 'm.text', body: expect.stringContaining('💧') }),
    );
  });

  test('skips reminder outside the active window', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(makeDate(1, 7)); // Mon 07:00 — before 09:00
    loadMod();
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) };
    registry.startScheduler(client as any);
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  test('skips reminder when muted', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(makeDate(1, 12));
    loadMod();
    // Mute via command
    const cmd = registry.get('water')!;
    await cmd.handler({ client: {} as any, roomId: '!r:m.org', event: {} as any, args: ['mute'] });

    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) };
    registry.startScheduler(client as any);
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  test('registers !water command', () => {
    loadMod();
    expect(registry.get('water')).toBeDefined();
  });

  test('!water status returns current state', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(makeDate(1, 12));
    loadMod();
    const cmd = registry.get('water')!;
    const result = await cmd.handler({ client: {} as any, roomId: '!r:m.org', event: {} as any, args: [] });
    expect(result).toContain('active');
    expect(result).toContain('09:00-20:00');
  });

  test('!water mute without duration mutes indefinitely', async () => {
    loadMod();
    const cmd = registry.get('water')!;
    const result = await cmd.handler({ client: {} as any, roomId: '!r:m.org', event: {} as any, args: ['mute'] });
    expect(result).toContain('indefinitely');
  });

  test('!water mute 30m mutes for 30 minutes', async () => {
    loadMod();
    const cmd = registry.get('water')!;
    const result = await cmd.handler({ client: {} as any, roomId: '!r:m.org', event: {} as any, args: ['mute', '30m'] });
    expect(result).toContain('30m');
  });

  test('!water mute with invalid duration returns error', async () => {
    loadMod();
    const cmd = registry.get('water')!;
    const result = await cmd.handler({ client: {} as any, roomId: '!r:m.org', event: {} as any, args: ['mute', 'bad'] });
    expect(result).toContain('Invalid');
  });

  test('!water unmute resumes reminders', async () => {
    loadMod();
    const cmd = registry.get('water')!;
    await cmd.handler({ client: {} as any, roomId: '!r:m.org', event: {} as any, args: ['mute'] });
    const result = await cmd.handler({ client: {} as any, roomId: '!r:m.org', event: {} as any, args: ['unmute'] });
    expect(result).toContain('resumed');
  });

  test('timed mute expires and reminder fires again', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(makeDate(1, 12));
    loadMod();
    const cmd = registry.get('water')!;
    // Mute for 1 minute
    await cmd.handler({ client: {} as any, roomId: '!r:m.org', event: {} as any, args: ['mute', '1m'] });

    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) };
    registry.startScheduler(client as any);

    // Advance 60s — still within mute window (mute=60s, interval=60s, exact boundary)
    // Advance 2 minutes so mute has expired
    jest.setSystemTime(makeDate(1, 12, 2)); // Mon 12:02
    jest.advanceTimersByTime(120_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(client.sendMessage).toHaveBeenCalled();
  });
});
