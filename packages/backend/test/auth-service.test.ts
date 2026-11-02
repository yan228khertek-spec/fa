import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { MemoryAuthRepository } from '../src/auth/memory.js';
import type { SmsSender } from '../src/auth/types.js';

describe('вход покупателей по одноразовому коду', () => {
  let repo: MemoryAuthRepository;
  let auth: AuthService;
  let now: Date;
  let sent: { phone: string; code: string }[];
  let sender: SmsSender;
  beforeEach(() => {
    repo = new MemoryAuthRepository();
    now = new Date('2026-11-02T12:00:00Z');
    sent = [];
    sender = {
      kind: 'test',
      async send(phone, code) {
        sent.push({ phone, code });
      },
    };
    auth = new AuthService(repo, sender, 'test-secret-that-is-at-least-32-characters', () => now);
  });
  const request = () => auth.requestCode('8 (913) 123-45-67', '127.0.0.1');
  const login = async () => {
    const c = await request();
    return auth.verifyCode(c.challengeId, sent.at(-1)!.code);
  };

  it('нормализует телефон, создаёт аккаунт и восстанавливает сессию', async () => {
    const { account, token } = await login();
    expect(sent[0].phone).toBe('+79131234567');
    expect(sent[0].code).toMatch(/^\d{6}$/);
    expect(account).toMatchObject({ phone: '+79131234567', name: null, email: null });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await auth.authenticate(token)).toEqual(account);
    const restarted = new AuthService(
      repo,
      sender,
      'test-secret-that-is-at-least-32-characters',
      () => now,
    );
    expect(await restarted.authenticate(token)).toEqual(account);
    expect(JSON.stringify([...repo.challenges.values()])).not.toContain(`"${sent[0].code}"`);
    expect(JSON.stringify([...repo.sessions.values()])).not.toContain(token);
  });
  it('код потребляется только один раз, включая параллельное подтверждение', async () => {
    const c = await request();
    const results = await Promise.allSettled([
      auth.verifyCode(c.challengeId, sent[0].code),
      auth.verifyCode(c.challengeId, sent[0].code),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('блокирует код после пяти неверных попыток', async () => {
    const c = await request();
    const wrong = sent[0].code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      await expect(auth.verifyCode(c.challengeId, wrong)).rejects.toMatchObject({
        code: 'INVALID_CODE',
      });
    await expect(auth.verifyCode(c.challengeId, sent[0].code)).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
  });
  it('код истекает через пять минут', async () => {
    const c = await request();
    now = new Date(now.getTime() + 300_000);
    await expect(auth.verifyCode(c.challengeId, sent[0].code)).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
  });
  it('повторная отправка ограничена и отменяет прежний код', async () => {
    const first = await request();
    await expect(request()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    now = new Date(now.getTime() + 60_000);
    const second = await request();
    await expect(auth.verifyCode(first.challengeId, sent[0].code)).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    expect((await auth.verifyCode(second.challengeId, sent[1].code)).account.phone).toBe(
      '+79131234567',
    );
  });
  it('ограничивает отправки на телефон за час', async () => {
    for (let i = 0; i < 5; i++) {
      await request();
      now = new Date(now.getTime() + 60_000);
    }
    await expect(request()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('ограничивает отправки на IP независимо от номера', async () => {
    for (let i = 0; i < 20; i++)
      await auth.requestCode(`+7913000${String(i).padStart(4, '0')}`, '127.0.0.1');
    await expect(auth.requestCode('+79139999999', '127.0.0.1')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
  it('повторный вход использует прежний аккаунт', async () => {
    const first = await login();
    now = new Date(now.getTime() + 60_000);
    expect((await login()).account.id).toBe(first.account.id);
  });
  it('выход и истечение срока отзывают доступ', async () => {
    const first = await login();
    await auth.logout(first.token);
    expect(await auth.authenticate(first.token)).toBeNull();
    now = new Date(now.getTime() + 60_000);
    const second = await login();
    now = new Date(now.getTime() + 30 * 86400_000);
    expect(await auth.authenticate(second.token)).toBeNull();
  });
  it('не активирует код при ошибке SMS и не раскрывает ошибку провайдера', async () => {
    sender.send = async (phone, code) => {
      sent.push({ phone, code });
      throw new Error('provider secret');
    };
    await expect(request()).rejects.toMatchObject({ code: 'SMS_UNAVAILABLE' });
    const challenge = [...repo.challenges.values()][0];
    await expect(auth.verifyCode(challenge.id, sent[0].code)).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    await expect(request()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('отклоняет некорректный телефон и неизвестные коды/сессии', async () => {
    await expect(auth.requestCode('abc', '127.0.0.1')).rejects.toMatchObject({
      code: 'INVALID_PHONE',
    });
    await expect(auth.verifyCode('invalid', '123456')).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    expect(await auth.authenticate('invalid')).toBeNull();
  });
});
