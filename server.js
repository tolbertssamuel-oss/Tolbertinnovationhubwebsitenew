import express from 'express';
import cors from 'cors';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'data', 'db.json');

const PORT = Number(process.env.PORT || 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5500';
const SESSION_SECRET = process.env.SESSION_SECRET || 'replace-this-session-secret';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@tolbertinnovationhub.org').toLowerCase();
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '$2a$10$zJm7Qh2f1b1dQ7J2Y.xfQeXrFfQj2AztcdWxY2iQxuk3jD6nW1gMS';

const LOGIN_MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

const app = express();

app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === 'null' || origin === CLIENT_ORIGIN) return callback(null, true);
    return callback(new Error('CORS blocked'));
  },
  credentials: true
}));

app.use(express.json({ limit: '2mb' }));

app.use(session({
  name: 'tih.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: SESSION_TTL_MS
  }
}));

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeString(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

async function readDB() {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      students: Array.isArray(parsed.students) ? parsed.students : [],
      loginAttempts: parsed.loginAttempts && typeof parsed.loginAttempts === 'object'
        ? parsed.loginAttempts
        : { student: {}, admin: {} }
    };
  } catch {
    return { students: [], loginAttempts: { student: {}, admin: {} } };
  }
}

async function writeDB(data) {
  await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function getAttemptState(store, key) {
  const state = store[key] || { count: 0, lockUntil: 0 };
  return {
    count: Number(state.count) || 0,
    lockUntil: Number(state.lockUntil) || 0
  };
}

function isLocked(state) {
  return state.lockUntil > Date.now();
}

function remainingLockSeconds(state) {
  const ms = Math.max(0, state.lockUntil - Date.now());
  return Math.ceil(ms / 1000);
}

function registerFailedAttempt(store, key) {
  const current = getAttemptState(store, key);
  const nextCount = current.count + 1;
  const shouldLock = nextCount >= LOGIN_MAX_ATTEMPTS;
  store[key] = shouldLock
    ? { count: 0, lockUntil: Date.now() + LOCKOUT_WINDOW_MS }
    : { count: nextCount, lockUntil: 0 };
  return store[key];
}

function clearAttempt(store, key) {
  if (store[key]) delete store[key];
}

function toPublicStudent(student) {
  return {
    id: student.id,
    fullName: student.fullName,
    email: student.email,
    phone: student.phone,
    program: student.program,
    submissions: Array.isArray(student.submissions) ? student.submissions : [],
    createdAt: student.createdAt
  };
}

function requireStudent(req, res, next) {
  if (!req.session.studentId || !req.session.studentExpiresAt || Number(req.session.studentExpiresAt) <= Date.now()) {
    req.session.destroy(() => {});
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.adminEmail || !req.session.adminExpiresAt || Number(req.session.adminExpiresAt) <= Date.now()) {
    req.session.destroy(() => {});
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'tih-backend' });
});

