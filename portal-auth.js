const STORAGE_KEY = 'tih_students_v1';
const SESSION_KEY = 'tih_student_session_v1';
const ADMIN_SESSION_KEY = 'tih_admin_session_v1';
const STUDENT_ATTEMPTS_KEY = 'tih_student_login_attempts_v1';
const ADMIN_ATTEMPTS_KEY = 'tih_admin_login_attempts_v1';
const ADMIN_PASSWORD_HASH = 'b9ce8936c5737662cfb81de1784a976f870df9b7e2c262a009bc259b04835b50';
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const STUDENT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_TOTAL_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_SINGLE_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const ADMIN_USER = {
  email: 'admin@tolbertinnovationhub.org',
  name: 'TIH Admissions Admin'
};
const API_BASE = window.TIH_API_BASE || 'http://localhost:4000/api';

async function apiRequest(path, options = {}) {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });

    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
      reachable: true,
      error: data?.error || (response.ok ? '' : 'Request failed')
    };
  } catch {
    return { ok: false, status: 0, data: null, reachable: false, error: 'Backend unavailable' };
  }
}

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getStudents() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveStudents(students) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(students));
}

function upsertStudent(student) {
  if (!student?.id) return;
  const students = getStudents();
  const index = students.findIndex((entry) => entry.id === student.id || entry.email === student.email);
  const merged = {
    submissions: [],
    ...students[index],
    ...student,
    submissions: student.submissions || students[index]?.submissions || []
  };

  if (index >= 0) students[index] = merged;
  else students.push(merged);

  saveStudents(students);
}

