import { describe, expect, it, vi } from 'vitest';
import { CdekClient, loadCdekConfig } from '../src/delivery/cdek.js';
import { parseCdekInput } from '../src/delivery/validate.js';

const config = {
  environment: 'test' as const,
  clientId: 'test-account',
  clientSecret: 'secret-with-&=+',
  timeoutMs: 100,
};
const input = {
  tariffCode: 136,
  fromLocation: { code: 268 },
  toLocation: { code: 44, address: 'Тестовый адрес' },
  shipmentPoint: 'TEST1',
  deliveryPoint: 'TEST2',
  packages: [{ weightG: 1200, lengthCm: 30, widthCm: 20, heightCm: 10 }],
};
const token = () => Response.json({ access_token: 'access-token', expires_in: 3600 });
const result = (over = {}) => ({
  delivery_sum: 500,
  total_sum: 612.34,
  currency: 'RUB',
  period_min: 2,
  period_max: 5,
  weight_calc: 1200,
  ...over,
});
const transport = (reply: Response = Response.json(result())) =>
  vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValue(reply);

describe('CDEK configuration and validation', () => {
  it('is disabled by default and requires explicit environment and credentials when enabled', () => {
    expect(loadCdekConfig({})).toBeUndefined();
    expect(loadCdekConfig({ CDEK_ENABLED: '0', CDEK_CLIENT_SECRET: 'unused' })).toBeUndefined();
    expect(() => loadCdekConfig({ CDEK_ENABLED: 'true' })).toThrow(/CDEK_ENVIRONMENT/);
    expect(() => loadCdekConfig({ CDEK_ENABLED: '1', CDEK_ENVIRONMENT: 'production' })).toThrow(
      /CDEK_CLIENT/,
    );
    expect(
      loadCdekConfig({
        CDEK_ENABLED: '1',
        CDEK_ENVIRONMENT: 'test',
        CDEK_CLIENT_ID: 'id',
        CDEK_CLIENT_SECRET: 'secret',
      }),
    ).toEqual({ ...config, clientId: 'id', clientSecret: 'secret', timeoutMs: 10000 });
    expect(() => loadCdekConfig({ CDEK_ENABLED: 'yes' })).toThrow(/CDEK_ENABLED/);
  });

  it('normalizes only documented input fields', () => {
    expect(parseCdekInput({ ...input, clientSecret: 'ignored', currency: 'USD' })).toEqual(input);
  });

  it.each([
    null,
    {},
    { ...input, tariffCode: '136' },
    { ...input, fromLocation: { code: -1 } },
    { ...input, toLocation: { code: 0 } },
    { ...input, packages: [] },
    { ...input, packages: Array(31).fill(input.packages[0]) },
    { ...input, packages: [{ weightG: 1 }] },
    { ...input, packages: [{ ...input.packages[0], weightG: 0 }] },
    { ...input, packages: [{ ...input.packages[0], lengthCm: 1.5 }] },
    { ...input, deliveryPoint: ' ' },
  ])('rejects incomplete or invalid shipment without guessing defaults: %j', (body) => {
    expect(() => parseCdekInput(body)).toThrow();
  });
});