app.post('/api/auth/register', async (req, res) => {
  const fullName = safeString(req.body.fullName, 120);
  const email = normalizeEmail(req.body.email);
  const phone = safeString(req.body.phone, 40);
  const program = safeString(req.body.program, 120);
  const password = String(req.body.password || '');

  if (!fullName || !validEmail(email) || !phone || !program || password.length < 8) {
    res.status(400).json({ error: 'Invalid registration data' });
    return;
  }

  const db = await readDB();
  const exists = db.students.some((student) => student.email === email);
  if (exists) {
    res.status(409).json({ error: 'Account already exists' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const student = {
    id: crypto.randomUUID(),
    fullName,
    email,
    phone,
    program,
    passwordHash,
    submissions: [],
    createdAt: new Date().toISOString()
  };

  db.students.push(student);
  await writeDB(db);

  req.session.studentId = student.id;
  req.session.studentExpiresAt = Date.now() + SESSION_TTL_MS;

  res.status(201).json({ student: toPublicStudent(student) });
});

app.post('/api/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  if (!validEmail(email) || !password) {
    res.status(400).json({ error: 'Invalid credentials' });
    return;
  }

  const db = await readDB();
  const attemptKey = `student:${email}`;
  const attemptState = getAttemptState(db.loginAttempts.student || {}, attemptKey);

  if (isLocked(attemptState)) {
    res.status(429).json({ error: `Too many attempts. Retry in ${remainingLockSeconds(attemptState)}s.` });
    return;
  }

  const student = db.students.find((entry) => entry.email === email);
  const isValid = student ? await bcrypt.compare(password, student.passwordHash) : false;

  if (!isValid) {
    const studentAttempts = db.loginAttempts.student || {};
    db.loginAttempts.student = studentAttempts;
    const state = registerFailedAttempt(studentAttempts, attemptKey);
    await writeDB(db);
    const lockMessage = state.lockUntil ? ` Too many attempts. Retry in ${remainingLockSeconds(state)}s.` : '';
    res.status(401).json({ error: `Invalid credentials.${lockMessage}` });
    return;
  }

  const studentAttempts = db.loginAttempts.student || {};
  db.loginAttempts.student = studentAttempts;
  clearAttempt(studentAttempts, attemptKey);
  await writeDB(db);

  req.session.studentId = student.id;
  req.session.studentExpiresAt = Date.now() + SESSION_TTL_MS;

  res.json({ student: toPublicStudent(student) });
});

app.get('/api/auth/session', async (req, res) => {
  if (!req.session.studentId || !req.session.studentExpiresAt || Number(req.session.studentExpiresAt) <= Date.now()) {
    req.session.destroy(() => {});
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const db = await readDB();
  const student = db.students.find((entry) => entry.id === req.session.studentId);
  if (!student) {
    req.session.destroy(() => {});
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  res.json({ student: toPublicStudent(student) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.post('/api/admin/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const attemptKey = `admin:${email || 'unknown'}`;

  const db = await readDB();
  const adminAttempts = db.loginAttempts.admin || {};
  db.loginAttempts.admin = adminAttempts;
  const attemptState = getAttemptState(adminAttempts, attemptKey);

  if (isLocked(attemptState)) {
    res.status(429).json({ error: `Too many attempts. Retry in ${remainingLockSeconds(attemptState)}s.` });
    return;
  }

  const emailValid = email === ADMIN_EMAIL;
  const passwordValid = emailValid ? await bcrypt.compare(password, ADMIN_PASSWORD_HASH) : false;

  if (!emailValid || !passwordValid) {
    const state = registerFailedAttempt(adminAttempts, attemptKey);
    await writeDB(db);
    const lockMessage = state.lockUntil ? ` Too many attempts. Retry in ${remainingLockSeconds(state)}s.` : '';
    res.status(401).json({ error: `Invalid admin credentials.${lockMessage}` });
    return;
  }

  clearAttempt(adminAttempts, attemptKey);
  await writeDB(db);

  req.session.adminEmail = ADMIN_EMAIL;
  req.session.adminName = 'TIH Admissions Admin';
  req.session.adminExpiresAt = Date.now() + ADMIN_SESSION_TTL_MS;

  res.json({ admin: { email: req.session.adminEmail, name: req.session.adminName } });
});

app.get('/api/admin/session', requireAdmin, (req, res) => {
  res.json({ admin: { email: req.session.adminEmail, name: req.session.adminName } });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.post('/api/student/submissions', requireStudent, async (req, res) => {
  const db = await readDB();
  const studentIndex = db.students.findIndex((student) => student.id === req.session.studentId);
  if (studentIndex < 0) {
    res.status(404).json({ error: 'Student not found' });
    return;
  }

  const applicationType = safeString(req.body.applicationType, 80);
  const targetProgram = safeString(req.body.targetProgram, 120);
  const summary = safeString(req.body.summary, 4000);
  const documents = Array.isArray(req.body.documents)
    ? req.body.documents.slice(0, 12).map((doc) => ({
      name: safeString(doc.name, 160),
      size: Number(doc.size) || 0,
      sizeLabel: safeString(doc.sizeLabel, 24),
      type: safeString(doc.type, 80)
    }))
    : [];

  if (!applicationType || !targetProgram || !summary || !documents.length) {
    res.status(400).json({ error: 'Invalid submission payload' });
    return;
  }

  const submission = {
    id: crypto.randomUUID(),
    applicationType,
    targetProgram,
    summary,
    documents,
    submittedAt: new Date().toISOString(),
    status: 'Submitted'
  };

  db.students[studentIndex].submissions = db.students[studentIndex].submissions || [];
  db.students[studentIndex].submissions.push(submission);
  await writeDB(db);

  res.status(201).json({ submission });
});

app.get('/api/student/submissions', requireStudent, async (req, res) => {
  const db = await readDB();
  const student = db.students.find((entry) => entry.id === req.session.studentId);
  if (!student) {
    res.status(404).json({ error: 'Student not found' });
    return;
  }

  res.json({ submissions: student.submissions || [] });
});

app.get('/api/admin/submissions', requireAdmin, async (req, res) => {
  const db = await readDB();
  const submissions = db.students.flatMap((student) =>
    (student.submissions || []).map((submission) => ({
      studentId: student.id,
      studentName: student.fullName,
      studentEmail: student.email,
      studentProgram: student.program,
      ...submission
    }))
  );

  res.json({
    totalStudents: db.students.length,
    totalSubmissions: submissions.length,
    issuedLetters: submissions.filter((submission) => submission.admissionLetter).length,
    submissions
  });
});

app.patch('/api/admin/submissions/:studentId/:submissionId/status', requireAdmin, async (req, res) => {
  const studentId = safeString(req.params.studentId, 80);
  const submissionId = safeString(req.params.submissionId, 80);
  const status = safeString(req.body.status, 60);
  if (!studentId || !submissionId || !status) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const db = await readDB();
  const studentIndex = db.students.findIndex((student) => student.id === studentId);
  if (studentIndex < 0) {
    res.status(404).json({ error: 'Student not found' });
    return;
  }

  const submissions = db.students[studentIndex].submissions || [];
  const submissionIndex = submissions.findIndex((submission) => submission.id === submissionId);
  if (submissionIndex < 0) {
    res.status(404).json({ error: 'Submission not found' });
    return;
  }

  submissions[submissionIndex].status = status;
  await writeDB(db);

  res.json({ submission: submissions[submissionIndex] });
});

app.post('/api/admin/submissions/:studentId/:submissionId/letter', requireAdmin, async (req, res) => {
  const studentId = safeString(req.params.studentId, 80);
  const submissionId = safeString(req.params.submissionId, 80);
  const message = safeString(req.body.message, 4000);

  if (!studentId || !submissionId || !message) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const db = await readDB();
  const studentIndex = db.students.findIndex((student) => student.id === studentId);
  if (studentIndex < 0) {
    res.status(404).json({ error: 'Student not found' });
    return;
  }

  const submissions = db.students[studentIndex].submissions || [];
  const submissionIndex = submissions.findIndex((submission) => submission.id === submissionId);
  if (submissionIndex < 0) {
    res.status(404).json({ error: 'Submission not found' });
    return;
  }

  const letterId = `TIH-ADMIT-${new Date().getFullYear()}-${Math.floor(Math.random() * 9000 + 1000)}`;
  submissions[submissionIndex].status = 'Admission Letter Issued';
  submissions[submissionIndex].admissionLetter = {
    letterId,
    message,
    issuedAt: new Date().toISOString(),
    issuedBy: req.session.adminName || 'Admin'
  };

  await writeDB(db);
  res.json({ submission: submissions[submissionIndex] });
});

app.use((err, req, res, next) => {
  if (err?.message === 'CORS blocked') {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }
  next(err);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`TIH backend running at http://localhost:${PORT}`);
});
