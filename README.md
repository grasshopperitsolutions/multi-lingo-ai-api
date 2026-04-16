# Multi Lingo AI API

Vercel Serverless Functions API with Firebase Authentication, Firestore and Storage.

## Features

✅ **Authentication**
- Email / Password login & registration
- Google, Apple, Facebook, X (Twitter) OAuth login
- Token refresh, email verification, password reset
- Global authentication middleware

✅ **Firestore Database**
- Generic CRUD endpoints for any collection
- Query support with filtering, sorting, pagination
- Automatic audit fields (createdBy, createdAt, updatedAt)

✅ **Storage**
- Upload any file type
- Update and delete files
- Signed URLs for secure access
- File metadata tracking

✅ **Security**
- Proper CORS policy with origin whitelisting
- JWT token verification on all protected routes
- Input validation
- Standardized error responses

## Getting Started

1. Copy `.env.example` to `.env` and fill in your Firebase credentials
2. Deploy to Vercel or run locally with `vercel dev`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register new user with email/password |
| POST | `/api/auth/login` | Login with email/password |
| POST | `/api/auth/google` | Google OAuth login |
| POST | `/api/auth/apple` | Apple OAuth login |
| POST | `/api/auth/facebook` | Facebook OAuth login |
| POST | `/api/auth/twitter` | X (Twitter) OAuth login |
| POST | `/api/storage/upload` | Generate signed upload URL |
| POST | `/api/storage/update` | Update existing file |
| DELETE | `/api/storage/delete` | Delete file |
| POST | `/api/firestore/create` | Create document in any collection |
| GET | `/api/firestore/read` | Get document by ID |
| PUT | `/api/firestore/update` | Update document |
| DELETE | `/api/firestore/delete` | Delete document |
| POST | `/api/firestore/query` | Query collection |