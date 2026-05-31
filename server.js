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
const multer = require('multer');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const PassThrough = require('stream');
const axios = require('axios');

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

// File upload middleware
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });

// WhatsApp session management
app.post('/api/whatsapp/session/create', async (req, res) => {
  try {
    const { name, type } = req.body;
    const sessionId = await whatsappService.createSession(name, type);
    res.json({ success: true, sessionId });
  } catch (error) {
    logger.error('Error creating WhatsApp session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/whatsapp/session/:sessionId/connect', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const qrCode = await whatsappService.connectSession(sessionId);
    res.json({ success: true, qrCode });
  } catch (error) {
    logger.error('Error connecting WhatsApp session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/whatsapp/session/:sessionId/pair', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { phoneNumber } = req.body;
    const pairingCode = await whatsappService.pairSession(sessionId, phoneNumber);
    res.json({ success: true, pairingCode });
  } catch (error) {
    logger.error('Error pairing WhatsApp session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/whatsapp/session/:sessionId/status', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const status = await whatsappService.getSessionStatus(sessionId);
    res.json({ success: true, status });
  } catch (error) {
    logger.error('Error getting WhatsApp session status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/whatsapp/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    await whatsappService.deleteSession(sessionId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting WhatsApp session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Check functionality
app.post('/api/check/bio', upload.single('file'), async (req, res) => {
  try {
    const { numbers, delay } = req.body;
    const results = await checkService.checkBio(numbers, delay, io);
    res.json({ success: true, results });
  } catch (error) {
    logger.error('Error checking bio:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/check/registered', upload.single('file'), async (req, res) => {
  try {
    const { numbers, delay } = req.body;
    const results = await checkService.checkRegistered(numbers, delay, io);
    res.json({ success: true, results });
  } catch (error) {
    logger.error('Error checking registered numbers:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/check/range', async (req, res) => {
  try {
    const { prefix, start, end, delay } = req.body;
    const results = await checkService.checkRange(prefix, start, end, delay, io);
    res.json({ success: true, results });
  } catch (error) {
    logger.error('Error checking range:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/check/repe', upload.single('file'), async (req, res) => {
  try {
    const { numbers, delay } = req.body;
    const results = await checkService.checkRepe(numbers, delay, io);
    res.json({ success: true, results });
  } catch (error) {
    logger.error('Error checking repe:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Email functionality
app.post('/api/email/send', async (req, res) => {
  try {
    const { to, subject, body, template } = req.body;
    await emailService.sendEmail(to, subject, body, template);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error sending email:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export functionality
app.get('/api/export/users', async (req, res) => {
  try {
    const format = req.query.format || 'json';
    const data = await User.find({});
    const filename = `users_${Date.now()}.${format}`;
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.csv(data, true);
    } else if (format === 'xlsx') {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(data);
      XLSX.utils.book_append_sheet(wb, ws, 'Users');
      XLSX.writeFile(wb, filename);
      res.download(filename);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.json(data);
    }
  } catch (error) {
    logger.error('Error exporting users:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/export/sessions', async (req, res) => {
  try {
    const format = req.query.format || 'json';
    const data = await Session.find({});
    const filename = `sessions_${Date.now()}.${format}`;
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.csv(data, true);
    } else if (format === 'xlsx') {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(data);
      XLSX.utils.book_append_sheet(wb, ws, 'Sessions');
      XLSX.writeFile(wb, filename);
      res.download(filename);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.json(data);
    }
  } catch (error) {
    logger.error('Error exporting sessions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// System settings
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await Setting.find({});
    res.json({ success: true, settings });
  } catch (error) {
    logger.error('Error getting settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    const setting = await Setting.findOneAndUpdate({ key }, { value }, { upsert: true });
    res.json({ success: true, setting });
  } catch (error) {
    logger.error('Error updating setting:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Dashboard statistics
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const stats = {
      totalUsers: await User.countDocuments(),
      activeSessions: await Session.countDocuments({ status: 'active' }),
      totalChecks: await History.countDocuments(),
      systemStatus: await Setting.findOne({ key: 'system_status' }).value || 'active'
    };
    res.json({ success: true, stats });
  } catch (error) {
    logger.error('Error getting dashboard stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Real-time monitoring
app.get('/api/monitor/sessions', async (req, res) => {
  try {
    const sessions = await Session.find({});
    res.json({ success: true, sessions });
  } catch (error) {
    logger.error('Error getting session monitoring data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/monitor/activity', async (req, res) => {
  try {
    const activity = await History.find({})
      .sort({ timestamp: -1 })
      .limit(50)
      .populate('user', 'username');
    res.json({ success: true, activity });
  } catch (error) {
    logger.error('Error getting activity monitoring data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
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
  
  // Initialize services
  whatsappService.initialize(io);
  emailService.initialize();
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