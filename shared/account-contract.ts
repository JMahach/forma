export interface AccountProfile { id: string; email: string; telegramHandle: string | null; telegramLinked: boolean }
/** Diagnostic origin only: never a login secret or permission to read an account. */
export const DIAGNOSTIC_PROOF_HEADER = 'X-Forma-Diagnostic-Proof';
export function parseDiagnosticProof(value: unknown): {accountId: string; sessionId: string; signature: string} | null {
  if (typeof value !== 'string' || value.length > 128) return null;
  const parts = /^v1\.([1-9][0-9]{0,19})\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(value);
  return parts ? {accountId: parts[1]!, sessionId: parts[2]!, signature: parts[3]!} : null;
}
export interface AccountSession { id: string; expiresAt: number; diagnosticProof?: string }
export interface ConfirmedAccount { account: AccountProfile; session: AccountSession }
export interface EmailAttempt { id: string; expiresAt: number; codeExpiresAt: number; resendAt: number }
export interface EmailAttemptProgress extends EmailAttempt { stage: 'code' | 'verified'; canConfirm: boolean }

/** Before an email code exists its two timestamps are zero. */
export interface AuthAttemptProgress extends Omit<EmailAttemptProgress, 'stage'> {
  stage: 'telegram' | 'email' | 'code' | 'verified';
}
export interface TelegramStart {
  attempt: Pick<EmailAttempt, 'id' | 'expiresAt'>;
  telegram: {clientId: string; nonce: string; scope: ['profile']};
}
export type TelegramVerificationResult = {attemptId: string} & (
  {needsEmail: true; needsConfirmation: false} | {needsEmail: false; needsConfirmation: true}
);
