import axios from 'axios';
import { ModuleRegistry } from 'lumi';
import { BotConfig } from 'lumi';

jest.mock('axios');
const mockedAxios = jest.mocked(axios);

const mockConfig: BotConfig = {
  homeserver: '', userId: '', accessToken: '',
  logLevel: 'info',
  e2eeEnabled: false, deviceId: '', cryptoPassword: '', cryptoSaveInterval: 60,
  adminUsers: [],
};

async function invoke(registry: ModuleRegistry, name: string, args: string[]) {
  return registry.get(name)!.handler({
    args, roomId: '', event: {} as any, client: {} as any,
  });
}

// sumostats.com response shape
const sumostatsResponse = {
  data: {
    data: [{
      id: 1,
      shikona: 'Aonishiki', shikona_kanji: '安青錦',
      rank: 'O1e', highest_rank: 'O1e',
      heya: { name: 'Ajigawa', heya_id: 45 },
      birth_date: '2004-03-23',
      country: 'Ukraine', prefecture: null,
      height: 182, weight: 140,
      total_wins: 132, total_losses: 35, total_absents: null,
      current_elo: 2696.9,
      retired_basho: null,
    }],
  },
};

// sumo-api.com response shape
const sumoApiResponse = {
  data: {
    rikishi: [{
      id: 1, sumodbId: 1, nskId: 1,
      shikonaEn: 'Terunofuji', shikonaJp: '照ノ富士',
      currentRank: 'Yokozuna 1 East',
      heya: 'Isegahama',
      birthDate: '1991-11-29',
      shusshin: 'Tsogttsetseg, Mongolia',
      height: 192, weight: 177,
      debut: '2011-03',
    }],
  },
};

const mod = require('../src/sumo');

describe('sumo module', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    delete process.env.SUMO_FAVORITE;
    registry = new ModuleRegistry();
    mod.register(registry, mockConfig);
  });

  test('registers !sumo command', () => {
    expect(registry.get('sumo')).toBeDefined();
  });

  test('shows subcommand list when no args given', async () => {
    const result = await invoke(registry, 'sumo', []);
    expect(result).toContain('rikishi');
    expect(result).toContain('basho');
    expect(result).toContain('rules');
    expect(result).toContain('term');
  });

  test('!sumo rules returns rules text', async () => {
    const result = await invoke(registry, 'sumo', ['rules']);
    expect(result).toContain('tachi-ai');
    expect(result).toContain('82');
  });

  test('!sumo term yokozuna returns definition', async () => {
    const result = await invoke(registry, 'sumo', ['term', 'yokozuna']);
    expect(result).toContain('yokozuna');
    expect(result).toContain('highest rank');
  });

  test('!sumo term with no args lists known terms', async () => {
    const result = await invoke(registry, 'sumo', ['term']);
    expect(result).toContain('Known terms');
    expect(result).toContain('basho');
  });

  test('!sumo term for unknown word returns unknown message', async () => {
    const result = await invoke(registry, 'sumo', ['term', 'zazen']);
    expect(result).toContain('Unknown term');
  });

  test('!sumo basho returns basho info', async () => {
    const result = await invoke(registry, 'sumo', ['basho']);
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
  });

  test('!sumo rikishi with no args returns usage hint', async () => {
    const result = await invoke(registry, 'sumo', ['rikishi']);
    expect(result).toContain('Usage');
  });

  test('!sumo rikishi uses sumostats by default', async () => {
    mockedAxios.get.mockResolvedValueOnce(sumostatsResponse);
    const result = await invoke(registry, 'sumo', ['rikishi', 'aonishiki']);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('sumostats.com'),
      expect.objectContaining({ params: expect.objectContaining({ search: 'aonishiki' }) }),
    );
    expect(result).toContain('Aonishiki');
    expect(result).toContain('Ajigawa');
    expect(result).toContain('ELO');
  });

  test('!sumo rikishi --official uses sumo-api.com', async () => {
    mockedAxios.get.mockResolvedValueOnce(sumoApiResponse);
    const result = await invoke(registry, 'sumo', ['rikishi', 'Terunofuji', '--official']);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('sumo-api.com'),
      expect.anything(),
    );
    expect(result).toContain('Terunofuji');
    expect(result).toContain('Isegahama');
  });

  test('!sumo rikishi returns not-found message when API returns empty list', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [] } });
    const result = await invoke(registry, 'sumo', ['rikishi', 'nobody']);
    expect(result).toContain('No rikishi found');
  });

  test('!sumo favorite with no SUMO_FAVORITE set returns config hint', async () => {
    const result = await invoke(registry, 'sumo', ['favorite']);
    expect(result).toContain('SUMO_FAVORITE');
  });

  test('!sumo favorite with SUMO_FAVORITE set fetches rikishi via sumostats', async () => {
    process.env.SUMO_FAVORITE = 'aonishiki';
    const reg2 = new ModuleRegistry();
    mod.register(reg2, mockConfig);
    mockedAxios.get.mockResolvedValueOnce(sumostatsResponse);
    const result = await reg2.get('sumo')!.handler({ args: ['favorite'], roomId: '', event: {} as any, client: {} as any });
    expect(result).toContain('Aonishiki');
  });
});
