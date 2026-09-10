// Safe terminal stream writer that treats broken pipes as closed output.

type OutputStream = {
  write: (text: string) => unknown;
};

/** Hooks for safe stream writes. */
export type SafeStreamWriterOptions = {
  beforeWrite?: () => void;
  onBrokenPipe?: (err: NodeJS.ErrnoException, stream: OutputStream) => void;
};

/** Writer facade that tracks closed/broken-pipe state. */
export type SafeStreamWriter = {
  write: (stream: OutputStream, text: string) => boolean;
  writeLine: (stream: OutputStream, text: string) => boolean;
  handleError: (error: unknown, stream: OutputStream) => boolean;
  reset: () => void;
  isClosed: () => boolean;
};

/** Detect broken pipe style stream errors. */
function isBrokenPipeError(err: unknown): err is NodeJS.ErrnoException {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EPIPE" || code === "EIO";
}

/** Create a stream writer that stops writing after EPIPE/EIO. */
export function createSafeStreamWriter(options: SafeStreamWriterOptions = {}): SafeStreamWriter {
  let closed = false;

  const handleError = (err: unknown, stream: OutputStream): boolean => {
    if (!isBrokenPipeError(err)) {
      throw err;
    }
    if (!closed) {
      closed = true;
      options.onBrokenPipe?.(err, stream);
    }
    return false;
  };

  const write = (stream: OutputStream, text: string): boolean => {
    if (closed) {
      return false;
    }
    try {
      options.beforeWrite?.();
    } catch (err) {
      return handleError(err, process.stderr);
    }
    try {
      stream.write(text);
      return !closed;
    } catch (err) {
      return handleError(err, stream);
    }
  };

  const writeLine = (stream: OutputStream, text: string): boolean => write(stream, `${text}\n`);

  return {
    write,
    writeLine,
    handleError,
    reset: () => {
      closed = false;
    },
    isClosed: () => closed,
  };
}
