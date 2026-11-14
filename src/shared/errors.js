// Usamos el mismo formato de error en la carga, las consultas y los servicios
export class AppError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function errorResult(error) {
  let code = 'ERROR';

  if (error.code === 11000) {
    code = 'DUPLICADO';
  } else if (typeof error.code === 'string') {
    code = error.code;
  }

  return {
    ok: false,
    error: {
      code,
      message: error.message,
      details: error.details ?? {},
    },
  };
}
