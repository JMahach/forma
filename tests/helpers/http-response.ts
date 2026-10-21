import type { ServerResponse, OutgoingHttpHeaders } from 'node:http';

export interface CapturedResponse<Body> {
  status: number;
  headers: OutgoingHttpHeaders;
  body: Body;
  writeHead(status: number, headers: OutgoingHttpHeaders): void;
  end(body: Body): void;
}
// This HTTP test port captures only what a handler sends, without opening a socket.
export function captureResponse<Body = string>() {
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  } as CapturedResponse<Body>;
  return response as CapturedResponse<Body> & ServerResponse;
}
