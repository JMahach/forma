/** A live delivery command; its body belongs only to the mail queue. */
export interface CodeMail {
  id: string;
  contextId: string;
  email: string;
  code: string;
  createdAt: number;
  discardAt: number;
}
export interface CodeMailQueue {
  /** Recheck validity before every delivery attempt and after restart. */
  enqueue(value: CodeMail): Promise<void>;
  cancel(id: string): Promise<void>;
}
