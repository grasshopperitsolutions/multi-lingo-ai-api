export function successResponse(res: any, data: any, status = 200) {
  return res.status(status).json({
    success: true,
    data
  });
}

/**
 * `extra` adds machine-readable fields next to the message — e.g. the daily
 * limit's `code: 'DAILY_LIMIT'`, which lets the frontend tell its own quota
 * apart from a provider's rate limit (both are 429) and show its own copy.
 */
export function errorResponse(res: any, message: string, status = 400, extra: Record<string, unknown> = {}) {
  return res.status(status).json({
    success: false,
    error: message,
    ...extra
  });
}