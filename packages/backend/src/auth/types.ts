export interface Account {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  createdAt: string;
}

export interface SmsSender {
  kind: 'test' | 'provider';
  send(phone: string, code: string): Promise<void>;
}

export interface Challenge {
  id: string;
  phone: string;
  digest: string;
  expiresAt: Date;
  attempts: number;
  state: 'pending' | 'active' | 'used';
}

export interface IssueChallenge {
  challenge: Challenge;
  phoneKey: string;
  ipKey: string;
  now: Date;
}

export interface VerifyChallenge {
  id: string;
  digest: string;
  sessionHash: string;
  now: Date;
  sessionExpiresAt: Date;
}

export interface AuthRepository {
  ready(): Promise<void>;
  issue(input: IssueChallenge): Promise<boolean>;
  activate(id: string): Promise<void>;
  discard(id: string): Promise<void>;
  verify(input: VerifyChallenge): Promise<Account | null>;
  session(hash: string, now: Date): Promise<Account | null>;
  revoke(hash: string): Promise<void>;
  updateProfile(
    id: string,
    patch: { name?: string | null; email?: string | null },
  ): Promise<Account>;
  close(): Promise<void>;
}

export class AccountError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'AccountError';
  }
}

export interface AccountConfig {
  enabled: boolean;
  origins: string[];
  codeSecret: string;
}
