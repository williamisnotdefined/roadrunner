const defaultMaxCapturedOutputBytes = 1_000_000;

export interface CapturedOutputBuffer {
  append(text: string): void;
  value(): string;
}

export function createCapturedOutputBuffer(value: string | undefined = process.env.ROADRUNNER_MAX_CAPTURED_OUTPUT_BYTES): CapturedOutputBuffer {
  return new CappedOutputBuffer(maxCapturedOutputBytes(value));
}

function maxCapturedOutputBytes(value: string | undefined): number {
  if (value === undefined) return defaultMaxCapturedOutputBytes;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`ROADRUNNER_MAX_CAPTURED_OUTPUT_BYTES must be a positive integer, got ${value}.`);
  return bytes;
}

class CappedOutputBuffer implements CapturedOutputBuffer {
  private byteLength = 0;
  private readonly chunks: string[] = [];
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(text: string): void {
    this.chunks.push(text);
    this.byteLength += Buffer.byteLength(text);
    this.truncateIfNeeded();
  }

  value(): string {
    const output = this.chunks.join("");
    return this.truncated ? `[Output truncated to last ${this.maxBytes} bytes]\n${output}` : output;
  }

  private truncateIfNeeded(): void {
    if (this.byteLength <= this.maxBytes) return;

    const buffer = Buffer.from(this.chunks.join(""));
    const next = trimLeadingUtf8ContinuationBytes(buffer.subarray(Math.max(0, buffer.length - this.maxBytes))).toString("utf8");
    this.chunks.length = 0;
    this.chunks.push(next);
    this.byteLength = Buffer.byteLength(next);
    this.truncated = true;
  }
}

function trimLeadingUtf8ContinuationBytes(buffer: Buffer): Buffer {
  let start = 0;
  while (start < buffer.length && (buffer[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  return start === 0 ? buffer : buffer.subarray(start);
}
