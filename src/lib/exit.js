/** Exit codes are part of the public contract — CI pipelines branch on them. */
export const EXIT = {
  OK: 0,
  FAILED: 1,
  AUTH: 2,
  BALANCE: 3,
  NETWORK: 4,
  USAGE: 5,
  DEGRADED: 6,
};

export function fail(message, exitCode = EXIT.FAILED) {
  const err = new Error(message);
  err.__handled = true;
  err.exitCode = exitCode;
  return err;
}

export function exitCodeForError(err) {
  if (err?.status === 401 || err?.status === 403) return EXIT.AUTH;
  if (err?.status === 402) return EXIT.BALANCE;
  if (
    err?.code === 'ETIMEDOUT' ||
    err?.code === 'ENETWORK' ||
    err?.code === 'EPROXYIGNORED' ||
    err?.cause?.code === 'ENOTFOUND' ||
    err?.cause?.code === 'ECONNREFUSED'
  )
    return EXIT.NETWORK;
  return EXIT.FAILED;
}