function readStorageJSON(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStorageJSON(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function secureCompare(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getAttemptStore(storageKey) {
  const store = readStorageJSON(localStorage, storageKey, {});
  return store && typeof store === 'object' ? store : {};
}

function getAttemptState(storageKey, id) {
  const store = getAttemptStore(storageKey);
  const state = store[id] || { count: 0, lockUntil: 0 };
  return { count: Number(state.count) || 0, lockUntil: Number(state.lockUntil) || 0 };
}

function clearAttemptState(storageKey, id) {
  const store = getAttemptStore(storageKey);
  if (!store[id]) return;
  delete store[id];
  writeStorageJSON(localStorage, storageKey, store);
}

function registerFailedAttempt(storageKey, id) {
  const now = Date.now();
  const store = getAttemptStore(storageKey);
  const current = getAttemptState(storageKey, id);
  const nextCount = current.lockUntil > now ? current.count + 1 : current.count + 1;
  const lockUntil = nextCount >= MAX_LOGIN_ATTEMPTS ? now + LOCKOUT_WINDOW_MS : 0;
  store[id] = {
    count: lockUntil ? 0 : nextCount,
    lockUntil
  };
  writeStorageJSON(localStorage, storageKey, store);
  return store[id];
}

function getLockoutSeconds(state) {
  const remaining = Math.max(0, Number(state.lockUntil || 0) - Date.now());
  return Math.ceil(remaining / 1000);
}

function createSessionPayload(id, ttlMs) {
  const now = Date.now();
  return {
    id,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString()
  };
}

function setStudentSession(studentId) {
  writeStorageJSON(sessionStorage, SESSION_KEY, createSessionPayload(studentId, STUDENT_SESSION_TTL_MS));
}

function setAdminSession(email, name) {
  const payload = createSessionPayload(email, ADMIN_SESSION_TTL_MS);
  payload.email = email;
  payload.name = name;
  payload.loggedInAt = payload.issuedAt;
  writeStorageJSON(sessionStorage, ADMIN_SESSION_KEY, payload);
}

function isSessionExpired(expiresAt) {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  return Number.isFinite(ts) ? ts <= Date.now() : false;
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function setFeedback(form, message, isError = false) {
  const feedback = form.querySelector('.form-feedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.style.color = isError ? '#b42318' : '#0b5a32';
}

function getSessionStudent() {
  const sessionValue = sessionStorage.getItem(SESSION_KEY);
  let sessionId = sessionValue;

  if (sessionValue && sessionValue.startsWith('{')) {
    const parsed = readStorageJSON(sessionStorage, SESSION_KEY, null);
    if (!parsed?.id || isSessionExpired(parsed.expiresAt)) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    sessionId = parsed.id;
  }

  const students = getStudents();
  return students.find((s) => s.id === sessionId) || null;
}

function getAdminSession() {
  const session = readStorageJSON(sessionStorage, ADMIN_SESSION_KEY, null);
  if (!session?.email) return null;
  if (isSessionExpired(session.expiresAt)) {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    return null;
  }
  return session;
}

function normalizeLegacyStudentSession() {
  const session = sessionStorage.getItem(SESSION_KEY);
  if (!session || session.startsWith('{')) return;
  setStudentSession(session);
}

function normalizeLegacyAdminSession() {
  const raw = readStorageJSON(sessionStorage, ADMIN_SESSION_KEY, null);
  if (!raw || typeof raw !== 'object' || !raw.email || !raw.name) return;
  if (raw.expiresAt) return;
  setAdminSession(raw.email, raw.name);
}

async function handleRegister(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) {
    form.reportValidity();
    setFeedback(form, 'Please complete all required fields.', true);
    return;
  }

  const data = new FormData(form);
  const email = normalizeEmail(data.get('email'));
  const password = String(data.get('password'));
  const fullName = String(data.get('fullName') || '').trim();
  const phone = String(data.get('phone') || '').trim();
  const program = String(data.get('program') || '').trim();

  if (!isValidEmail(email)) {
    setFeedback(form, 'Please enter a valid email address.', true);
    return;
  }

  if (password.length < 8) {
    setFeedback(form, 'Password must be at least 8 characters.', true);
    return;
  }

  if (!fullName || !phone || !program) {
    setFeedback(form, 'Please complete all required fields.', true);
    return;
  }

  const registerResponse = await apiRequest('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ fullName, email, phone, program, password })
  });

  if (registerResponse.reachable) {
    if (!registerResponse.ok) {
      setFeedback(form, registerResponse.error || 'Unable to register account.', true);
      return;
    }

    const backendStudent = registerResponse.data?.student;
    if (backendStudent?.id) {
      upsertStudent(backendStudent);
      setStudentSession(backendStudent.id);
      window.location.href = 'portal-dashboard.html';
      return;
    }
  }

  const students = getStudents();

  if (students.some((s) => s.email === email)) {
    setFeedback(form, 'An account with this email already exists. Please log in.', true);
    return;
  }

  const passwordHash = await hashPassword(password);
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

  students.push(student);
  saveStudents(students);
  setStudentSession(student.id);
  window.location.href = 'portal-dashboard.html';
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) {
    form.reportValidity();
    setFeedback(form, 'Please enter your email and password.', true);
    return;
  }

  const data = new FormData(form);
  const email = normalizeEmail(data.get('email'));
  const password = String(data.get('password') || '');

  if (!isValidEmail(email)) {
    setFeedback(form, 'Please enter a valid email address.', true);
    return;
  }

  const attemptKey = `student:${email}`;
  const attemptState = getAttemptState(STUDENT_ATTEMPTS_KEY, attemptKey);
  if (attemptState.lockUntil > Date.now()) {
    const waitSeconds = getLockoutSeconds(attemptState);
    setFeedback(form, `Too many failed attempts. Please try again in ${waitSeconds} seconds.`, true);
    return;
  }

  const loginResponse = await apiRequest('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });

  if (loginResponse.reachable) {
    if (!loginResponse.ok) {
      setFeedback(form, loginResponse.error || 'Invalid credentials. Please try again.', true);
      return;
    }

    const backendStudent = loginResponse.data?.student;
    if (backendStudent?.id) {
      clearAttemptState(STUDENT_ATTEMPTS_KEY, attemptKey);
      upsertStudent(backendStudent);
      setStudentSession(backendStudent.id);
      window.location.href = 'portal-dashboard.html';
      return;
    }
  }

  const passwordHash = await hashPassword(password);
  const students = getStudents();
  const student = students.find((s) => s.email === email && secureCompare(s.passwordHash, passwordHash));

  if (!student) {
    const updatedState = registerFailedAttempt(STUDENT_ATTEMPTS_KEY, attemptKey);
    const waitSeconds = updatedState.lockUntil ? getLockoutSeconds(updatedState) : 0;
    const lockoutMsg = waitSeconds > 0 ? ` Account temporarily locked for ${waitSeconds} seconds.` : '';
    setFeedback(form, `Invalid credentials. Please try again.${lockoutMsg}`, true);
    return;
  }

  clearAttemptState(STUDENT_ATTEMPTS_KEY, attemptKey);
  setStudentSession(student.id);
  window.location.href = 'portal-dashboard.html';
}

function renderSubmissionHistory(student) {
  const host = document.getElementById('submission-history');
  if (!host) return;

  const submissions = student.submissions || [];
  if (!submissions.length) {
    host.innerHTML = '<p class="section-intro">No application submitted yet.</p>';
    return;
  }

  host.innerHTML = submissions
    .slice()
    .reverse()
    .map((submission) => {
      const documents = (submission.documents || [])
        .map((doc) => `<li>${escapeHTML(doc.name)} <small>(${escapeHTML(doc.type || 'unknown')}, ${escapeHTML(doc.sizeLabel)})</small></li>`)
        .join('');

      return `
        <article class="submission-item">
          <h4>${escapeHTML(submission.applicationType)}</h4>
          <p><strong>Status:</strong> <span class="badge">${escapeHTML(submission.status || 'Submitted')}</span></p>
          <p><strong>Target:</strong> ${escapeHTML(submission.targetProgram)}</p>
          <p><strong>Submitted:</strong> ${new Date(submission.submittedAt).toLocaleString()}</p>
          <p><strong>Summary:</strong> ${escapeHTML(submission.summary)}</p>
          <ul class="list-tight">${documents}</ul>
        </article>
      `;
    })
    .join('');
}

function renderStudentStatus(student) {
  const host = document.getElementById('application-status-list');
  if (!host) return;

  const submissions = student.submissions || [];
  if (!submissions.length) {
    host.innerHTML = [
      '<li>✅ Account created successfully</li>',
      '<li>📝 Start by submitting your first application below.</li>',
      '<li>📨 Admission letter updates will appear once approved.</li>'
    ].join('');
    return;
  }

  const latest = submissions[submissions.length - 1];
  host.innerHTML = [
    '<li>✅ Account created successfully</li>',
    `<li>📄 Latest application: ${escapeHTML(latest.applicationType)}</li>`,
    `<li>🕒 Review status: ${escapeHTML(latest.status || 'Submitted')}</li>`
  ].join('');
}

function renderAdmissionLetters(student) {
  const host = document.getElementById('admission-letter-history');
  if (!host) return;

  const letters = (student.submissions || [])
    .filter((submission) => submission.admissionLetter)
    .map((submission) => ({ ...submission.admissionLetter, applicationType: submission.applicationType, targetProgram: submission.targetProgram }))
    .reverse();

  if (!letters.length) {
    host.innerHTML = '<p class="section-intro">No admission letter has been issued yet.</p>';
    return;
  }

  host.innerHTML = letters
    .map(
      (letter) => `
      <article class="submission-item letter-item">
        <h4>Letter ID: ${escapeHTML(letter.letterId)}</h4>
        <p><strong>Program:</strong> ${escapeHTML(letter.applicationType)} – ${escapeHTML(letter.targetProgram)}</p>
        <p><strong>Issued On:</strong> ${new Date(letter.issuedAt).toLocaleString()}</p>
        <p><strong>Issued By:</strong> ${escapeHTML(letter.issuedBy)}</p>
        <p><strong>Letter Note:</strong> ${escapeHTML(letter.message)}</p>
      </article>
    `
    )
    .join('');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function handleApplicationSubmission(event) {
  event.preventDefault();
  const form = event.currentTarget;

  if (!form.checkValidity()) {
    form.reportValidity();
    setFeedback(form, 'Please complete all fields and upload at least one document.', true);
    return;
  }

  const current = getSessionStudent();
  if (!current) {
    window.location.href = 'portal-login.html';
    return;
  }

  const fileInput = document.getElementById('supporting-documents');
  const files = Array.from(fileInput?.files || []);
  if (!files.length) {
    setFeedback(form, 'Please upload at least one supporting document.', true);
    return;
  }

  const totalSize = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  if (totalSize > MAX_TOTAL_UPLOAD_BYTES) {
    setFeedback(form, 'Total upload size is too large. Keep total files under 10 MB.', true);
    return;
  }

  const hasInvalidFile = files.some((file) => {
    const type = String(file.type || '').toLowerCase();
    const tooLarge = Number(file.size) > MAX_SINGLE_UPLOAD_BYTES;
    const invalidType = type && !ALLOWED_UPLOAD_TYPES.includes(type);
    return tooLarge || invalidType;
  });

  if (hasInvalidFile) {
    setFeedback(form, 'Use supported files only (PDF, DOC/DOCX, JPG, PNG) and keep each file under 5 MB.', true);
    return;
  }

  const data = new FormData(form);
  const submission = {
    id: crypto.randomUUID(),
    applicationType: String(data.get('applicationType')).trim(),
    targetProgram: String(data.get('targetProgram')).trim(),
    summary: String(data.get('summary')).trim(),
    documents: files.map((f) => ({
      name: f.name,
      size: f.size,
      sizeLabel: formatSize(f.size),
      type: f.type || 'file'
    })),
    submittedAt: new Date().toISOString(),
    status: 'Submitted'
  };

  const submitResponse = await apiRequest('/student/submissions', {
    method: 'POST',
    body: JSON.stringify({
      applicationType: submission.applicationType,
      targetProgram: submission.targetProgram,
      summary: submission.summary,
      documents: submission.documents
    })
  });

  const students = getStudents();
  const index = students.findIndex((s) => s.id === current.id);
  if (index === -1) {
    window.location.href = 'portal-login.html';
    return;
  }

  students[index].submissions = students[index].submissions || [];
  students[index].submissions.push(submitResponse.ok && submitResponse.data?.submission ? submitResponse.data.submission : submission);
  saveStudents(students);

  setFeedback(form, 'Application submitted successfully with your uploaded documents.');
  form.reset();
  renderSubmissionHistory(students[index]);
  renderStudentStatus(students[index]);
  renderAdmissionLetters(students[index]);
}

async function loadDashboard() {
  let student = getSessionStudent();

  const sessionResponse = await apiRequest('/auth/session');
  if (sessionResponse.ok && sessionResponse.data?.student) {
    upsertStudent(sessionResponse.data.student);
    setStudentSession(sessionResponse.data.student.id);
    student = sessionResponse.data.student;
  }

  if (!student) {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.href = 'portal-login.html';
    return;
  }

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value || '-';
  };

  setText('student-name', student.fullName);
  setText('student-email', student.email);
  setText('student-phone', student.phone);
  setText('student-program', student.program);

  renderSubmissionHistory(student);
  renderStudentStatus(student);
  renderAdmissionLetters(student);

  const applicationForm = document.getElementById('application-submission-form');
  if (applicationForm) {
    applicationForm.addEventListener('submit', handleApplicationSubmission);
  }

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await apiRequest('/auth/logout', { method: 'POST' });
      sessionStorage.removeItem(SESSION_KEY);
      window.location.href = 'portal-login.html';
    });
  }
}

