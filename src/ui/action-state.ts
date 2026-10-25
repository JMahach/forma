import type { ConnectionMode } from '../data/http-transport.ts';
import { UI_MESSAGES } from './messages.ts';
interface ActionContext {
  connection: ConnectionMode; requiresConnection: boolean;
  hasReadyData?: boolean; pending?: boolean; available?: boolean;
}
/** The action owner supplies permissions, data readiness and operation state. */
export function actionAvailability({ connection, requiresConnection, hasReadyData = false, pending = false, available = true }: ActionContext) {
  const offline = requiresConnection && !hasReadyData && connection === 'offline';
  return { disabled: !available || pending || offline, busy: pending,
    reason: available && !pending && offline ? UI_MESSAGES.offline : '' };
}
