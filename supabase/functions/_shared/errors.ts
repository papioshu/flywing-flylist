// An error that maps directly to an HTTP response: { error: { code, message, ...extra } }.
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}