async function handleAdminLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) {
    form.reportValidity();
    setFeedback(form, 'Please enter admin email and password.', true);
    return;
  }

  const data = new FormData(form);
  const email = normalizeEmail(data.get('email'));
  const password = String(data.get('password'));

  const adminLoginResponse = await apiRequest('/admin/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });

  if (adminLoginResponse.reachable) {
    if (!adminLoginResponse.ok) {
      setFeedback(form, adminLoginResponse.error || 'Invalid admin credentials.', true);
      return;
    }

    const admin = adminLoginResponse.data?.admin;
    if (admin?.email) {
      setAdminSession(admin.email, admin.name || ADMIN_USER.name);
      window.location.href = 'admin-dashboard.html';
      return;
    }
  }

  const attemptKey = `admin:${email || 'unknown'}`;
  const attemptState = getAttemptState(ADMIN_ATTEMPTS_KEY, attemptKey);
  if (attemptState.lockUntil > Date.now()) {
    const waitSeconds = getLockoutSeconds(attemptState);
    setFeedback(form, `Too many failed attempts. Please try again in ${waitSeconds} seconds.`, true);
    return;
  }

  const passwordHash = await hashPassword(password);

  if (!secureCompare(email, ADMIN_USER.email) || !secureCompare(passwordHash, ADMIN_PASSWORD_HASH)) {
    const updatedState = registerFailedAttempt(ADMIN_ATTEMPTS_KEY, attemptKey);
    const waitSeconds = updatedState.lockUntil ? getLockoutSeconds(updatedState) : 0;
    const lockoutMsg = waitSeconds > 0 ? ` Account temporarily locked for ${waitSeconds} seconds.` : '';
    setFeedback(form, `Invalid admin credentials.${lockoutMsg}`, true);
    return;
  }

  clearAttemptState(ADMIN_ATTEMPTS_KEY, attemptKey);
  setAdminSession(ADMIN_USER.email, ADMIN_USER.name);
  window.location.href = 'admin-dashboard.html';
}

