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
      process.env.HTTP_ALLOWED_DOMAINS = 'example.com';
      const reg = new ModuleRegistry();
      mod.register(reg, baseConfig);
      expect(await invoke(reg, 'fetch', ['https://evil.com'])).toContain('Domain not in');
      delete process.env.HTTP_ALLOWED_DOMAINS;
    });

    test('allows domain that is in allowlist', async () => {
      process.env.HTTP_ALLOWED_DOMAINS = 'example.com';
      mockedAxios.get.mockResolvedValueOnce({
        data: 'ok', headers: { 'content-type': 'text/plain' }, status: 200,
      });
      const reg = new ModuleRegistry();
      mod.register(reg, baseConfig);
      const result = await invoke(reg, 'fetch', ['https://example.com/path']);
      expect(result).toContain('ok');
      delete process.env.HTTP_ALLOWED_DOMAINS;
    });
  });

  describe('SSRF guard', () => {
    test.each([
      'http://169.254.169.254/latest/meta-data/',   // cloud metadata
      'http://127.0.0.1/',                           // loopback
      'http://10.0.0.5/',                            // private
      'http://192.168.1.1/',                         // private
      'http://172.16.0.1/',                          // private
      'http://[::1]/',                               // IPv6 loopback
      'https://localhost/',                          // localhost
      'ftp://example.com/',                          // non-http scheme
    ])('!fetch blocks %s', async (url) => {
      const result = await invoke(registry, 'fetch', [url]);
      expect(result).toContain('Blocked');
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    test('!json blocks a private target too', async () => {
      const result = await invoke(registry, 'json', ['http://169.254.169.254/', 'x']);
      expect(result).toContain('Blocked');
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    test('isBlockedIp classifies addresses correctly', () => {
      const { isBlockedIp } = mod;
      // blocked
      for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1',
                         '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1',
                         '::ffff:127.0.0.1', 'not-an-ip']) {
        expect(isBlockedIp(ip)).toBe(true);
      }
      // allowed (public)
      for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
        expect(isBlockedIp(ip)).toBe(false);
      }
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
