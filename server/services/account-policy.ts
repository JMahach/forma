const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Approved product limits. Transport and presentation do not redefine them. */
export const ACCOUNT_POLICY = Object.freeze({
  attemptMs: 30 * MINUTE,
  codeMs: 10 * MINUTE,
  sessionMs: 90 * 24 * HOUR,
  cleanupMs: 5 * MINUTE,
  resendMs: MINUTE,
  sendWindowMs: HOUR,
  sendsPerIp: 100,
  wrongCodeWindowMs: 15 * MINUTE,
  wrongCodes: 5,
  verificationPauseMs: 15 * MINUTE,
});