function findSubmission(students, studentId, submissionId) {
  const studentIndex = students.findIndex((student) => student.id === studentId);
  if (studentIndex === -1) return null;

  const submissionIndex = (students[studentIndex].submissions || []).findIndex((submission) => submission.id === submissionId);
  if (submissionIndex === -1) return null;

  return {
    studentIndex,
    submissionIndex,
    student: students[studentIndex],
    submission: students[studentIndex].submissions[submissionIndex]
  };
}

function getAllSubmissions(students) {
  return students.flatMap((student) =>
    (student.submissions || []).map((submission) => ({
      studentId: student.id,
      studentName: student.fullName,
      studentEmail: student.email,
      studentProgram: student.program,
      ...submission
    }))
  );
}

function renderAdminSummary(students) {
  const totalStudents = students.length;
  const totalSubmissions = students.reduce((count, student) => count + (student.submissions || []).length, 0);
  const issuedLetters = students.reduce(
    (count, student) => count + (student.submissions || []).filter((submission) => submission.admissionLetter).length,
    0
  );

  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  };

  setValue('total-students', totalStudents);
  setValue('total-submissions', totalSubmissions);
  setValue('issued-letters', issuedLetters);
}

async function renderAdminSubmissions() {
  const host = document.getElementById('admin-submissions');
  if (!host) return;

  const apiResponse = await apiRequest('/admin/submissions');
  if (apiResponse.ok && apiResponse.data) {
    const payload = apiResponse.data;
    const allSubmissions = Array.isArray(payload.submissions) ? payload.submissions : [];

    const setValue = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(value);
    };

    setValue('total-students', Number(payload.totalStudents) || 0);
    setValue('total-submissions', Number(payload.totalSubmissions) || 0);
    setValue('issued-letters', Number(payload.issuedLetters) || 0);

    if (!allSubmissions.length) {
      host.innerHTML = '<p class="section-intro">No student submissions available yet.</p>';
      return;
    }

    host.innerHTML = allSubmissions
      .slice()
      .reverse()
      .map((submission) => {
        const docs = (submission.documents || [])
          .map((doc) => `<li>${escapeHTML(doc.name)} <small>(${escapeHTML(doc.sizeLabel)})</small></li>`)
          .join('');

        const letter = submission.admissionLetter
          ? `<div class="letter-box"><strong>Issued Letter:</strong> ${escapeHTML(submission.admissionLetter.letterId)} on ${new Date(submission.admissionLetter.issuedAt).toLocaleString()}</div>`
          : '';

        return `
        <article class="card admin-submission-item" data-student-id="${escapeHTML(submission.studentId)}" data-submission-id="${escapeHTML(submission.id)}">
          <h3>${escapeHTML(submission.applicationType)}</h3>
          <p><strong>Student:</strong> ${escapeHTML(submission.studentName)} (${escapeHTML(submission.studentEmail)})</p>
          <p><strong>Student Track:</strong> ${escapeHTML(submission.studentProgram)}</p>
          <p><strong>Target Program:</strong> ${escapeHTML(submission.targetProgram)}</p>
          <p><strong>Submitted:</strong> ${new Date(submission.submittedAt).toLocaleString()}</p>
          <p><strong>Summary:</strong> ${escapeHTML(submission.summary)}</p>
          <ul class="list-tight">${docs}</ul>

          <div class="admin-actions">
            <label>Review Status
              <select class="admin-status-select">
                <option ${submission.status === 'Submitted' ? 'selected' : ''}>Submitted</option>
                <option ${submission.status === 'Under Review' ? 'selected' : ''}>Under Review</option>
                <option ${submission.status === 'Needs More Documents' ? 'selected' : ''}>Needs More Documents</option>
                <option ${submission.status === 'Qualified' ? 'selected' : ''}>Qualified</option>
                <option ${submission.status === 'Admission Letter Issued' ? 'selected' : ''}>Admission Letter Issued</option>
              </select>
            </label>
            <button type="button" class="btn btn-primary btn-save-status">Save Status</button>
          </div>

          <form class="admin-letter-form form-wrap">
            <label>Admission Letter Message
              <textarea name="letterMessage" rows="3" required placeholder="Enter admission letter note for the student."></textarea>
            </label>
            <button type="submit" class="btn btn-primary">Issue Admission Letter</button>
            <p class="form-feedback" aria-live="polite"></p>
          </form>
          ${letter}
        </article>
        `;
      })
      .join('');

    return;
  }

  const students = getStudents();

  renderAdminSummary(students);
  const allSubmissions = getAllSubmissions(students);

  if (!allSubmissions.length) {
    host.innerHTML = '<p class="section-intro">No student submissions available yet.</p>';
    return;
  }

  host.innerHTML = allSubmissions
    .slice()
    .reverse()
    .map((submission) => {
      const docs = (submission.documents || [])
        .map((doc) => `<li>${escapeHTML(doc.name)} <small>(${escapeHTML(doc.sizeLabel)})</small></li>`)
        .join('');

      const letter = submission.admissionLetter
        ? `<div class="letter-box"><strong>Issued Letter:</strong> ${escapeHTML(submission.admissionLetter.letterId)} on ${new Date(submission.admissionLetter.issuedAt).toLocaleString()}</div>`
        : '';

      return `
      <article class="card admin-submission-item" data-student-id="${escapeHTML(submission.studentId)}" data-submission-id="${escapeHTML(submission.id)}">
        <h3>${escapeHTML(submission.applicationType)}</h3>
        <p><strong>Student:</strong> ${escapeHTML(submission.studentName)} (${escapeHTML(submission.studentEmail)})</p>
        <p><strong>Student Track:</strong> ${escapeHTML(submission.studentProgram)}</p>
        <p><strong>Target Program:</strong> ${escapeHTML(submission.targetProgram)}</p>
        <p><strong>Submitted:</strong> ${new Date(submission.submittedAt).toLocaleString()}</p>
        <p><strong>Summary:</strong> ${escapeHTML(submission.summary)}</p>
        <ul class="list-tight">${docs}</ul>

        <div class="admin-actions">
          <label>Review Status
            <select class="admin-status-select">
              <option ${submission.status === 'Submitted' ? 'selected' : ''}>Submitted</option>
              <option ${submission.status === 'Under Review' ? 'selected' : ''}>Under Review</option>
              <option ${submission.status === 'Needs More Documents' ? 'selected' : ''}>Needs More Documents</option>
              <option ${submission.status === 'Qualified' ? 'selected' : ''}>Qualified</option>
              <option ${submission.status === 'Admission Letter Issued' ? 'selected' : ''}>Admission Letter Issued</option>
            </select>
          </label>
          <button type="button" class="btn btn-primary btn-save-status">Save Status</button>
        </div>

        <form class="admin-letter-form form-wrap">
          <label>Admission Letter Message
            <textarea name="letterMessage" rows="3" required placeholder="Enter admission letter note for the student."></textarea>
          </label>
          <button type="submit" class="btn btn-primary">Issue Admission Letter</button>
          <p class="form-feedback" aria-live="polite"></p>
        </form>
        ${letter}
      </article>
      `;
    })
    .join('');
}

