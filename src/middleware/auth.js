function basicAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).json({ error: 'Authentication required' });
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const [username, password] = decoded.split(':');

  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).json({ error: 'Invalid credentials' });
}

module.exports = basicAuth;
