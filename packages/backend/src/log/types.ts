export interface ExchangeLogEntry {
  at: Date;
  type: string;
  mode: string;
  filename: string | null;
  bodyBytes: number;
  result: string;
  detail: string | null;
}

export interface ExchangeLogSink {
  write(entry: ExchangeLogEntry): Promise<void>;
  close(): Promise<void>;
}