async function loadAdminDashboard() {
  const session = getAdminSession();
  if (!session?.email) {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    window.location.href = 'admin-login.html';
    return;
  }

  const nameEl = document.getElementById('admin-name');
  if (nameEl) nameEl.textContent = session.name;

  await renderAdminSubmissions();

  const host = document.getElementById('admin-submissions');
  if (host) {
    host.addEventListener('click', async (event) => {
      const button = event.target.closest('.btn-save-status');
      if (!button) return;

      const container = button.closest('.admin-submission-item');
      if (!container) return;

      const studentId = container.dataset.studentId;
      const submissionId = container.dataset.submissionId;
      const statusSelect = container.querySelector('.admin-status-select');
      const selectedStatus = statusSelect ? statusSelect.value : 'Submitted';

      const statusResponse = await apiRequest(`/admin/submissions/${encodeURIComponent(studentId)}/${encodeURIComponent(submissionId)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: selectedStatus })
      });

      if (statusResponse.ok) {
        await renderAdminSubmissions();
        return;
      }

      const students = getStudents();
      const match = findSubmission(students, studentId, submissionId);
      if (!match) return;

      students[match.studentIndex].submissions[match.submissionIndex].status = selectedStatus;
      saveStudents(students);
      await renderAdminSubmissions();
    });

    host.addEventListener('submit', async (event) => {
      const form = event.target.closest('.admin-letter-form');
      if (!form) return;
      event.preventDefault();

      if (!form.checkValidity()) {
        form.reportValidity();
        setFeedback(form, 'Please include a letter message before issuing.', true);
        return;
      }

      const container = form.closest('.admin-submission-item');
      if (!container) return;

      const studentId = container.dataset.studentId;
      const submissionId = container.dataset.submissionId;
      const message = String(new FormData(form).get('letterMessage')).trim();

      const letterResponse = await apiRequest(`/admin/submissions/${encodeURIComponent(studentId)}/${encodeURIComponent(submissionId)}/letter`, {
        method: 'POST',
        body: JSON.stringify({ message })
      });

      if (letterResponse.ok) {
        await renderAdminSubmissions();
        return;
      }

      const students = getStudents();
      const match = findSubmission(students, studentId, submissionId);

      if (!match) {
        setFeedback(form, 'Unable to find submission. Please refresh.', true);
        return;
      }

      const letterId = `TIH-ADMIT-${new Date().getFullYear()}-${Math.floor(Math.random() * 9000 + 1000)}`;
      students[match.studentIndex].submissions[match.submissionIndex].status = 'Admission Letter Issued';
      students[match.studentIndex].submissions[match.submissionIndex].admissionLetter = {
        letterId,
        message,
        issuedAt: new Date().toISOString(),
        issuedBy: session.name
      };

      saveStudents(students);
      await renderAdminSubmissions();
    });
  }

  const logoutBtn = document.getElementById('admin-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await apiRequest('/admin/logout', { method: 'POST' });
      sessionStorage.removeItem(ADMIN_SESSION_KEY);
      window.location.href = 'admin-login.html';
    });
  }
}

const registerForm = document.getElementById('student-register-form');
if (registerForm) registerForm.addEventListener('submit', handleRegister);

const loginForm = document.getElementById('student-login-form');
if (loginForm) loginForm.addEventListener('submit', handleLogin);

const adminLoginForm = document.getElementById('admin-login-form');
if (adminLoginForm) adminLoginForm.addEventListener('submit', handleAdminLogin);

normalizeLegacyStudentSession();
normalizeLegacyAdminSession();

if (document.getElementById('student-name')) loadDashboard();
if (document.getElementById('admin-name')) loadAdminDashboard();
