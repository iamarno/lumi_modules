import axios from 'axios';
import { renderAndUpload } from '../src/lib/grafana_render';

jest.mock('axios');
const mockedAxios = jest.mocked(axios);

const mockClient = {
  uploadContent: jest.fn(),
  sendMessage: jest.fn(),
};

const ROOM = '!room:example.com';
const URL  = 'http://grafana:3000/render/d-solo/abc/dash?panelId=1';

describe('renderAndUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.uploadContent.mockResolvedValue({ content_uri: 'mxc://example/abc' });
    mockClient.sendMessage.mockResolvedValue({});
  });

  test('fetches URL with bearer token and sends image message', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: Buffer.from('fakeimage'),
      headers: { 'content-type': 'image/png' },
    });

    await renderAndUpload(mockClient as any, ROOM, URL, 'mytoken');

    expect(mockedAxios.get).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ headers: { Authorization: 'Bearer mytoken' } }),
    );
    expect(mockClient.uploadContent).toHaveBeenCalled();
    expect(mockClient.sendMessage).toHaveBeenCalledWith(
      ROOM,
      expect.objectContaining({ msgtype: 'm.image', url: 'mxc://example/abc' }),
    );
  });

  test('omits auth header when token is empty', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: Buffer.from('img'),
      headers: { 'content-type': 'image/png' },
    });

    await renderAndUpload(mockClient as any, ROOM, URL, '');

    expect(mockedAxios.get).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ headers: {} }),
    );
  });

  test('appends .png to filename when no extension in path', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: Buffer.from('img'),
      headers: { 'content-type': 'image/png' },
    });

    await renderAndUpload(mockClient as any, ROOM, URL, '');

    const [, content] = mockClient.sendMessage.mock.calls[0]!;
    expect(content.body).toMatch(/\.png$/);
  });

  test('throws when grafana returns non-image content-type', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: Buffer.from('<html>error</html>'),
      headers: { 'content-type': 'text/html' },
    });

    await expect(
      renderAndUpload(mockClient as any, ROOM, URL, ''),
    ).rejects.toThrow('text/html');
  });
});
