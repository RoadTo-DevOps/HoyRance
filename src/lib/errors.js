export class AppError extends Error {
  constructor(status, message, code = 'APP_ERROR', details = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assertApp(condition, status, message, code = 'APP_ERROR', details = null) {
  if (!condition) {
    throw new AppError(status, message, code, details);
  }
}

export function toHttpError(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        ok: false,
        error: error.message,
        code: error.code,
        details: error.details
      }
    };
  }

  return {
    status: 500,
    body: {
      ok: false,
      error: 'Internal server error',
      code: 'INTERNAL_ERROR'
    }
  };
}
