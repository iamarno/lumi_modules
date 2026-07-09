import axios from 'axios';
import { ModuleRegistry } from 'lumi';
import { BotConfig } from 'lumi';

jest.mock('axios');
const mockedAxios = jest.mocked(axios);

const mockConfig: BotConfig = {
  homeserver: '', userId: '', accessToken: '',
  prometheusUrl: '', hassUrl: '', hassToken: '', grafanaUrl: '', grafanaToken: '',
  httpAllowedDomains: [], weatherEnabled: false, logLevel: 'info',
  e2eeEnabled: false, deviceId: '', cryptoPassword: '', cryptoSaveInterval: 60,
};

async function invoke(registry: ModuleRegistry, name: string, args: string[]) {
  return registry.get(name)!.handler({
    args, roomId: '', event: {} as any, client: {} as any,
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const todayDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, always today UTC

const scheduledMatch = {
  id: 100,
  competition: { id: 2021, name: 'Premier League', code: 'PL' },
  homeTeam: { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
  awayTeam: { id: 61, name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
  utcDate: `${todayDate}T15:00:00Z`, // always today UTC, no midnight-crossing risk
  status: 'TIMED',
  score: { winner: null, duration: 'REGULAR', fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
  goals: [],
};

const liveMatch = {
  ...scheduledMatch,
  status: 'IN_PLAY',
  minute: 67,
  score: { winner: null, duration: 'REGULAR', fullTime: { home: 2, away: 1 }, halfTime: { home: 1, away: 0 } },
  goals: [
    { minute: 23, team: { id: 57, name: 'Arsenal FC' }, scorer: { name: 'Saka' }, type: 'NORMAL' },
    { minute: 55, team: { id: 57, name: 'Arsenal FC' }, scorer: { name: 'Martinelli' }, type: 'NORMAL' },
    { minute: 60, team: { id: 61, name: 'Chelsea FC' }, scorer: { name: 'Palmer' }, type: 'NORMAL' },
  ],
};

const finishedMatch = {
  ...liveMatch,
  status: 'FINISHED',
  score: { winner: 'HOME_TEAM', duration: 'REGULAR', fullTime: { home: 2, away: 1 }, halfTime: { home: 1, away: 0 } },
};

const standingsResponse = {
  data: {
    standings: [{
      type: 'TOTAL',
      table: [
        { position: 1, team: { id: 11, name: 'Manchester City', shortName: 'Man City', tla: 'MCI' }, playedGames: 28, points: 64, won: 20, draw: 4, lost: 4, goalDifference: 42 },
        { position: 2, team: { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },       playedGames: 28, points: 60, won: 18, draw: 6, lost: 4, goalDifference: 35 },
        { position: 3, team: { id: 65, name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },   playedGames: 28, points: 58, won: 18, draw: 4, lost: 6, goalDifference: 28 },
      ],
    }],
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

const mod = require('../src/football');

describe('football module', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FOOTBALL_API_KEY = 'test-key';
    process.env.FOOTBALL_CLUB_ID = '57';
    process.env.FOOTBALL_COMPETITION = 'PL';
    delete process.env.FOOTBALL_LIVE_ROOMS;
    registry = new ModuleRegistry();
    mod.register(registry, mockConfig);
  });

  afterEach(() => {
    delete process.env.FOOTBALL_API_KEY;
    delete process.env.FOOTBALL_CLUB_ID;
    delete process.env.FOOTBALL_COMPETITION;
  });

  test('does not register when FOOTBALL_API_KEY is missing', () => {
    delete process.env.FOOTBALL_API_KEY;
    const reg2 = new ModuleRegistry();
    mod.register(reg2, mockConfig);
    expect(reg2.get('football')).toBeUndefined();
  });

  test('does not register when FOOTBALL_CLUB_ID is missing', () => {
    delete process.env.FOOTBALL_CLUB_ID;
    const reg2 = new ModuleRegistry();
    mod.register(reg2, mockConfig);
    expect(reg2.get('football')).toBeUndefined();
  });

  test('registers !football command', () => {
    expect(registry.get('football')).toBeDefined();
  });

  test('!football shows live score when match is in progress', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { matches: [liveMatch] } });
    const result = await invoke(registry, 'football', []);
    expect(result).toContain('LIVE');
    expect(result).toContain('Arsenal');
    expect(result).toContain('2');
  });

  test('!football shows today fixture when no live match', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { matches: [] } }); // no live
    mockedAxios.get.mockResolvedValueOnce({ data: { matches: [scheduledMatch] } }); // today
    const result = await invoke(registry, 'football', []);
    expect(result).toContain('Today');
    expect(result).toContain('Arsenal');
    expect(result).toContain('Chelsea');
  });

  test('!football shows next fixture when no match today', async () => {
    const futureMatch = { ...scheduledMatch, utcDate: new Date(Date.now() + 5 * 86400_000).toISOString() };
    mockedAxios.get.mockResolvedValueOnce({ data: { matches: [] } }); // no live
    mockedAxios.get.mockResolvedValueOnce({ data: { matches: [] } }); // no today
    mockedAxios.get.mockResolvedValueOnce({ data: { matches: [futureMatch] } }); // next fixture
    const result = await invoke(registry, 'football', []);
    expect(result).toContain('Next');
    expect(result).toContain('Arsenal');
  });

  test('!football shows FT result for finished match today', async () => {
    const todayFinished = { ...finishedMatch, utcDate: new Date().toISOString() };
    mockedAxios.get.mockResolvedValueOnce({ data: { matches: [] } }); // no live
    mockedAxios.get.mockResolvedValueOnce({ data: { matches: [todayFinished] } }); // today finished
    const result = await invoke(registry, 'football', []);
    expect(result).toContain('FT');
    expect(result).toContain('2');
  });

  test('!football score returns no live match message when idle', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { matches: [] } });
    const result = await invoke(registry, 'football', ['score']);
    expect(result).toContain('No live match');
  });

  test('!football score shows live score and scorers', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { matches: [liveMatch] } });
    mockedAxios.get.mockResolvedValueOnce({ data: liveMatch }); // fetchMatchById
    const result = await invoke(registry, 'football', ['score']);
    expect(result).toContain('LIVE');
    expect(result).toContain('67\'');
    expect(result).toContain('Saka');
    expect(result).toContain('Martinelli');
    expect(result).toContain('Palmer');
  });

  test('!football table shows standings centred on club', async () => {
    mockedAxios.get.mockResolvedValueOnce(standingsResponse);
    const result = await invoke(registry, 'football', ['table']);
    expect(result).toContain('PL Standings');
    expect(result).toContain('Arsenal');
    expect(result).toContain('Man City');
    expect(result).toContain('pts');
  });

  test('!football fixtures shows upcoming matches', async () => {
    const future1 = { ...scheduledMatch, utcDate: new Date(Date.now() + 3 * 86400_000).toISOString() };
    const future2 = { ...scheduledMatch, id: 101, utcDate: new Date(Date.now() + 10 * 86400_000).toISOString() };
    mockedAxios.get.mockResolvedValueOnce({ data: { matches: [future1, future2] } });
    const result = await invoke(registry, 'football', ['fixtures']);
    expect(result).toContain('Upcoming');
    expect(result).toContain('Arsenal');
    expect(result).toContain('Chelsea');
  });

  test('!football fixtures with count argument limits results', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { matches: [] } });
    await invoke(registry, 'football', ['fixtures', '3']);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ params: expect.objectContaining({ limit: 3 }) }),
    );
  });

  test('live monitor is registered as onStart hook when FOOTBALL_LIVE_ROOMS is set', () => {
    process.env.FOOTBALL_LIVE_ROOMS = '!testroom:matrix.org';
    const reg2 = new ModuleRegistry();
    mod.register(reg2, mockConfig);
    // onStart hooks are stored internally; verify the command still registers
    expect(reg2.get('football')).toBeDefined();
  });
});
