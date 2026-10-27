export const MAIL_POLICY = Object.freeze({
  lifetimeMs: 5 * 60_000,
  retryMs: 60_000,
  cleanupMs: 60_000,
  // Pending reports are diagnostics, separate from live SMTP capacity.
  maxPendingReports: 2048,
  reportBatchSize: 32,
  maxMessages: 500,
  maxBytes: 10 * 1024 * 1024,
});
