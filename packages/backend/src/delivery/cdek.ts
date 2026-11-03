export interface CdekConfig {
  environment: 'test' | 'production';
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
}

export interface CdekInput {
  tariffCode: number;
  fromLocation: { code: number; address?: string };
  toLocation: { code: number; address?: string };
  shipmentPoint?: string;
  deliveryPoint?: string;
  packages: { weightG: number; lengthCm: number; widthCm: number; heightCm: number }[];
}

export interface CdekQuote {
  provider: 'cdek';
  environment: CdekConfig['environment'];
  tariffCode: number;
  currency: 'RUB';
  deliveryCostKop: number;
  baseCostKop: number;
  periodMin: number;
  periodMax: number;
  calculatedWeightG: number;
  hasWarnings: boolean;
}

export interface CdekCalculator {
  calculate(input: CdekInput): Promise<CdekQuote>;
}

/** No provider payload, request, credentials or underlying exception is retained. */
export class CdekError extends Error {
  constructor(
    readonly code: string,
    readonly status = 502,
  ) {
    super(code);
    this.name = 'CdekError';
  }
}

export function loadCdekConfig(env: NodeJS.ProcessEnv = process.env): CdekConfig | undefined {
  const enabled = env.CDEK_ENABLED?.trim() || '0';
  if (enabled === '0' || enabled === 'false') return undefined;
  if (enabled !== '1' && enabled !== 'true') throw new Error('CDEK_ENABLED: expected 0 or 1');
  const environment = env.CDEK_ENVIRONMENT?.trim();
  if (environment !== 'test' && environment !== 'production')
    throw new Error('CDEK_ENVIRONMENT: select test or production explicitly');
  const clientId = env.CDEK_CLIENT_ID?.trim();
  const clientSecret = env.CDEK_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error('CDEK_CLIENT_ID and CDEK_CLIENT_SECRET required');
  const timeoutMs = Number(env.CDEK_TIMEOUT_MS ?? 10000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000)
    throw new Error('CDEK_TIMEOUT_MS: expected integer from 100 to 30000');
  return { environment, clientId, clientSecret, timeoutMs };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CdekError('CDEK_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

function money(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new CdekError('CDEK_INVALID_RESPONSE');
  const kop = Math.round(value * 100);
  if (!Number.isSafeInteger(kop)) throw new CdekError('CDEK_INVALID_RESPONSE');
  return kop;
}

function integer(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new CdekError('CDEK_INVALID_RESPONSE');
  return value;
}

export class CdekClient implements CdekCalculator {
  private token?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string>;
  private readonly base: string;

  constructor(
    private readonly config: CdekConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.base =
      config.environment === 'production' ? 'https://api.cdek.ru/v2' : 'https://api.edu.cdek.ru/v2';
  }

  private async request(path: string, options: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(`${this.base}${path}`, {
        ...options,
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      throw new CdekError(timeout ? 'CDEK_TIMEOUT' : 'CDEK_UNAVAILABLE', 503);
    }
  }

  private async json(response: Response): Promise<Record<string, unknown>> {
    try {
      return record(await response.json());
    } catch (error) {
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
        throw new CdekError('CDEK_TIMEOUT', 503);
      throw new CdekError('CDEK_INVALID_RESPONSE');
    }
  }

  private accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt) return Promise.resolve(this.token.value);
    if (!this.pendingToken)
      this.pendingToken = this.authorize().finally(() => {
        this.pendingToken = undefined;
      });
    return this.pendingToken;
  }

  private async authorize(): Promise<string> {
    const startedAt = this.now();
    const response = await this.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CdekError(
        response.status === 429 ? 'CDEK_RATE_LIMITED' : 'CDEK_AUTH_FAILED',
        response.status === 429 ? 503 : 502,
      );
    }
    const data = await this.json(response);
    if (
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      /\s/.test(data.access_token) ||
      typeof data.expires_in !== 'number' ||
      !Number.isSafeInteger(data.expires_in) ||
      data.expires_in <= 0 ||
      data.expires_in > 86400
    )
      throw new CdekError('CDEK_AUTH_FAILED');
    const lifetime = data.expires_in * 1000;
    this.token = {
      value: data.access_token,
      expiresAt: startedAt + lifetime - Math.min(30000, lifetime / 2),
    };
    return data.access_token;
  }

  async calculate(input: CdekInput): Promise<CdekQuote> {
    const body = JSON.stringify({
      type: 1,
      currency: 1, // CDEK appendix 14: RUB, not ISO 4217 numeric code 643.
      lang: 'rus',
      tariff_code: input.tariffCode,
      from_location: input.fromLocation,
      to_location: input.toLocation,
      shipment_point: input.shipmentPoint,
      delivery_point: input.deliveryPoint,
      packages: input.packages.map((p) => ({
        weight: p.weightG,
        length: p.lengthCm,
        width: p.widthCm,
        height: p.heightCm,
      })),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await this.accessToken();
      const response = await this.request('/calculator/tariff', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) {
          // A late 401 must not invalidate a newer token obtained by another request.
          if (this.token?.value === accessToken) this.token = undefined;
          if (attempt === 0) continue;
          throw new CdekError('CDEK_AUTH_FAILED');
        }
        if (response.status === 429) throw new CdekError('CDEK_RATE_LIMITED', 503);
        throw new CdekError(
          response.status >= 500 ? 'CDEK_UNAVAILABLE' : 'CDEK_CALCULATION_FAILED',
          response.status >= 500 ? 503 : 502,
        );
      }
      const data = await this.json(response);
      if (data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length > 0))
        throw new CdekError('CDEK_CALCULATION_FAILED');
      if (data.currency !== 'RUB' || (data.warnings !== undefined && !Array.isArray(data.warnings)))
        throw new CdekError('CDEK_INVALID_RESPONSE');
      const periodMin = integer(data.period_min, 0);
      const periodMax = integer(data.period_max, periodMin);
      return {
        provider: 'cdek',
        environment: this.config.environment,
        tariffCode: input.tariffCode,
        currency: 'RUB',
        deliveryCostKop: money(data.total_sum),
        baseCostKop: money(data.delivery_sum),
        periodMin,
        periodMax,
        calculatedWeightG: integer(data.weight_calc, 1),
        hasWarnings: Array.isArray(data.warnings) && data.warnings.length > 0,
      };
    }
    throw new CdekError('CDEK_AUTH_FAILED');
  }
}
