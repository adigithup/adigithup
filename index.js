const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('rate-limiter-flexible');
const path = require('path');
const { createLogger, format, transports } = require('winston');

// Import routes
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const whatsappRoutes = require('./routes/whatsapp');
const checkRoutes = require('./routes/check');
const adminRoutes = require('./routes/admin');
const exportRoutes = require('./routes/export');

// Import middleware
const { isAuthenticated, isAdmin } = require('./middleware/auth');

// Import models
const User = require('./models/User');
const Session = require('./models/Session');
const History = require('./models/History');
const Setting = require('./models/Setting');

// Import services
const whatsappService = require('./services/whatsapp');
const checkService = require('./services/check');
const emailService = require('./services/email');
const backupService = require('./services/backup');

// Configuration
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Logger setup
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'logs/error.log', level: 'error' }),
    new transports.File({ filename: 'logs/combined.log' }),
    new transports.Console()
  ]
});

// Rate limiting
const limiter = rateLimit.createRateLimiter({
  keyGenerator: (req) => req.ip,
  points: 100,
  duration: 60,
  blockDuration: 60,
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
app.use(limiter);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp_dashboard',
    ttl: 24 * 60 * 60 // 1 day
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  }
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp_dashboard', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => logger.info('MongoDB connected successfully'))
.catch(err => logger.error('MongoDB connection error:', err));

// Socket.IO connection
io.on('connection', (socket) => {
  logger.info(`User connected: ${socket.id}`);
  
  // Join dashboard room for real-time updates
  socket.on('join-dashboard', (userId) => {
    socket.join(`dashboard-${userId}`);
  });
  
  // WhatsApp session events
  socket.on('whatsapp-event', (data) => {
    io.emit('whatsapp-update', data);
  });
  
  socket.on('disconnect', () => {
    logger.info(`User disconnected: ${socket.id}`);
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/check', checkRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/export', exportRoutes);

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  
  // Initialize WhatsApp service
  whatsappService.initialize(io);
  
  // Initialize email service
  emailService.initialize();
  
  // Schedule backups
  backupService.scheduleBackups();
  
  // Initialize default settings
  Setting.findOneAndUpdate(
    { key: 'system_status' },
    { value: 'active' },
    { upsert: true }
  ).then(() => {
    logger.info('System status initialized');
  }).catch(err => {
    logger.error('Error initializing system status:', err);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT. Graceful shutdown...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM. Graceful shutdown...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});