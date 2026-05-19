# Multi-Lingo AI API

A consolidated API service for authentication, Firestore operations, and storage management using Firebase Admin SDK with Vercel serverless functions.

## API Endpoints

This API has been consolidated into **3 main endpoints**:

### 1. Authentication - `POST /api/auth`

Handles all authentication operations via an `action` parameter in the request body.

#### Actions:

**Login**
```json
POST /api/auth
{
  "action": "login",
  "email": "user@example.com",
  "password": "password123"
}
```

**Register**
```json
POST /api/auth
{
  "action": "register",
  "email": "user@example.com",
  "password": "password123",
  "displayName": "John Doe",
  "photoURL": "https://example.com/photo.jpg"
}
```

**Social Login (Google, Apple, Facebook, Twitter)**
```json
POST /api/auth
{
  "action": "google", // or "apple", "facebook", "twitter"
  "idToken": "id_token_from_provider"
}
```

**Logout**
```json
POST /api/auth
{
  "action": "logout"
}
```

**Verify Email**
```json
POST /api/auth
{
  "action": "verify-email",
  "oobCode": "oob_code_from_email"
}
```

**Reset Password**
```json
POST /api/auth
{
  "action": "reset-password",
  "oobCode": "oob_code_from_email",
  "newPassword": "newSecurePassword123"
}
```

**Refresh Token**
```json
POST /api/auth
{
  "action": "refresh-token",
  "refreshToken": "refresh_token"
}
```

### 2. Firestore - `/api/firestore`

Handles all Firestore CRUD operations via HTTP methods.

**Authentication Required**: Yes (except for public collections if configured)

#### Create Document
```http
POST /api/firestore
Authorization: Bearer <token>
{
  "collection": "users",
  "data": {
    "name": "John Doe",
    "email": "john@example.com"
  },
  "id": "optional_custom_id" // Optional: if not provided, Firestore will auto-generate
}
```

#### Read Single Document
```http
GET /api/firestore?collection=users&id=user123
Authorization: Bearer <token>
```

#### Query Documents
```http
GET /api/firestore?collection=users&query={"status":"active"}&orderBy=createdAt&order=desc&limit=20
Authorization: Bearer <token>
```

Query parameters:
- `collection` (required): The collection to query
- `query` (optional): JSON string of filter conditions
- `orderBy` (optional): Field to order by (default: createdAt)
- `order` (optional): Order direction - 'asc' or 'desc' (default: desc)
- `limit` (optional): Number of documents to return (default: 20, max: 100)
- `startAfter` (optional): Document ID for pagination

#### Update Document
```http
PUT /api/firestore
Authorization: Bearer <token>
{
  "collection": "users",
  "id": "user123",
  "data": {
    "name": "Jane Doe"
  }
}
```

#### Delete Document
```http
DELETE /api/firestore
Authorization: Bearer <token>
{
  "collection": "users",
  "id": "user123"
}
```

### 3. Storage - `/api/storage`

Handles all file storage operations via HTTP methods.

**Authentication Required**: Yes

#### Upload File (Generate Signed URL)
```http
POST /api/storage
Authorization: Bearer <token>
{
  "fileName": "document.pdf",
  "contentType": "application/pdf",
  "folder": "documents", // Optional: defaults to 'uploads'
  "metadata": {
    "description": "Important document"
  }
}
```

Response includes a signed URL for direct upload to storage.

#### Get Signed Download URL
```http
GET /api/storage?fileId=file123&expiresIn=3600
Authorization: Bearer <token>
```

#### Update File Metadata
```http
PUT /api/storage
Authorization: Bearer <token>
{
  "fileId": "file123",
  "fileName": "updated-document.pdf", // Optional: if provided, will upload new content
  "contentType": "application/pdf",
  "metadata": {
    "description": "Updated description"
  }
}
```

#### Delete File
```http
DELETE /api/storage
Authorization: Bearer <token>
{
  "fileId": "file123"
}
```

## User Data Management

User profiles and settings are now managed through the generic Firestore endpoint:

#### Get User Profile
```http
GET /api/firestore?collection=users&id={userId}
Authorization: Bearer <token>
```

#### Update User Profile
```http
PUT /api/firestore
Authorization: Bearer <token>
{
  "collection": "users",
  "id": "{userId}",
  "data": {
    "displayName": "Updated Name",
    "photoURL": "https://new-photo.jpg",
    "settings": {
      "language": "en",
      "notifications": {
        "email": true,
        "push": false
      }
    }
  }
}
```

## Authentication

All endpoints except `/api/auth` require authentication via Firebase ID token.

**Headers:**
```
Authorization: Bearer <firebase_id_token>
```

Each endpoint handler uses `lib/verify-auth.ts` to:
1. Verify the Firebase ID token from the `Authorization` header
2. Return the authenticated user's UID for the handler to use
3. Respond with `401 Unauthorized` if the token is invalid or missing

## CORS

CORS is enabled for all endpoints with configurable allowed origins via the `ALLOWED_ORIGINS` environment variable.

## Environment Variables

Required environment variables:
- `FIREBASE_PROJECT_ID`: Firebase project ID
- `FIREBASE_CLIENT_EMAIL`: Firebase service account client email
- `FIREBASE_PRIVATE_KEY`: Firebase service account private key
- `FIREBASE_STORAGE_BUCKET`: Firebase storage bucket name
- `ALLOWED_ORIGINS`: Comma-separated list of allowed origins (optional)

## Deployment

This API is designed for Vercel serverless deployment. Each endpoint is a separate serverless function with:
- Memory: 1024MB
- Max Duration: 10 seconds

## Security

- All sensitive operations require Firebase authentication
- User data is protected by ownership checks
- File access is restricted to file owners
- CORS headers are properly configured
- Rate limiting can be added via Vercel configuration

## Migration Notes

This API has been consolidated from multiple individual endpoints into 3 main endpoints for better maintainability and scalability. The old endpoints have been removed:
- All auth operations are now in `/api/auth`
- All Firestore operations are now in `/api/firestore`
- All storage operations are now in `/api/storage`
- User profile and settings are accessed via the Firestore endpoint