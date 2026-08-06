/**
 * Minimal fake VercelRequest/VercelResponse pair for driving handlers
 * directly in unit tests, without spinning up an HTTP server.
 */

export interface MockReqOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  query?: Record<string, any>;
  rawBody?: string;
}

export function createMockReqRes(opts: MockReqOptions = {}) {
  const req: any = {
    method: opts.method ?? 'GET',
    headers: opts.headers ?? {},
    body: opts.body,
    query: opts.query ?? {},
  };
  if (opts.rawBody !== undefined) {
    req.__rawBody = opts.rawBody;
  }

  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    setHeader(key: string, value: string) {
      res.headers[key.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
    writeHead(code: number) {
      res.statusCode = code;
      return { end() {} };
    },
    end() {},
    req,
  };

  return { req, res };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
