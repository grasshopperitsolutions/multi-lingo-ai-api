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
2. Install dependencies: `npm install`
3. Deploy to Vercel or run locally with `vercel dev`

## API Endpoints

### Authentication
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register new user with email/password |
| POST | `/api/auth/login` | Login with email/password |
| POST | `/api/auth/google` | Google OAuth login |
| POST | `/api/auth/apple` | Apple OAuth login |
| POST | `/api/auth/facebook` | Facebook OAuth login |
| POST | `/api/auth/twitter` | X (Twitter) OAuth login |
| POST | `/api/auth/logout` | Logout and revoke tokens |
| POST | `/api/auth/refresh-token` | Refresh authentication token |
| POST | `/api/auth/verify-email` | Verify email address |
| POST | `/api/auth/reset-password` | Request or confirm password reset |

### Storage
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/storage/upload` | Generate signed upload URL |
| PUT | `/api/storage/update` | Update existing file |
| DELETE | `/api/storage/delete` | Delete file |
| GET/POST | `/api/storage/signed-url` | Generate temporary access URL |

### Firestore
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/firestore/create` | Create document in any collection |
| GET | `/api/firestore/read` | Get document by ID |
| PUT | `/api/firestore/update` | Update document |
| DELETE | `/api/firestore/delete` | Delete document |
| POST | `/api/firestore/query` | Query collection with filters |

### Users
| Method | Path | Description |
|--------|------|-------------|
| GET/PUT | `/api/users/profile` | Get or update user profile |
| GET/PUT | `/api/users/settings` | Get or update user settings |

## Environment Variables

Copy `.env.example` to `.env` and configure:

```env
# Firebase Admin Configuration
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_STORAGE_BUCKET=your-project.appspot.com

# CORS Configuration
ALLOWED_ORIGINS=http://localhost:3000,https://your-domain.com

# Optional
PASSWORD_RESET_URL=https://your-app.com/reset-password
```

## Usage Examples

### Register a new user
```bash
curl -X POST https://your-api.vercel.app/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "securepassword"}'
```

### Upload a file
```bash
# 1. Get signed upload URL
curl -X POST https://your-api.vercel.app/api/storage/upload \
  -H "Authorization: Bearer YOUR_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fileName": "photo.jpg", "contentType": "image/jpeg"}'

# 2. Upload file to the returned signed URL
curl -X PUT "<signed-url>" \
  -H "Content-Type: image/jpeg" \
  --data-binary @photo.jpg
```

### Create a document
```bash
curl -X POST https://your-api.vercel.app/api/firestore/create \
  -H "Authorization: Bearer YOUR_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"collection": "translations", "data": {"text": "Hello", "language": "en"}}'