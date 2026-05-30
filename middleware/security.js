// Owns: Helmet CSP, CORS policy, rate limiters.
// Does NOT own: authentication, route handling, database access.

const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// All domains that serve this app
const ALLOWED_ORIGINS = [
  'https://focusledger.polsia.app',
  'https://focusledger.net',
  'https://www.focusledger.net'
];
if (process.env.ALLOWED_ORIGIN && !ALLOWED_ORIGINS.includes(process.env.ALLOWED_ORIGIN)) {
  ALLOWED_ORIGINS.push(process.env.ALLOWED_ORIGIN);
}

const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://cdn.plaid.com",
        "https://cdn.jsdelivr.net",
        "https://js.stripe.com",
        "https://checkout.stripe.com",
        "https://polsia.com",
        "https://*.polsia.com",
        "https://accounts.google.com"
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://cdn.jsdelivr.net",
        "https://api.fontshare.com"
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com",
        "https://cdn.jsdelivr.net",
        "https://cdn.fontshare.com"
      ],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: [
        "'self'",
        "https://cdn.plaid.com",
        "https://production.plaid.com",
        "https://sandbox.plaid.com",
        "https://development.plaid.com",
        "https://api.plaid.com",
        "https://js.stripe.com",
        "https://checkout.stripe.com",
        "https://accounts.google.com",
        "https://oauth2.googleapis.com",
        "https://gmail.googleapis.com",
        "https://graph.microsoft.com",
        "https://login.microsoftonline.com",
        "https://api.login.yahoo.com",
        "https://api.open-meteo.com",
        "https://geocoding-api.open-meteo.com",
        "https://ipapi.co",
        "https://gnews.io",
        "https://api.gnews.io"
      ],
      frameSrc: ["https://cdn.plaid.com", "https://accounts.google.com"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: []
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permittedCrossDomainPolicies: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginResourcePolicy: { policy: 'same-origin' }
});

const corsMiddleware = cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    if (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
});

const permissionsPolicyMiddleware = (req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(self), geolocation=(self), payment=(), usb=(), fullscreen=(self)'
  );
  next();
};

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please wait 15 minutes and try again.' }
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many signup attempts. Please wait an hour and try again.' }
});

// Rule 16: Rate limit password reset endpoints (forgot-password + reset-password)
// Separate from loginLimiter so brute-forcing reset tokens doesn't burn login attempts.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many password reset attempts. Please wait 15 minutes and try again.' }
});

module.exports = {
  helmetMiddleware,
  corsMiddleware,
  permissionsPolicyMiddleware,
  globalLimiter,
  loginLimiter,
  signupLimiter,
  passwordResetLimiter
};
