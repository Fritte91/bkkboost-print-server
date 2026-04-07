export function authMiddleware(config) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || header !== `Bearer ${config.auth_token}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}
