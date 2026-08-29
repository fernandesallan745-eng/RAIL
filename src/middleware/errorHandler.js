export const notFoundHandler = (req, res, next) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `Endpoint ${req.method} ${req.originalUrl} does not exist on this server.`,
    statusCode: 404,
  });
};

export const errorHandler = (err, req, res, next) => {
  const statusCode = err.status || err.statusCode || 500;
  const message = err.message || 'An unexpected error occurred while communicating with RailRadar.';

  console.error(`\x1b[31m[API Error ${statusCode}]\x1b[0m ${req.method} ${req.originalUrl}:`, err.message);

  res.status(statusCode).json({
    success: false,
    error: err.name || 'API_ERROR',
    message,
    statusCode,
    details: err.data || null,
    timestamp: new Date().toISOString(),
  });
};