describe('CDEK calculator', () => {
  it('requests a contract quote in RUB, preserves measurements, and uses the VAT-inclusive total', async () => {
    const fetcher = transport();
    const quote = await new CdekClient(config, fetcher).calculate(input);
    expect(quote).toEqual({
      provider: 'cdek',
      environment: 'test',
      tariffCode: 136,
      currency: 'RUB',
      deliveryCostKop: 61234,
      baseCostKop: 50000,
      periodMin: 2,
      periodMax: 5,
      calculatedWeightG: 1200,
      hasWarnings: false,
    });
    const [authUrl, authOptions] = fetcher.mock.calls[0]!;
    expect(authUrl).toBe('https://api.edu.cdek.ru/v2/oauth/token');
    expect(new URLSearchParams(String(authOptions?.body)).get('client_secret')).toBe(
      config.clientSecret,
    );
    expect(authOptions?.redirect).toBe('error');
    const [url, options] = fetcher.mock.calls[1]!;
    expect(url).toBe('https://api.edu.cdek.ru/v2/calculator/tariff');
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer access-token');
    expect(JSON.parse(String(options?.body))).toEqual({
      type: 1,
      currency: 1,
      lang: 'rus',
      tariff_code: 136,
      from_location: { code: 268 },
      to_location: { code: 44, address: 'Тестовый адрес' },
      shipment_point: 'TEST1',
      delivery_point: 'TEST2',
      packages: [{ weight: 1200, length: 30, width: 20, height: 10 }],
    });
  });

  it('selects only the official production host for production credentials', async () => {
    const fetcher = transport();
    await new CdekClient({ ...config, environment: 'production' }, fetcher).calculate(input);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.cdek.ru/v2/oauth/token',
      'https://api.cdek.ru/v2/calculator/tariff',
    ]);
  });

  it('shares a pending token and reuses it until its provider expiry', async () => {
    let time = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/oauth/token') ? token() : Response.json(result()),
    );
    const client = new CdekClient(config, fetcher, () => time);
    await Promise.all([client.calculate(input), client.calculate(input)]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/oauth/token'))).toHaveLength(
      1,
    );
    time = 3600000;
    await client.calculate(input);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/oauth/token'))).toHaveLength(
      2,
    );
  });

  it('refreshes a rejected token once, then fails instead of retrying indefinitely', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(new CdekClient(config, fetcher).calculate(input)).rejects.toMatchObject({
      code: 'CDEK_AUTH_FAILED',
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('successfully recalculates after refreshing an expired token', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json(result()));
    expect((await new CdekClient(config, fetcher).calculate(input)).deliveryCostKop).toBe(61234);
  });

  it.each([
    { total_sum: undefined },
    { total_sum: -1 },
    { total_sum: '612.34' },
    { total_sum: 1e20 },
    { currency: 'USD' },
    { period_max: 1 },
    { period_min: null },
    { weight_calc: 0 },
    { errors: [{ code: 'ERROR', message: 'secret provider detail' }] },
  ])('rejects an unusable result without a fixed-price fallback: %j', async (over) => {
    await expect(
      new CdekClient(config, transport(Response.json(result(over)))).calculate(input),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^CDEK_/) });
  });

  it('reports provider warnings without exposing raw messages', async () => {
    const quote = await new CdekClient(
      config,
      transport(Response.json(result({ warnings: [{ code: 'OFFICE', message: 'private' }] }))),
    ).calculate(input);
    expect(quote.hasWarnings).toBe(true);
    expect(JSON.stringify(quote)).not.toContain('private');
  });

  it.each([
    [429, 'CDEK_RATE_LIMITED'],
    [500, 'CDEK_UNAVAILABLE'],
    [400, 'CDEK_CALCULATION_FAILED'],
  ])('maps HTTP %i to a safe error', async (status, code) => {
    await expect(
      new CdekClient(
        config,
        transport(new Response('secret provider detail', { status: Number(status) })),
      ).calculate(input),
    ).rejects.toMatchObject({ code });
  });

  it('sanitizes network/auth failures and allows a subsequent token attempt', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(config.clientSecret))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json(result()));
    const client = new CdekClient(config, fetcher);
    await expect(client.calculate(input)).rejects.toMatchObject({
      code: 'CDEK_UNAVAILABLE',
      message: expect.not.stringContaining(config.clientSecret),
    });
    expect((await client.calculate(input)).deliveryCostKop).toBe(61234);
  });

  it('aborts a stalled provider request', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_url, opts) =>
        new Promise((_resolve, reject) => {
          opts!.signal!.addEventListener('abort', () =>
            reject(new DOMException('timeout', 'TimeoutError')),
          );
        }),
    );
    await expect(
      new CdekClient({ ...config, timeoutMs: 10 }, fetcher).calculate(input),
    ).rejects.toMatchObject({ code: 'CDEK_TIMEOUT' });
  });

  it('rejects malformed JSON and malformed OAuth credentials', async () => {
    await expect(
      new CdekClient(config, transport(new Response('bad json'))).calculate(input),
    ).rejects.toMatchObject({ code: 'CDEK_INVALID_RESPONSE' });
    await expect(
      new CdekClient(
        config,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ access_token: '', expires_in: -1 })),
      ).calculate(input),
    ).rejects.toMatchObject({ code: 'CDEK_AUTH_FAILED' });
  });
});
