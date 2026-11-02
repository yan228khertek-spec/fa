import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { normalizePhone } from '../orders/validate.js';
import { AccountError, type AuthRepository, type SmsSender } from './types.js';

export const SESSION_SECONDS = 30 * 86400;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class AuthService {
  constructor(
    readonly repo: AuthRepository,
    private readonly sender: SmsSender,
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (secret.length < 32) throw new Error('AUTH_CODE_SECRET must contain at least 32 characters');
  }

  private hmac(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }

  async requestCode(rawPhone: string, ip: string) {
    const phone = normalizePhone(rawPhone);
    if (!phone) throw new AccountError(422, 'INVALID_PHONE');
    const now = this.now();
    const id = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const issued = await this.repo.issue({
      challenge: {
        id,
        phone,
        digest: this.hmac(`code:${id}:${code}`),
        expiresAt: new Date(now.getTime() + 300_000),
        attempts: 0,
        state: 'pending',
      },
      phoneKey: this.hmac(`phone:${phone}`),
      ipKey: this.hmac(`ip:${ip}`),
      now,
    });
    if (!issued) throw new AccountError(429, 'RATE_LIMITED');
    try {
      await this.sender.send(phone, code);
      await this.repo.activate(id);
    } catch {
      await this.repo.discard(id);
      throw new AccountError(503, 'SMS_UNAVAILABLE');
    }
    return { challengeId: id, expiresIn: 300, resendAfter: 60 };
  }

  async verifyCode(id: string, code: string) {
    if (!UUID.test(id) || !/^\d{6}$/.test(code)) throw new AccountError(401, 'INVALID_CODE');
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const account = await this.repo.verify({
      id,
      digest: this.hmac(`code:${id}:${code}`),
      sessionHash: hash(token),
      now,
      sessionExpiresAt: new Date(now.getTime() + SESSION_SECONDS * 1000),
    });
    if (!account) throw new AccountError(401, 'INVALID_CODE');
    return { account, token };
  }

  csrfToken(token: string): string {
    return this.hmac(`csrf:${token}`);
  }

  async authenticate(token: string) {
    return TOKEN.test(token) ? this.repo.session(hash(token), this.now()) : null;
  }

  async logout(token: string): Promise<void> {
    if (TOKEN.test(token)) await this.repo.revoke(hash(token));
  }
}
