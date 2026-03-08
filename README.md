# TIH Backend API

This backend adds real server-side authentication, sessions, and submission management for the portal/classroom flows.

## Features
- Student register/login/logout with bcrypt password hashing
- Admin login/logout with lockout throttling
- Session cookies with expiration checks
- Submission endpoints for students and admin review updates
- Persistent data in `backend/data/db.json`

## Setup
1. Open terminal in `backend`.
2. Install dependencies:
   - `npm install`
3. Create environment file:
   - copy `.env.example` to `.env`
4. Start server:
   - `npm run dev`

Backend URL: `http://localhost:4000`

## API (high-level)
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/session`
- `POST /api/auth/logout`
- `POST /api/admin/login`
- `GET /api/admin/session`
- `POST /api/admin/logout`
- `POST /api/student/submissions`
- `GET /api/student/submissions`
- `GET /api/admin/submissions`
- `PATCH /api/admin/submissions/:studentId/:submissionId/status`
- `POST /api/admin/submissions/:studentId/:submissionId/letter`

## Frontend integration
`portal-auth.js` and `classroom.js` now call the API at:
- `window.TIH_API_BASE` if defined, else `http://localhost:4000/api`

If backend is unavailable, client-side fallback logic remains active for continuity.
