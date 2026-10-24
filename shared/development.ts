// Only the two explicitly assigned development stands expose rehearsal tools.
export function isDevelopmentPort(port: string) {
  return port === '3636' || port === '36';
}
