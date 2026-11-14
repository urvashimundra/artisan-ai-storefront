/** Raised when an outbound call exceeds its time budget. */
export class TimeoutError extends Error {
  /** @param {string} label What timed out (no secrets). @param {number} ms Budget in milliseconds. */
  constructor(label, ms) {
    super(`${label} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Rejects with TimeoutError if `operation` does not settle within `ms`.
 * @template T
 * @param {() => Promise<T>} operation Starts the work.
 * @param {number} ms Time budget in milliseconds.
 * @param {string} label Name used in the error message.
 * @returns {Promise<T>}
 */
export async function withTimeout(operation, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
