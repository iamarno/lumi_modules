import axios from 'axios';
import { ModuleRegistry } from 'lumi';
import { BotConfig } from 'lumi';

jest.mock('axios');
const mockedAxios = jest.mocked(axios);

const mod = require('../src/http');

const baseConfig: BotConfig = {
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

describe('http module', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
    mod.register(registry, baseConfig);
    (mockedAxios.isAxiosError as jest.Mock) = jest.fn().mockReturnValue(false);
  });

  describe('!fetch', () => {
    test('returns response body for plain text', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: 'hello world', headers: { 'content-type': 'text/plain' }, status: 200,
      });
      const result = await invoke(registry, 'fetch', ['https://example.com']);
      expect(result).toContain('hello world');
      expect(result).toContain('200');
    });

    test('pretty-prints JSON responses', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: '{"key":"value"}', headers: { 'content-type': 'application/json' }, status: 200,
      });
      const result = await invoke(registry, 'fetch', ['https://example.com']);
      expect(result).toContain('json');
    });

    test('returns usage hint when no URL given', async () => {
      expect(await invoke(registry, 'fetch', [])).toContain('Usage');
    });

    test('blocks domain not in allowlist', async () => {
      const reg = new ModuleRegistry();
      mod.register(reg, { ...baseConfig, httpAllowedDomains: ['example.com'] });
      expect(await invoke(reg, 'fetch', ['https://evil.com'])).toContain('Domain not in');
    });

    test('allows domain that is in allowlist', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: 'ok', headers: { 'content-type': 'text/plain' }, status: 200,
      });
      const reg = new ModuleRegistry();
      mod.register(reg, { ...baseConfig, httpAllowedDomains: ['example.com'] });
      const result = await invoke(reg, 'fetch', ['https://example.com/path']);
      expect(result).toContain('ok');
    });
  });

  describe('!json', () => {
    test('extracts a top-level field', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { name: 'Alice' } });
      expect(await invoke(registry, 'json', ['https://api.example.com', 'name'])).toContain('Alice');
    });

    test('extracts a nested dotted field', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { user: { name: 'Bob' } } });
      expect(await invoke(registry, 'json', ['https://api.example.com', 'user.name'])).toContain('Bob');
    });

    test('returns error when field not found', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { other: 'stuff' } });
      expect(await invoke(registry, 'json', ['https://api.example.com', 'missing'])).toContain('not found');
    });

    test('returns usage hint when field path missing', async () => {
      expect(await invoke(registry, 'json', ['https://api.example.com'])).toContain('Usage');
    });
  });
});
