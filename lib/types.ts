import { IncomingMessage, ServerResponse } from 'http';

export type VercelRequest = IncomingMessage & {
  body?: any;
  query?: any;
};

export type VercelResponse = ServerResponse & {
  status: (code: number) => VercelResponse;
  json: (body: any) => void;
};